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
  installTransportReturn({ store, ws });

  // Drain ClientGreeting into the feature + variant registries.
  // The store already broadcasts `rbac` after handling the greeting;
  // we use `rbac` as our cue for "greeting has landed" without
  // adding a second listener path.
  const onFirstRbac = () => {
    store.removeEventListener("rbac", onFirstRbac);
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
    mountVariant,
    unmountVariant,
  });

  ws.connect();
  opts.onReady?.();

  // If the greeting never lands (server down, cold boot) paint the
  // fallback UI after a short grace period so the page is usable.
  if (!opts.skipUi) {
    setTimeout(() => {
      if (!_current) {
        mountVariant({ forceFallback: true }).catch((err) =>
          console.error("[foyer-core] fallback mount failed", err),
        );
      }
    }, 1200);
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
