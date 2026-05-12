// Shared "stop the transport, but wait for the browser-ingress
// tail to land first" helper. Used by:
//
//   * Transport bar's Stop button click.
//   * The global space-bar keybind (`web/ui-core/layout/keybinds.js`).
//   * (Future) command-palette stop entries.
//
// Without a shared module, the keybind path was silently bypassing
// the delay — the user could click the on-screen Stop and get a
// preserved tail, then hit space the next take and lose the last
// 100–300 ms. (Reported 2026-05-08.)
//
// What it accounts for:
//
//   capture (live)  AudioContext.baseLatency + worklet frame buffer.
//   network (live)  ingress one-way median latency (server-tracked).
//   backend (pref)  IPC + Ardour cycle + record-write — not directly
//                   measurable from the browser, exposed in Preferences.
//   buffer  (pref)  the shim's ingress buffer depth (formerly a
//                   separate "jitter cushion" pref; the buffer
//                   already represents how much packet jitter the
//                   shim is willing to absorb, so we derive the
//                   cushion from it directly instead of asking the
//                   user to tune two correlated knobs).

import { readAudioPrefs } from "./audio-listener.js";

const TRACK_MICS = (globalThis.__foyerTrackMics ||= new Map());

function findActiveIngress() {
  for (const [, mic] of TRACK_MICS) {
    const ingress = mic?.ingress;
    if (ingress?._running) return ingress;
  }
  return null;
}

function requestIngressLatency(ws, streamId) {
  return new Promise((resolve) => {
    if (!ws) return resolve(null);
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("envelope", onEnv);
    };
    const onEnv = (ev) => {
      const body = ev?.detail?.body;
      if (body?.type === "ingress_latency_report" && body.stream_id === streamId) {
        cleanup();
        resolve(body.median_ms ?? null);
      }
    };
    ws.addEventListener("envelope", onEnv);
    ws.send({ type: "request_ingress_latency", stream_id: streamId });
  });
}

/**
 * Stop the transport. If the current peer is recording and has an
 * active browser ingress stream, the actual stop is delayed by the
 * estimated end-to-end capture-to-record latency so the tail of the
 * take reaches Ardour's record source before the engine halts.
 *
 * `commandKind`:
 *   - "control" (default) — send `control_set transport.playing=false`.
 *     Matches the transport-bar Stop button.
 *   - "action"            — send `invoke_action transport.stop`.
 *     Matches the global space-bar keybind, which historically went
 *     through `invoke_action` so the host's stop-action semantics
 *     (e.g. Ardour's locate-on-stop) fire as the user expects.
 *
 * Returns the breakdown so the caller can stash / surface it.
 */
export async function stopTransportWithIngressTailDelay({ ws, store, commandKind = "control" } = {}) {
  if (!ws || !store) return null;
  const recording = !!store.state?.controls?.get("transport.recording");
  const playing = !!store.state?.controls?.get("transport.playing");
  const sendStop = () => {
    if (commandKind === "action") {
      ws.send({ type: "invoke_action", id: "transport.stop" });
    } else {
      ws.send({ type: "control_set", id: "transport.playing", value: false });
    }
  };
  // Not recording or already stopped → no delay needed.
  if (!recording || !playing) {
    sendStop();
    return null;
  }
  const ingress = findActiveIngress();
  if (!ingress) {
    sendStop();
    return null;
  }
  const prefs = readAudioPrefs();
  const captureMs = ingress.getCaptureLatencyMs?.() ?? 25;
  const networkMs = (await requestIngressLatency(ws, ingress.streamId)) ?? 50;
  const backendMs = Number(prefs.recordStopBackendMs) || 0;
  // Buffer cushion: the shim's ingress jitter buffer absorbs packets
  // arriving up to that many ms late. Use it as the safety margin
  // beyond the measured median; deeper buffer → more headroom.
  const bufferMs  = Number(prefs.shimIngressRingPrimeMs) || 0;
  const delayMs = Math.round(captureMs + networkMs + backendMs + bufferMs);
  const breakdown = {
    captureMs: Math.round(captureMs),
    networkMs: Math.round(networkMs),
    backendMs,
    bufferMs,
    totalMs: delayMs,
    commandKind,
  };
  globalThis.__foyer = globalThis.__foyer || {};
  globalThis.__foyer.lastStopDelay = breakdown;
  console.info(
    `[record-stop] delay ${delayMs} ms ` +
      `(capture ${breakdown.captureMs} + network ${breakdown.networkMs} + ` +
      `backend ${backendMs} + buffer ${bufferMs}) via ${commandKind}`,
  );
  await new Promise((r) => setTimeout(r, delayMs));
  sendStop();
  return breakdown;
}

/** Is there an active ingress that would trigger the tail delay? */
export function hasActiveIngressForTailDelay() {
  return !!findActiveIngress();
}
