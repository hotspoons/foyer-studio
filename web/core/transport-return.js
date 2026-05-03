// Post-stop playhead-return behavior.
//
// Handles the "what happens to the playhead when transport stops?" question
// that every DAW gets slightly differently. Three modes, cycled by a button
// in the transport bar:
//
//   "leave"      — playhead stays where it stopped (default, preferred by
//                  most tracking engineers)
//   "zero"       — snap to 0 on stop (Reaper's "Return to start on stop")
//   "play_start" — return to the sample where PLAY was pressed (Pro Tools'
//                  classic behavior; great for auditioning the same
//                  section repeatedly)
//
// Installed once by the app bootstrap. Watches store `control` events for
// transitions on `transport.playing` and applies the selected return mode
// by sending a `transport.position` controlSet when transport goes
// true → false.

import { getTransportPref, setTransportPref } from "./transport-settings.js";

/** Valid mode values. Keep in sync with the UI cycler. */
export const RETURN_MODES = ["leave", "zero", "play_start"];

export const RETURN_MODE_LABELS = {
  leave: "Stay",
  zero: "→ 0",
  play_start: "↩ Start",
};

export const RETURN_MODE_TITLES = {
  leave: "Leave playhead where it stopped",
  zero: "Return to start (sample 0) on stop",
  play_start: "Return to where play was pressed",
};

/// Coerce a backend-emitted ControlValue (object or primitive) into
/// the bare mode string we operate on. The wire encoding wraps strings
/// as `{ String: "..." }`, but local store mutations may have already
/// unwrapped to a plain string; tolerate both shapes.
function unwrapMode(raw) {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof raw.String === "string") {
    return raw.String;
  }
  return null;
}

/// Read the current mode. Server-authoritative — the backend stores
/// the mode in `transport.return_mode` so a host's choice travels to
/// every connected client (a phone-only toggle would silently disagree
/// with the desktop). The localStorage cache is a fallback for the
/// pre-snapshot window (cold boot, before the store has any controls)
/// and for backends that don't yet emit `transport.return_mode`
/// (legacy snapshots, shims still on the old schema).
export function getReturnMode() {
  // Authoritative path: the live store value.
  const store = (typeof window !== "undefined" ? window : globalThis)
    ?.__foyer?.store;
  const live = store?.state?.controls?.get?.("transport.return_mode");
  const wireMode = unwrapMode(live);
  if (wireMode && RETURN_MODES.includes(wireMode)) return wireMode;
  // Fallback: cached preference, with the legacy boolean migration.
  const cur = getTransportPref("returnMode");
  if (RETURN_MODES.includes(cur)) return cur;
  const legacy = getTransportPref("returnOnStop");
  const migrated = legacy ? "zero" : "leave";
  setTransportPref("returnMode", migrated);
  return migrated;
}

/// Change the mode. Sends `control_set` so the backend records it and
/// broadcasts to every other client (this is the bit that was a
/// localStorage-only side-effect before — a desktop click never
/// reached the phone, and vice versa). The localStorage cache is
/// kept in sync so reload before the first snapshot still picks the
/// right mode.
export function setReturnMode(mode) {
  if (!RETURN_MODES.includes(mode)) return;
  setTransportPref("returnMode", mode);
  const root = (typeof window !== "undefined" ? window : globalThis)
    ?.__foyer;
  // Optimistic local write so the button re-renders immediately
  // instead of waiting for the WS round trip. The pinned value in
  // `_pendingControls` (set by ws.controlSet's control_set_request
  // dispatch) holds against any in-flight stale snapshot, so a slow
  // server echo can't roll us back to the previous mode.
  const store = root?.store;
  if (store?.state?.controls) {
    store.state.controls.set("transport.return_mode", mode);
    store.dispatchEvent(
      new CustomEvent("control", { detail: "transport.return_mode" }),
    );
  }
  if (root?.ws) {
    try {
      root.ws.controlSet("transport.return_mode", mode);
    } catch {
      // Best-effort — caching above already kept the local state.
    }
  }
}

