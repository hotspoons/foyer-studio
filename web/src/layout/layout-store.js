// Layout persistence + named layout slots. EventTarget-shaped so components
// subscribe with addEventListener("change", …).

import * as Tree from "./tile-tree.js";
import { slotBounds } from "./slots.js";

const CUR_KEY = "foyer.layout.current.v1";
const NAMED_KEY = "foyer.layout.named.v1";
const FOCUS_KEY = "foyer.layout.focus.v1";
const FLOAT_KEY = "foyer.layout.floating.v1";
const FAB_DOCK_KEY = "foyer.layout.dockedFabs.v1";

let _floatId = 0;
function mkFloatId() {
  _floatId += 1;
  return `f_${Date.now().toString(36)}_${_floatId.toString(36)}`;
}

export class LayoutStore extends EventTarget {
  constructor() {
    super();
    this.tree = Tree.deserialize(this._read(CUR_KEY)) || Tree.defaultTree();
    this.focusId = this._read(FOCUS_KEY) || Tree.leaves(this.tree)[0]?.id || null;
    this.named = (() => {
      try { return JSON.parse(localStorage.getItem(NAMED_KEY) || "{}") || {}; }
      catch { return {}; }
    })();
    this._floating = (() => {
      try { return JSON.parse(localStorage.getItem(FLOAT_KEY) || "[]") || []; }
      catch { return []; }
    })();
    this._dockedFabs = (() => {
      try { return JSON.parse(localStorage.getItem(FAB_DOCK_KEY) || "{}") || {}; }
      catch { return {}; }
    })();
    // Registry of FAB metadata keyed by FAB id — NOT persisted. Populated at
    // runtime by each QuadrantFab instance so the right-dock knows how to
    // render its rail icon and panel without a circular import.
    this._fabRegistry = new Map();
    // Baseline = the serialized tree that matched the last loaded preset or
    // named layout. `isDirty()` compares the current tree against this.
    this._baseline = Tree.serialize(this.tree);
    this._baselineKind = null; // "preset" | "named" | null
    this._baselineName = null;
  }

  /**
   * True when the tree has been edited since the last loaded/saved layout.
   * Comparison is against the serialized baseline, so reordering back to the
   * same shape registers as "clean" even if the user fumbled around.
   */
  isDirty() {
    return Tree.serialize(this.tree) !== this._baseline;
  }

  /** Last-loaded layout identity, or null if the tree is freeform. */
  currentLayoutIdentity() {
    if (!this._baselineKind) return null;
    return { kind: this._baselineKind, name: this._baselineName };
  }

  _markBaseline(kind, name) {
    this._baseline = Tree.serialize(this.tree);
    this._baselineKind = kind;
    this._baselineName = name;
  }

  _read(k) {
    try { return localStorage.getItem(k) || null; } catch { return null; }
  }

  _emit() {
    this._persist();
    this.dispatchEvent(new CustomEvent("change"));
  }

  _persist() {
    try {
      localStorage.setItem(CUR_KEY, Tree.serialize(this.tree));
      if (this.focusId) localStorage.setItem(FOCUS_KEY, this.focusId);
      localStorage.setItem(NAMED_KEY, JSON.stringify(this.named));
      localStorage.setItem(FLOAT_KEY, JSON.stringify(this._floating));
      localStorage.setItem(FAB_DOCK_KEY, JSON.stringify(this._dockedFabs));
    } catch {}
  }

  // ── docked FABs ────────────────────────────────────────────────────────

  /**
   * Components (QuadrantFab instances) register themselves so the right-dock
   * can render their rail icon + know who to wake up without a circular
   * import. `meta` carries `{ label, icon, dockWidth, expandsRail, accent }`.
   */
  registerFab(id, meta) {
    this._fabRegistry.set(id, meta || {});
    this._emit();
  }
  unregisterFab(id) {
    this._fabRegistry.delete(id);
    this._emit();
  }
  fabMeta(id) {
    return this._fabRegistry.get(id) || {};
  }

