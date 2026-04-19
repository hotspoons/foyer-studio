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

  const handler = (ev) => {
    if (ev.detail !== "transport.playing") return;
    const now = !!store.state.controls.get("transport.playing");
    if (now && !wasPlaying) {
      // Record the position at which play began. Used by "play_start".
      const pos = Number(store.state.controls.get("transport.position") || 0);
      playStartSample = pos;
    } else if (!now && wasPlaying) {
      const mode = getReturnMode();
      if (mode === "zero") {
        ws.controlSet("transport.position", 0);
      } else if (mode === "play_start") {
        ws.controlSet("transport.position", playStartSample);
      }
      // "leave" → do nothing.
    }
    wasPlaying = now;
  };

  store.addEventListener("control", handler);
  return () => store.removeEventListener("control", handler);
}
