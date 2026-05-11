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
    /**
     * Engine sample rate negotiated during the ingress handshake.
     * Captured from `AudioIngressOpened.format.sample_rate`. Needed
     * to translate latency milliseconds into engine SAMPLES before
     * sending `SetIngressCaptureLatency` to the shim — the engine's
     * record-shift compensation operates on sample counts at the
     * engine rate, not on time.
     */
    this._engineSampleRate = 0;
    /** Last latency-sample value we sent — avoids spamming the shim. */
    this._lastLatencySamples = -1;
    /** Interval handle for periodic latency refresh. */
    this._latencyTimer = null;
    /** Last network latency (ms) reported by the server for this stream. */
    this._lastNetworkMs = null;
    /** Bound envelope handler so we can remove it cleanly on stop(). */
    this._envHandler = (ev) => this._onEnvelope(ev?.detail);
  }

  get enginePortName() {
    return this._enginePortName;
  }

  /**
   * Best-effort estimate of the latency between a sound hitting the
   * physical microphone and the corresponding sample bytes being
   * handed to the WS for transmission, in milliseconds.
   *
   * Components:
   *   * `AudioContext.baseLatency` × 1000 — hardware + driver buffer
   *     reported by the browser. Typically 10–25 ms on desktop,
   *     20–40 ms on a phone.
   *   * Half the worklet frame size (~10 ms at 20 ms frames) —
   *     averages the within-frame wait before bytes are flushed onto
   *     the WS. The full frame is a worst-case upper bound; midpoint
   *     is a fairer expected-value estimate for a stream of frames.
   *
   * Returns `null` if the context hasn't been opened yet.
   * Used by the transport-stop delay so the user's recording tail
   * isn't clipped — without subtracting capture latency, the engine
   * stops while bytes from the last ~20–40 ms of the take are still
   * in-flight through the browser's input buffer.
   */
  getCaptureLatencyMs() {
    if (!this._ctx) return null;
    const base = (Number(this._ctx.baseLatency) || 0) * 1000;
    const frameMs = INGRESS_FRAME_MS * 1000;
    return base + frameMs / 2;
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
      // Begin pushing capture-latency compensation to the shim so
      // recorded regions land at the right position on the timeline.
      // Without this, the take is offset to the right by the full
      // browser→shim transport latency. Fires immediately with a
      // capture-only estimate, then refines on each
      // `ingress_latency_report` reply.
      this._startLatencyCompensation();
    } catch (e) {
      await this._cleanupAfterFailure();
      throw e;
    }
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    this._stopLatencyCompensation();

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
      // Push the user's preferred ring-prime depth BEFORE the
      // shim constructs the soft port — the shim caches whatever
      // value lands most recently and applies it to the next
      // AudioIngressOpen. Cheap idempotent send; no harm if the
      // value is unchanged.
      try {
        const prefs = JSON.parse(localStorage.getItem("foyer.audio.prefs.v1") || "{}");
        const ms = Number(prefs.shimIngressRingPrimeMs);
        if (Number.isFinite(ms) && ms > 0) {
          this.ws.send({ type: "set_ingress_ring_prime_ms", ms: Math.round(ms) });
        }
      } catch {}
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
      if (engineSr > 0) this._engineSampleRate = engineSr;
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

  // ─── Capture-latency compensation ─────────────────────────────
  //
  // Pushes a periodic `SetIngressCaptureLatency` to the server so
  // the shim sets the matching port's private capture-latency
  // range. Ardour's `Route::update_signal_latency()` then shifts
  // every recording on that track earlier by the FULL round-trip
  // latency — the take lines up acoustically with the playback
  // the user heard.
  //
  // Why round-trip and not just ingress: the user sings in
  // response to audio they HEAR. What they hear is delayed by the
  // egress path (engine → server encoder → WS → worklet jitter
  // buffer → AudioContext output → speakers). When they sing at
  // wall-clock W, the engine had emitted the audio at engine time
  // T = W - egress_latency. Their sung audio then travels back
  // through ingress and lands at engine time W + ingress. To
  // align the recording with T (where the user thought they
  // sang), we shift by egress + ingress, not just ingress.
  //
  // Components we measure browser-side:
  //   * capture        — browser baseLatency + half-frame
  //   * ingress net    — ingress one-way median from server tracker
  //   * playback delay — worklet jitter buffer + AudioContext
  //                      output latency (from `audioClock`)
  //   * egress net     — approximated as ≈ ingress one-way
  //                      (symmetric path assumption)
  //
  // The shim's `ShimInputPort::set_capture_latency` adds its OWN
  // contribution on top (PRIME_THRESHOLD_MS ring depth + one
  // engine cycle, read live from `AudioEngine`). That keeps the
  // browser ignorant of engine-side state (JACK vs in-process
  // dummy, buffer size) — same code adapts automatically.
  //
  // Fires immediately on stream open with capture-only (no other
  // measurements yet), then every 5 s once the server has > 8
  // ingress samples and the worklet has reported a buffer-fill
  // stat.

  _startLatencyCompensation() {
    if (!this.ws || !this._engineSampleRate) return;
    this.ws.addEventListener("envelope", this._envHandler);
    // Fire once right away so the shim has SOMETHING by the time
    // the user hits record. The capture-only estimate is the
    // single biggest component (~25–40 ms) so it's worth applying
    // before the first network sample arrives.
    this._pushCaptureLatency();
    this._latencyTimer = setInterval(() => {
      if (!this._running) return;
      // Re-request the server's latest median; the envelope
      // handler will re-push when the reply arrives.
      this.ws.send({ type: "request_ingress_latency", stream_id: this.streamId });
    }, 5000);
    // Also fire one initial latency request so we get the network
    // median as soon as the server has enough samples.
    setTimeout(() => {
      if (!this._running) return;
      this.ws.send({ type: "request_ingress_latency", stream_id: this.streamId });
    }, 1500);
  }

  _stopLatencyCompensation() {
    if (this._latencyTimer) {
      clearInterval(this._latencyTimer);
      this._latencyTimer = null;
    }
    try { this.ws?.removeEventListener("envelope", this._envHandler); } catch {}
    // Clear the shim's compensation for this stream — any future
    // reuse of the same stream_id starts from zero (shouldn't
    // happen since we mint a fresh id per ingress, but defensive).
    if (this._lastLatencySamples > 0) {
      try {
        this.ws?.send({
          type: "set_ingress_capture_latency",
          stream_id: this.streamId,
          samples: 0,
        });
      } catch {}
    }
    this._lastLatencySamples = -1;
    this._lastNetworkMs = null;
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type !== "ingress_latency_report") return;
    if (body.stream_id !== this.streamId) return;
    if (body.median_ms != null && Number.isFinite(body.median_ms)) {
      this._lastNetworkMs = body.median_ms;
      this._pushCaptureLatency();
    }
  }

  _pushCaptureLatency() {
    if (!this._running || !this.ws || !this._engineSampleRate) return;
    const captureMs = this.getCaptureLatencyMs() ?? 0;
    const ingressNetworkMs = this._lastNetworkMs ?? 0;
    // Egress (playback) leg — what the user HEARS lags the engine
    // by this much. We read it from the live audio-clock if the
    // listener is running. Falls back to 0 (user isn't listening,
    // so they couldn't have sung in response to anything anyway).
    let playbackDelayMs = 0;
    try {
      const ac = globalThis.__foyer?.audioClock;
      const snap = ac?.snapshot?.();
      if (snap && Number.isFinite(snap.playbackDelayMs)) {
        playbackDelayMs = snap.playbackDelayMs;
      }
    } catch {}
    // Assume the egress network leg ≈ ingress network leg. On
    // loopback / LAN this is true within a ms or two; on a tunnel
    // the asymmetry is bounded by routing and gets absorbed into
    // whatever jitter is already in the worklet buffer.
    const egressNetworkMs = ingressNetworkMs;
    // Browser-side ms → samples at the engine rate. The shim adds
    // its internal ring-prime + cycle contribution on top before
    // calling `Port::set_private_latency_range`, so we report only
    // the part we can measure here.
    const browserMs = captureMs + ingressNetworkMs + egressNetworkMs + playbackDelayMs;
    const samples = Math.max(0, Math.round((browserMs / 1000) * this._engineSampleRate));
    // Skip the send if the value hasn't meaningfully changed —
    // anything within 32 samples is below a single typical JACK
    // period and would only churn the latency-compensation pass.
    if (Math.abs(samples - this._lastLatencySamples) < 32 && this._lastLatencySamples >= 0) {
      return;
    }
    this._lastLatencySamples = samples;
    this.ws.send({
      type: "set_ingress_capture_latency",
      stream_id: this.streamId,
      samples,
    });
    // Stash for diagnostics.
    globalThis.__foyer = globalThis.__foyer || {};
    globalThis.__foyer.lastIngressLatency = {
      streamId: this.streamId,
      captureMs: Math.round(captureMs),
      ingressNetworkMs: Math.round(ingressNetworkMs),
      egressNetworkMs: Math.round(egressNetworkMs),
      playbackDelayMs: Math.round(playbackDelayMs),
      browserMs: Math.round(browserMs),
      samplesToShim: samples,
      engineSampleRate: this._engineSampleRate,
    };
    console.info(
      `[ingress] capture latency → ${samples} samples ` +
        `(capture ${Math.round(captureMs)} + ingress-net ${Math.round(ingressNetworkMs)} + ` +
        `egress-net ${Math.round(egressNetworkMs)} + playback ${Math.round(playbackDelayMs)} = ` +
        `${Math.round(browserMs)} ms browser-side) @ ${this._engineSampleRate} Hz; ` +
        `shim adds ring + cycle on top`,
    );
  }
}
