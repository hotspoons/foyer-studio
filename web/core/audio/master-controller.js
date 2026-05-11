// Master-bus listen controller — singleton owner of the master-tap
// AudioListener.
//
// Why this exists: the listener used to live inside the
// `<foyer-mixer>` component, so its lifecycle was bound to whether
// the mixer view was mounted. Tunnel guests who hadn't opened the
// mixer yet got silence — exactly the "audio doesn't start until
// the mixer opens once" complaint in TODO 38. Hoisting the listener
// here decouples audio from the UI surface: the controller mounts
// at the app shell, applies the saved/forced preference on
// `client_greeting`, and stays alive across mixer mount/unmount.
//
// The mixer's toggle button now calls `start()` / `stop()` on this
// singleton; it doesn't own any AudioListener of its own.
//
// Forced-on rule: tunnel guests have no hardware audio path to the
// host machine, so we always start the listener for them. The
// non-tunnel branch honors the user's saved preference
// (`foyer.listen.master`), and when unset defaults to **on** so a
// normal browser session against the sidecar hears the mix without
// an extra click. (Older builds defaulted local connections to off
// on the assumption the operator was also at the DAW with monitors;
// standalone Foyer use is common enough that default-off caused more
// confusion than help.)

import { AudioListener, readAudioPrefs } from "./audio-listener.js";

const PREF_KEY = "foyer.listen.master";

class AudioController extends EventTarget {
  constructor() {
    super();
    this._ws = null;
    this._store = null;
    this._listener = null;
    this._on = false;
    this._starting = false;
    this._envelopeHandler = (ev) => this._onEnvelope(ev?.detail);
    /** @type {Array<{serverMonoNs: number, audioArrivedMs: number, sentinelArrivedMs: number, driftMs: number}>} */
    this._sentinelHistory = [];
    this._lastReconnectAt = 0;
  }

  /// Wire up the controller. Called from app.js once the WS + store
  /// globals exist. Idempotent — re-attach replaces handlers cleanly.
  attach(ws, store) {
    this.detach();
    this._ws = ws || null;
    this._store = store || null;
    if (!this._ws) return;
    this._ws.addEventListener("envelope", this._envelopeHandler);
    // The greeting may have already arrived before we attached
    // (race between core bootstrap and UI mount). Apply pref right
    // away using whatever info the store has now.
    this._applyPref(null);
  }

