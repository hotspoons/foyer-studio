// Layout persistence + named layout slots. EventTarget-shaped so components
// subscribe with addEventListener("change", …).

import * as Tree from "./tile-tree.js";
import { slotBounds } from "./slots.js";

/**
 * Sane first-open slot defaults per view, borrowed from pro-DAW
 * conventions:
 *
 * - **Mixer → right-half** — Pro Tools Mix window, Reaper mixer dock,
 *   Ardour's mixer-on-the-right default.
 * - **Timeline → left-half** — the companion surface; editor lives
 *   opposite the mixer so both can be open.
 * - **Plugins browser → left-third** — matches Ableton/Bitwig "devices
 *   panel on the side" affordance.
 * - **Session picker → right-third** — file-tree placement convention
 *   from IDEs and DAW browsers.
 * - **Preview → center** — text previews are transient, center of
 *   workspace is a reasonable short-lived spot.
 *
 * User can override via the re-slot menu; the override gets written
 * into `foyer.layout.sticky.<view>` and wins on subsequent opens.
 */
const DEFAULT_STICKY_SLOT = {
  mixer:    "right-half",
  timeline: "left-half",
  plugins:  "left-third",
  preview:  "center",
  // `session` removed: Projects is no longer a tile-class view, it's
  // a modal (project-picker-modal). Stickying it to a tile slot would
  // pin the modal to a workspace region — not what we want.
};