export function cycleReturnMode() {
  const cur = getReturnMode();
  const next = RETURN_MODES[(RETURN_MODES.indexOf(cur) + 1) % RETURN_MODES.length];
  setReturnMode(next);
  return next;
}

/**
 * Install the return-on-stop handler on a running {@link Store}. Listens
 * to `control` events and fires `transport.position` when playing flips
 * true → false.
 *
 * Call once during app bootstrap. Returns an `uninstall` closure for
 * tests / hot-reload.
 */
export function installTransportReturn({ store, ws }) {
  if (!store || !ws) return () => {};

  let wasPlaying = false;
  let playStartSample = 0;

  // ── front-end position lock ─────────────────────────────────────────
  //
  // When the user hits stop with "zero" or "play_start" mode on, we
  // need the playhead to land (and stay) at the requested sample. But
  // Ardour's FSM is asynchronous — the shim's 30 Hz tick will keep
  // broadcasting `session.transport_sample()`, which can race our
  // locate and yank the UI back to whatever Ardour thinks is "live".
  //
  // Fix: a short front-end lock. While held:
  //   - the store pins `transport.position` to `target` (see
  //     `Store._applyControl`) so incoming backend position values are
  //     ignored — we trust the front-end for this one UX.
  //   - the lock auto-releases after `LOCK_MS`.
  //   - if the user explicitly seeks elsewhere during the window, we
  //     release immediately so their action isn't swallowed.
  //
  // This is intentional one-feature spoofing: DAW-agnostic return-on-
  // stop UX is valuable enough to override backend truth briefly.
  const LOCK_MS = 600;
  let lock = null; // { target, expiresAt }

  store.transportPositionLock = () => {
    if (!lock) return null;
    if (Date.now() > lock.expiresAt) { lock = null; return null; }
    return lock.target;
  };

  /** Called by the transport-bar's seek buttons / ruler-click handlers
   *  to release the lock early when the user explicitly moves elsewhere. */
  store.releaseTransportPositionLock = () => { lock = null; };

  function applyReturn(target) {
    lock = { target, expiresAt: Date.now() + LOCK_MS };
    ws.controlSet("transport.position", target);
    // Pin visually: overwrite the store's cached value so the playhead
    // snaps immediately without waiting for a round trip.
    store.state.controls.set("transport.position", target);
    store.dispatchEvent(
      new CustomEvent("control", { detail: "transport.position" })
    );
  }

  const controlHandler = (ev) => {
    // Keep `playStartSample` synced with any explicit seeks. If the
    // user clicks/drags the ruler DURING playback, they expect a
    // subsequent stop to snap back to the NEW position, not the
    // original one they hit play from. `transportPositionLock` is
    // set by our own applyReturn and by direct lock helpers in the
    // store; a seek event outside that lock is user-initiated and
    // overrides `playStartSample`.
    if (ev.detail === "transport.position") {
      const locked = typeof store.transportPositionLock === "function"
        ? store.transportPositionLock()
        : null;
      if (locked == null) {
        const pos = Number(store.state.controls.get("transport.position") || 0);
        playStartSample = pos;
      }
      return;
    }
    if (ev.detail !== "transport.playing") return;
    const now = !!store.state.controls.get("transport.playing");
    if (now && !wasPlaying) {
      const pos = Number(store.state.controls.get("transport.position") || 0);
      playStartSample = pos;
    } else if (!now && wasPlaying) {
      const mode = getReturnMode();
      if (mode === "zero") applyReturn(0);
      else if (mode === "play_start") applyReturn(playStartSample);
    }
    wasPlaying = now;
  };

  store.addEventListener("control", controlHandler);
  return () => {
    store.removeEventListener("control", controlHandler);
    delete store.transportPositionLock;
    delete store.releaseTransportPositionLock;
  };
}
