// SPDX-License-Identifier: Apache-2.0
// Pane handoff between sibling windows.
//
// Carries a tile-leaf's `{ view, props }` payload from one window of
// a multi-window peer to another via the BroadcastChannel set up in
// `foyer-core/multi-window.js`. The sender removes the leaf from its
// own tile tree; the receiver re-spawns it via
// `LayoutStore.sendToTiles(view, props)` — the same code path used
// for any in-window "open this view" action, so the receiving
// window's slot heuristics, focus rules, and dedup all behave
// identically to a local invocation.
//
// Floating windows (free-floating tile + plugin floats) ride the
// same transport with a `kind: "floating-tile"` payload variant.
//
// Receiver side is autonomous — it registers on the multiWindow
// channel and dispatches to `window.__foyer.layout` lazily so the
// import graph stays one-way (ui-core does not depend on ui-full's
// app shell).

import { multiWindow } from "foyer-core/multi-window.js";

let _attached = false;
let _unsubscribe = null;

/**
 * Wire the receiver side. Idempotent. Call once from the UI variant's
 * boot — the resulting subscription lives for the page lifetime
 * because tile handoffs can land long after first paint.
 */
export function attachPaneHandoff() {
  if (_attached) return;
  _attached = true;
  _unsubscribe = multiWindow.onHandoff((payload) => {
    if (!payload || typeof payload !== "object") return;
    const layout = globalThis.__foyer?.layout;
    if (!layout || typeof layout.sendToTiles !== "function") {
      console.warn("[pane-handoff] received payload before layout was attached", payload);
      return;
    }
    if (payload.kind === "tile-leaf") {
      const id = layout.sendToTiles(payload.view, payload.props || {});
      if (id && typeof layout.focus === "function") layout.focus(id);
    } else if (payload.kind === "floating-tile") {
      if (typeof layout.openFloating === "function") {
        layout.openFloating(payload.view, payload.props || {});
      } else {
        // Older variants without floating support — drop into the
        // tile tree instead of throwing the payload away.
        layout.sendToTiles(payload.view, payload.props || {});
      }
    } else {
      console.warn("[pane-handoff] unknown payload kind", payload.kind);
    }
  });
}

/** Detach the receiver — primarily for tests. */
export function detachPaneHandoff() {
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = null;
  _attached = false;
}

/**
 * Send a tile-leaf to a sibling window and remove it from this
 * window's tile tree. `targetConnectionId` is the receiver's
 * `connection_id` (from `multiWindow.siblings`); pass `null` to
 * broadcast to every sibling (only useful when you know there's
 * exactly one — duplicate landings produce duplicate panes).
 *
 * @param {object} opts
 * @param {string | null} opts.targetConnectionId
 * @param {{id?: string, view: string, props?: object}} opts.leaf
 * @param {boolean} [opts.removeLocal=true]
 */
export function sendTileLeaf({ targetConnectionId, leaf, removeLocal = true }) {
  if (!leaf?.view) return false;
  const ok = multiWindow.sendHandoff({
    kind: "tile-leaf",
    view: leaf.view,
    props: leaf.props || {},
  }, targetConnectionId);
  if (!ok) return false;
  if (removeLocal && leaf.id) {
    const layout = globalThis.__foyer?.layout;
    if (layout && typeof layout.removeLeaf === "function") {
      layout.removeLeaf(leaf.id);
    }
  }
  return true;
}

/**
 * Send a floating-tile spec to a sibling window. The local floating
 * tile is left alone — the sender decides whether to close it (most
 * features want a "move", which means caller closes after sending).
 */
export function sendFloatingTile({ targetConnectionId, view, props }) {
  if (!view) return false;
  return multiWindow.sendHandoff({
    kind: "floating-tile",
    view,
    props: props || {},
  }, targetConnectionId);
}
