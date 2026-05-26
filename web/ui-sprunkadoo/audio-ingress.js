// Sprunki audio-ingress bootstrapper.
//
// Wraps foyer-core's canonical `AudioIngress` class (which already
// handles the kinks — AudioWorklet capture, sample-rate handshake
// with the shim, resampler bookkeeping, latency compensation) so
// the sprunki variant just expresses INTENT: "for this slot's
// track, please start streaming the mic." Each ingress is keyed
// on track_id and is idempotent.
//
// When the Phantom is placed on stage we ask for mic permission
// once; subsequent boots reuse the OS-level grant + our cached
// consent flag and reconnect silently. Toggling Autotune /
// Vocoder while Phantom isn't streaming triggers the same
// permission flow, so the kid only ever sees the prompt once.
//
// The mic → port → track wiring mirrors the main-UI pattern
// (see web/ui-full/components/track-editor-modal.js):
//   1. start AudioIngress (resolves with enginePortName)
//   2. update_track { input_port: <enginePortName> }
// On stop we clear input_port and tear the ingress down.

import { AudioIngress } from "foyer-core/audio/audio-ingress.js";

const PERM_KEY = "foyer.sprunki.ingress.allowed";

const _live = new Map();   // trackId → { ingress, portName }

export function ingressState(trackId) {
  const live = _live.get(trackId);
  if (!live) return null;
  return { connected: true, portName: live.portName };
}

export function hasIngressConsent() {
  try { return localStorage.getItem(PERM_KEY) === "yes"; }
  catch { return false; }
}
export function recordIngressConsent() {
  try { localStorage.setItem(PERM_KEY, "yes"); } catch {}
}
export function clearIngressConsent() {
  try { localStorage.removeItem(PERM_KEY); } catch {}
}

/**
 * Start mic capture and wire it onto `trackId`. Resolves true on
 * success (the kid hears their own mic on the Phantom track) or
 * false if permission was denied / WS handshake failed. Safe to
 * call repeatedly for the same trackId — a second call is a
 * no-op while the first one is alive.
 */
export async function startAudioIngress({ trackId }) {
  if (!trackId) return false;
  if (_live.has(trackId)) return true;

  const f = globalThis.__foyer;
  if (!f?.ws) return false;

  const ingress = new AudioIngress({
    ws: f.ws,
    baseUrl: location.origin.replace(/^http/, "ws"),
  });
  try {
    await ingress.start();
  } catch (e) {
    console.warn("[sprunki-ingress] AudioIngress.start failed:", e?.message || e);
    return false;
  }
  recordIngressConsent();

  const portName = ingress.enginePortName;
  if (!portName) {
    console.warn("[sprunki-ingress] handshake returned no engine port name");
    try { await ingress.stop(); } catch {}
    return false;
  }

  // Patch the track's input to the new engine port. The shim's
  // update_track handler wires this through IO::connect on its
  // side and echoes a TrackUpdated event the UI picks up.
  f.ws.send({
    type: "update_track",
    id: trackId,
    patch: { input_port: portName },
  });

  _live.set(trackId, { ingress, portName });
  console.info(`[sprunki-ingress] mic → ${trackId} (port ${portName})`);
  return true;
}

/** Tear the ingress stream down for `trackId` and clear the
 *  track's input_port so the next boot doesn't try to reconnect
 *  to a dead port. Safe to call when no stream is live. */
export async function stopAudioIngress({ trackId }) {
  const live = _live.get(trackId);
  if (!live) return;
  _live.delete(trackId);

  try { await live.ingress.stop(); } catch {}

  const f = globalThis.__foyer;
  if (f?.ws) {
    f.ws.send({
      type: "update_track",
      id: trackId,
      patch: { input_port: "" },
    });
  }
}

export async function stopAllIngress() {
  for (const trackId of [..._live.keys()]) {
    await stopAudioIngress({ trackId });
  }
}