  detach() {
    if (this._ws) this._ws.removeEventListener("envelope", this._envelopeHandler);
    this._ws = null;
    this._store = null;
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "client_greeting") {
      this._applyPref(!!body.is_local);
    } else if (body.type === "audio_sentinel") {
      this._handleAudioSentinel(body);
    } else if (
      body.type === "backend_swapped" ||
      body.type === "session_opened" ||
      body.type === "session_focus_changed"
    ) {
      // Backend changed under us — the old listener's stream is
      // dead. `session_focus_changed` covers the "switch between two
      // already-open sessions" case where no backend swap or
      // session_opened fires but the audio stream the listener was
      // reading from is no longer the focused session's stream.
      if (this._on) {
        // The listener was running, which means the user just
        // interacted with the page (the click that caused this event
        // is well within Chrome's transient-activation window). Tear
        // down + restart directly, NOT via _applyPref/_scheduleAutoStart.
        //
        // Why direct: the gesture-defer path installs a window-level
        // capture-phase pointerdown handler that fires on the user's
        // very next click. If that click is the Listen button itself,
        // the handler silently start()s the listener; the click then
        // bubbles to the button's toggle() which sees _on=true and
        // stops it. Net effect: Listen appears to do nothing or
        // briefly flickers on. Restarting here keeps _on continuously
        // true, so the next Listen click is an honest stop.
        this._teardown();
        this._on = false;
        this._emitChange();
        this.start({ silent: true }).catch((e) => {
          // Autoplay refused (no transient activation, or extension
          // interference). Fall back to the gesture path so the next
          // user click revives audio.
          console.warn("[audio-controller] direct restart after focus change failed:", e);
          this._applyPref(null);
        });
      } else {
        // Listener wasn't running — re-evaluate the pref against the
        // new session. If the user's saved pref is "on" but they
        // hadn't yet clicked anywhere, _applyPref will install the
        // gesture-defer handler.
        this._applyPref(null);
      }
    }
  }

  /**
   * Correlates an `Event::AudioSentinel` with the matching audio
   * frame in our ring and computes audio-vs-event path skew.
   * If drift exceeds the threshold while transport is paused,
   * we restart the audio stream (the sentinel is stale and
   * audio packets are being dropped or buffered past safe limits).
   */
  _handleAudioSentinel(body) {
    const { server_mono_ns: serverMonoNs } = body;
    if (!this._listener?.audioClock || !serverMonoNs) return;
    const audioArrivedMs = this._listener.audioClock.lookupAudioArrivalMs(
      Number(serverMonoNs),
    );
    const sentinelArrivedMs = performance.now();
    if (audioArrivedMs == null) return;
    const driftMs = sentinelArrivedMs - audioArrivedMs;
    const entry = {
      serverMonoNs: Number(serverMonoNs),
      audioArrivedMs,
      sentinelArrivedMs,
      driftMs,
    };
    this._sentinelHistory.push(entry);
    if (this._sentinelHistory.length > 20) this._sentinelHistory.shift();
    this.dispatchEvent(
      new CustomEvent("sentinel", { detail: entry }),
    );
    // Restart audio stream if:
    //   1. drift exceeds the user-configured threshold (Edit →
    //      Preferences → Audio drift). Setting `0` disables.
    //   2. transport is paused (we don't disrupt playback)
    //   3. we haven't restarted recently (< 5 s throttle)
    const threshold = Number(readAudioPrefs().sentinelDriftMs) || 0;
    const playing = this._store?.state?.controls?.get("transport.playing");
    const now = performance.now();
    if (threshold > 0 && driftMs > threshold && !playing && now - this._lastReconnectAt > 5000) {
      console.warn(
        `[audio-controller] sentinel drift ${driftMs.toFixed(1)} ms > ${threshold} ms, ` +
          `transport paused — restarting audio stream`,
      );
      this._lastReconnectAt = now;
      this.stop({ silent: true })
        .then(() => this.start({ silent: true }))
        .catch((e) =>
          console.warn("[audio-controller] sentinel-triggered restart failed:", e),
        );
    }
  }

  /// Decide based on tunnel status + saved preference whether to
  /// start the listener now. `isLocal` may be null when called
  /// before the greeting; we then bail unless a saved pref exists.
  ///
  /// Deferral: we DON'T call start() directly. Chrome's autoplay
  /// policy refuses to actually un-suspend an AudioContext created
  /// outside a user-gesture call stack (page load doesn't count),
  /// and even though the rest of the listener pipeline can spin up
  /// against a suspended context, you get the console warning and
  /// the UI shows "playing" while no audio comes out — confusing.
  /// Instead, install a one-shot gesture hook; the very first click
  /// or keypress on the page triggers the real `start()`, where the
  /// AudioContext is born inside the gesture stack and never has to
  /// be un-suspended. No-op if no auto-on pref applies.
  _applyPref(isLocal) {
    if (this._on || this._starting || this._gestureHandler) return;
    const rbac = this._store?.state?.rbac;
    const isTunnel = !!rbac?.isTunnel;
    let wantOn;
    if (isTunnel) {
      wantOn = true;
    } else {
      let saved = null;
      try { saved = localStorage.getItem(PREF_KEY); } catch {}
      if (saved === "1") wantOn = true;
      else if (saved === "0") wantOn = false;
      else if (isLocal === null) return;
      else wantOn = true;
    }
    if (wantOn) this._scheduleAutoStart();
  }

  /// Wait for the next user gesture, then call start({ silent: true }).
  /// Idempotent; only one set of listeners is registered at a time.
  _scheduleAutoStart() {
    if (this._gestureHandler) return;
    const onGesture = (ev) => {
      // If the user's gesture IS a tap on a Listen button, hand off:
      // unbind without starting and let the button's own `@click =>
      // toggle()` do the start. Otherwise we'd start() here in
      // capture phase, then the button's click sees `_on=true` and
      // immediately stops — the user-visible "Listen does nothing /
      // briefly flickers" symptom on cold-boot. Listen buttons mark
      // themselves with `data-foyer-listen-toggle="1"` for this
      // probe; composedPath() pierces shadow roots so it works for
      // both phone (`<foyer-phone-top-bar>`) and desktop
      // (`<foyer-mixer>`) toggle locations.
      if (ev?.composedPath) {
        const onListenButton = ev.composedPath().some(
          (n) => n?.dataset?.foyerListenToggle === "1",
        );
        if (onListenButton) {
          window.removeEventListener("pointerdown", onGesture, true);
          window.removeEventListener("keydown", onGesture, true);
          this._gestureHandler = null;
          return;
        }
      }
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      this._gestureHandler = null;
      // Don't re-schedule if start() throws — the user can still
      // toggle Listen on manually and that's a fresh gesture.
      this.start({ silent: true }).catch(() => {});
    };
    this._gestureHandler = onGesture;
    // Capture phase + window so we run before any in-app handler can
    // stopPropagation away. `pointerdown` covers mouse + touch +
    // pen; `keydown` covers keyboard-only navigation.
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
  }

  isOn() { return this._on; }

  /// Start listening. Returns a promise that resolves once the
  /// listener handshake is up. Saves the user pref unless `silent`.
  async start({ silent = false } = {}) {
    if (this._on || this._starting) return;
    if (!this._ws) return;
    this._starting = true;
    try {
      const baseUrl = location.origin.replace(/^http/, "ws");
      // Codec override via URL: `?audio_codec=raw_f32_le` bypasses
      // Opus entirely. Same flag the mixer used to read directly.
      const params = new URLSearchParams(location.search);
      const codec = params.get("audio_codec") || "opus";
      // Pull the audio-clock + clock-sync singletons off
      // window.__foyer (set by bootstrap.js). Audio listener uses
      // them to feed per-frame timing into the audio-derived
      // playhead and to convert server monotonic timestamps onto
      // the local performance.now() timeline.
      const audioClock = globalThis.__foyer?.audioClock || null;
      const clockSync = globalThis.__foyer?.clockSync || null;
      this._listener = new AudioListener({
        ws: this._ws,
        baseUrl,
        sourceKind: "master",
        codec,
        audioClock,
        clockSync,
        // Idle-drift watchdog reconnect: tear down + restart this
        // listener. The audio-clock fires this when the gap between
        // control-derived and audio-derived position exceeds the
        // threshold AND no audio frame has arrived in over a
        // second — symptom of a wedged jitter buffer or a long
        // network stall after a tab-background. Restart goes
        // through the controller's start/stop so the user pref
        // bookkeeping stays consistent.
        onWatchdogReconnect: ({ driftMs, idleMs }) => {
          console.warn(
            `[audio-controller] watchdog reconnect — drift=${driftMs.toFixed(1)} ms idle=${idleMs.toFixed(0)} ms`,
          );
          this.stop({ silent: true })
            .then(() => this.start({ silent: true }))
            .catch((e) =>
              console.warn("[audio-controller] watchdog restart failed:", e),
            );
        },
      });
      await this._listener.start();
      this._on = true;
      if (!silent) {
        try { localStorage.setItem(PREF_KEY, "1"); } catch {}
      }
      this._emitChange();
    } catch (e) {
      console.warn("[audio-controller] start failed:", e);
      this._teardown();
    } finally {
      this._starting = false;
    }
  }

  async stop({ silent = false } = {}) {
    if (!this._on && !this._listener) return;
    this._teardown();
    this._on = false;
    if (!silent) {
      try { localStorage.setItem(PREF_KEY, "0"); } catch {}
    }
    this._emitChange();
  }

  /// Listen button click handler. This is the ONE blessed user-gesture
  /// entry point for the audio pipeline — every code path through here
  /// runs inside the click's synchronous call stack until the first
  /// `await`, which is exactly the window the browser's autoplay policy
  /// gives us to prime an AudioContext.
  ///
  /// Behavior matrix:
  ///   * `_on=false`              → start fresh (gesture credit available)
  ///   * `_on=true`, ctx running  → stop (true toggle off)
  ///   * `_on=true`, ctx suspended → try resume in this gesture stack;
  ///                                 if still suspended, do a clean
  ///                                 stop + start. Recovery path for
  ///                                 the "auto-start fired before any
  ///                                 gesture and got blocked" case.
  ///   * `_on=true`, ctx missing   → state is desynced; restart.
  async toggle() {
    // Whatever this click is, the user is now manually steering the
    // audio. Drop any pending deferred-start gesture handler so we
    // don't double-fire later on some unrelated click.
    this._clearGestureHandler();

    if (!this._on) {
      return this.start();
    }

    const ctx = this._listener?.ctx;
    const state = ctx?.state ?? "(no ctx)";
    if (state === "running") {
      return this.stop();
    }
    console.info(`[audio-controller] Listen click: _on=true but ctx state=${state} — attempting recovery`);
    if (ctx && state === "suspended") {
      // ctx.resume() inside this click stack should succeed — Chrome
      // grants gesture credit for click events. If it really refuses
      // (extension interference, bizarre browser state), fall through
      // to the full restart below.
      try {
        await ctx.resume();
      } catch (e) {
        console.warn("[audio-controller] resume during toggle failed:", e);
      }
      if (this._listener?.ctx?.state === "running") {
        this._emitChange();
        return;
      }
    }
    // Stale state — tear down and start fresh inside this gesture.
    await this.stop({ silent: true });
    return this.start();
  }

  _clearGestureHandler() {
    if (!this._gestureHandler) return;
    window.removeEventListener("pointerdown", this._gestureHandler, true);
    window.removeEventListener("keydown", this._gestureHandler, true);
    this._gestureHandler = null;
  }

  _teardown() {
    try { this._listener?.stop(); } catch {}
    this._listener = null;
    if (this._gestureHandler) {
      window.removeEventListener("pointerdown", this._gestureHandler, true);
      window.removeEventListener("keydown", this._gestureHandler, true);
      this._gestureHandler = null;
    }
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: { on: this._on } }));
  }
}

export const audioController = new AudioController();
