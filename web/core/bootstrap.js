// SPDX-License-Identifier: Apache-2.0
// foyer-core bootstrap.
//
// Single entry point that:
//   1. Picks a ws URL (wss:// when served over https).
//   2. Creates the shared `store` and `ws` client; wires them with
//      `store.attach(ws)` so envelopes, seek-requests, and status
//      transitions all reduce cleanly.
//   3. Installs transport-return behavior (post-stop zero/return).
//   4. After the first ClientGreeting, picks a UI variant via the
//      registry and hands it control. Until then the "loading"
//      shell from ui-core paints so the page is never blank.
//   5. Re-mounts on variant swap without tearing down store/ws.
//
// Consumers wire this up by:
//   - importing `foyer-ui/package.js` (and any other variants) so
//     those packages register themselves;
//   - calling `bootFoyerCore()` once from boot.js.
//
// A zero-UI consumer (automated test driver, headless controller)
// passes `{ skipUi: true }` and drives the store/ws themselves.

import { FoyerWs } from "./ws.js";
import { Store } from "./store.js";
import { ChatStore } from "./chat.js";
import { installTransportReturn } from "./transport-return.js";
import { installBackTrap } from "./back-trap.js";
import { attach as attachRecents } from "./recents.js";
import { audioController } from "./audio/master-controller.js";
import { multiWindow } from "./multi-window.js";
import { windowRestore } from "./window-restore.js";
import { attachWindowIdentify, identifyAllWindows, hideAllWindowIdentifiers } from "./multi-window-identify.js";
import { ClockSync } from "./audio/clock-sync.js";
import { AudioClock } from "./audio/audio-clock.js";
import { getWebMidiService } from "./midi/web-midi.js";
import { pickUiVariant, sniffEnv, getUiVariant } from "./registry/ui-variants.js";
import { setFeatures } from "./registry/features.js";
import { setActiveVariant } from "./registry/widgets.js";

/** @typedef {import("./registry/ui-variants.js").VariantBootResult} VariantBootResult */

let _booted = false;
/** @type {VariantBootResult | null} */
let _current = null;

/**
 * Boot core. Safe to call once per page load.
 *
 * @param {Object} [opts]
 * @param {string} [opts.wsUrl]       Override default ws URL resolution.
 * @param {string} [opts.originTag]   Outbound-envelope origin tag. Defaults `web-0`.
 * @param {boolean} [opts.skipUi]     Don't auto-mount a UI variant.
 * @param {() => void} [opts.onReady] Fires after WS is initiated.
 */
