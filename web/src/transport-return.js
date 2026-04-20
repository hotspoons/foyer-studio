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

/** Read the current mode; migrates the legacy boolean pref on first call. */
export function getReturnMode() {
  const cur = getTransportPref("returnMode");
  if (RETURN_MODES.includes(cur)) return cur;
  // Legacy migration: a `true` boolean on `returnOnStop` maps to "zero",
  // anything else to "leave". Overwrite once so subsequent reads are clean.
  const legacy = getTransportPref("returnOnStop");
  const migrated = legacy ? "zero" : "leave";
  setTransportPref("returnMode", migrated);
  return migrated;
}

export function setReturnMode(mode) {
  if (!RETURN_MODES.includes(mode)) return;
  setTransportPref("returnMode", mode);
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