  /** Is this FAB currently docked to the right rail? */
  isFabDocked(id) {
    return !!this._dockedFabs[id];
  }

  dockFab(id) {
    if (this._dockedFabs[id]) return;
    this._dockedFabs[id] = true;
    this._emit();
  }

  undockFab(id) {
    if (!this._dockedFabs[id]) return;
    delete this._dockedFabs[id];
    this._emit();
  }

  /** List of { id, meta } for every docked FAB, filtered to those with registered metadata. */
  dockedFabs() {
    return Object.keys(this._dockedFabs)
      .filter((id) => this._fabRegistry.has(id))
      .map((id) => ({ id, meta: this._fabRegistry.get(id) }));
  }

  // ── floating windows ───────────────────────────────────────────────────

  floating() { return this._floating.slice(); }

  /** Detach the focused leaf from the tree into a floating window. */
  floatFocused() {
    if (!this.focusId) return;
    const node = Tree.findById(this.tree, this.focusId);
    if (!node || node.kind !== "leaf") return;
    const view = node.view;
    const props = node.props;
    const next = Tree.removeNode(this.tree, this.focusId);
    if (!next) { this.tree = Tree.defaultTree(); }
    else { this.tree = next; }
    this.focusId = Tree.leaves(this.tree)[0]?.id || null;
    this._pushFloat(view, props || {});
    this._emit();
  }

  /**
   * Open a new floating window for `view` with the given props, positioned
   * according to `placement`. Returns the new float id.
   *
   * `placement` shapes:
   *   - undefined          — stack in a free offset cascade (default)
   *   - "free"             — same as undefined
   *   - { slot: "left-third" | ... } — a named slot (see slotBounds below)
   *   - { x, y, w, h }     — raw rect in viewport px
   */
  openFloating(view, props = {}, placement) {
    // If caller didn't specify a placement, prefer the sticky slot for this view.
    if (!placement) {
      const sticky = this.stickySlotFor(view);
      if (sticky) placement = { slot: sticky };
    }
    const id = this._pushFloat(view, props, placement);
    this._emit();
    return id;
  }

  _pushFloat(view, props, placement) {
    const id = mkFloatId();
    const rect = this._placementRect(placement);
    const z = this._nextZ();
    this._floating.push({
      id,
      view,
      props: props || {},
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      minimized: false,
      z,
      // Remember the last slot for "sticky sizing" — next open of the same
      // view lands in the same slot if no explicit placement is requested.
      slot: typeof placement === "object" && placement?.slot ? placement.slot : null,
    });
    this._rememberSlot(view, placement);
    return id;
  }

  /** Bring a floating window to the front (highest z). */
  raiseFloat(id) {
    const f = this._floating.find((x) => x.id === id);
    if (!f) return;
    f.z = this._nextZ();
    this._emit();
  }

  _nextZ() {
    let max = 0;
    for (const f of this._floating) if ((f.z | 0) > max) max = f.z | 0;
    return max + 1;
  }

  _rememberSlot(view, placement) {
    const slot = typeof placement === "object" && placement?.slot ? placement.slot : null;
    if (!slot) return;
    try {
      const key = `foyer.layout.sticky.${view}`;
      localStorage.setItem(key, slot);
    } catch {}
  }

  stickySlotFor(view) {
    try {
      return localStorage.getItem(`foyer.layout.sticky.${view}`) || null;
    } catch {
      return null;
    }
  }

  /** Compute a rect from a placement specifier against the current viewport. */
  _placementRect(placement) {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 720;
    const pad = 24;
    if (placement && typeof placement === "object") {
      if ("x" in placement) {
        return {
          x: Math.round(placement.x),
          y: Math.round(placement.y),
          w: Math.round(placement.w ?? 540),
          h: Math.round(placement.h ?? 360),
        };
      }
      if (placement.slot) {
        const r = slotBounds(placement.slot, vw, vh, pad);
        if (r) return r;
      }
    }
    // Default cascade.
    const n = this._floating.length;
    return {
      x: Math.min(vw - 560, 120 + n * 32),
      y: Math.min(vh - 380, 120 + n * 32),
      w: 540,
      h: 360,
    };
  }

