// Browser ↔ sidecar clock-offset estimator (NTP-style single bounce).
//
// The audio egress wire (V2) carries a server monotonic timestamp on
// every frame. The browser needs to convert that into its own
// `performance.now()` clock so it can:
//
//   - Stamp the moment each audio frame arrived (for the
//     audio-derived transport timeline that pins the displayed
//     playhead to the speaker-out position).
//   - Detect drift between expected and observed audio arrival, so
//     the idle-drift watchdog can reconnect when the buffer slips
//     past a threshold.
//   - Report ingress one-way latency at recording finalize so the
//     sidecar can stamp the resulting region with
//     `Region.ingress_latency_ms`.
//
// Wire shape (`Command::ClockProbe { client_ts_ms }` →
// `Event::ClockProbeReply { client_ts_ms, server_mono_ns }`):
// the client sends its `performance.now()` at send time, the server
// echoes that verbatim AND attaches its monotonic-ns clock at receive
// time. We compute:
//
//   rtt_ms     = (recv_ms - send_ms)
//   one_way_ms = rtt_ms / 2
//   offset_ms  = (server_mono_ns / 1e6) - (send_ms + one_way_ms)
//                ↑ "what to add to client clock to get server clock"
//
// Multiple probes are run on connect (default 6, ~80 ms apart) and
// the sample with the **smallest RTT** wins — minimum-RTT is the
// least-noisy estimator because the only thing that can shrink RTT
// is "less queueing", and queueing is what causes the noise.
//
// After the initial seed, a steady-state probe fires every 60 s to
// track drift between the client's QPC and the server's monotonic
// clock (real crystal skew of 10–50 ppm produces a few ms of drift
// per minute on long sessions; without resync the audio-derived
// playhead would visibly slide vs. control-plane position over time).

const INITIAL_PROBES = 6;
const INITIAL_PROBE_GAP_MS = 80;
const STEADY_STATE_PERIOD_MS = 60_000;

export class ClockSync extends EventTarget {
  /**
   * @param {object} opts
   * @param {import("../ws.js").FoyerWs} opts.ws
   */
  constructor({ ws }) {
    super();
    this.ws = ws;
    /** @type {Array<{ rttMs: number, offsetMs: number }>} */
    this._samples = [];
    // Best-known offset, in milliseconds. Add to a client
    // `performance.now()` value to get the corresponding server
    // monotonic-ms reading. Null until the first probe completes.
    this.offsetMs = null;
    // Smallest RTT we've observed in the current sample window.
    // Tracked separately from offsetMs because outside callers
    // (idle-drift watchdog) want to know the noise floor.
    this.minRttMs = null;
    // Pending probes keyed by `client_ts_ms` so out-of-order replies
    // resolve correctly. Probes are removed on reply or after
    // `PROBE_TIMEOUT_MS` to avoid leaking entries on dropped
    // packets.
    /** @type {Map<number, { sentAt: number, timer: any }>} */
    this._pending = new Map();
    this._steadyTimer = null;
    this._burstTimer = null;
    this._onEnvelope = (ev) => this._handleEnvelope(ev.detail);
    this._onStatus = (ev) => {
      if (ev.detail === "open") this._onWsOpen();
      else if (ev.detail === "closed") this._reset();
    };
  }

  start() {
    this.ws.addEventListener("envelope", this._onEnvelope);
    this.ws.addEventListener("status", this._onStatus);
    // If the WS is already open when we attach (common on hot-reload
    // / late-mount), kick off a probe burst directly.
    if (this.ws._ws && this.ws._ws.readyState === WebSocket.OPEN) {
      this._onWsOpen();
    }
  }

  stop() {
    this.ws.removeEventListener("envelope", this._onEnvelope);
    this.ws.removeEventListener("status", this._onStatus);
    this._reset();
  }

  /**
   * Convert a server monotonic-ns timestamp (as carried in audio frame
   * V2 headers) into a client `performance.now()`-style milliseconds
   * value. Returns null until the first probe completes — callers
   * typically fall back to "treat the frame as having arrived now" in
   * that window.
   */
  serverMonoNsToClientMs(serverMonoNs) {
    if (this.offsetMs == null) return null;
    return Number(serverMonoNs) / 1_000_000 - this.offsetMs;
  }