export function bootFoyerCore(opts = {}) {
  if (_booted) return globalThis.__foyer;
  _booted = true;

  const wsUrl = opts.wsUrl || _resolveWsUrl();
  const originTag = opts.originTag || "web-0";

  const store = new Store({ selfOrigin: originTag });
  const ws = new FoyerWs({ url: wsUrl, origin: originTag });
  const chat = new ChatStore({ ws, store });

  store.attach(ws);
  chat.attach();
  attachRecents(store);
  // Multi-window: BroadcastChannel between sibling tabs of the same
  // logical peer + helpers for spawning secondary windows. Audio I/O
  // is rejected by the server on secondaries — feature code should
  // gate on `multiWindow.role === "primary"`.
  multiWindow.attach(store);
  // Wire the receiver for the "identify this window" overlay so
  // siblings paint a transient label when any window in the family
  // asks "which one are you?". Triggered from context menus that
  // need the user to map menu items onto physical windows.
  attachWindowIdentify();
  // Ctrl+Alt+W — open a new sibling window. We intentionally do NOT
  // accept the Cmd-key variant on macOS because Cmd+Option+W is "close
  // all windows of the app" — binding ourselves there would surprise
  // Mac users into killing their session. Mac users get the same
  // shortcut with the Control key. KeyboardEvent.code reads the
  // physical key so dvorak / azerty users hit the same chord.
  // Installed at document capture so it fires even with focus inside
  // a tile; the typing-target check skips text inputs.
  if (typeof document !== "undefined") {
    document.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code !== "KeyW") return;
      if (!e.ctrlKey || !e.altKey) return;
      if (e.shiftKey || e.metaKey) return;
      const t = e.target;
      const tag = t?.tagName?.toLowerCase?.();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      multiWindow.openSecondary({ width: 1280, height: 820 }).catch((err) => {
        console.warn("[foyer-core] open-window shortcut failed", err);
      });
    }, true);
  }
  // Window/monitor layout persistence — saves per-display-fingerprint
  // window position + size + (eventually) tile tree so a power-cycle
  // returns to the same arrangement.
  windowRestore.attach({ store, multiWindow });
  installTransportReturn({ store, ws });
  // Web MIDI bridge — singleton; construction is cheap and does NOT
  // ask the browser for permission. The first call to
  // `webMidi.requestAccess()` (from a panel button or a stored
  // preference) triggers the prompt. Attaching here so any later
  // overlay can grab the same instance via `getWebMidiService()`.
  const webMidi = getWebMidiService();
  webMidi.attach(ws);
  // Capture stray browser-back gestures (engineers reach for "rewind
  // to start" and overshoot into the chrome arrow) and re-route them
  // to a transport rewind instead of unmounting the page.
  installBackTrap({ store, ws });
  // Master-bus listen controller. Lives at the core layer (not in any
  // ui-* variant) so the phone shell, the desktop shell, and any
  // future variant all share one singleton — without this the phone
  // top-bar's Listen button was a no-op because `window.__foyer.audio`
  // was undefined (only `ui-full/app.js` was wiring it up).
  audioController.attach(ws, store);

  // Clock-sync + audio-derived transport timeline. Together these
  // make the displayed playhead match the speaker output instead of
  // racing ahead by the audio pipeline's latency. See
  // ./audio/clock-sync.js + ./audio/audio-clock.js for the design.
  const clockSync = new ClockSync({ ws });
  clockSync.start();
  const audioClock = new AudioClock();
  // Mirror control-plane transport state into the audio clock so its
  // watchdog + seek-freeze logic can compare control vs. audio.
  store.addEventListener("envelope", (ev) => {
    const body = ev.detail?.body;
    if (!body) return;
    if (body.type === "control_update") {
      const u = body.update;
      if (u?.id === "transport.position") {
        audioClock.noteControlPosition(
          Number(u.value) || 0,
          !!store.state.controls.get("transport.playing"),
        );
      } else if (u?.id === "transport.playing") {
        audioClock.noteControlPosition(
          Number(store.state.controls.get("transport.position") || 0),
          !!u.value,
        );
      }
    } else if (body.type === "meter_batch") {
      for (const u of body.values || []) {
        if (u?.id === "transport.position") {
          audioClock.noteControlPosition(
            Number(u.value) || 0,
            !!store.state.controls.get("transport.playing"),
          );
        }
      }
    }
  });
  // Local seeks freeze the displayed playhead so it doesn't visibly
  // backtrack while the audio stream catches up.
  ws.addEventListener("transport_seek_request", (ev) => {
    audioClock.noteSeek(Number(ev.detail?.value) || 0);
  });

  // Fallback-timer handle — cleared the moment the greeting arrives,
  // because the timer's job is "server is dead, paint something," NOT
  // "variant is slow to mount." Over a Cloudflare tunnel the handshake
  // eats a few hundred ms before the greeting even reaches us, then
  // mountVariant kicks off an async import tree that can run past the
  // timer's deadline. Without this cancel both mounts race and the
  // fallback's `swap()` overwrites the real variant.
  let fallbackTimer = null;

  // Drain ClientGreeting into the feature + variant registries.
  // The store already broadcasts `rbac` after handling the greeting;
  // we use `rbac` as our cue for "greeting has landed" without
  // adding a second listener path.
  const onFirstRbac = () => {
    store.removeEventListener("rbac", onFirstRbac);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    const greeting = store.state.greeting || {};
    setFeatures(greeting.features || {});
    if (!opts.skipUi) {
      mountVariant({
        serverDefault: greeting.default_ui_variant || null,
      }).catch((err) =>
        console.error("[foyer-core] variant mount failed", err),
      );
    }
  };
  store.addEventListener("rbac", onFirstRbac);

  // Expose on window for legacy components and DevTools poking.
  globalThis.__foyer = Object.assign(globalThis.__foyer || {}, {
    store,
    ws,
    chat,
    audio: audioController,
    clockSync,
    audioClock,
    webMidi,
    mountVariant,
    unmountVariant,
    multiWindow,
    windowRestore,
    identifyAllWindows,
    hideAllWindowIdentifiers,
  });

  ws.connect();
  opts.onReady?.();

  // If the greeting never lands (server down, cold boot) paint the
  // fallback UI after a short grace period so the page is usable.
  // The timer is cancelled in `onFirstRbac` above the moment a real
  // greeting arrives; 2500 ms is generous enough for LAN + slow
  // tunnel handshakes but short enough to feel snappy when the
  // server is actually gone.
  if (!opts.skipUi) {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      if (!_current) {
        mountVariant({ forceFallback: true }).catch((err) =>
          console.error("[foyer-core] fallback mount failed", err),
        );
      }
    }, 2500);
  }

  return globalThis.__foyer;
}

/**
 * Mount (or swap to) a UI variant. Tears down the previous variant
 * first if one is up; leaves store/ws untouched so mid-session swap
 * is cheap.
 *
 * @param {Object} [opts]
 * @param {string}  [opts.id]
 * @param {string}  [opts.serverDefault]
 * @param {boolean} [opts.forceFallback]
 */
export async function mountVariant(opts = {}) {
  const { id = null, serverDefault = null, forceFallback = false } = opts;
  let variant = null;
  if (id) variant = getUiVariant(id);
  else     variant = pickUiVariant({ serverDefault, env: sniffEnv() });

  if (!variant || forceFallback) {
    const fallback = await import("foyer-ui-core/fallback-ui.js");
    const result = await fallback.mountFallback({
      reason: variant ? "force-fallback" : "no-variant-registered",
    });
    await swap(result, "fallback");
    return result;
  }

  const result = await variant.boot();
  await swap(result, variant.id);
  return result;
}

/** Unmount the current variant (leaves store/ws running). */
export async function unmountVariant() {
  if (_current?.teardown) {
    try { _current.teardown(); } catch (err) { console.error(err); }
  }
  _current = null;
  setActiveVariant(null);
}

async function swap(next, variantId) {
  if (_current?.teardown) {
    try { _current.teardown(); } catch (err) { console.error(err); }
  }
  _current = next;
  setActiveVariant(variantId);
}

/**
 * Default WS URL — same host/port as the page, `/ws` path. Honours
 * the page protocol (wss if the page is https). Adds `?window=N`
 * coordination if the page URL already carries it.
 */
function _resolveWsUrl() {
  const loc = globalThis.location;
  if (!loc) return "ws://127.0.0.1:3838/ws";
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws`;
}
