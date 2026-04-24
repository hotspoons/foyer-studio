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
import { isTypingTarget } from "../typing-guard.js";

const STORAGE_MOD = "foyer.keymap.mod";

/** Walk shadow roots recursively to find a custom element. */
function queryDeep(sel) {
  const walk = (root) => {
    const found = root.querySelector(sel);
    if (found) return found;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const nested = walk(el.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(document);
}

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

  install() { document.addEventListener("keydown", this._handler, true); }
  uninstall() { document.removeEventListener("keydown", this._handler, true); }

  _mod(e) {
    const m = (() => { try { return localStorage.getItem(STORAGE_MOD); } catch { return null; } })();
    if (m === "meta-alt") return e.metaKey && e.altKey;
    return e.ctrlKey && e.altKey;
  }

  _onKey(e) {
    // Ignore when typing into an input — including text entries inside
    // shadow roots (chat composer, agent input, etc). `composedPath()`
    // walks through Lit component boundaries that a plain `target.tagName`
    // check can't see.
    if (isTypingTarget(e)) return;

    // Global plugin-layer toggle: Ctrl+Shift+P hides/shows every plugin
    // window at once. Lives outside the Ctrl+Alt chord family so it doesn't
    // collide with the tiling keys.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey
        && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      this.store.togglePluginFloats?.();
      return;
    }

    // Delete key (no modifiers) → delete regions in the current
    // selection. If there's a time-range selection OR track selection
    // with regions in it, delete. Only fires when no modifier is
    // held so native delete in text inputs still works.
    if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const tl = queryDeep("foyer-timeline-view");
      const store = window.__foyer?.store;
      const selectedTracks = store?.state?.selectedTrackIds;
      // Region click-selection wins first.
      const selectedRegions = tl?.getSelectedRegionIds?.() || [];
      if (selectedRegions.length) {
        e.preventDefault();
        tl.deleteSelectedRegions?.();
        return;
      }
      // If there's a time-range selection, delete those regions
      if (tl?._selection) {
        e.preventDefault();
        tl.deleteSelection();
        return;
      }
      // If tracks are selected, spawn delete-track confirm dialog
      if (selectedTracks && selectedTracks.size > 0) {
        e.preventDefault();
        const ids = Array.from(selectedTracks);
        import("../components/confirm-modal.js").then(({ confirmAction }) => {
          confirmAction({
            title: ids.length === 1 ? "Delete track" : `Delete ${ids.length} tracks`,
            message: ids.length === 1 ? "Delete this track and all of its regions?" : `Delete ${ids.length} selected tracks and all of their regions?`,
            confirmLabel: "Delete",
            tone: "danger",
          }).then((ok) => {
            if (!ok) return;
            for (const id of ids) window.__foyer?.ws?.send({ type: "delete_track", id });
          });
        });
        return;
      }
      // If nothing selected, check for a focused/clicked region via DOM
      const focused = document.activeElement;
      if (focused?.closest?.(".region")) {
        e.preventDefault();
        const regionEl = focused.closest(".region");
        const regionId = regionEl?.dataset?.id;
        if (regionId) {
          window.__foyer?.ws?.send({ type: "delete_region", id: regionId });
        }
        return;
      }
    }

    // Global transport shortcuts:
    //   Space      → toggle play/pause (DAW convention)
    //   Ctrl+Space → toggle record
    //
    // These run OUTSIDE the Ctrl+Alt chord family so they work regardless of
    // focus.
    if ((e.key === " " || e.code === "Space") && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const ws = window.__foyer?.ws;
      if (!ws) return;
      if (e.ctrlKey) {
        ws.send({ type: "invoke_action", id: "transport.record" });
      } else {
        // Toggle playing: if currently playing, stop; else play.
        const st = window.__foyer?.store?.state?.controls;
        const playing = !!(st && st.get("transport.playing"));
        if (playing) {
          // Return-on-stop behavior lives in transport-return.js — it
          // watches the store transition and handles the locate. No
          // special-casing here.
          ws.send({ type: "invoke_action", id: "transport.stop" });
        } else {
          ws.send({ type: "invoke_action", id: "transport.play" });
        }
      }
      return;
    }

    // Edit chords — Ctrl/Cmd + Z/Y/X/C/V. These route to the backend's
    // `edit.*` action catalog entries so whatever the DAW would do for
    // those menu items fires. Gated off the same input-focus check at
    // the top: if the user is typing into a text field, we bail so
    // native editing still works.
    const cmdOrCtrl = e.ctrlKey || e.metaKey;
    if (cmdOrCtrl && !e.altKey) {
      const ws = window.__foyer?.ws;
      const key = e.key.toLowerCase();

      // Ctrl+Shift+E  → zoom time-range selection to fill the viewport.
      // Ctrl+Shift+Backspace → pop the zoom stack.
      // Both operate locally on the timeline, no backend round-trip.
      if (e.shiftKey && key === "e") {
        e.preventDefault();
        queryDeep("foyer-timeline-view")?.zoomToSelection?.();
        return;
      }
      if (e.shiftKey && (key === "backspace" || key === "delete")) {
        e.preventDefault();
        queryDeep("foyer-timeline-view")?.zoomPrevious?.();
        return;
      }

      let action = null;
      if (key === "z" && !e.shiftKey)      action = "edit.undo";
      else if (key === "z" && e.shiftKey)  action = "edit.redo";
      else if (key === "y" && !e.shiftKey) action = "edit.redo";
      else if (key === "x" && !e.shiftKey) action = "edit.cut";
      else if (key === "c" && !e.shiftKey) action = "edit.copy";
      else if (key === "v" && !e.shiftKey) action = "edit.paste";
      if (action && ws) {
        e.preventDefault();
        ws.send({ type: "invoke_action", id: action });
        return;
      }
    }

    if (!this._mod(e)) return;
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
