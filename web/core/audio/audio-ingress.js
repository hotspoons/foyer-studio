// Browser-side audio capture → DAW ingress.
//
// Pipeline:
//   getUserMedia() → AudioContext → AudioWorkletNode (capture)
//                        ↓
//                   Float32Array interleaved
//                        ↓
//                /ws/ingress/:stream_id (binary)
//                        ↓
//                sidecar → backend → shim → soft port
//
// Control handshake:
//   1. Send `AudioIngressOpen` over control WS.
//   2. Wait for `AudioIngressOpened` event.
//   3. Open binary WS to `/ws/ingress/:stream_id`.
//   4. Pump captured chunks.
//   5. On stop: close binary WS, send `AudioIngressClose` over control WS.
//
// The sidecar keys ingress PCM on `AudioIngressOpen.format.sample_rate`. If
// the OS/browser cannot provide an `AudioContext` at the engine rate, we
// close and reopen the ingress stream so resampler bookkeeping stays
// consistent.

const INGRESS_FRAME_MS = 0.02; // wall-clock frame duration for WS batches

export class AudioIngress {
  constructor(opts) {
    this.ws = opts.ws;
    this.baseUrl = opts.baseUrl;
    this.streamId = (Math.random() * 0xffffffff) >>> 0;
    this._running = false;
    this._audioWs = null;
    this._ctx = null;
    this._source = null;
    this._workletNode = null;
    this._micStream = null;
    this._enginePortName = ""; // set after AudioIngressOpened ack
  }

  get enginePortName() {
    return this._enginePortName;
  }

