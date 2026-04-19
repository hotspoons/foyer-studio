// Foyer WebSocket client.
//
// Thin layer on top of the browser WebSocket. Handles:
//   - connection lifecycle with exponential backoff
//   - seq tracking for ?since= resync on reconnect
//   - typed dispatch: fires "event" events on an EventTarget for each Envelope
//   - outbound commands: `send(body)` wraps in an Envelope and writes
//
// The store subscribes to this and reduces events into session state.

export class FoyerWs extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.url       WebSocket URL (e.g. "ws://127.0.0.1:3838/ws")
   * @param {string} [opts.origin]  tag attached to outbound messages
   */
  constructor({ url, origin = "web" } = {}) {
    super();
    this.url = url;
    this.origin = origin;
    this._ws = null;
    this._lastSeq = 0;
    this._backoff = 500;
    this._closed = false;
    // Outbox: commands sent before the socket opens (common on first-
    // paint — components mount and fire `list_backends`/`browse_path`
    // in `connectedCallback` while the WS is still handshaking). Flushed
    // in order on "open". Capped so a permanently-offline socket doesn't
    // balloon memory.
    this._outbox = [];
    this._outboxCap = 256;
  }

  connect() {
    this._closed = false;
    this._open();
  }

  close() {
    this._closed = true;
    if (this._ws) this._ws.close();
  }

  /**
   * Send an Envelope<Command> to the server. `body` must be one of the command
   * bodies defined in foyer-schema (subscribe / request_snapshot / control_set /
   * audio_*). The envelope is built for you.
   */
  send(body) {
    const env = { schema: [0, 1], seq: 0, origin: this.origin, body };
    const text = JSON.stringify(env);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(text);
      return true;
    }
    // Socket not open yet (or has closed between a reconnect). Queue
    // and flush on next "open" — keeps component-mount code paths simple
    // (they can `send()` in `connectedCallback` without gating).
    if (this._outbox.length < this._outboxCap) {
      this._outbox.push(text);
    }
    return false;
  }

  /** Ask for a fresh snapshot. */
  requestSnapshot() {
    return this.send({ type: "request_snapshot" });
  }

  /** Apply a value change to a control by its stable ID. */
  controlSet(id, value) {
    return this.send({ type: "control_set", id, value });
  }

  _open() {
    const sep = this.url.includes("?") ? "&" : "?";
    const url =
      this.url +
      sep +
      new URLSearchParams({
        origin: this.origin,
        ...(this._lastSeq > 0 ? { since: String(this._lastSeq) } : {}),
      }).toString();

    const ws = new WebSocket(url);
    this._ws = ws;

    ws.addEventListener("open", () => {
      this._backoff = 500;
      this.dispatchEvent(new CustomEvent("status", { detail: "open" }));
      // Flush anything components queued while the WS was still
      // handshaking. Order is preserved (FIFO).
      if (this._outbox.length) {
        const pending = this._outbox;
        this._outbox = [];
        for (const text of pending) {
          try { ws.send(text); } catch {}
        }
      }
      // Subscribe explicitly in case the server didn't send us cached snapshot yet.
      if (this._lastSeq === 0) this.send({ type: "subscribe" });
    });

    ws.addEventListener("message", (ev) => {
      let env;
      try {
        env = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof env.seq === "number") this._lastSeq = Math.max(this._lastSeq, env.seq);
      this.dispatchEvent(new CustomEvent("envelope", { detail: env }));
    });

    ws.addEventListener("close", () => {
      this.dispatchEvent(new CustomEvent("status", { detail: "closed" }));
      if (this._closed) return;
      const wait = Math.min(this._backoff, 8000);
      this._backoff = Math.min(this._backoff * 2, 8000);
      setTimeout(() => this._open(), wait);
    });

    ws.addEventListener("error", () => {
      this.dispatchEvent(new CustomEvent("status", { detail: "error" }));
    });
  }
}
