// SPDX-License-Identifier: Apache-2.0
//
// In-app chat store + push-to-talk glue.
//
// Mirrors the server-side `chat.rs`: messages land in a bounded in-memory
// ring, admins can clear it, snapshotting writes JSONL to the foyer data
// dir. PTT capture + playback piggybacks on the existing control `/ws`
// (binary frames) so we don't burn another socket against the browser's
// per-origin connection cap.
//
// Usage:
//
//     const chat = new ChatStore({ ws, store });
//     chat.attach();
//     chat.addEventListener("change", () => repaint(chat.state));
//     chat.send("hello from alice");
//     chat.pttStart();     // enables mic capture → server fanout
//     chat.pttStop();
//
// The chat UI (web/ui-full/components/chat-panel.js) consumes this.

const PTT_MAGIC = 0x50;  // 'P'
const PTT_VERSION = 0x01;
const PTT_HEADER_LEN_IN = 2;                          // [magic, version]
const PTT_HEADER_LEN_OUT = 2 + 8 + 32;                // + ts_ms + peer_id
const PTT_SAMPLE_RATE = 48_000;                       // matches AudioContext default

export class ChatStore extends EventTarget {
  constructor({ ws, store } = {}) {
    super();
    this.ws = ws;
    this.store = store;
    /** @type {{id:number, from_peer_id:string, from_label:string, body:string, ts_ms:number}[]} */
    this.messages = [];
    /** @type {null | { peer_id:string, label:string, since_ms:number }} */
    this.speaker = null;
    /** True while this browser is locally holding the PTT key. */
    this.localPressed = false;
    /** True while mic capture is wired up. */
    this.micActive = false;
    this._historyRequested = false;
    // PTT capture bits.
    this._audioCtx = null;
    this._micStream = null;
    this._micNode = null;
    this._workletNode = null;
    // Playback: incoming frames get queued per-speaker so we can apply a
    // tiny jitter buffer (just FIFO for now) before scheduling.
    this._playCtx = null;
    this._playheadAt = 0;
    this._onEnvelope = this._onEnvelope.bind(this);
    this._onBinary = this._onBinary.bind(this);
  }

  /**
   * Subscribe to ws events. Call once after the ws is created — safe to
   * call before the ws connects. Returns an unsubscribe fn for tests.
   */
  attach() {
    if (!this.ws) return () => {};
    this.ws.addEventListener("envelope", this._onEnvelope);
    this.ws.addEventListener("binary", this._onBinary);
    return () => {
      this.ws.removeEventListener("envelope", this._onEnvelope);
      this.ws.removeEventListener("binary", this._onBinary);
    };
  }

  _emit() {
    this.dispatchEvent(new CustomEvent("change"));
  }

  // ── commands ───────────────────────────────────────────────────────

  /** Post a chat message (markdown-ok body). */
  send(body) {
    const trimmed = (body || "").trim();
    if (!trimmed) return;
    this.ws?.send({ type: "chat_send", body: trimmed });
  }

  /** Admin-only (server enforces). Clears everyone's in-memory history. */
  clear() {
    this.ws?.send({ type: "chat_clear" });
  }

  /** Ask the server for the latest ring. Sent on panel first-open. */
  requestHistory() {
    this._historyRequested = true;
    this.ws?.send({ type: "chat_history_request" });
  }

  /**
   * Admin-only. Persists the current in-memory ring to disk under
   * `$XDG_DATA_HOME/foyer/chat/<filename>.jsonl`. Pass `null` to let
   * the server name the file (`chat-<unix-ts>.jsonl`).
   */
  snapshot(filename) {
    const body = { type: "chat_snapshot" };
    if (filename) body.filename = filename;
    this.ws?.send(body);
  }

  /** Tell the server we're about to start pushing PTT audio. */
  async pttStart() {
    if (this.localPressed) return;
    this.localPressed = true;
    this._emit();
    this.ws?.send({ type: "ptt_start" });
    try {
      await this._startMic();
    } catch (err) {
      console.warn("[chat] mic start failed:", err);
      this.localPressed = false;
      this.ws?.send({ type: "ptt_stop" });
      this._emit();
    }
  }

  /** Release the PTT key. */
  pttStop() {
    if (!this.localPressed) return;
    this.localPressed = false;
    this._stopMic();
    this.ws?.send({ type: "ptt_stop" });
    this._emit();
  }

  // ── event wiring ──────────────────────────────────────────────────

