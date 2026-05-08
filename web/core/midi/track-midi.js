// Per-track MIDI arm state machine. The MIDI analogue of
// `core/audio/track-mic.js` — when a user clicks "I" on a MIDI
// track strip we need to:
//
//   1. claim the track (`set_track_browser_source` → self) so the
//      server can gate MIDI bytes targeted at this track to this
//      peer (mirrors the audio ingress access rule).
//   2. arm the local Web MIDI service so every byte it forwards
//      from a connected device (or the on-screen keyboard) carries
//      this track id; the shim direct-injects them via
//      `MidiTrack::write_user_immediate_event`.
//
// Releasing reverses both. A claim with no devices yet enabled is
// allowed — the user can pop the on-screen keyboard or plug in a
// controller after, and the arm stays valid because Web MIDI
// permission isn't a hard precondition for the on-screen surface.
//
// State lives on `globalThis` (same trick as track-mic) so a sheet
// closing mid-take or a UI variant hot-swap doesn't drop the arm.

import { getWebMidiService } from "./web-midi.js";

const ARMED = (globalThis.__foyerTrackMidiArm ||= { trackId: null });
const EMITTER = (globalThis.__foyerTrackMidiEmitter ||= new EventTarget());
const CHANGE_EVENT = "track-midi-change";

function emitChange(trackId) {
  EMITTER.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { trackId } }));
}

/** True iff this client has armed `trackId` for direct-injection. */
export function isTrackMidiActive(trackId) {
  if (!trackId) return false;
  return ARMED.trackId === trackId;
}

/** Currently armed track id (or `null`). */
export function armedMidiTrackId() {
  return ARMED.trackId;
}

/** Subscribe to "any MIDI arm changed" events. Returns an unsubscribe thunk. */
export function onTrackMidiChange(handler) {
  EMITTER.addEventListener(CHANGE_EVENT, handler);
  return () => EMITTER.removeEventListener(CHANGE_EVENT, handler);
}

/**
 * Toggle the per-track MIDI arm. Args mirror `toggleTrackTake`
 * (audio): `trackId`, `ws`, `store`, optional `onError`. Returns the
 * new active state.
 *
 * Claim ordering matters here too — set the source-user FIRST so
 * the server's per-track gate sees this peer as owner before any
 * envelope tagged with the track id arrives. Without that, the
 * very first event could race ahead of the assignment broadcast
 * and the server would drop it (visible as "first key press is
 * silent, the rest work").
 */
export async function toggleTrackMidi({ trackId, ws, store, onError } = {}) {
  if (!trackId || !ws || !store) return isTrackMidiActive(trackId);
  const selfPeerId = store.state?.selfPeerId || "";
  if (!selfPeerId) return isTrackMidiActive(trackId);

  // Active → release. Disarm the local router first so no in-flight
  // device events get tagged with a track we're about to disown,
  // then clear the source-user.
  if (ARMED.trackId === trackId) {
    const svc = getWebMidiService();
    svc.disarmTrack(trackId);
    ARMED.trackId = null;
    ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: "" });
    emitChange(trackId);
    return false;
  }

  // If a different track was previously armed, drop it first; one
  // armed track at a time matches the audio model.
  if (ARMED.trackId && ARMED.trackId !== trackId) {
    const prev = ARMED.trackId;
    try {
      const svc = getWebMidiService();
      svc.disarmTrack(prev);
    } catch {}
    ARMED.trackId = null;
    ws.send({ type: "set_track_browser_source", track_id: prev, peer_id: "" });
    emitChange(prev);
  }

  // Idle → claim. Three steps: claim source-user, arm router, emit.
  ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: selfPeerId });
  try {
    const svc = getWebMidiService();
    svc.armTrack(trackId);
    ARMED.trackId = trackId;
  } catch (e) {
    ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: "" });
    if (onError) {
      try { onError(e); } catch {}
    } else {
      console.error("[track-midi] arm failed:", e);
    }
    emitChange(trackId);
    return false;
  }
  emitChange(trackId);
  return true;
}

/** Drop the arm without touching the source-user assignment. */
export function releaseTrackMidi(trackId) {
  if (!trackId) return;
  if (ARMED.trackId !== trackId) return;
  try {
    const svc = getWebMidiService();
    svc.disarmTrack(trackId);
  } catch {}
  ARMED.trackId = null;
  emitChange(trackId);
}
