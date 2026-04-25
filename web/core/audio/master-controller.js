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
  _applyPref(isLocal) {
    if (this._on || this._starting) return;
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
    if (wantOn) this.start({ silent: true }).catch(() => {});
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

  async toggle() {
    if (this._on) return this.stop();
    return this.start();
  }

  _teardown() {
    try { this._listener?.stop(); } catch {}
    this._listener = null;
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: { on: this._on } }));
  }
}

export const audioController = new AudioController();
