// UI variant registry.
//
// A UI variant is a bootable renderer (the full Foyer UI, a touch
// control surface, a kids UI, a third-party React/Svelte port, …).
// Each variant declares a stable id, a label for the settings UI, a
// `match(env)` predicate that scores how well it fits the current
// client, and a `boot()` async function that paints itself into the
// page and returns a `{ root, teardown }` handle.
//
// **Selection priority** (first hit wins):
//   1. `?ui=<id>` URL override — explicit, debuggable, shareable
//   2. `localStorage['foyer.ui.variant']` — sticky user preference
//   3. Server default from `ClientGreeting.default_ui_variant` — host
//      admin can pin a variant for a given deployment
//   4. Highest `match(env)` score across registered variants
//   5. Fallback "you're home" shell from ui-core
//
// The core bootstrap imports each UI package as an ES module; the
// side-effect of that import is a `registerUiVariant({...})` call.
// This is why UI packages sit alongside ui-core, not inside — you
// include only the variants you want by editing which `import`s
// happen at boot time.

/** @typedef {Object} VariantEnv
 *  @property {boolean} touch    True if the device reports a touch surface.
 *  @property {number}  minDim   min(viewport.width, viewport.height) in px.
 *  @property {number}  width    viewport width
 *  @property {number}  height   viewport height
 *  @property {string}  userAgent
 */

/** @typedef {Object} VariantBootResult
 *  @property {Element}        root     The top-level element the variant mounted.
 *  @property {() => void}     teardown Called on variant swap or shutdown.
 */

/** @typedef {Object} Variant
 *  @property {string}  id
 *  @property {string}  label
 *  @property {(env: VariantEnv) => number}          match
 *  @property {() => Promise<VariantBootResult>}     boot
 */

const _variants = new Map();

/**
 * Register a UI variant. Idempotent — re-registering the same id
 * replaces the old entry (useful for hot-reload during dev).
 * @param {Variant} v
 */
export function registerUiVariant(v) {
  if (!v || !v.id || typeof v.boot !== "function") {
    throw new Error("registerUiVariant: need { id, boot, match, label }");
  }
  _variants.set(v.id, v);
}

/** List all registered variants, in registration order. */
export function listUiVariants() {
  return Array.from(_variants.values());
}

/** Look up a variant by id. */
export function getUiVariant(id) {
  return _variants.get(id) || null;
}

/** Build the env snapshot used for auto-detection. */
export function sniffEnv() {
  const w = typeof window !== "undefined" ? window : null;
  const width = w?.innerWidth ?? 1024;
  const height = w?.innerHeight ?? 768;
  const touch = !!(
    w &&
    ("ontouchstart" in w ||
      (w.navigator && w.navigator.maxTouchPoints > 0))
  );
  const userAgent = (w?.navigator?.userAgent) || "";
  return { touch, width, height, minDim: Math.min(width, height), userAgent };
}

const STORAGE_KEY = "foyer.ui.variant";

/**
 * Pick the UI variant to boot, honouring the full priority ladder.
 * @param {Object} [opts]
 * @param {string} [opts.serverDefault]  Variant id pinned by the server.
 * @param {VariantEnv} [opts.env]        Override for tests.
 * @returns {Variant | null}
 */
export function pickUiVariant({ serverDefault = null, env = null } = {}) {
  const resolvedEnv = env || sniffEnv();

  // 1. URL override
  try {
    const params = new URLSearchParams(globalThis.location?.search || "");
    const override = params.get("ui");
    if (override) {
      const v = getUiVariant(override);
      if (v) return v;
    }
  } catch { /* no window */ }

  // 2. localStorage preference
  try {
    const pref = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (pref) {
      const v = getUiVariant(pref);
      if (v) return v;
    }
  } catch { /* no storage */ }

  // 3. Server default
  if (serverDefault) {
    const v = getUiVariant(serverDefault);
    if (v) return v;
  }

  // 4. Highest match score
  let best = null;
  let bestScore = -Infinity;
  for (const v of _variants.values()) {
    const score = (v.match?.(resolvedEnv) ?? 0);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** Persist the user's variant preference so next boot honours it. */
export function setUserVariantPreference(id) {
  try {
    if (id) globalThis.localStorage?.setItem(STORAGE_KEY, id);
    else    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* no storage */ }
}

/** Return the currently-saved preference (may be null). */
export function getUserVariantPreference() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) || null; }
  catch { return null; }
}
