// View registry.
//
// A "view" is a named surface the user can switch to — mixer,
// timeline, plugins, console, projects, etc. Foyer's hash router
// uses the view id (`#mixer`, `#timeline/42`) and the tile tree
// offers the catalog as a dropdown when users split a pane.
//
// Keeping this registry in core (not in any concrete UI) means:
//   · ui-core's tiling/dropdown reads views without a ui → ui-core
//     cycle;
//   · alternate UIs can add or remove views cleanly — a kids UI
//     may only register `mixer` + `transport`; a touch UI adds
//     `remote-strip` and drops `console`.
//
// Views register themselves as a side-effect of their package's
// boot; register-order wins for identical ids (later registrations
// replace earlier ones — useful for hot-reload).

/** @typedef {Object} View
 *  @property {string} id
 *  @property {string} label
 *  @property {string} [icon]  icon name from ui-core/icons
 *  @property {number} [order] lower = earlier in menus
 */

const _views = new Map();

/** Register (or replace) a view. */
export function registerView(v) {
  if (!v || !v.id) return;
  _views.set(v.id, { order: 100, ...v });
}

/** Unregister a view by id. */
export function unregisterView(id) {
  _views.delete(id);
}

/** Ordered list of views. Stable — sorted by `order`, then insertion. */
export function listViews() {
  return Array.from(_views.values()).sort((a, b) => {
    const da = a.order ?? 100;
    const db = b.order ?? 100;
    return da - db;
  });
}

/** Resolve the current view id from `location.hash`, clamped to known ids. */
export function currentView() {
  const h = (globalThis.location?.hash || "#mixer").replace(/^#/, "").split("/")[0];
  return _views.has(h) ? h : (listViews()[0]?.id ?? "mixer");
}
