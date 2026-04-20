// Browser-side consumer of the sidecar's egress audio path.
//
// Pipeline per the M6a spec (see crates/foyer-server/src/audio.rs):
//
//   /ws/audio/:stream_id  ──►  per-packet parser  ──►  AudioDecoder
//                                                        │
//                                                        ▼
//                                               AudioWorklet (future)
//                                               or AudioContext (current)
//
// Current implementation: decode with WebCodecs `AudioDecoder`, queue
// into a scheduled-buffer playback (simple but works). Swap for an
// AudioWorklet-based jitter buffer once we have real shim audio to
// smoothe out — the synthetic test tone is continuous so the simple
// path holds up fine.
//
// If the browser lacks WebCodecs or we're asked for a `raw_f32_le`
// stream, the listener falls through to a trivially-parsing path that
// pushes raw f32 samples into the same AudioContext.

const FRAME_HEADER_BYTES = 12;

export class AudioListener {
  /**
   * @param {object} opts
   * @param {WebSocket} opts.ws  - control WS for the sidecar
   * @param {string}   opts.baseUrl - e.g. "ws://localhost:3838"
   * @param {string}   opts.sourceKind - AudioSource kind: "master" | "track" | ...
   * @param {string}   [opts.sourceId] - track id when kind = "track"
   * @param {string}   [opts.codec] - "opus" (default) or "raw_f32_le"
   */
  constructor(opts) {
    this.ws = opts.ws;
    this.baseUrl = opts.baseUrl;
    this.sourceKind = opts.sourceKind;
    this.sourceId = opts.sourceId;
    this.codec = opts.codec || "opus";
    this.streamId = (Math.random() * 0xffffffff) | 0;
    this.format = { sample_rate: 48_000, channels: 2, format: "f32_le", frame_size: 960, codec: this.codec };

    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {WebSocket | null} */
    this.audioWs = null;
    /** @type {AudioDecoder | null} */
    this.decoder = null;
    this.nextPlayhead = 0;
    this._running = false;
  }

  async start() {
    if (this._running) return;
    this._running = true;

    // Resume the AudioContext on a user gesture (caller must await
    // `.start()` from a click handler — browsers silently mute
    // contexts created outside a gesture).
    this.ctx = new AudioContext({ sampleRate: this.format.sample_rate });
    this.nextPlayhead = this.ctx.currentTime + 0.15; // 150 ms warm-up cushion

    if (this.codec === "opus") {
      if (!("AudioDecoder" in window)) {
        throw new Error(
          "WebCodecs AudioDecoder not available — the browser can't decode opus here",
        );
      }
      this.decoder = new AudioDecoder({
        output: (data) => this._playDecoded(data),
        error: (e) => console.error("[audio-listener] decoder error:", e),
      });
      this.decoder.configure({
        codec: "opus",
        sampleRate: this.format.sample_rate,
        numberOfChannels: this.format.channels,
      });
    }

    // Ask the sidecar to open the stream. Sidecar spins up the encoder
    // + test-tone source and replies with `AudioEgressStarted`.
    const source = this.sourceKind === "track"
      ? { kind: "track", id: this.sourceId }
      : { kind: this.sourceKind };
    this.ws.send({
      type: "audio_stream_open",
      stream_id: this.streamId,
      source,
      format: this.format,
      transport: { kind: "web_socket" },
    });

    // Open the audio-binary socket. Same host as the control WS.
    this.audioWs = new WebSocket(`${this.baseUrl}/ws/audio/${this.streamId}`);
    this.audioWs.binaryType = "arraybuffer";
    this.audioWs.onmessage = (ev) => this._onPacket(ev.data);
    this.audioWs.onerror = (e) => console.error("[audio-listener] audio ws error:", e);
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    try { this.ws.send({ type: "audio_stream_close", stream_id: this.streamId }); } catch {}
    try { this.audioWs?.close(); } catch {}
    try { this.decoder?.close?.(); } catch {}
    try { await this.ctx?.close?.(); } catch {}
    this.audioWs = null;
    this.decoder = null;
    this.ctx = null;
  }

  _onPacket(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength <= FRAME_HEADER_BYTES) return;
    const view = new DataView(buf);
    const streamId = view.getUint32(0, false);
    if (streamId !== this.streamId) return;
    // 8-byte capture timestamp (microseconds) follows; unused by the
    // naive playback path but wired for the jitter-buffer upgrade.
    const payload = buf.slice(FRAME_HEADER_BYTES);

    if (this.codec === "opus" && this.decoder) {
      try {
        const chunk = new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((performance.now() * 1000)),
          data: new Uint8Array(payload),
        });
        this.decoder.decode(chunk);
      } catch (e) {
        console.warn("[audio-listener] decode failed:", e);
      }
    } else if (this.codec === "raw_f32_le") {
      // The payload is f32 interleaved; package into an AudioBuffer.
      const samples = new Float32Array(payload);
      this._playFloat32(samples);
    }
  }

  _playDecoded(audioData) {
    if (!this.ctx) return;
    // AudioData → AudioBuffer → BufferSource scheduled at nextPlayhead.
    const n = audioData.numberOfFrames;
    const ch = audioData.numberOfChannels;
    const ab = this.ctx.createBuffer(ch, n, audioData.sampleRate);
    for (let c = 0; c < ch; c++) {
      const out = ab.getChannelData(c);
      audioData.copyTo(out, { planeIndex: c });
    }
    this._scheduleAndPlay(ab);
    audioData.close();
  }

  _playFloat32(interleaved) {
    if (!this.ctx) return;
    const ch = this.format.channels;
    const n = Math.floor(interleaved.length / ch);
    const ab = this.ctx.createBuffer(ch, n, this.format.sample_rate);
    for (let c = 0; c < ch; c++) {
      const out = ab.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] = interleaved[i * ch + c];
    }
    this._scheduleAndPlay(ab);
  }

  _scheduleAndPlay(ab) {
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.ctx.destination);
    const when = Math.max(this.ctx.currentTime + 0.01, this.nextPlayhead);
    src.start(when);
    this.nextPlayhead = when + ab.duration;
  }
}
