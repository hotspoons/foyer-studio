// Global keyboard bindings for the tiling layout. Modifier is Ctrl+Alt by
// default (avoids clashing with browser shortcuts). Mac users can swap via
// localStorage key `foyer.keymap.mod` = "meta-alt".
//
// Bindings (modifier + key):
//   h/ArrowLeft   focus left
//   j/ArrowDown   focus down
//   k/ArrowUp     focus up
//   l/ArrowRight  focus right
//   |             split right (vertical pane)
//   -             split below (horizontal pane)
//   w             close focused leaf
//   [ / ]         shrink / grow focused pane
//   0             reset focused split ratios to even
//   ?             show help overlay (TODO)
//
// The `rectById` provider is injected so we don't hard-couple to the DOM.

import { DIR } from "./tile-tree.js";

const STORAGE_MOD = "foyer.keymap.mod";

export class Keybinds {
  /**
   * @param {import("./layout-store.js").LayoutStore} store
   * @param {() => Map<string, DOMRect>} rectProvider
   */
  constructor(store, rectProvider) {
    this.store = store;
    this.rectProvider = rectProvider;
    this._handler = (e) => this._onKey(e);
  }

  install() { document.addEventListener("keydown", this._handler); }
  uninstall() { document.removeEventListener("keydown", this._handler); }

  _mod(e) {
    const m = (() => { try { return localStorage.getItem(STORAGE_MOD); } catch { return null; } })();
    if (m === "meta-alt") return e.metaKey && e.altKey;
    return e.ctrlKey && e.altKey;
  }

  _onKey(e) {
    if (!this._mod(e)) return;
    // Ignore when typing into an input.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    const mv = (dir) => {
      e.preventDefault();
      this.store.moveFocus(dir, this.rectProvider());
    };
    switch (k) {
      case "h": case "arrowleft":  return mv("left");
      case "j": case "arrowdown":  return mv("down");
      case "k": case "arrowup":    return mv("up");
      case "l": case "arrowright": return mv("right");
      case "|": case "\\":         e.preventDefault(); return this.store.split(DIR.ROW,    this._current());
      case "-": case "_":          e.preventDefault(); return this.store.split(DIR.COLUMN, this._current());
      case "w":                    e.preventDefault(); return this.store.closeFocused();
      case "[":                    e.preventDefault(); return this._resizeFocused(-0.05);
      case "]":                    e.preventDefault(); return this._resizeFocused(+0.05);
      default:
    }
  }

  _current() {
    // Duplicate the focused leaf's view by default on split.
    const tree = this.store.tree;
    const id = this.store.focusId;
    const walk = (n) => {
      if (n.kind === "leaf") return n.id === id ? n.view : null;
      for (const c of n.children) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(tree) || "mixer";
  }

  _resizeFocused(delta) {
    // Find the focused leaf's parent split and resize the edge nearest to it.
    const tree = this.store.tree;
    const id = this.store.focusId;
    const walk = (n) => {
      if (n.kind !== "split") return null;
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (c.id === id) {
          const edge = i === n.children.length - 1 ? i - 1 : i;
          return { split: n, edge };
        }
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    const hit = walk(tree);
    if (hit) this.store.resize(hit.split.id, hit.edge, delta);
  }
}