  floatSet(id, patch) {
    const idx = this._floating.findIndex(f => f.id === id);
    if (idx < 0) return;
    this._floating[idx] = { ...this._floating[idx], ...patch };
    this._emit();
  }

  removeFloat(id) {
    this._floating = this._floating.filter(f => f.id !== id);
    this._emit();
  }

  /** Move a floating window back into the tile tree as a split of the focus. */
  dockFloat(id) {
    const f = this._floating.find(x => x.id === id);
    if (!f) return;
    this._floating = this._floating.filter(x => x.id !== id);
    if (this.focusId) {
      this.tree = Tree.splitLeaf(this.tree, this.focusId, Tree.DIR.ROW, f.view, "after", f.props || {});
    } else {
      this.tree = Tree.leaf(f.view, f.props || {});
    }
    this.focusId = Tree.leaves(this.tree)[0]?.id || null;
    this._emit();
  }

  // ── tree ops ───────────────────────────────────────────────────────────

  setTree(next) {
    if (!next) return;
    this.tree = next;
    const lfs = Tree.leaves(this.tree);
    if (!lfs.some(l => l.id === this.focusId)) {
      this.focusId = lfs[0]?.id || null;
    }
    this._emit();
  }

  focus(id) {
    if (!id || !Tree.findById(this.tree, id)) return;
    this.focusId = id;
    this._emit();
  }

  split(direction, newView, side = "after") {
    if (!this.focusId) return;
    const next = Tree.splitLeaf(this.tree, this.focusId, direction, newView, side);
    const added = Tree.leaves(next).find(l => !Tree.leaves(this.tree).some(p => p.id === l.id));
    this.tree = next;
    if (added) this.focusId = added.id;
    this._emit();
  }

  closeFocused() {
    if (!this.focusId) return;
    const next = Tree.removeNode(this.tree, this.focusId);
    if (next) {
      this.tree = next;
      this.focusId = Tree.leaves(next)[0]?.id || null;
    } else {
      // Never allow an empty tree — fall back to a fresh mixer.
      this.tree = Tree.defaultTree();
      this.focusId = Tree.leaves(this.tree)[0]?.id || null;
    }
    this._emit();
  }

  setFocusedView(view) {
    if (!this.focusId) return;
    this.tree = Tree.setLeafView(this.tree, this.focusId, view);
    this._emit();
  }

  resize(splitId, edgeIndex, delta) {
    this.tree = Tree.resizeSplit(this.tree, splitId, edgeIndex, delta);
    this._emit();
  }

  moveFocus(direction, rectById) {
    if (!this.focusId) return false;
    const next = Tree.focusNeighbor(this.tree, this.focusId, direction, rectById);
    if (next) { this.focusId = next; this._emit(); return true; }
    return false;
  }

  // ── named layouts ──────────────────────────────────────────────────────

  saveNamed(name) {
    this.named[name] = Tree.serialize(this.tree);
    this._markBaseline("named", name);
    this._emit();
  }
  loadNamed(name) {
    const raw = this.named[name];
    const t = Tree.deserialize(raw);
    if (t) {
      this.tree = t;
      this.focusId = Tree.leaves(t)[0]?.id || null;
      this._markBaseline("named", name);
      this._emit();
    }
  }
  deleteNamed(name) {
    delete this.named[name];
    if (this._baselineKind === "named" && this._baselineName === name) {
      this._baselineKind = null;
      this._baselineName = null;
    }
    this._emit();
  }
  listNamed() {
    return Object.keys(this.named).sort();
  }

  loadPreset(name) {
    const fn = Tree.PRESETS[name];
    if (!fn) return;
    this.tree = fn();
    this.focusId = Tree.leaves(this.tree)[0]?.id || null;
    this._markBaseline("preset", name);
    this._emit();
  }
}