  _onEnvelope(ev) {
    const env = ev.detail;
    const body = env?.body;
    if (!body) return;
    switch (body.type) {
      case "chat_message": {
        const rec = body.record;
        if (!rec) return;
        // Dedupe by id — the server assigns monotonic ids even across
        // history replays.
        if (this.messages.length && this.messages[this.messages.length - 1].id === rec.id) {
          return;
        }
        this.messages.push(rec);
        // Keep client-side ring bounded too so long sessions don't grow
        // the array without end.
        if (this.messages.length > 1000) this.messages.splice(0, this.messages.length - 1000);
        this._emit();
        break;
      }
      case "chat_history": {
        const incoming = body.records || [];
        // Replace whole-sale — history replies are authoritative.
        this.messages = incoming.slice();
        this._emit();
        break;
      }
      case "chat_cleared": {
        this.messages = [];
        this._lastClearedBy = { peerId: body.cleared_by_peer_id, label: body.cleared_by_label };
        this._emit();
        break;
      }
      case "chat_snapshot_saved": {
        this._lastSnapshot = { path: body.path, count: body.message_count, at: Date.now() };
        this._emit();
        break;
      }
      case "ptt_state": {
        this.speaker = body.speaker || null;
        this._emit();
        break;
      }
      default:
        break;
    }
  }

  _onBinary(ev) {
    const buf = ev.detail;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < PTT_HEADER_LEN_OUT + 4) return;
    const view = new DataView(buf);
    if (view.getUint8(0) !== PTT_MAGIC || view.getUint8(1) !== PTT_VERSION) return;
    // ts_ms at [2..10], peer_id at [10..42], samples after.
    const samplesBuf = buf.slice(PTT_HEADER_LEN_OUT);
    const samples = new Float32Array(samplesBuf);
    this._playSamples(samples);
  }

  // ── mic capture ───────────────────────────────────────────────────

  async _startMic() {
    if (this.micActive) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PTT_SAMPLE_RATE,
    });
    // The ingress worklet is already in-repo for the DAW-side mic
    // feature; re-use it so we don't ship two copies.
    try {
      await ctx.audioWorklet.addModule("/core/audio/ingress-worklet.js");
    } catch (err) {
      // Some old browsers + insecure contexts kill Worklet; fall through
      // to ScriptProcessor if the module refuses to load.
      console.warn("[chat] AudioWorklet unavailable:", err);
    }
    const src = ctx.createMediaStreamSource(stream);
    let node;
    try {
      node = new AudioWorkletNode(ctx, "foyer-ingress", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
    } catch {
      // Fallback: ScriptProcessor. Deprecated but ubiquitous — good
      // enough for voice while we're still in the fallback arm.
      const spn = ctx.createScriptProcessor(1024, 1, 1);
      spn.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        this._shipPttFrame(ch);
      };
      src.connect(spn);
      spn.connect(ctx.destination);
      this._audioCtx = ctx;
      this._micStream = stream;
      this._workletNode = spn;
      this.micActive = true;
      return;
    }
    node.port.onmessage = (ev) => {
      if (ev.data instanceof Float32Array) {
        this._shipPttFrame(ev.data);
      }
    };
    src.connect(node);
    this._audioCtx = ctx;
    this._micStream = stream;
    this._micNode = src;
    this._workletNode = node;
    this.micActive = true;
  }

  _stopMic() {
    try { this._workletNode?.disconnect?.(); } catch {}
    try { this._micNode?.disconnect?.(); } catch {}
    try {
      this._micStream?.getTracks?.().forEach((t) => t.stop());
    } catch {}
    try { this._audioCtx?.close?.(); } catch {}
    this._workletNode = null;
    this._micNode = null;
    this._micStream = null;
    this._audioCtx = null;
    this.micActive = false;
  }

  _shipPttFrame(samples) {
    if (!samples || !samples.length) return;
    const buf = new ArrayBuffer(PTT_HEADER_LEN_IN + samples.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, PTT_MAGIC);
    view.setUint8(1, PTT_VERSION);
    const dst = new Float32Array(buf, PTT_HEADER_LEN_IN);
    dst.set(samples);
    this.ws?.sendBinary?.(buf);
  }

  // ── playback ──────────────────────────────────────────────────────

  _ensurePlayCtx() {
    if (this._playCtx) return this._playCtx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PTT_SAMPLE_RATE,
    });
    // Chrome blocks AudioContext.start until a user gesture. Since PTT
    // reception only triggers after someone else speaks (and the
    // listener has already interacted with the page to open chat /
    // click something) this usually resumes immediately. If not,
    // audio silently queues until the user interacts — acceptable.
    ctx.resume?.().catch(() => {});
    this._playCtx = ctx;
    this._playheadAt = ctx.currentTime;
    return ctx;
  }

  _playSamples(samples) {
    if (!samples.length) return;
    const ctx = this._ensurePlayCtx();
    const buffer = ctx.createBuffer(1, samples.length, PTT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(this._playheadAt, ctx.currentTime + 0.02);
    src.start(startAt);
    this._playheadAt = startAt + buffer.duration;
  }
}
