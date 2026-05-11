// Audio-derived transport timeline.
//
// The control plane delivers `transport.position` updates at ~30 Hz
// from the DAW. The audio frames carrying the corresponding speaker-
// out samples arrive 200–400 ms later (encode + WS hop + jitter
// buffer + AudioWorklet quantum). If we paint the playhead from the
// control updates the user sees the position racing AHEAD of what
// they're hearing — the bug Rich asked us to fix.
//
// The fix is to make the audio stream canonical for "what's playing
// now". Each V2 audio frame carries a `transport_pos_samples`
// attached at capture. We:
//
//   1. On every received frame, push (arrivedAt, transportPos,
//      sampleRate) onto a small ring. Each entry's "playoutAt" is
//      computed at push time as `arrivedAt + playbackDelayMs` —
//      i.e. the wall-clock moment that frame's audio is expected
//      to hit the speaker.
//
//   2. `derivedPositionSamples()` walks the ring backward and picks
//      the latest frame whose `playoutAt <= now` — that's the frame
//      currently coming out of the speaker. The displayed playhead
//      is its `transportPos`. While playing we extend that by
//      `(now - playoutAt) * sampleRate` so the display animates
//      smoothly between frame transitions instead of stepping in
//      20 ms increments.
//
// Why a queue rather than projecting forward from the most-recent
// frame: projecting forward and subtracting a single playback-delay
// estimate folds wall-clock latency, network latency, and worklet
// jitter into one number that you have to get exactly right or the
// playhead leads / lags by the residual error. The queue lookup
// makes the relationship per-frame: each frame independently knows
// when its audio is supposed to play, and we just read out the one
// that should be playing right now. Result: a wrong playback-delay
// estimate shifts which frame is "current" by one or two slots
// (~20-40 ms) instead of permanently leading or lagging.
//
// On seek (a `transport.position` ControlSet from any client), we
// freeze `derivedPositionSamples()` to "the new value" until we
// see an audio frame whose `transport_pos_samples` is on the far
// side of the seek target. Otherwise the playhead jumps to the new
// location and then visibly slides backwards as the audio catches
// up — also confusing.
//
// Watchdog: if no frames have arrived for >1 s AND
// `controls["transport.playing"]` is true AND the gap between
// control-derived and audio-derived position grows past
// `WATCHDOG_THRESHOLD_MS`, we fire `drift-exceeded` so the listener
// can reconnect the audio WS (the only reliable way to resync
// after extended idle is to dump the encoder + jitter buffer state
// and start fresh).

const WATCHDOG_THRESHOLD_MS = 200;
const WATCHDOG_MIN_IDLE_MS = 1_000;
const SEEK_THAW_TOLERANCE_SAMPLES = 4_800; // ~100 ms at 48 kHz
// Ring depth — covers ~1.3 s of frames at 20 ms each. Plenty of
// history for "find the frame currently playing" even when buffer
// drain runs deep.
const FRAME_RING_MAX = 64;

export class AudioClock extends EventTarget {
  constructor() {
    super();
    /** @type {Array<{ transportPos: number, capturedAtClientMs: number, arrivedAtClientMs: number, playoutAtClientMs: number }>} */
    this._frames = [];
    /**
     * Independent ring of `{ serverMonoNs, arrivedAtClientMs }` for
     * sentinel drift lookups. Can't reuse `_frames` because that
     * ring only fills when the producer attaches a valid
     * `transportPosSamples` — when transport is stopped the frames
     * still flow but their position is `-1`, and `noteFrame` skips
     * them. Sentinel drift detection needs to work while paused
     * (that's the whole point of the auto-restart logic), so it
     * has its own ring.
     */
    this._sentinelFrames = [];
    // Estimated wall-clock latency between a frame ARRIVING in the
    // worklet and its samples hitting the speaker, in milliseconds.
    // Computed from worklet stats as `buffered/sr + outputLatency`
    // and refreshed via setPlaybackDelay() on each stats message.
    // `playoutAt` for each pushed frame uses this snapshot; a
    // changing buffer fill level naturally produces newer frames
    // with newer playout estimates while older ones are immutable.
    this._playbackDelayMs = 0;
    /** @type {number | null} */
    this._seekFreezeSamples = null;
    this._sampleRate = 48_000;
    this._lastFrameAtClientMs = 0;
    this._watchdogTimer = null;
    this._lastControlPosSamples = 0;
    this._controlPlaying = false;
  }

