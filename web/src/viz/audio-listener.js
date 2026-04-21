// Browser-side consumer of the sidecar's egress audio path.
//
// Pipeline per the M6a spec (see crates/foyer-server/src/audio.rs):
//
//   /ws/audio/:stream_id  ──►  per-packet parser  ──►  AudioDecoder
//                                                        │
//                                                        ▼  deinterleave
//                                                postMessage(transfer)
//                                                        │
//                                                        ▼
//                                          AudioWorkletProcessor ring
//                                          (see ./audio-worklet.js)
//                                                        │
//                                                        ▼
//                                             AudioContext destination
//
// The worklet owns the jitter buffer. Main thread's only job is to
// decode and transfer; no scheduling math lives here anymore. If
// the browser lacks WebCodecs or we're asked for a `raw_f32_le`
// stream, packets are deinterleaved inline and fed to the same
// worklet via `_sendToWorklet`.

const FRAME_HEADER_BYTES = 12;

// Browser-side audio ingress preferences. Stored in localStorage so
// the choice survives reloads. Rich's M6 note: "disable Opus
// compression and use raw waveforms, set client sampling freq if
// possible" — this is how the user picks that.
const AUDIO_PREFS_KEY = "foyer.audio.prefs.v1";
const DEFAULT_AUDIO_PREFS = Object.freeze({
  codec: "opus",          // "opus" | "raw_f32_le"
  sampleRate: 48_000,      // 44100 / 48000 / 96000 / 192000
  channels: 2,
});

