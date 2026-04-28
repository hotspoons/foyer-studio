// Client-side transport preferences.
//
// These aren't session data (the backend doesn't care) — they're UX
// preferences about how transport commands behave. Persisted in
// localStorage so they survive reloads.

const KEY = "foyer.transport.prefs.v1";
const DEFAULTS = Object.freeze({
  /** When the user hits Stop, also snap playhead back to 0. Mirrors
   *  Reaper's "Return to start when stop pressed" and Logic's
   *  "Chase on stop" toggles. Defaults off — most engineers want
   *  the playhead to stay put. */
  returnOnStop: false,
});

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function write(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
}

export function getTransportPref(key) {
  return read()[key];
}

export function setTransportPref(key, value) {
  const prefs = read();
  prefs[key] = value;
  write(prefs);
  window.dispatchEvent(new CustomEvent("foyer:transport-prefs-changed", {
    detail: { key, value },
  }));
}

export function toggleTransportPref(key) {
  const cur = !!read()[key];
  setTransportPref(key, !cur);
  return !cur;
}
