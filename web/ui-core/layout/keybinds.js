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
import { isTypingTarget, hasActiveTextSelection } from "../typing-guard.js";
import { isActionAllowed } from "foyer-core/rbac.js";
import { stopTransportWithIngressTailDelay } from "foyer-core/audio/record-stop.js";
import { matchKey } from "foyer-core/keymap/index.js";

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

/** Every matching element in the document + open shadow trees (tree order). */
function queryAllDeep(sel) {
  const out = [];
  const walk = (root) => {
    try {
      root.querySelectorAll(sel).forEach((el) => out.push(el));
    } catch {
      /* ignore */
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
}

/**
 * Pick the timeline the user is actually editing. `queryDeep` alone
 * returns DOM-first match, which can be an unused float / wrong instance
 * while the focused tile has the selection — splits then no-op.
 */
function queryTimelineFromKeyEvent(ev) {
  const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
  for (const n of path) {
    if (n?.nodeName === "FOYER-TIMELINE-VIEW") return n;
  }
  const all = queryAllDeep("foyer-timeline-view");
  for (const tl of all) {
    if (tl.getSelectedRegionIds?.()?.length) return tl;
  }
  for (const tl of all) {
    if (tl._hoverSamples != null || tl._lastMouseGridX != null) return tl;
  }
  return all[0] || null;
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

    // Cut/Copy/Paste/Duplicate region clipboard ops. Mod is the
    // platform-conventional Ctrl on Linux/Windows, Cmd on macOS — the
    // same `ctrlKey || metaKey` shape every other Foyer shortcut uses.
    // We only fire when there's an actual region selection so the
    // browser's native copy of the page text still works elsewhere.
    {
      const isMod = (e.ctrlKey || e.metaKey) && !e.altKey;
      const lower = e.key?.toLowerCase?.();
      if (isMod && (lower === "c" || lower === "x" || lower === "v" || lower === "d")) {
        const tl = queryDeep("foyer-timeline-view");
        if (!tl) return;
        const hasSel = (tl.getSelectedRegionIds?.() || []).length > 0;
        // C/X/D require a region selection; the un-shift forms are the
        // canonical bindings and Shift+C/X/D are reserved.
        if (!e.shiftKey && lower === "c" && hasSel) { e.preventDefault(); tl.copyRegionSelection?.(); return; }
        if (!e.shiftKey && lower === "x" && hasSel) { e.preventDefault(); tl.cutRegionSelection?.(); return; }
        if (!e.shiftKey && lower === "d" && hasSel) { e.preventDefault(); tl.duplicateRegionSelection?.(); return; }
        // Paste:
        //   Ctrl/Cmd+V       → paste at the mouse cursor (Reaper /
        //                       Ableton default — most useful when the
        //                       user is dragging selections around).
        //   Ctrl/Cmd+Shift+V → paste at the playhead (legacy default;
        //                       useful when the cursor is off-grid or
        //                       the user wants timeline-anchored paste).
        if (lower === "v" && tl.hasClipboard?.()) {
          e.preventDefault();
          tl.pasteRegions?.({ at: e.shiftKey ? "playhead" : "mouse" });
          return;
        }
      }
      // Mute (region.mute_toggle) + split (edit.split_at_playhead) are
      // routed through the keymap profile via `_dispatchKeymap` further
      // down, so each DAW profile can rebind them (Pro Tools / Cubase
      // disagree on what S does, etc.). No handler needed here.
      // Arrow-key region nudge USED to live as a global capture here;
      // it now lives on `foyer-timeline-view` itself (host-level
      // keydown), so an arrow press only nudges regions when the
      // timeline is actually focused. That keeps the mixer / agent
      // panel / sessions list arrow behaviour intact. The
      // component-level handler delegates to `nudgeSelectedRegions`
      // with the same fine/beat semantics that used to live here.
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
        import("../widgets/confirm-modal.js").then(({ confirmAction }) => {
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

    // Profile-driven actions (Preferences → Editor conventions).
    // Each `matchKey(actionId, e)` consults the active DAW profile so
    // e.g. Reaper users get +/- as zoom while Cubase users get G/H, all
    // routed through the same Foyer call sites.
    if (this._dispatchKeymap(e)) return;

    // Edit chords — Ctrl/Cmd + X/C/V. These route to the backend's
    // `edit.*` action catalog entries so whatever the DAW would do for
    // those menu items fires. Gated off the same input-focus check at
    // the top: if the user is typing into a text field, we bail so
    // native editing still works. (Undo/redo + zoom shortcuts live in
    // `_dispatchKeymap` above — they vary per profile.)
    const cmdOrCtrl = e.ctrlKey || e.metaKey;
    if (cmdOrCtrl && !e.altKey) {
      const ws = window.__foyer?.ws;
      const key = e.key.toLowerCase();
      let action = null;
      if (key === "x" && !e.shiftKey) action = "edit.cut";
      else if (key === "c" && !e.shiftKey) action = "edit.copy";
      else if (key === "v" && !e.shiftKey) action = "edit.paste";
      // If the user has highlighted plain text (e.g. credentials in
      // the Remote Access form, a path in the project picker, a log
      // line in the console panel), Cmd+C / Cmd+X mean "copy that
      // text" — `isTypingTarget` doesn't catch this because the
      // selection is on a read-only span, not an editable input.
      // Bail so the browser's native clipboard runs instead of our
      // DAW edit.copy / edit.cut action. (Paste is unaffected — it
      // only matters in editable surfaces, which `isTypingTarget`
      // already covers.)
      if ((action === "edit.copy" || action === "edit.cut")
          && hasActiveTextSelection()) {
        return;
      }
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

  /**
   * Profile-driven action dispatch. Returns `true` when the event was
   * consumed; the caller should bail out of further processing.
   * Bindings come from `core/keymap/profiles.js` and the user's pick
   * (Preferences → Editor conventions).
   */
  _dispatchKeymap(e) {
    const ws = window.__foyer?.ws;

    if (matchKey("transport.play_toggle", e)) {
      if (!ws) return false;
      if (!isActionAllowed("transport.play") && !isActionAllowed("transport.stop")) return false;
      e.preventDefault();
      const store = window.__foyer?.store;
      const st = store?.state?.controls;
      const playing = !!(st && st.get("transport.playing"));
      if (playing) {
        stopTransportWithIngressTailDelay({ ws, store, commandKind: "action" })
          .catch((err) => {
            console.warn("[keybinds] stop-with-tail-delay failed:", err);
            ws.send({ type: "invoke_action", id: "transport.stop" });
          });
      } else {
        ws.send({ type: "invoke_action", id: "transport.play" });
      }
      return true;
    }

    if (matchKey("transport.record_toggle", e)) {
      if (!ws) return false;
      if (!isActionAllowed("transport.record")) return false;
      e.preventDefault();
      ws.send({ type: "invoke_action", id: "transport.record" });
      return true;
    }

    if (matchKey("transport.return_to_zero", e)) {
      if (!ws) return false;
      e.preventDefault();
      ws.controlSet?.("transport.position", 0);
      return true;
    }

    if (matchKey("edit.undo", e) && ws) {
      e.preventDefault();
      ws.send({ type: "invoke_action", id: "edit.undo" });
      return true;
    }
    if (matchKey("edit.redo", e) && ws) {
      e.preventDefault();
      ws.send({ type: "invoke_action", id: "edit.redo" });
      return true;
    }

    if (matchKey("editor.zoom_in", e)) {
      const tl = queryTimelineFromKeyEvent(e) || queryDeep("foyer-timeline-view");
      if (tl?.zoomStepH) { e.preventDefault(); tl.zoomStepH(1.25); return true; }
    }
    if (matchKey("editor.zoom_out", e)) {
      const tl = queryTimelineFromKeyEvent(e) || queryDeep("foyer-timeline-view");
      if (tl?.zoomStepH) { e.preventDefault(); tl.zoomStepH(1 / 1.25); return true; }
    }
    if (matchKey("editor.zoom_vertical_in", e)) {
      const tl = queryTimelineFromKeyEvent(e) || queryDeep("foyer-timeline-view");
      if (tl?.zoomStepV) { e.preventDefault(); tl.zoomStepV(1.2); return true; }
    }
    if (matchKey("editor.zoom_vertical_out", e)) {
      const tl = queryTimelineFromKeyEvent(e) || queryDeep("foyer-timeline-view");
      if (tl?.zoomStepV) { e.preventDefault(); tl.zoomStepV(1 / 1.2); return true; }
    }
    if (matchKey("editor.zoom_to_selection", e)) {
      const tl = queryDeep("foyer-timeline-view");
      if (tl?.zoomToSelection) { e.preventDefault(); tl.zoomToSelection(); return true; }
    }
    if (matchKey("editor.zoom_previous", e)) {
      const tl = queryDeep("foyer-timeline-view");
      if (tl?.zoomPrevious) { e.preventDefault(); tl.zoomPrevious(); return true; }
    }

    if (matchKey("edit.split_at_playhead", e)) {
      if (e.defaultPrevented || e.repeat) return false;
      const tl = queryTimelineFromKeyEvent(e);
      if (tl?.splitSelectedRegionsAtPlayhead) {
        e.preventDefault();
        tl.splitSelectedRegionsAtPlayhead();
        return true;
      }
    }
    if (matchKey("region.mute_toggle", e)) {
      const tl = queryDeep("foyer-timeline-view");
      if (tl?.getSelectedRegionIds?.()?.length) {
        e.preventDefault();
        tl.toggleMuteRegionSelection?.();
        return true;
      }
    }

    return false;
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
