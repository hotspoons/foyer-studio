// Per-client UI preference: is the dedicated metronome mixer strip
// open? This is a *visibility* concern, not a session-shared engine
// concern — the engine clicking state lives on the backend at
// `transport.metronome` and is driven by the M button on the strip.
// The strip itself can be shown or hidden independently per browser,
// the same way density/width settings are local to the surface.
//
// Why localStorage: see the "Per-client preferences" carve-out in
// CLAUDE.md — does another client at the same session need to see
// this? No (each user picks their own visible affordances). Local
// preference, written here.

const KEY = "foyer.mixer.show-metronome-strip.v1";
const EVENT = "foyer:metronome-strip-pref-changed";

/** True iff the metronome strip should currently be mounted. */
export function isMetronomeStripShown() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the preference and notify listeners (mixer, transport bar). */
export function setMetronomeStripShown(value) {
  const v = value ? "1" : "0";
  try {
    localStorage.setItem(KEY, v);
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: !!value }));
}

/** Subscribe to changes; returns an unsubscribe fn. */
export function onMetronomeStripPrefChange(handler) {
  const wrapped = (ev) => handler(!!ev.detail);
  window.addEventListener(EVENT, wrapped);
  return () => window.removeEventListener(EVENT, wrapped);
}
