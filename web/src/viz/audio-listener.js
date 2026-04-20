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
    // JS's `| 0` coerces to i32 and can produce negative numbers —
    // the schema's `stream_id` is a u32 and the server rejects
    // negatives with a JSON parse error. `>>> 0` forces the
    // unsigned interpretation. Also keep it well under 2**32 so the
    // u32 wire encoding is exact.
    this.streamId = (Math.random() * 0xffffffff) >>> 0;
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

    // The AudioContext defaults to `suspended` on most browsers —
    // Chrome's autoplay policy mutes any context created outside a
    // user gesture, and Safari outright refuses to play. We MUST
    // call `resume()` from within the user-gesture call-stack that
    // invoked `start()`; the "Listen" click handler is what we
    // rely on. Calling resume() is cheap when it's already running.
    this.ctx = new AudioContext({ sampleRate: this.format.sample_rate });
    try { await this.ctx.resume(); } catch (e) {
      console.warn("[audio-listener] AudioContext.resume failed:", e);
    }
    console.info(
      `[audio-listener] ctx state=${this.ctx.state} sr=${this.ctx.sampleRate} ` +
      `baseLatency=${this.ctx.baseLatency?.toFixed?.(3)} ` +
      `outputLatency=${this.ctx.outputLatency?.toFixed?.(3)}`,
    );
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

    // The sidecar's `open_egress` → shim round-trip takes a moment
    // before the stream is registered in the hub. The server's
    // `/ws/audio/:stream_id` handler now polls for up to ~6 s;
    // matching that here is belt-and-braces.
    this.audioWs = new WebSocket(`${this.baseUrl}/ws/audio/${this.streamId}`);
    this.audioWs.binaryType = "arraybuffer";
    this.audioWs.onopen   = () => console.info(`[audio-listener] audio ws open stream_id=${this.streamId}`);
    this.audioWs.onmessage = (ev) => this._onPacket(ev.data);
    this.audioWs.onclose  = (ev) => console.info(`[audio-listener] audio ws closed code=${ev.code} reason='${ev.reason}'`);
    this.audioWs.onerror  = (e) => console.error("[audio-listener] audio ws error:", e);
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
    // Diagnostic: log the first few packets + every 500th after that.
    // Helps distinguish "audio never arrives" from "audio arrives but
    // isn't audible" (a common AudioContext-suspended footgun).
    this._pktCount = (this._pktCount || 0) + 1;
    if (this._pktCount <= 5 || this._pktCount % 500 === 0) {
      console.info(
        `[audio-listener] pkt #${this._pktCount} bytes=${buf.byteLength} ctx=${this.ctx?.state}`,
      );
    }
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
    //
    // WebCodecs `AudioData.copyTo()` validates destination size
    // against the **source** sample format unless we ask it to
    // convert. Opus decodes to `f32-planar` per spec, but Chrome
    // sometimes hands back `s16` or `f32` (interleaved) and silently
    // fails the copy with "destination is not large enough" if the
    // destination's implicit format doesn't match. Force
    // `f32-planar` on every copy — the browser handles the
    // conversion, and our `Float32Array` channel buffer is the
    // exact right size for that format.
    const n = audioData.numberOfFrames;
    const ch = audioData.numberOfChannels;
    const ab = this.ctx.createBuffer(ch, n, audioData.sampleRate);
    for (let c = 0; c < ch; c++) {
      const out = ab.getChannelData(c);
      try {
        audioData.copyTo(out, { planeIndex: c, format: "f32-planar" });
      } catch (e) {
        // Last-resort fallback: some browsers reject the format hint
        // for already-f32 AudioData. Try without the hint.
        try {
          audioData.copyTo(out, { planeIndex: c });
        } catch (e2) {
          console.warn(
            `[audio-listener] copyTo failed for ch=${c} n=${n} ` +
            `(numberOfChannels=${ch} sampleRate=${audioData.sampleRate} ` +
            `format=${audioData.format}):`, e2,
          );
          return;
        }
      }
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
