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
// (`foyer.listen.master`), and falls back to "on if the connection
// is remote, off if local" when no preference is set.

import { AudioListener } from "./audio-listener.js";

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
    } else if (body.type === "backend_swapped" || body.type === "session_opened") {
      // Backend changed under us — the old listener's stream is
      // dead. Tear it down; pref re-application below will start a
      // fresh one if appropriate.
      if (this._on) {
        this._teardown();
        this._on = false;
        this._emitChange();
      }
      this._applyPref(null);
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
      else wantOn = !isLocal;
    }
    if (wantOn) this._scheduleAutoStart();
  }

  /// Wait for the next user gesture, then call start({ silent: true }).
  /// Idempotent; only one set of listeners is registered at a time.
  _scheduleAutoStart() {
    if (this._gestureHandler) return;
    const onGesture = () => {
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
      this._listener = new AudioListener({
        ws: this._ws,
        baseUrl,
        sourceKind: "master",
        codec,
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