  /** Inverse of the above — useful when stamping an outbound packet
   *  with a server-side timestamp without an extra round-trip. */
  clientMsToServerMonoNs(clientMs) {
    if (this.offsetMs == null) return null;
    return (clientMs + this.offsetMs) * 1_000_000;
  }

  _reset() {
    if (this._steadyTimer) {
      clearTimeout(this._steadyTimer);
      this._steadyTimer = null;
    }
    if (this._burstTimer) {
      clearTimeout(this._burstTimer);
      this._burstTimer = null;
    }
    for (const { timer } of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this._samples = [];
    // We DON'T null out `offsetMs` on disconnect — the cached value
    // is the best estimate we have until a fresh probe round
    // completes after reconnect, and using stale offset for one or
    // two seconds is much better than going back to "no clock sync"
    // and showing the playhead racing ahead until probes complete.
  }

  _onWsOpen() {
    // Burst the initial probes back-to-back so the offset converges
    // before the user clicks Listen.
    this._samples = [];
    this._burstProbes(INITIAL_PROBES, INITIAL_PROBE_GAP_MS);
    if (this._steadyTimer) clearTimeout(this._steadyTimer);
    const tick = () => {
      this._burstProbes(2, INITIAL_PROBE_GAP_MS);
      this._steadyTimer = setTimeout(tick, STEADY_STATE_PERIOD_MS);
    };
    this._steadyTimer = setTimeout(tick, STEADY_STATE_PERIOD_MS);
  }

  _burstProbes(count, gapMs) {
    let i = 0;
    const sendOne = () => {
      this._sendOneProbe();
      i += 1;
      if (i < count) this._burstTimer = setTimeout(sendOne, gapMs);
      else this._burstTimer = null;
    };
    sendOne();
  }

  _sendOneProbe() {
    const sentAt = performance.now();
    // Tag the probe by the exact `client_ts_ms` we send so we can
    // match the reply even when several probes are in flight. The
    // server echoes it verbatim. f64 keeps full precision.
    this._pending.set(sentAt, {
      sentAt,
      timer: setTimeout(() => this._pending.delete(sentAt), 5_000),
    });
    this.ws.send({ type: "clock_probe", client_ts_ms: sentAt });
  }

  _handleEnvelope(env) {
    const body = env?.body;
    if (body?.type !== "clock_probe_reply") return;
    const sent = body.client_ts_ms;
    const pending = this._pending.get(sent);
    if (!pending) return; // not ours, or expired
    clearTimeout(pending.timer);
    this._pending.delete(sent);

    const recvAt = performance.now();
    const rttMs = recvAt - sent;
    if (!Number.isFinite(rttMs) || rttMs < 0) return;

    const oneWayMs = rttMs / 2;
    // server_mono_ns is sampled by the server roughly halfway between
    // sent and recv (more accurately: at handle time, which is closer
    // to recv minus the writer-loop scheduling slop). We approximate
    // "client time at server-handle moment" as `sent + oneWayMs`.
    const serverMonoMs = Number(body.server_mono_ns) / 1_000_000;
    const offsetMs = serverMonoMs - (sent + oneWayMs);

    this._samples.push({ rttMs, offsetMs });
    // Keep only the most-recent ~16 samples so steady-state drift
    // (over hours) eventually rotates old, stale offsets out of the
    // window. With one probe per minute that's a 16-minute trailing
    // window — long enough for the minimum-RTT estimator to be
    // robust against transient queueing, short enough that real
    // crystal drift can't accumulate undetected.
    if (this._samples.length > 16) this._samples.shift();

    // Pick the sample with the smallest RTT — minimum-RTT estimator
    // is the standard NTP trick because anything that GROWS RTT
    // (queueing, scheduling slop, GC) also corrupts the offset
    // estimate, so the round with the least delay is the most
    // trustworthy.
    let best = this._samples[0];
    for (const s of this._samples) if (s.rttMs < best.rttMs) best = s;
    this.offsetMs = best.offsetMs;
    this.minRttMs = best.rttMs;

    this.dispatchEvent(
      new CustomEvent("offset", {
        detail: {
          offsetMs: this.offsetMs,
          minRttMs: this.minRttMs,
          sampleCount: this._samples.length,
        },
      }),
    );
  }
}
