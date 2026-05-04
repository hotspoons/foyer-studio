// Shared "Take" state machine — bundles the three operations that a
// remote performer wants to fire off in one gesture:
//
//   1. set_track_browser_source — claim the track for self so the
//      sidecar's mic-routing policy sees the new ownership before the
//      ingress port appears.
//   2. AudioIngress.start() — open getUserMedia + the binary WS,
//      block until the shim acks `audio_ingress_opened` so the engine
//      port name we wire next is real.
//   3. update_track input_port — pin the track to the new ingress
//      port (so Ardour stops auto-connecting it to whatever it had).
//
// Tap-to-release reverses all three.
//
// Lives in foyer-core (renderless) so the phone Take chip and the
// desktop Take button drive the same registry and the same ordering.
// Without a shared module, the desktop track-strip would re-implement
// this and inevitably drift on rollback ordering — that's been
// expensive in the past (the rollback was added after a mic-failure
// left a track claimed-but-silent in production).
//
// The registry is keyed by track id and lives on `globalThis` so:
//   * a sheet/modal closing mid-take doesn't tear down the mic
//   * desktop and phone surfaces in the same browser see the same
//     "active" state
//   * every component that wants to render a Take button reads from
//     one place
//
// `track-mic-change` events bubble through `globalThis` as a CustomEvent
// so subscribers can re-render without polling. Combined with the
// store's `track-browser-sources` event and the WS `audio_ingress_*`
// envelopes, a Take button stays in sync with reality regardless of
// which surface drove the change.

import { AudioIngress } from "./audio-ingress.js";

/// Map<trackId, { ingress: AudioIngress, portName: string }>.
/// Initialized lazily on first access so re-imports don't clobber an
/// already-running ingress (matters when ui-* variants are hot-swapped
/// at runtime via `mountVariant({id})`).
const TRACK_MICS = (globalThis.__foyerTrackMics ||= new Map());

/// Singleton EventTarget for "this map changed" notifications. Same
/// `globalThis` placement as the map so subscribers added under one UI
/// variant survive a hot-swap to another.
const EMITTER = (globalThis.__foyerTrackMicEmitter ||= new EventTarget());

const CHANGE_EVENT = "track-mic-change";

function emitChange(trackId) {
    EMITTER.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { trackId } }));
}

/// True when this client owns an active mic ingress for `trackId`.
/// Stable across UI surfaces and across sheet/modal re-mounts.
export function isTrackMicActive(trackId) {
    if (!trackId) return false;
    return TRACK_MICS.has(trackId);
}

/// Subscribe to "any take state changed" events. Returns an unsubscribe
/// thunk. Use this from a component's connectedCallback.
export function onTrackMicChange(handler) {
    EMITTER.addEventListener(CHANGE_EVENT, handler);
    return () => EMITTER.removeEventListener(CHANGE_EVENT, handler);
}

/// Toggle the bundled "claim + mic + wire" gesture for `trackId`.
///
/// Args:
///   trackId  — track to toggle.
///   ws       — `window.__foyer.ws`.
///   store    — `window.__foyer.store`.
///   onError  — optional `(err) => void` for caller-side reporting.
///              The function still resolves (no throw) so the caller's
///              `_busy` flag doesn't get stuck.
///
/// Returns the new active state (true after a successful claim, false
/// after a release or after a mic failure that rolled back).
export async function toggleTrackTake({ trackId, ws, store, onError } = {}) {
    if (!trackId || !ws || !store) return isTrackMicActive(trackId);
    const selfPeerId = store.state?.selfPeerId || "";
    if (!selfPeerId) return isTrackMicActive(trackId);

    // Active → release. Order is the reverse of the claim path: stop
    // the ingress first so the engine port disappears, THEN clear
    // input_port (so Ardour can re-auto-connect), THEN un-claim
    // source-user ownership. The reverse order matters: a client that
    // sees `input_port=""` before the ingress port is gone could try to
    // auto-pick that same dead port.
    if (TRACK_MICS.has(trackId)) {
        const live = TRACK_MICS.get(trackId);
        if (live) {
            try { await live.ingress.stop(); } catch {}
            TRACK_MICS.delete(trackId);
        }
        ws.send({ type: "update_track", id: trackId, patch: { input_port: "" } });
        ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: "" });
        emitChange(trackId);
        return false;
    }

    // Idle → claim + start. Three commands, executed in order:
    //   (1) claim — server-side mic-routing policy needs to see
    //       ownership before the ingress port appears, otherwise some
    //       routing rules race the port-create event.
    //   (2) ingress — `start()` blocks on `audio_ingress_opened`, so by
    //       the time it resolves, `enginePortName` is the real name.
    //   (3) wire — patch the track's input_port to the resolved name.
    ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: selfPeerId });

    const ingress = new AudioIngress({
        ws,
        baseUrl: location.origin.replace(/^http/, "ws"),
    });
    try {
        await ingress.start();
    } catch (e) {
        // Mic capture failed (no permission, no device, getUserMedia
        // rejected, etc.). Roll back the source-user assignment so we
        // don't leave the track claimed-but-silent.
        ws.send({ type: "set_track_browser_source", track_id: trackId, peer_id: "" });
        if (onError) {
            try { onError(e); } catch {}
        } else {
            console.error("[track-mic] ingress failed:", e);
        }
        emitChange(trackId);
        return false;
    }
    const portName = ingress.enginePortName;
    TRACK_MICS.set(trackId, { ingress, portName });
    ws.send({ type: "update_track", id: trackId, patch: { input_port: portName } });
    emitChange(trackId);
    return true;
}

/// Stop a single track's mic without touching its source-user claim or
/// input_port. Used by surfaces that own only the mic-half of the
/// state machine (e.g. the desktop track-editor "Stop my mic"
/// button — it disconnects mic but leaves the manual port choice
/// alone). The bundled Take toggle uses `toggleTrackTake` instead.
export async function stopTrackMic(trackId) {
    const live = TRACK_MICS.get(trackId);
    if (!live) return;
    try { await live.ingress.stop(); } catch {}
    TRACK_MICS.delete(trackId);
    emitChange(trackId);
}