  /**
   * Push one received frame's metadata. Call from the audio
   * listener's `_onPacket` after parsing the V2 header. Pass `null`
   * for `capturedAtClientMs` if the clock-sync hasn't seeded yet —
   * we'll fall back to "the frame just arrived" which is good
   * enough until the offset converges (typically the first 200 ms
   * after WS open).
   *
   * `transportPosSamples == -1` means the producer didn't supply a
   * position (older shim, fallback path). We treat it as "no audio-
   * derived clock available for this frame" and don't update state
   * — the UI keeps using the control-plane position for that
   * stretch.
   */
  noteFrame({ transportPosSamples, capturedAtClientMs, serverMonoNs, sampleRate }) {
    if (transportPosSamples == null || transportPosSamples < 0) return;
    if (sampleRate && sampleRate > 0) this._sampleRate = sampleRate;
    const arrivedAt = performance.now();
    this._lastFrameAtClientMs = arrivedAt;
    const captured = (capturedAtClientMs == null || !Number.isFinite(capturedAtClientMs))
      ? arrivedAt
      : capturedAtClientMs;
    // Snapshot when this frame's audio is expected to hit the
    // speaker. Frozen on push — subsequent buffer fluctuations
    // change FUTURE frames' playout estimates, not this one.
    const playoutAt = arrivedAt + this._playbackDelayMs;
    this._frames.push({
      transportPos: Number(transportPosSamples),
      capturedAtClientMs: captured,
      arrivedAtClientMs: arrivedAt,
      playoutAtClientMs: playoutAt,
      serverMonoNs,
    });
    if (this._frames.length > FRAME_RING_MAX) this._frames.shift();
    if (this._seekFreezeSamples != null) {
      const drift = Math.abs(transportPosSamples - this._seekFreezeSamples);
      if (drift < SEEK_THAW_TOLERANCE_SAMPLES) {
        this._seekFreezeSamples = null;
      }
    }
  }

  /**
   * Record an audio frame's arrival time keyed by its `serverMonoNs`
   * correlation id. Always runs — independent of whether the frame
   * had a usable transport position. Called from the audio listener
   * for every received packet.
   */
  noteSentinelFrame(serverMonoNs) {
    if (serverMonoNs == null) return;
    this._sentinelFrames.push({
      serverMonoNs,
      arrivedAtClientMs: performance.now(),
    });
    if (this._sentinelFrames.length > FRAME_RING_MAX) {
      this._sentinelFrames.shift();
    }
  }

  /**
   * Look up the client arrival time (performance.now()) of an
   * audio frame by its `server_mono_ns` correlation id. Used by
   * the sentinel drift monitor to compute audio-vs-event path
   * skew. Checks the sentinel-only ring first; falls back to the
   * transport-derived ring for hosts that happen to be playing
   * (older callers expected this lookup path).
   */
  lookupAudioArrivalMs(serverMonoNs) {
    if (serverMonoNs == null) return null;
    // Walk backward — sentinels usually reference recent frames.
    for (let i = this._sentinelFrames.length - 1; i >= 0; i--) {
      if (this._sentinelFrames[i].serverMonoNs === serverMonoNs) {
        return this._sentinelFrames[i].arrivedAtClientMs;
      }
    }
    for (let i = this._frames.length - 1; i >= 0; i--) {
      if (this._frames[i].serverMonoNs === serverMonoNs) {
        return this._frames[i].arrivedAtClientMs;
      }
    }
    return null;
  }

  /** Worklet stats reporter calls this with the latest buffered-sample count. */
  setPlaybackDelay(samplesBuffered, outputLatencySeconds) {
    const ms = (samplesBuffered / this._sampleRate) * 1000
      + (Number(outputLatencySeconds) || 0) * 1000;
    this._playbackDelayMs = ms;
  }