  async start() {
    if (this._running) return;
    this._running = true;

    try {
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        console.error("[ingress] getUserMedia failed:", e);
        this._running = false;
        throw e;
      }
      this._micStream = micStream;

      await this._openCaptureContext(null);
      await this._handshakeIngressUntilAligned();

      this._setupBinaryWsAndPump();
      await this._ctx.resume();
    } catch (e) {
      await this._cleanupAfterFailure();
      throw e;
    }
  }

  async stop() {
    if (!this._running) return;
    this._running = false;

    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      try { this._workletNode.disconnect(); } catch {}
    }
    if (this._source) {
      try { this._source.disconnect(); } catch {}
    }
    if (this._audioWs) {
      try { this._audioWs.close(); } catch {}
    }
    if (this._ctx && this._ctx.state !== "closed") {
      try { await this._ctx.close(); } catch {}
    }
    if (this._micStream) {
      for (const t of this._micStream.getTracks()) {
        try { t.stop(); } catch {}
      }
      this._micStream = null;
    }
    this._enginePortName = "";
    this.ws.send({ type: "audio_ingress_close", stream_id: this.streamId });
  }

  /// Called when `session_snapshot` reports a new engine sample rate while
  /// capture is running. May close/reopen the ingress session so declared
  /// client rate matches the graph.
  async syncEngineSampleRate(engineSr) {
    const target = Math.round(Number(engineSr) || 0);
    if (!this._running || !this._micStream || target <= 0) {
      return { portChanged: false, portName: this._enginePortName };
    }
    if (Math.round(this._ctx.sampleRate) === target) {
      return { portChanged: false, portName: this._enginePortName };
    }

    const oldPort = this._enginePortName;
    const hadWs = this._audioWs && this._audioWs.readyState === WebSocket.OPEN;

    if (this._audioWs) {
      try { this._audioWs.close(); } catch {}
      this._audioWs = null;
    }
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch {}
      this._source = null;
    }

    this.ws.send({ type: "audio_ingress_close", stream_id: this.streamId });
    await this._waitForIngressClosed(this.streamId);
    this.streamId = (Math.random() * 0xffffffff) >>> 0;

    await this._openCaptureContext(target);
    await this._handshakeIngressUntilAligned();

    if (hadWs) {
      this._setupBinaryWsAndPump();
      try { await this._ctx.resume(); } catch {}
    }

    const portChanged = this._enginePortName !== oldPort;
    return { portChanged, portName: this._enginePortName };
  }

  _captureClientFormat() {
    const sr = Math.round(this._ctx.sampleRate);
    const frameSize = Math.max(32, Math.round(sr * INGRESS_FRAME_MS));
    return {
      sample_rate: sr,
      channels: 1,
      format: "f32_le",
      frame_size: frameSize,
      codec: "raw_f32_le",
    };
  }

  async _openCaptureContext(preferredSr) {
    if (this._workletNode) {
      try {
        this._workletNode.port.onmessage = null;
        this._workletNode.disconnect();
      } catch {}
      this._workletNode = null;
    }
    if (this._ctx && this._ctx.state !== "closed") {
      try { await this._ctx.close(); } catch {}
    }
    this._ctx = null;

    const want = preferredSr != null ? Math.round(Number(preferredSr)) : 0;
    let ctx;
    if (want > 0) {
      try {
        ctx = new AudioContext({ sampleRate: want });
      } catch {
        ctx = new AudioContext();
      }
      if (Math.abs(ctx.sampleRate - want) > 1) {
        try { await ctx.close(); } catch {}
        ctx = new AudioContext();
      }
    } else {
      ctx = new AudioContext();
    }

    this._ctx = ctx;
    const sr = Math.round(ctx.sampleRate);
    const frameSize = Math.max(32, Math.round(sr * INGRESS_FRAME_MS));
    await ctx.audioWorklet.addModule(new URL("./ingress-worklet.js", import.meta.url));
    this._workletNode = new AudioWorkletNode(ctx, "foyer-ingress", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize },
    });
  }

  async _handshakeIngressUntilAligned() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const fmt = this._captureClientFormat();
      const ackPromise = this._waitForIngressOpened(this.streamId);
      this.ws.send({
        type: "audio_ingress_open",
        stream_id: this.streamId,
        source: { kind: "virtual_input", name: `browser-${this.streamId}` },
        format: fmt,
      });
      const ack = await ackPromise;
      if (ack.port_name) {
        this._enginePortName = ack.port_name;
      }
      const engineSr = Math.round(Number(ack.format?.sample_rate) || 0);
      if (engineSr > 0 && fmt.sample_rate !== engineSr) {
        this.ws.send({ type: "audio_ingress_close", stream_id: this.streamId });
        await this._waitForIngressClosed(this.streamId);
        this.streamId = (Math.random() * 0xffffffff) >>> 0;
        await this._openCaptureContext(engineSr);
        continue;
      }
      return;
    }
    throw new Error("ingress open could not align capture rate with engine");
  }

  _setupBinaryWsAndPump() {
    this._audioWs = new WebSocket(`${this.baseUrl}/ws/ingress/${this.streamId}`);
    this._audioWs.binaryType = "arraybuffer";
    this._audioWs.onopen = () => {
      console.info(`[ingress] binary WS open stream_id=${this.streamId}`);
    };
    this._audioWs.onerror = (e) => console.error("[ingress] binary WS error:", e);
    this._audioWs.onclose = (e) => {
      console.info(`[ingress] binary WS closed code=${e.code}`);
    };

    this._wireWorkletToWs();
    this._source = this._ctx.createMediaStreamSource(this._micStream);
    this._source.connect(this._workletNode);
  }

  _wireWorkletToWs() {
    this._workletNode.port.onmessage = (ev) => {
      if (!this._audioWs || this._audioWs.readyState !== WebSocket.OPEN) return;
      const buf = ev.data;
      // Prepend the 8-byte `client_send_ms` (f64 LE) header expected
      // by /ws/ingress/:stream_id. We stamp on the main thread at
      // receipt of the worklet message; the queueing delay between
      // worklet post and main-thread receipt is small (~quantum-
      // bounded, single-digit ms) and constant across packets, so
      // it cancels out of the median latency the server tracks.
      // Doing it on the main thread keeps the worklet's hot-path
      // budget free of cross-thread clock alignment math.
      const header = new Float64Array(1);
      header[0] = performance.now();
      const out = new Uint8Array(8 + buf.byteLength);
      out.set(new Uint8Array(header.buffer), 0);
      out.set(new Uint8Array(buf.buffer), 8);
      this._audioWs.send(out.buffer);
    };
  }

  async _cleanupAfterFailure() {
    this._running = false;
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      try { this._workletNode.disconnect(); } catch {}
    }
    if (this._source) {
      try { this._source.disconnect(); } catch {}
    }
    if (this._audioWs) {
      try { this._audioWs.close(); } catch {}
    }
    if (this._ctx && this._ctx.state !== "closed") {
      try { await this._ctx.close(); } catch {}
    }
    if (this._micStream) {
      for (const t of this._micStream.getTracks()) {
        try { t.stop(); } catch {}
      }
      this._micStream = null;
    }
    try {
      this.ws.send({ type: "audio_ingress_close", stream_id: this.streamId });
    } catch {}
  }

  _waitForIngressOpened(streamId) {
    return new Promise((resolve, reject) => {
      const onEnv = (ev) => {
        const body = ev.detail?.body;
        if (body?.type === "audio_ingress_opened" && body.stream_id === streamId) {
          cleanup();
          resolve(body);
        }
        if (body?.type === "error" && body.code === "ingress_open_failed") {
          cleanup();
          reject(new Error(body.message));
        }
      };
      const cleanup = () => {
        this.ws.removeEventListener("envelope", onEnv);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("ingress open timeout (no AudioIngressOpened within 10 s)"));
      }, 10_000);
      this.ws.addEventListener("envelope", onEnv);
    });
  }

  _waitForIngressClosed(streamId) {
    return new Promise((resolve) => {
      const onEnv = (ev) => {
        const body = ev.detail?.body;
        if (body?.type === "audio_ingress_closed" && body.stream_id === streamId) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.ws.removeEventListener("envelope", onEnv);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);
      this.ws.addEventListener("envelope", onEnv);
    });
  }
}