const CUR_KEY = "foyer.layout.current.v1";
const NAMED_KEY = "foyer.layout.named.v1";
const FOCUS_KEY = "foyer.layout.focus.v1";
const FLOAT_KEY = "foyer.layout.floating.v1";
const FAB_DOCK_KEY = "foyer.layout.dockedFabs.v1";
// Set of FAB ids whose dock state has been explicitly decided —
// either by a `defaultDocked` register (first-ever) or by a user
// dock/undock action. Gates the "default to docked" logic so we
// don't override a user's explicit undock on every reload.
const FAB_SEEN_KEY = "foyer.layout.fabSeen.v1";
const PLUGIN_FLOAT_KEY = "foyer.layout.pluginFloats.v1";
const PLUGIN_VIS_KEY = "foyer.layout.pluginFloatsVisible.v1";
// Widgets layer = the conceptual umbrella over plugin floats + free-
// floating tiles (track editor, beat sequencer, console, diagnostics,
// piano roll, …). Two boolean axes user-controllable from the dock:
//   · _widgetsVisible — the whole layer hides at once. Click on a tile
//     auto-hides the layer (modal-overlay feel) when not sticky.
//   · _widgetsSticky  — disables auto-hide. When sticky, the user
//     toggles the layer explicitly via the dock's show/hide button.
const WIDGETS_VIS_KEY    = "foyer.layout.widgetsVisible.v1";
const WIDGETS_STICKY_KEY = "foyer.layout.widgetsSticky.v1";

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
    // Migration: floats persisted before the kind discriminator existed
    // (DECISION 42, 4/24) have no `kind`. Re-classify the dialog-class
    // views explicitly so the widgets dock picks them up. Tile-class
    // views (mixer, timeline) default to "tile". Anything else missing
    // a kind is also treated as tile to preserve existing behavior.
    const WIDGET_VIEWS = new Set(["console", "diagnostics", "preview"]);
    for (const f of this._floating) {
      if (f.kind === "tile" || f.kind === "widget") continue;
      f.kind = WIDGET_VIEWS.has(f.view) ? "widget" : "tile";
    }
    // Console + Diagnostics moved out of the floating-tiles renderer
    // and into the shared foyer-window chrome on 2026-04-25 (Rich's
    // ask: identical chrome with track-editor, MIDI editor, beat
    // sequencer; idempotent open from the dock spawn menu). Drop any
    // stale `_floating` entry for those views — they'd otherwise
    // render with the OLD tile-class chrome (slot tag, dock-back,
    // duplicate title) alongside the new foyer-window when the user
    // re-opens.
    const STALE_VIEWS = new Set(["console", "diagnostics"]);
    this._floating = this._floating.filter((f) => !STALE_VIEWS.has(f.view));
    this._dockedFabs = (() => {
      try { return JSON.parse(localStorage.getItem(FAB_DOCK_KEY) || "{}") || {}; }
      catch { return {}; }
    })();
    this._dockSeen = (() => {
      try { return new Set(JSON.parse(localStorage.getItem(FAB_SEEN_KEY) || "[]")); }
      catch { return new Set(); }
    })();
    // Plugin floats live in their own layer (see
    // docs/DECISIONS.md #plugin-layer): separate from the tile grid and
    // the generic floating-tiles, never snapping to slots, auto-placed by
    // the packer. Array of { plugin_id, w, h }.
    this._pluginFloats = (() => {
      try { return JSON.parse(localStorage.getItem(PLUGIN_FLOAT_KEY) || "[]") || []; }
      catch { return []; }
    })();
    this._pluginFloatsVisible = (() => {
      try { return JSON.parse(localStorage.getItem(PLUGIN_VIS_KEY) || "true"); }
      catch { return true; }
    })();
    // Widgets-layer state — see comment at WIDGETS_*_KEY above. Default
    // visible + non-sticky so a fresh user sees their widgets but they
    // get out of the way the moment the user clicks back into a tile.
    this._widgetsVisible = (() => {
      try { return JSON.parse(localStorage.getItem(WIDGETS_VIS_KEY) ?? "true"); }
      catch { return true; }
    })();
    this._widgetsSticky = (() => {
      try { return JSON.parse(localStorage.getItem(WIDGETS_STICKY_KEY) ?? "false"); }
      catch { return false; }
    })();
    // Registry of FAB metadata keyed by FAB id — NOT persisted. Populated at
    // runtime by each QuadrantFab instance so the right-dock knows how to
    // render its rail icon and panel without a circular import.
    this._fabRegistry = new Map();
    // External widgets — windows that aren't rendered by the floating-tiles
    // or plugin-layer renderers. Track editor, MIDI editor, beat sequencer
    // all live inside <foyer-window> elements appended directly to
    // document.body and never join _floating. We still want them
    // listed + controlled by the widgets dock, so each foyer-window
    // registers itself here on connect. NOT persisted — these are
    // ephemeral per session.
    //   id  → { title, icon, focus(), close(), setMinimized(on), setHidden(on),
    //           tileTo(rect), minimized: bool }
    this._externalWidgets = new Map();
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
      localStorage.setItem(FAB_SEEN_KEY, JSON.stringify([...this._dockSeen]));
      localStorage.setItem(PLUGIN_FLOAT_KEY, JSON.stringify(this._pluginFloats));
      localStorage.setItem(PLUGIN_VIS_KEY, JSON.stringify(this._pluginFloatsVisible));
      localStorage.setItem(WIDGETS_VIS_KEY, JSON.stringify(this._widgetsVisible));
      localStorage.setItem(WIDGETS_STICKY_KEY, JSON.stringify(this._widgetsSticky));
    } catch {}
  }

  // ── widgets layer (umbrella over plugin floats + floating tiles) ──
  //
  // The layer's renderers (`<foyer-floating-tiles>`, `<foyer-plugin-layer>`)
  // observe `widgetsVisible()` and hide themselves wholesale when it's
  // false. The right-dock surfaces a dock UI that lets the user toggle
  // visibility, pin sticky, and run group operations (tile-all, min-all,
  // restore-all). A tile-leaf click auto-hides the layer when sticky is
  // off; with sticky on the user explicitly clicks the show/hide button.

  widgetsVisible() { return this._widgetsVisible; }
  widgetsSticky()  { return this._widgetsSticky; }

  setWidgetsVisible(v) {
    const next = !!v;
    if (this._widgetsVisible === next) return;
    this._widgetsVisible = next;
    this._emit();
  }
  toggleWidgetsVisible() { this.setWidgetsVisible(!this._widgetsVisible); }

  setWidgetsSticky(v) {
    const next = !!v;
    if (this._widgetsSticky === next) return;
    this._widgetsSticky = next;
    // Pinning sticky-ON also reveals the layer so the affordance is
    // immediate. Sticky-OFF leaves visibility alone — the user might
    // be unsticking specifically to let the next click auto-hide.
    if (next && !this._widgetsVisible) this._widgetsVisible = true;
    this._emit();
  }
  toggleWidgetsSticky() { this.setWidgetsSticky(!this._widgetsSticky); }

  /** Called from the global tile-click handler. No-op when sticky. */
  notifyTileClicked() {
    if (this._widgetsSticky) return;
    if (!this._widgetsVisible) return;
    this._widgetsVisible = false;
    this._emit();
  }

  /// Open widgets across all surfaces, normalized for the dock UI.
  /// Tile-class floating-tile entries (Mixer / Timeline tear-outs)
  /// are deliberately excluded — the widgets layer manages
  /// dialog-class windows only (DECISION 42).
  allWidgets() {
    const out = [];
    for (const f of this._floating) {
      if (f.kind !== "widget") continue;
      out.push({
        kind: "widget",
        id: f.id,
        view: f.view,
        minimized: !!f.minimized,
        z: f.z | 0,
      });
    }
    for (const p of this._pluginFloats) {
      out.push({
        kind: "plugin",
        id: p.plugin_id,
        view: "plugin_panel",
        minimized: false, // plugin layer doesn't have a minimize concept
        z: p.z | 0,
      });
    }
    for (const [id, meta] of this._externalWidgets) {
      out.push({
        kind: "external",
        id,
        view: meta.view || "widget",
        title: meta.title || "",
        icon: meta.icon || "document",
        minimized: !!meta.minimized,
        z: 0,
      });
    }
    return out;
  }

  // ── external widgets (foyer-window instances) ──────────────────────────

  registerExternalWidget(id, meta) {
    if (!id) return;
    this._externalWidgets.set(id, {
      title: meta?.title || "",
      icon: meta?.icon || "document",
      view: meta?.view || "widget",
      focus: typeof meta?.focus === "function" ? meta.focus : () => {},
      close: typeof meta?.close === "function" ? meta.close : () => {},
      setMinimized: typeof meta?.setMinimized === "function" ? meta.setMinimized : () => {},
      setHidden: typeof meta?.setHidden === "function" ? meta.setHidden : () => {},
      tileTo: typeof meta?.tileTo === "function" ? meta.tileTo : () => {},
      minimized: false,
    });
    if (!this._widgetsVisible) this._widgetsVisible = true;
    this._emit();
  }
  unregisterExternalWidget(id) {
    if (this._externalWidgets.delete(id)) this._emit();
  }
  externalWidget(id) { return this._externalWidgets.get(id) || null; }
  setExternalMinimized(id, on) {
    const w = this._externalWidgets.get(id);
    if (!w) return;
    const next = !!on;
    if (w.minimized === next) return;
    w.minimized = next;
    try { w.setMinimized(next); } catch {}
    this._emit();
  }

  /// Re-pack: widget-kind tiles + external widgets get tiled into a
  /// grid that prefers the workspace's aspect ratio — wider workspaces
  /// get more columns, taller workspaces get more rows. Tile-class
  /// floats are NOT touched (they belong to the mature tile-grid
  /// surface and the widgets dock has no authority there). Plugin
  /// floats run their own packer every render so this is a no-op for
  /// them.
  tileAllWidgets() {
    const ws =
      (typeof window !== "undefined" && window.__foyer?.workspaceRect)
        ? window.__foyer.workspaceRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    const wsW = Math.max(120, (ws.right ?? 0) - (ws.left ?? 0));
    const wsH = Math.max(120, (ws.bottom ?? 0) - (ws.top ?? 0));
    const internal = this._floating.filter((f) => f.kind === "widget" && !f.minimized);
    const external = [...this._externalWidgets.entries()].filter(([, w]) => !w.minimized);
    const total = internal.length + external.length;
    if (total > 0) {
      // Pick (cols, rows) that best fills the workspace, balancing
      // three costs:
      //   · `empties` — wasted cells (cols·rows − total)
      //   · `stretchPen` — cells that exceed ~2:1 aspect (very narrow
      //     or very wide cells make awful windows)
      //   · `aspectDist` — distance between cell aspect and workspace
      //     aspect, so 16:9 workspaces favor wider grids
      // Lower score = better. Picks 3×1 for n=3 wide (no waste, even
      // though 2×2 would match workspace aspect more closely with one
      // empty), and 3×2 for n=5 wide (1 empty preferred over 5×1
      // pencil-thin cells).
      const wsAspect = wsW / wsH;
      const STRETCH_GATE = Math.log(2); // cells past 2:1 in either dimension
      let best = { cols: 1, rows: total, score: Infinity };
      for (let cols = 1; cols <= total; cols++) {
        const rows = Math.ceil(total / cols);
        const cellAspect = (wsW / cols) / (wsH / rows);
        const empties = cols * rows - total;
        const stretchPen = Math.max(0, Math.abs(Math.log(cellAspect)) - STRETCH_GATE) * 5;
        const aspectDist = Math.abs(Math.log(cellAspect / wsAspect));
        const score = empties * 1.5 + stretchPen + aspectDist;
        if (score < best.score) best = { cols, rows, score };
      }
      const { cols, rows } = best;
      const cellW = Math.floor(wsW / cols);
      const cellH = Math.floor(wsH / rows);
      internal.sort((a, b) => (a.z | 0) - (b.z | 0));
      let i = 0;
      for (const f of internal) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        f.x = (ws.left ?? 0) + c * cellW;
        f.y = (ws.top ?? 0) + r * cellH;
        f.w = cellW;
        f.h = cellH;
        f.slot = null;
        i++;
      }
      for (const [, w] of external) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        try {
          w.tileTo({
            x: (ws.left ?? 0) + c * cellW,
            y: (ws.top ?? 0) + r * cellH,
            w: cellW,
            h: cellH,
          });
        } catch {}
        i++;
      }
    }
    this._emit();
  }

  minimizeAllWidgets() {
    let touched = false;
    for (const f of this._floating) {
      if (f.kind !== "widget") continue;
      if (!f.minimized) { f.minimized = true; touched = true; }
    }
    for (const [, w] of this._externalWidgets) {
      if (!w.minimized) {
        w.minimized = true;
        try { w.setMinimized(true); } catch {}
        touched = true;
      }
    }
    // Plugin floats don't have a minimize state; the layer-wide
    // visibility flag is their analogue. Hiding the layer entirely
    // rather than per-plugin keeps the existing pluginFloats invariant
    // (open-set persistence) intact.
    if (touched) this._emit();
  }

  restoreAllWidgets() {
    let touched = false;
    for (const f of this._floating) {
      if (f.kind !== "widget") continue;
      if (f.minimized) { f.minimized = false; touched = true; }
    }
    for (const [, w] of this._externalWidgets) {
      if (w.minimized) {
        w.minimized = false;
        try { w.setMinimized(false); } catch {}
        touched = true;
      }
    }
    if (!this._widgetsVisible) {
      this._widgetsVisible = true; touched = true;
    }
    if (touched) this._emit();
  }

  // ── docked FABs ────────────────────────────────────────────────────────

  /**
   * Components (QuadrantFab instances) register themselves so the right-dock
   * can render their rail icon + call back into them without a circular
   * import OR a `document.querySelector` that can't pierce shadow roots.
   *
   * - `meta` carries `{ label, icon, dockWidth, expandsRail, accent }`.
   * - `instance` is the component element itself; used by right-dock to
   *   call `toggleFromDock()` / `openFromDock()` / `closeFromDock()`.
   */
  registerFab(id, meta, instance) {
    this._fabRegistry.set(id, { meta: meta || {}, instance: instance || null });
    // First-ever sighting of a FAB with `defaultDocked: true` seeds
    // it into the docked set. Subsequent reloads stay out of the
    // user's way — `_dockSeen` records every id whose dock state has
    // been deliberately decided (either by this seed or by a user
    // dock/undock), so nothing here will override an explicit choice.
    if (meta?.defaultDocked && !this._dockSeen.has(id) && !this._dockedFabs[id]) {
      this._dockedFabs[id] = true;
      this._dockSeen.add(id);
    }
    this._emit();
  }
  unregisterFab(id) {
    this._fabRegistry.delete(id);
    this._emit();
  }
  fabMeta(id) {
    return this._fabRegistry.get(id)?.meta || {};
  }
  fabInstance(id) {
    return this._fabRegistry.get(id)?.instance || null;
  }

  /** Is this FAB currently docked to the right rail? */
  isFabDocked(id) {
    return !!this._dockedFabs[id];
  }

  dockFab(id) {
    this._dockSeen.add(id);
    if (this._dockedFabs[id]) return;
    this._dockedFabs[id] = true;
    this._emit();
  }

  undockFab(id) {
    this._dockSeen.add(id);
    if (!this._dockedFabs[id]) {
      // Still persist the `_dockSeen` update so a later register
      // with `defaultDocked` doesn't re-seed.
      this._emit();
      return;
    }
    delete this._dockedFabs[id];
    this._emit();
  }

  /** List of { id, meta } for every docked FAB, filtered to those with registered metadata. */
  dockedFabs() {
    return Object.keys(this._dockedFabs)
      .filter((id) => this._fabRegistry.has(id))
      .map((id) => ({ id, meta: this._fabRegistry.get(id).meta }));
  }

  // ── plugin floats ──────────────────────────────────────────────────────
  //
  // Plugin windows live on their own layer (see DECISIONS #12). They never
  // participate in the slot grid; the packer auto-places them in unused
  // workspace space. Global show/hide toggles every plugin window at once,
  // preserving their set for "bring them all back" workflows.

  pluginFloats() {
    return this._pluginFloats.slice();
  }
  pluginFloatsVisible() {
    return this._pluginFloatsVisible;
  }

  openPluginFloat(plugin_id, size) {
    if (this._pluginFloats.some((p) => p.plugin_id === plugin_id)) {
      // Already open — nop. A `raise` could bump ordering later.
      return;
    }
    const w = Math.max(160, size?.w ?? 320);
    const h = Math.max(120, size?.h ?? 360);
    this._pluginFloats.push({ plugin_id, w, h, x: null, y: null });
    this._emit();
  }

  closePluginFloat(plugin_id) {
    const before = this._pluginFloats.length;
    this._pluginFloats = this._pluginFloats.filter((p) => p.plugin_id !== plugin_id);
    if (this._pluginFloats.length !== before) this._emit();
  }

  /** Let a plugin panel report its natural size after first render so the
   *  packer can place it accurately on the next pass. */
  setPluginFloatSize(plugin_id, w, h) {
    const entry = this._pluginFloats.find((p) => p.plugin_id === plugin_id);
    if (!entry) return;
    const nw = Math.max(160, Math.round(w));
    const nh = Math.max(120, Math.round(h));
    if (entry.w === nw && entry.h === nh) return;
    entry.w = nw;
    entry.h = nh;
    this._emit();
  }

  setPluginFloatPosition(plugin_id, x, y) {
    const entry = this._pluginFloats.find((p) => p.plugin_id === plugin_id);
    if (!entry) return;
    const nx = Math.round(Number(x));
    const ny = Math.round(Number(y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    if (entry.x === nx && entry.y === ny) return;
    entry.x = nx;
    entry.y = ny;
    this._emit();
  }

  togglePluginFloats() {
    this._pluginFloatsVisible = !this._pluginFloatsVisible;
    this._emit();
  }
  setPluginFloatsVisible(on) {
    this._pluginFloatsVisible = !!on;
    this._emit();
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
    // If caller didn't specify a placement, prefer the user's sticky slot
    // for this view, then fall back to the project-level sane default
    // (cribbed from Pro Tools / Reaper / Ableton conventions).
    if (!placement) {
      const sticky = this.stickySlotFor(view) || DEFAULT_STICKY_SLOT[view];
      if (sticky) placement = { slot: sticky };
    }
    const id = this._pushFloat(view, props, placement);
    this._emit();
    return id;
  }

  _pushFloat(view, props, placement, kind = "tile") {
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
      // Discriminator for the widgets layer (DECISION 42). `tile`
      // entries are tear-outs of the mature tile-class views (Mixer,
      // Timeline) and never participate in the widgets layer's
      // visibility / sticky / dock controls. `widget` entries are
      // dialog-class tools (Console, Diagnostics, Track editor,
      // Beat sequencer, …) and are the ONLY things the widgets dock
      // lists or hides.
      kind: kind === "widget" ? "widget" : "tile",
      // Remember the last slot for "sticky sizing" — next open of the same
      // view lands in the same slot if no explicit placement is requested.
      slot: typeof placement === "object" && placement?.slot ? placement.slot : null,
    });
    this._rememberSlot(view, placement);
    return id;
  }

  /// Spawn a widget-class float (Console, Diagnostics, etc.). Mirrors
  /// `openFloat` but tags the entry as `kind: "widget"` so the widgets
  /// dock + visibility flag pick it up.
  openWidget(view, props = {}, placement = null) {
    const id = this._pushFloat(view, props, placement, "widget");
    // Auto-reveal the widgets layer when something spawns into it.
    if (!this._widgetsVisible) this._widgetsVisible = true;
    this._emit();
    return id;
  }

  /** Bring a floating window to the front (highest z). */
  raiseFloat(id) {
    const f = this._floating.find((x) => x.id === id);
    if (!f) return;
    f.z = this._nextZ();
    this._emit();
  }

  /** Bring a plugin window to the front within the plugin layer. */
  raisePluginFloat(plugin_id) {
    const p = this._pluginFloats.find((x) => x.plugin_id === plugin_id);
    if (!p) return;
    p.z = this._nextPluginZ();
    this._emit();
  }

  _nextPluginZ() {
    let max = 0;
    for (const p of this._pluginFloats) if ((p.z | 0) > max) max = p.z | 0;
    return max + 1;
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

  /** Compute a rect from a placement specifier against the current workspace. */
  _placementRect(placement) {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 720;
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
        // pad=0: docked windows sit flush against workspace edges.
        const r = slotBounds(placement.slot);
        if (r) return r;
      }
    }
    // Default cascade — open near the top-left of the workspace.
    const ws =
      typeof window !== "undefined" && window.__foyer?.workspaceRect
        ? window.__foyer.workspaceRect()
        : { top: 0, left: 0, right: vw, bottom: vh };
    const n = this._floating.length;
    return {
      x: Math.min((ws.right ?? vw) - 560, (ws.left ?? 0) + 120 + n * 32),
      y: Math.min((ws.bottom ?? vh) - 380, (ws.top ?? 0) + 120 + n * 32),
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

  closeFocused(opts = {}) {
    if (!this.focusId) return;
    const next = Tree.removeNode(this.tree, this.focusId);
    if (next) {
      this.tree = next;
      this.focusId = Tree.leaves(next)[0]?.id || null;
    } else if (opts.keepAlive) {
      // Opt-in backfill when the caller specifically wants to guarantee
      // a non-empty workspace. Default is to let the tree go empty and
      // let the tile-container placeholder ("Workspace is empty — use
      // the New menu") do its job.
      this.tree = Tree.defaultTree();
      this.focusId = Tree.leaves(this.tree)[0]?.id || null;
    } else {
      this.tree = null;
      this.focusId = null;
    }
    this._emit();
  }

  /**
   * Low-level remove that mirrors `closeFocused({ allowEmpty: true })`
   * without assuming the current focus — used by the tear-out pipeline
   * which needs to remove an explicit leaf id and always permit emptiness.
   */
  removeLeaf(leafId, opts = { allowEmpty: true }) {
    if (!leafId) return;
    const next = Tree.removeNode(this.tree, leafId);
    if (next) {
      this.tree = next;
      if (!Tree.leaves(next).some((l) => l.id === this.focusId)) {
        this.focusId = Tree.leaves(next)[0]?.id || null;
      }
    } else if (opts.allowEmpty) {
      this.tree = null;
      this.focusId = null;
    } else {
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
      // Preset/named switches are workspace-level swaps: clear generic
      // floating tiles so stale detached windows from the old layout
      // don't hang around on top of the new one.
      this._floating = [];
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
    // Keep tile-class windows tied to the active layout identity.
    this._floating = [];
    this._markBaseline("preset", name);
    this._emit();
  }
}