  /** Called by the store when a control_set or transport_seek_request fires
   *  for `transport.position`. Freezes the displayed playhead at the new
   *  value until audio confirms it has caught up.
   */
  noteSeek(targetSamples) {
    this._seekFreezeSamples = Number(targetSamples) || 0;
    // Clear queued frames — they're from before the seek and would
    // resolve as "currently playing" until they aged out. The
    // sentinel ring is kept; its job is wall-clock drift detection,
    // not transport correlation, so a seek doesn't invalidate it.
    this._frames = [];
    this.dispatchEvent(
      new CustomEvent("seek-freeze", { detail: { targetSamples: this._seekFreezeSamples } }),
    );
  }

  /** Called by the store on every transport.position control update so
   *  the watchdog can compare control-derived vs audio-derived. */
  noteControlPosition(samples, playing) {
    this._lastControlPosSamples = Number(samples) || 0;
    this._controlPlaying = !!playing;
  }

  /**
   * Best-known displayed playhead, in samples.
   *
   * Returns `null` when no audio-derived clock is available — the
   * caller should fall back to the control-plane value in that case
   * (the typical case: audio not started yet, OR shim doesn't
   * attach transport timecode and the polled fallback hasn't
   * advanced). Returning `null` is more honest than guessing.
   */
  derivedPositionSamples() {
    if (this._seekFreezeSamples != null) return this._seekFreezeSamples;
    if (this._frames.length === 0) return null;
    const now = performance.now();
    // Walk backward — the latest frame whose playoutAt has already
    // passed is the one currently coming out of the speaker. If no
    // frame's playoutAt has passed yet (still priming), display the
    // earliest queued position so the playhead doesn't jump from
    // the control-plane value down to nothing.
    let current = null;
    for (let i = this._frames.length - 1; i >= 0; i--) {
      const f = this._frames[i];
      if (f.playoutAtClientMs <= now) {
        current = f;
        break;
      }
    }
    if (current == null) {
      return this._frames[0].transportPos;
    }
    if (!this._controlPlaying) return current.transportPos;
    // Animate forward inside the current frame's interval so the
    // display doesn't step in 20 ms quanta — we know transport is
    // running and `current.transportPos` is the position when
    // current's audio STARTED hitting the speaker. We advance by
    // wall-clock since then, capped at the next frame's expected
    // arrival to avoid overshooting on a buffer underrun.
    const elapsedMs = now - current.playoutAtClientMs;
    const advance = (elapsedMs / 1000) * this._sampleRate;
    return current.transportPos + Math.max(0, advance);
  }

  /** Snapshot for diagnostics (used by the probe + status bar). */
  snapshot() {
    return {
      derivedPositionSamples: this.derivedPositionSamples(),
      controlPositionSamples: this._lastControlPosSamples,
      playbackDelayMs: this._playbackDelayMs,
      lastFrameAtClientMs: this._lastFrameAtClientMs,
      seekFrozenAt: this._seekFreezeSamples,
      sampleRate: this._sampleRate,
      hasAudioClock: this._frames.length > 0,
      framesQueued: this._frames.length,
    };
  }

  /** Start the idle-drift watchdog. Caller passes a callback that
   *  performs the audio-stream reconnect.
   *  `onReconnect` is invoked at most once per second.
   */
  startWatchdog({ onReconnect }) {
    if (this._watchdogTimer) return;
    let lastReconnectAt = 0;
    this._watchdogTimer = setInterval(() => {
      const now = performance.now();
      if (this._frames.length === 0 || !this._controlPlaying) return;
      const idleMs = now - this._lastFrameAtClientMs;
      if (idleMs < WATCHDOG_MIN_IDLE_MS) return;
      const audio = this.derivedPositionSamples();
      if (audio == null) return;
      const driftSamples = Math.abs(this._lastControlPosSamples - audio);
      const driftMs = (driftSamples / this._sampleRate) * 1000;
      if (driftMs <= WATCHDOG_THRESHOLD_MS) return;
      if (now - lastReconnectAt < 1_000) return;
      lastReconnectAt = now;
      this.dispatchEvent(
        new CustomEvent("drift-exceeded", { detail: { driftMs, idleMs } }),
      );
      if (typeof onReconnect === "function") {
        try { onReconnect({ driftMs, idleMs }); } catch (e) {
          console.warn("[audio-clock] watchdog reconnect threw:", e);
        }
      }
    }, 250);
  }

  stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }
}
