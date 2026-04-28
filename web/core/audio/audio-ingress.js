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

const INGRESS_FRAME_SAMPLES = 960; // 20 ms @ 48 kHz; must match shim expectation.

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
    this._awaitingAck = null;
    this._enginePortName = ""; // set after AudioIngressOpened ack
  }

  get enginePortName() {
    return this._enginePortName;
  }

  async start() {
    if (this._running) return;
    this._running = true;

    // 1. Acquire mic stream.
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.error("[ingress] getUserMedia failed:", e);
      this._running = false;
      throw e;
    }

    // 2. Build AudioContext + worklet for capture.
    this._ctx = new AudioContext({ sampleRate: 48_000 });
    await this._ctx.audioWorklet.addModule(new URL("./ingress-worklet.js", import.meta.url));
    this._workletNode = new AudioWorkletNode(this._ctx, "foyer-ingress", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize: INGRESS_FRAME_SAMPLES },
    });

    // 3. Wait for AudioIngressOpened before opening binary WS.
    const ackPromise = this._waitForIngressOpened(this.streamId);
    this.ws.send({
      type: "audio_ingress_open",
      stream_id: this.streamId,
      source: { kind: "virtual_input", name: `browser-${this.streamId}` },
      format: {
        sample_rate: 48_000,
        channels: 1,
        format: "f32_le",
        frame_size: INGRESS_FRAME_SAMPLES,
        codec: "raw_f32_le",
      },
    });
    await ackPromise;

    // 4. Open binary WS and wire worklet → WS.
    this._audioWs = new WebSocket(`${this.baseUrl}/ws/ingress/${this.streamId}`);
    this._audioWs.binaryType = "arraybuffer";
    this._audioWs.onopen = () => {
      console.info(`[ingress] binary WS open stream_id=${this.streamId}`);
    };
    this._audioWs.onerror = (e) => console.error("[ingress] binary WS error:", e);
    this._audioWs.onclose = (e) => {
      console.info(`[ingress] binary WS closed code=${e.code}`);
    };

    this._workletNode.port.onmessage = (ev) => {
      if (!this._audioWs || this._audioWs.readyState !== WebSocket.OPEN) return;
      const buf = ev.data; // Float32Array (mono)
      this._audioWs.send(buf.buffer);
    };

    const micSource = this._ctx.createMediaStreamSource(micStream);
    micSource.connect(this._workletNode);
    this._source = micSource;
    await this._ctx.resume();
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
    this._enginePortName = "";
    this.ws.send({ type: "audio_ingress_close", stream_id: this.streamId });
  }

  _waitForIngressOpened(streamId) {
    return new Promise((resolve, reject) => {
      const onEnv = (ev) => {
        const body = ev.detail?.body;
        if (body?.type === "audio_ingress_opened" && body.stream_id === streamId) {
          if (body.port_name) {
            this._enginePortName = body.port_name;
          }
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
}
