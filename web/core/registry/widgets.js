// Widget registry — logical → concrete element mapping.
//
// A widget id is a *logical role* like `"knob"`, `"fader"`,
// `"transport.playhead"`, or `"mixer.track.header"`. A UI variant
// registers the concrete custom-element tag that fulfils that role:
//
//   registerWidget("knob", "foyer-knob");
//   registerWidget("mixer.track.header", "foyer-lite-strip-header");
//
// Downstream code asks the registry rather than hardcoding tags:
//
//   const tag = widgetTag("knob") || "span";
//   // create-element-by-tag, pass props through attributes / properties
//
// **Why.** The shipping UI has ~50 components; a lite UI may want to
// substitute a third of them with smaller versions while keeping the
// rest identical. Registry indirection means the lite UI registers
// only the widgets it overrides; everything else resolves through
// the fallback chain.
//
// **Fallback chain.** Variants can declare a `parent` and lookups
// walk up: if `lite` doesn't register `"meter"`, we try `lite.parent`
// (e.g. `"full"`), then the global default. This keeps each variant's
// registration minimal and surprises predictable.

const _widgets = new Map();   // variant -> Map<id, tag>
const _parents = new Map();   // variant -> parent variant id
let _activeVariant = null;

/** Tell the registry which variant is currently active. */
export function setActiveVariant(id) { _activeVariant = id; }

/** Declare a parent variant for fallback lookups. */
export function setVariantParent(variant, parent) {
  _parents.set(variant, parent);
}

/** Register a widget implementation for a variant (defaults to active). */
export function registerWidget(id, tag, { variant = null } = {}) {
  const v = variant || _activeVariant || "default";
  let m = _widgets.get(v);
  if (!m) { m = new Map(); _widgets.set(v, m); }
  m.set(id, tag);
}

/**
 * Resolve a widget id to an element tag name. Walks variant → parent
 * → `"default"`. Returns `null` if nothing is registered.
 */
export function widgetTag(id, { variant = null } = {}) {
  let cursor = variant || _activeVariant;
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const m = _widgets.get(cursor);
    if (m?.has(id)) return m.get(id);
    cursor = _parents.get(cursor) || null;
  }
  const def = _widgets.get("default");
  return def?.get(id) || null;
}

/** Debug: dump the full registry. */
export function widgetSnapshot() {
  const out = {};
  for (const [variant, m] of _widgets) {
    out[variant] = Object.fromEntries(m);
  }
  return out;
}