export function readAudioPrefs() {
  try {
    return { ...DEFAULT_AUDIO_PREFS, ...JSON.parse(localStorage.getItem(AUDIO_PREFS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_AUDIO_PREFS };
  }
}
export function writeAudioPrefs(next) {
  const merged = { ...readAudioPrefs(), ...next };
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(merged)); } catch {}
  window.dispatchEvent(new CustomEvent("foyer:audio-prefs-changed", { detail: merged }));
  return merged;
}

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
    // Codec & sample rate are user-selectable via the browser audio
    // config pref (viz-settings.js). Defaults are Opus @ 48 kHz for
    // bandwidth-friendly streaming; "raw_f32_le" skips the codec and
    // ships PCM directly (higher bandwidth, lossless — needed for
    // 96/192 kHz since Opus is capped at 48 kHz).
    const userPrefs = readAudioPrefs();
    this.codec = opts.codec || userPrefs.codec;
    const sampleRate = opts.sampleRate || userPrefs.sampleRate;
    const channels = opts.channels || userPrefs.channels;
    // JS's `| 0` coerces to i32 and can produce negative numbers —
    // the schema's `stream_id` is a u32 and the server rejects
    // negatives with a JSON parse error. `>>> 0` forces the
    // unsigned interpretation. Also keep it well under 2**32 so the
    // u32 wire encoding is exact.
    this.streamId = (Math.random() * 0xffffffff) >>> 0;
    // Opus only accepts 8 / 12 / 16 / 24 / 48 kHz — if the user
    // requested a higher rate with opus selected, fall back to raw.
    const effectiveCodec = (this.codec === "opus" && sampleRate > 48_000)
      ? "raw_f32_le" : this.codec;
    this.codec = effectiveCodec;
    // Frame size scales with the sample rate so 20 ms frames stay
    // 20 ms at whatever rate we ship — the browser-side worklet
    // budgets its jitter window in samples, not seconds.
    const frameSize = Math.round(sampleRate * 0.020);
    this.format = {
      sample_rate: sampleRate,
      channels,
      format: "f32_le",
      frame_size: frameSize,
      codec: effectiveCodec,
    };

    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {WebSocket | null} */
    this.audioWs = null;
    /** @type {AudioDecoder | null} */
    this.decoder = null;
    /** @type {AudioWorkletNode | null} */
    this.workletNode = null;
    this._running = false;

    // ─── Jitter buffer lives in the AudioWorklet ─────────────────
    //
    // Previous design: main-thread `setInterval(5 ms)` dequeued
    // decoded AudioBuffers into `BufferSource.start(nextPlayhead)`
    // and chased a 200 ms playhead-lead target. That scheduler was
    // driven by `setTimeout`-class timers, which get coarsened by
    // GC, layout, and (especially) background-tab throttling. Any
    // 5–20 ms timer jitter looked like scheduler drift and — once
    // the underrun threshold was low enough to not fire on harmless
    // dips — still produced audible pops and pitch-shift artifacts
    // on shaky connections.
    //
    // Current design: decoded PCM is `postMessage`d (with transfer)
    // to an `AudioWorkletProcessor` that owns a 2-second ring
    // buffer and writes 128-sample quanta straight into its output
    // on each `process()` call. `process()` is driven by the audio
    // thread's own render clock — immune to main-thread stalls —
    // so scheduler drift as a failure mode is gone. Priming,
    // overrun/underrun bookkeeping, and stats all live in the
    // worklet (see `audio-worklet.js`).
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

    // Load + instantiate the audio-thread ring buffer. `new URL(...,
    // import.meta.url)` resolves the worklet file relative to THIS
    // module's served URL — the worklet is sibling in /src/viz/.
    // Must complete before any `postMessage` is issued, else the
    // transfer lands on a port with no onmessage handler yet.
    //
    // `AudioContext.audioWorklet` is `undefined` outside a secure
    // context — browsers gate it on HTTPS + localhost. Hitting the
    // sidecar over a plain LAN IP (e.g. `http://192.168.1.5:3838/`)
    // trips this on phones and on any iOS browser. Detect early and
    // surface a useful message instead of the raw
    // "cannot read properties of undefined" crash the bare
    // `.addModule` call produced.
    if (!this.ctx.audioWorklet || typeof this.ctx.audioWorklet.addModule !== "function") {
      const https = location.protocol === "https:";
      const host = location.hostname;
      const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const hint = (!https && !isLocalhost)
        ? `Browsers disable AudioWorklet on plain HTTP LAN origins. Reach the sidecar over HTTPS (a reverse proxy like \`caddy reverse-proxy --from :8443 --to :3838\` gives you an auto-cert) or over localhost via an SSH/Tailscale tunnel.`
        : `This browser doesn't support AudioWorklet — try Chrome / Firefox / Safari 14.1+.`;
      throw new Error(
        `AudioWorklet not available on ${location.origin}. ${hint}`,
      );
    }
    const workletUrl = new URL("./audio-worklet.js", import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.workletNode = new AudioWorkletNode(this.ctx, "foyer-pcm", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.format.channels],
    });
    this.workletNode.port.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.kind === "stats") {
        // One-per-second line — cheap enough to always log.
        console.info(
          `[audio-listener] worklet stats — buffered=${m.buffered} ` +
          `written=${m.written} read=${m.read} ` +
          `underruns=${m.underruns} overruns=${m.overruns}`,
        );
      }
    };
    this.workletNode.connect(this.ctx.destination);

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
    // Teardown order matters. Previously the symptom of a sloppy
    // shutdown was "each Listen restart hears more pops than the
    // last" — stale decoders kept firing output callbacks into
    // an AudioContext being closed. Same rules apply with the
    // worklet in the mix:
    //   1. Tell the sidecar to close the stream (sidecar drops
    //      the tap + broadcast). Fire-and-forget.
    //   2. Close the binary WS so no more packets arrive.
    //   3. Detach decoder callbacks BEFORE closing the decoder —
    //      otherwise queued frames can call _playDecoded after we
    //      null out `workletNode`.
    //   4. Disconnect + null the worklet node.
    //   5. Close the AudioContext last.
    try { this.ws.send({ type: "audio_stream_close", stream_id: this.streamId }); } catch {}
    if (this.audioWs) {
      try { this.audioWs.onmessage = null; } catch {}
      try { this.audioWs.onerror   = null; } catch {}
      try { this.audioWs.onclose   = null; } catch {}
      try { this.audioWs.close(); } catch {}
    }
    if (this.decoder) {
      try { this.decoder.output = () => {}; } catch {}
      try { this.decoder.error  = () => {}; } catch {}
      try { this.decoder.reset?.(); } catch {}
      try { this.decoder.close?.(); } catch {}
    }
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; } catch {}
      try { this.workletNode.port.close?.(); } catch {}
      try { this.workletNode.disconnect(); } catch {}
    }
    if (this.ctx && this.ctx.state !== "closed") {
      try { await this.ctx.close(); } catch {}
    }
    this.audioWs = null;
    this.decoder = null;
    this.workletNode = null;
    this.ctx = null;
    // Reset per-session diagnostic counters so a subsequent Listen
    // starts fresh — no carryover Opus timestamps, no stale packet
    // counter misleading the dump triggers.
    this._opusTs = 0;
    this._pktCount = 0;
    this._decodedLogged = false;
    this._packetsSeen = 0;
    this._ilScratch = null;
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
        // Opus uses overlap-add windowing between frames (CELT
        // layer). The decoder needs CUMULATIVE, monotonic
        // timestamps that increase by exactly one frame per chunk
        // — if we feed `performance.now()` instead, each chunk
        // looks like a fresh start and we get audible pops at
        // every frame boundary (Rich: "pops only happen after a
        // second or two", i.e. after the decoder's initial
        // warmup where pops are hidden by onset transients).
        //
        // 20 ms frame × 1_000_000 µs/s ÷ 48000 Hz → the exact
        // increment per Opus chunk. Using `frame_size` so the
        // math stays right if sample_rate ever changes.
        if (this._opusTs === undefined) this._opusTs = 0;
        const frameUs = Math.round(
          (this.format.frame_size / this.format.sample_rate) * 1_000_000,
        );
        const chunk = new EncodedAudioChunk({
          type: "key",
          timestamp: this._opusTs,
          data: new Uint8Array(payload),
        });
        this._opusTs += frameUs;
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
    if (!this._decodedLogged) {
      this._decodedLogged = true;
      // Also ask the decoder for its allocation sizes per plane.
      // For an "f32" interleaved format we expect
      //   allocationSize({planeIndex: 0}) === numberOfFrames * numberOfChannels * 4
      // i.e. 960 × 2 × 4 = 7680 bytes. If Chrome reports half that
      // (3840) the format metadata lies and we're actually getting
      // 480-frame buffers mislabeled as 960 — that's what would
      // play an octave down.
      let allocBytes = null;
      try {
        allocBytes = audioData.allocationSize({
          planeIndex: 0,
          format: audioData.format,
        });
      } catch {}
      console.info(
        `[audio-listener] first decoded AudioData — ` +
        `sampleRate=${audioData.sampleRate} ` +
        `numberOfFrames=${audioData.numberOfFrames} ` +
        `numberOfChannels=${audioData.numberOfChannels} ` +
        `format=${audioData.format} ` +
        `duration_us=${audioData.duration} ` +
        `allocationSize(plane0)=${allocBytes} ` +
        `(ctx sr=${this.ctx.sampleRate}, format.frame_size=${this.format.frame_size})`,
      );
    }
    const n = audioData.numberOfFrames;
    const ch = audioData.numberOfChannels;

    // Two transferable per-channel Float32Arrays — we pay one copy
    // (planar deinterleave), then hand ownership to the worklet.
    // Reallocating each packet avoids holding references back on
    // the main thread that the worklet has already consumed.
    const ch0 = new Float32Array(n);
    const ch1 = ch > 1 ? new Float32Array(n) : null;

    const fmt = audioData.format || "";
    if (fmt.endsWith("-planar")) {
      try {
        audioData.copyTo(ch0, { planeIndex: 0 });
        if (ch1) audioData.copyTo(ch1, { planeIndex: 1 });
      } catch (e) {
        console.warn(`[audio-listener] planar copyTo failed n=${n} ch=${ch}:`, e);
        audioData.close();
        return;
      }
    } else {
      // Interleaved source. Copy into scratch, then deinterleave
      // into ch0/ch1.
      if (!this._ilScratch || this._ilScratch.length < n * ch) {
        this._ilScratch = new Float32Array(n * ch);
      }
      try {
        audioData.copyTo(this._ilScratch.subarray(0, n * ch), { planeIndex: 0 });
      } catch (e) {
        console.warn(`[audio-listener] interleaved copyTo failed n=${n} ch=${ch}:`, e);
        audioData.close();
        return;
      }
      const src = this._ilScratch;
      for (let i = 0; i < n; i++) {
        ch0[i] = src[i * ch];
        if (ch1) ch1[i] = src[i * ch + 1];
      }
      // Diagnostics (pkt #3 sparse + raw scratch; every 50 peak +
      // zero-crossing) — retain until the half-freq/half-amp bug
      // is nailed down; cheap to keep running once fixed.
      this._packetsSeen = (this._packetsSeen || 0) + 1;
      if (this._packetsSeen === 3) {
        const dump = [0, 10, 27, 54, 81, 100, 200, 500, 800, 959]
          .map((i) => `[${i}]=${ch0[i]?.toFixed?.(4) ?? "?"}`)
          .join(" ");
        console.info(`[audio-listener] ch0 sparse dump (pkt #3): ${dump}`);
        const head = Array.from(src.slice(0, 12)).map((x) => x.toFixed(4)).join(",");
        const mid  = Array.from(src.slice(956, 968)).map((x) => x.toFixed(4)).join(",");
        const tail = Array.from(src.slice(1908, 1920)).map((x) => x.toFixed(4)).join(",");
        console.info(
          `[audio-listener] raw scratch pkt #3 layout\n` +
          `  head[0..11]    = ${head}\n` +
          `  mid [956..967] = ${mid}\n` +
          `  tail[1908..19] = ${tail}\n` +
          `  scratch.length = ${src.length}`,
        );
      }
      if (this._packetsSeen % 50 === 0) {
        let peak = 0;
        let zc = 0;
        let prev = ch0[0];
        for (let i = 1; i < ch0.length; i++) {
          const v = ch0[i];
          const a = Math.abs(v);
          if (a > peak) peak = a;
          if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) zc++;
          prev = v;
        }
        console.info(
          `[audio-listener] pkt #${this._packetsSeen} peak=${peak.toFixed(4)} ` +
          `zeroXings=${zc} (expect ≈18 for 440 Hz, ≈9 if half-speed)`,
        );
      }
    }
    this._sendToWorklet(ch0, ch1);
    audioData.close();
  }

  _playFloat32(interleaved) {
    if (!this.workletNode) return;
    const ch = this.format.channels;
    const n = Math.floor(interleaved.length / ch);
    const ch0 = new Float32Array(n);
    const ch1 = ch > 1 ? new Float32Array(n) : null;
    for (let i = 0; i < n; i++) {
      ch0[i] = interleaved[i * ch];
      if (ch1) ch1[i] = interleaved[i * ch + 1];
    }
    this._sendToWorklet(ch0, ch1);
  }

  /** Transfer two planar channel buffers to the worklet's ring.
   *  Uses the transferable-buffer variant of postMessage so the
   *  underlying ArrayBuffers move without copy; after this call
   *  ch0 / ch1 are detached on the main thread. */
  _sendToWorklet(ch0, ch1) {
    if (!this.workletNode) return;
    const transfer = [ch0.buffer];
    const payload = { ch0 };
    if (ch1) {
      payload.ch1 = ch1;
      transfer.push(ch1.buffer);
    } else {
      // Worklet expects stereo; duplicate mono into both channels.
      const copy = new Float32Array(ch0);
      payload.ch1 = copy;
      transfer.push(copy.buffer);
    }
    this.workletNode.port.postMessage(payload, transfer);
  }
}
