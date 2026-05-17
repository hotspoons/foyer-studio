// Right-hand dock region. Two co-existing surfaces:
//
//   1. **Slide-out panel** for docked FABs (Chat, Layouts, Windows).
//      Tap a docked FAB icon → the dock's `_open` flips true, `_panel`
//      records `fab:<id>`, and a left-of-rail panel renders the FAB's
//      `dockPanelContent()`. The panel takes real workspace width via
//      `width:<n>px` so the tile grid reflows around it (resizable
//      via the strip on its left edge). This is the design we ran on
//      the 4/22 build; the brief experiment with pos:fixed per-FAB
//      popovers ("Dock overhaul" 4/24) lost too much polish, so we
//      restored this version.
//
//   2. **Widgets dock** (lower in the rail) — the hub for the
//      widgets layer (plugin floats + free-floating tiles). Hosts
//      visibility / sticky toggles, group controls (tile-all, min-all,
//      restore-all), the open-widget list, and a "+" spawn menu for
//      Console / Diagnostics / Plugins.
//
// Both persist in localStorage independently.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import { openWindow, registerWindowKind, spawnWindowKind } from "foyer-ui-core/widgets/window.js";
import { findRegion as _findRegionInCache } from "foyer-core/region-cache.js";
import { isAllowed } from "foyer-core/rbac.js";

// Persistence factories: replayed on reload by `rehydrateWindows()` so
// Console + Diagnostics come back exactly the way `_floating` used to
// remember them before they moved to the foyer-window chrome.
const _spawnConsole = () => {
  const el = document.createElement("foyer-console-view");
  openWindow({
    title: "Console", icon: "command-line", storageKey: "console-widget",
    content: el, width: 720, height: 480,
    persist: { kind: "console", id: "console", props: {} },
    viewKind: "console",
    viewProps: {},
  });
};
const _spawnDiagnostics = () => {
  const el = document.createElement("foyer-diagnostics");
  openWindow({
    title: "Diagnostics", icon: "check-circle", storageKey: "diagnostics-widget",
    content: el, width: 720, height: 520,
    persist: { kind: "diagnostics", id: "diagnostics", props: {} },
    viewKind: "diagnostics",
    viewProps: {},
  });
};
const _spawnMidiDevices = () => {
  const el = document.createElement("foyer-midi-devices-panel");
  openWindow({
    title: "MIDI Devices", icon: "musical-note", storageKey: "midi-devices-widget",
    content: el, width: 540, height: 460,
    persist: { kind: "midi-devices", id: "midi-devices", props: {} },
    viewKind: "midi-devices",
    viewProps: {},
  });
};
const _spawnSoftKeyboard = () => {
  const el = document.createElement("foyer-soft-keyboard");
  openWindow({
    title: "On-screen Keyboard", icon: "musical-note", storageKey: "soft-keyboard-widget",
    content: el, width: 720, height: 260,
    persist: { kind: "soft-keyboard", id: "soft-keyboard", props: {} },
    viewKind: "soft-keyboard",
    viewProps: {},
  });
};
// Spectrum analyser. Same "single floater per kind" rule as the
// other workspace widgets — re-opening returns the existing window.
// The tile-class registration in widget-tile-views.js still works
// for dragging it into the tile grid; this registration just adds
// the "+ launcher" / docked-window codepath.
const _spawnSpectrum = (props = {}) => {
  import("./spectrum-tile.js").then(() => {
    const el = document.createElement("foyer-spectrum-tile");
    if (props.target) el.target = props.target;
    openWindow({
      title: "Spectrum",
      icon: "chart-bar",
      storageKey: "spectrum-widget",
      content: el,
      width: 760,
      height: 520,
      persist: { kind: "spectrum", id: "spectrum", props: {} },
      viewKind: "spectrum",
      viewProps: {},
    });
  });
};
// Lazy-import the scripts view so the hljs + grammar bundle stays out
// of the boot path. Users who never open the Scripts panel don't pay.
const _spawnScripts = () => {
  import("./scripts-view.js").then(() => {
    const el = document.createElement("foyer-scripts-view");
    openWindow({
      title: "Scripts", icon: "document-text", storageKey: "scripts-widget",
      content: el, width: 900, height: 600,
      persist: { kind: "scripts", id: "scripts", props: {} },
      viewKind: "scripts",
      viewProps: {},
    });
  });
};
registerWindowKind("console", _spawnConsole, {
  label: "Console",
  description: "Logs + diagnostic output. No viz fallback.",
});
registerWindowKind("diagnostics", _spawnDiagnostics, {
  label: "Diagnostics",
  description: "Engine / WS / RBAC live state. No viz fallback.",
});
registerWindowKind("midi-devices", _spawnMidiDevices, {
  label: "MIDI devices",
  description: "Connected MIDI in/out ports + monitor.",
});
registerWindowKind("soft-keyboard", _spawnSoftKeyboard, {
  label: "Soft keyboard",
  description: "On-screen piano keyboard for MIDI input.",
});
registerWindowKind("scripts", _spawnScripts, {
  label: "Scripts",
  description: "Host-script editor (Lua under Ardour).",
});
registerWindowKind("spectrum", _spawnSpectrum, {
  label: "Spectrum",
  description: "Real-time FFT analyser + waterfall. Per-target picker for master / monitor / individual tracks.",
});

// Track Editor / MIDI Editor / Beat Sequencer factories. The heavy
// editor modules are lazy-imported at rehydrate time so we don't drag
// them into the boot path, but they register here so the kind is known
// before the session has even loaded.
registerWindowKind("track-editor", (props) => {
  if (!props?.trackId) return;
  import("./track-editor-modal.js").then((m) => {
    m.openTrackEditor(props.trackId, { tab: props.tab || "" });
  });
}, {
  label: "Track editor",
  description: "Per-track inspector + plugin chain editor.",
  viz_fallback: "mixer",
});

function _findRegion(regionId) {
  // Regions don't live on the session snapshot — they're only in the
  // global region cache (populated by the WS envelope stream). The
  // earlier `session.tracks[].regions[]` lookup always returned null,
  // so MIDI editor / beat sequencer rehydration silently no-op'd.
  // (Rich, 2026-04-26.)
  const hit = _findRegionInCache(regionId);
  return hit ? { region: hit.region, trackId: hit.track_id } : null;
}

function _findPlugin(pluginId) {
  const session = window.__foyer?.store?.state?.session;
  if (!session) return null;
  for (const t of session.tracks || []) {
    for (const p of t.plugins || []) {
      if (p.id === pluginId) return p;
    }
  }
  return null;
}

registerWindowKind("plugin", (props) => {
  const p = props?.pluginId ? _findPlugin(props.pluginId) : null;
  if (!p) return;
  import("foyer-ui-core/layout/plugin-layer.js").then((m) => m.openPluginFloat(p));
}, {
  label: "Plugin panel",
  description: "One plugin's params + native-GUI button. Use for plugins whose params aren't exposed over the schema (xpra native-GUI passthrough).",
});

function _retargetMidiEditor(editor, found) {
  if (!editor) return;
  editor.notes = Array.isArray(found.region.notes) ? found.region.notes : [];
  editor.regionId = found.region.id;
  editor.regionName = found.region.name || "";
  editor.sequencerLayout = found.region.foyer_sequencer || null;
  editor.readOnly = !!(found.region.foyer_sequencer && found.region.foyer_sequencer.active !== false);
  editor.trackId = found.trackId || "";
}

registerWindowKind("midi-editor", (props) => {
  const found = props?.regionId ? _findRegion(props.regionId) : null;
  if (!found) return;
  Promise.all([
    import("./midi-editor.js"),
    import("foyer-ui-core/widgets/window.js"),
  ]).then(([, winMod]) => {
    const editor = document.createElement("foyer-midi-editor");
    _retargetMidiEditor(editor, found);
    winMod.openWindow({
      title: `MIDI — ${found.region.name || found.region.id}`,
      icon: "sparkles",
      storageKey: "midi-editor",
      content: editor,
      width: 1040, height: 680,
      persist: { kind: "midi-editor", id: "midi-editor", props: { regionId: found.region.id } },
      viewKind: "midi-editor",
      viewProps: { regionId: found.region.id, trackId: found.trackId || "" },
      onReuse: (existing) => _retargetMidiEditor(existing, found),
    });
  });
}, {
  label: "Piano roll",
  description: "Per-region MIDI note editor. Variants without this kind support `visualize.midi_roll` as a read-only fallback.",
  viz_fallback: "midi_roll",
});

function _retargetBeatSequencer(seq, found) {
  if (!seq) return;
  seq.regionId = found.region.id;
  seq.regionName = found.region.name || "";
  seq.notes = Array.isArray(found.region.notes) ? found.region.notes : [];
  seq.layout = found.region.foyer_sequencer || null;
  seq._layoutFromBackend = !!found.region.foyer_sequencer;
  seq.trackId = found.trackId || "";
}

registerWindowKind("beat-sequencer", (props) => {
  const found = props?.regionId ? _findRegion(props.regionId) : null;
  if (!found) return;
  Promise.all([
    import("./beat-sequencer.js"),
    import("foyer-ui-core/widgets/window.js"),
  ]).then(([, winMod]) => {
    const seq = document.createElement("foyer-beat-sequencer");
    _retargetBeatSequencer(seq, found);
    winMod.openWindow({
      title: `Beat — ${found.region.name || found.region.id}`,
      icon: "queue-list",
      storageKey: "beat-sequencer",
      content: seq,
      width: 1100, height: 560,
      persist: { kind: "beat-sequencer", id: "beat-sequencer", props: { regionId: found.region.id } },
      viewKind: "beat-sequencer",
      viewProps: { regionId: found.region.id, trackId: found.trackId || "" },
      onReuse: (existing) => _retargetBeatSequencer(existing, found),
    });
  });
}, {
  label: "Beat sequencer",
  description: "Cell-grid drum / pattern authoring. Variants without this kind support `visualize.beat_sequencer` as a read-only fallback.",
  viz_fallback: "beat_sequencer",
});

const PANEL_KEY = "foyer.rightdock.v1";
/// Slide-out persistence: which docked FAB was last expanded into
/// the slide column. Separate key so a one-shot wipe doesn't reset
/// the dock's geometry (`PANEL_KEY`). `{open: bool, fabId: string}`.
const SLIDE_STATE_KEY = "foyer.rightdock.slide.v1";

function loadPanelState() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) || "{}") || {}; }
  catch { return {}; }
}
function savePanelState(s) {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(s)); } catch {}
}
function loadSlideState() {
  try { return JSON.parse(localStorage.getItem(SLIDE_STATE_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveSlideState(open, fabId) {
  try {
    localStorage.setItem(
      SLIDE_STATE_KEY,
      JSON.stringify({ open: !!open, fabId: fabId || "" }),
    );
  } catch {}
}

const VIEW_ICON = {
  mixer: "adjustments-horizontal",
  timeline: "list-bullet",
  plugins: "puzzle-piece",
  preview: "document",
  plugin_panel: "puzzle-piece",
  console: "command-line",
  diagnostics: "check-circle",
  track_editor: "wrench-screwdriver",
  beat_sequencer: "musical-note",
  piano_roll: "musical-note",
  scripts: "document-text",
};

// Spawnable widget types — surfaced through the dock's "+" menu so
// they can be opened without going through the top-level Launch
// picker. Order here is what the menu shows. These open as
// `kind: "widget"` floats, which means they participate in the
// widgets layer's visibility / sticky / dock controls. Tile-class
// views (Mixer, Timeline) stay in the top "+ New" menu and are
// handled by the tile grid, not this dock.
// The + launcher catalog. Sections render as visual groups with a
// header label in the menu. Each entry either:
//   · names a `view` registered via `registerWindowKind` (Console,
//     Diagnostics, Scripts, MIDI Devices, On-screen Keyboard) — these
//     spawn a foyer-window, persist across reload, and dock-icon when
//     minimized; OR
//   · provides an `open()` callback (modals like Audio Pool,
//     Preferences, Group Manager, Remote Access). Modals are one-
//     shot — they don't persist, don't dock, don't show up in the
//     widgets dock.
//
// `requires(state)` is the optional gate. Returns falsy to suppress
// the row — used for capability gating (Scripts only when the
// backend advertises a scripting surface) and RBAC gating (audio
// pool needs `list_audio_pool`, Remote Access needs
// `tunnel_create_token`).
const SPAWNABLE_WIDGETS = [
  { group: "Workspace", view: "console",     label: "Console",     icon: "command-line" },
  { group: "Workspace", view: "diagnostics", label: "Diagnostics", icon: "check-circle" },
  { group: "Workspace", view: "spectrum",    label: "Spectrum",    icon: "chart-bar" },
  { group: "Workspace", view: "scripts",     label: "Scripts",     icon: "document-text",
    requires: (state) => !!state?.session?.scripting },

  { group: "Devices",   view: "midi-devices",  label: "MIDI Devices",      icon: "musical-note",
    requires: () => isAllowed("list_audio_pool") },
  { group: "Devices",   view: "soft-keyboard", label: "On-screen Keyboard", icon: "musical-note",
    requires: () => isAllowed("list_audio_pool") },
  { group: "Devices",   view: "audio-pool",    label: "Audio Pool",         icon: "musical-note",
    requires: () => isAllowed("list_audio_pool"),
    open: () => import("./audio-pool-modal.js").then((m) => m.openAudioPoolModal()) },

  { group: "Session",   view: "group-manager", label: "Group Manager",  icon: "users",
    open: () => import("./group-manager-modal.js").then((m) => m.openGroupManager()) },
  { group: "Session",   view: "remote-access", label: "Remote Access",  icon: "globe-alt",
    requires: () => isAllowed("tunnel_create_token") || isAllowed("tunnel_admin"),
    open: () => import("./tunnel-manager-modal.js").then((m) => m.openTunnelManager()) },
  { group: "Session",   view: "preferences",   label: "Preferences",    icon: "cog-6-tooth",
    open: () => import("./settings-modal.js").then((m) => m.openSettings()) },
];

export class RightDock extends LitElement {
  static properties = {
    _open:   { state: true, type: Boolean },
    _width:  { state: true, type: Number },
    _panel:  { state: true, type: String },
    _minimized: { state: true, type: Array },
    _widgets:   { state: true, type: Array },
    _spawnOpen: { state: true, type: Boolean },
    _dropHighlight: { state: true, type: Boolean },
    _slideOpen: { state: true, type: Boolean },
    _slideWidth: { state: true, type: Number },
    _slideFabId: { state: true, type: String },
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      display: flex;
      height: 100%;
      background: var(--color-surface);
      border-left: 1px solid var(--color-border);
    }
    .rail {
      display: flex; flex-direction: column; align-items: center;
      gap: 4px;
      padding: 8px 4px;
      background: var(--color-surface);
      border-left: 1px solid var(--color-border);
    }
    /* Spacer pushes the widgets dock to the bottom of the rail —
     * the FAB strip sits at the top, the widgets dock anchors at
     * the bottom, and the gap between them stretches with rail
     * height. Keeps the two control surfaces visually separated. */
    .rail-spacer {
      flex: 1 1 auto;
      min-height: 12px;
    }
    .rail button {
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .rail button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }
    .rail button.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }

    /* Drop-target hint when a window is being dragged. */
    :host([drop-ready]) .rail {
      outline: 2px dashed color-mix(in oklab, var(--color-accent) 60%, transparent);
      outline-offset: -2px;
    }
    /* Ghost FAB at the top of the rail — concrete "you'll land here"
     * target. The user drags toward this; releasing anywhere over
     * the rail (already widened via DOCK_HIT_SLACK_PX in QuadrantFab)
     * triggers the dock. Only shown while a drag is highlighting
     * the dock. Pointer-events: none so it doesn't intercept the
     * pointerup that the QuadrantFab listens for. */
    .dock-ghost {
      width: 32px; height: 32px;
      border-radius: 50%;
      border: 2px dashed var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 18%, transparent);
      display: flex; align-items: center; justify-content: center;
      color: color-mix(in oklab, var(--color-accent) 70%, var(--color-text));
      pointer-events: none;
      animation: dock-ghost-pulse 1.2s ease-in-out infinite;
      flex: 0 0 auto;
    }
    @keyframes dock-ghost-pulse {
      0%, 100% { transform: scale(1.0); opacity: 0.85; }
      50%      { transform: scale(1.08); opacity: 1.0; }
    }

    /* Divider between dock-icons (minimized floats) and primary rail buttons. */
    .rail-sep {
      width: 24px;
      height: 1px;
      background: var(--color-border);
      opacity: 0.5;
      margin: 4px 0;
    }
    .rail button.dock-icon {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      position: relative;
    }
    .rail button.dock-icon .fab-badge {
      position: absolute;
      top: -3px; right: -3px;
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      border-radius: 999px;
      background: var(--color-error, #ef4444);
      color: #fff;
      font: 9px/14px var(--font-sans);
      font-weight: 700;
      text-align: center;
      pointer-events: none;
    }

    /* Widgets dock — open-window list + group controls + sticky
     * toggle, sandwiched between the FAB rail and the minimized-
     * floats area. Buttons render the same shape as the rail's so
     * the strip reads as a vertical extension of the dock. */
    .widgets-dock {
      display: flex; flex-direction: column; align-items: center;
      gap: 4px;
    }
    .widgets-dock button.toggle-active {
      color: var(--color-accent);
      border-color: color-mix(in oklab, var(--color-accent) 50%, transparent);
    }
    .widgets-dock .open-list {
      display: flex; flex-direction: column; align-items: center;
      gap: 2px;
    }
    .widgets-dock .open-list button.minimized {
      opacity: 0.55;
    }
    .widgets-dock .group-controls {
      display: flex; flex-direction: column; align-items: center;
      gap: 2px;
    }
    .spawn-menu {
      position: absolute;
      right: calc(100% + 6px);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      padding: 4px;
      display: flex; flex-direction: column;
      gap: 2px;
      min-width: 160px;
      z-index: 1100;
    }
    .spawn-menu button {
      display: flex; align-items: center; gap: 8px;
      /* Explicit justify-content so the icon + label sit flush against
         the left padding instead of being centered by an inherited
         justify-content: center from a parent flex context (the rail
         buttons use that for their square icon tiles; without an
         explicit override these column-style buttons inherit the
         look). */
      justify-content: flex-start;
      width: 100%; height: auto;
      padding: 6px 10px;
      font: inherit; font-size: 12px;
      background: transparent;
      color: var(--color-text);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      cursor: pointer;
      text-align: left;
    }
    .spawn-menu .spawn-header {
      text-align: left;
    }
    .spawn-menu button:hover {
      background: color-mix(in oklab, var(--color-accent) 16%, var(--color-surface-elevated));
    }
    .spawn-header {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      padding: 4px 10px 2px;
    }
    .spawn-sep {
      height: 1px;
      background: var(--color-border);
      margin: 4px 0;
      opacity: 0.6;
    }
    .spawn-anchor { position: relative; }

    /* Slide-out container that hosts a slotted FAB. The FAB is moved
     * here from document.body via DOM reparenting so its own shadow-
     * root styles still apply when it renders content via slot. */
    .slide-out {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--color-border);
      background: var(--color-surface);
      min-width: 200px;
      overflow: hidden;
    }
    .slide-out ::slotted(*) { flex: 1; min-height: 0; }
    :host([collapsed]) { border-left: 0; }
    .panel {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--color-border);
      overflow: hidden;
      min-width: 180px;
      background: var(--color-surface);
    }
    .panel header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
      font-family: var(--font-sans); font-weight: 600;
    }
    .panel .content {
      flex: 1;
      overflow: auto;
      padding: 8px 10px;
      font-family: var(--font-sans);
    }
    /* When the FAB provides its own chrome, drop our padding so the
     * FAB's header sits flush against the panel edges and matches
     * its own internal styling. */
    .panel .content.owns-header {
      padding: 0;
    }
    .resize {
      width: 4px; cursor: col-resize;
      background: transparent;
    }
    .resize:hover { background: var(--color-accent); }
  `;

  constructor() {
    super();
    const s = loadPanelState();
    // Default-closed so a fresh user sees the full workspace. Tapping a
    // docked FAB icon opens its dock-panel; subsequent tapping toggles.
    this._open = !!s.open;
    this._width = s.width || 280;
    this._panel = s.panel || "";
    this._minimized = [];
    this._widgets = [];
    this._spawnOpen = false;
    this._dropHighlight = false;
    // Slide-out state. `_slideOpen` is the visibility flag, `_slideFabId`
    // is which docked FAB is currently slotted in. Width persists in
    // localStorage like the rest of the dock.
    this._slideOpen = false;
    this._slideFabId = "";
    try {
      this._slideWidth = parseInt(localStorage.getItem("foyer.rightdock.slide.w") || "320", 10);
    } catch { this._slideWidth = 320; }
    if (!Number.isFinite(this._slideWidth) || this._slideWidth < 200) this._slideWidth = 320;
    this._storeHandler = () => this.requestUpdate();
    this._layoutHandler = () => this._refreshMinimized();
    this._docPointerDown = (ev) => this._maybeCloseSpawnMenu(ev);
    this._updateAttrs();
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._storeHandler);
    window.__foyer?.layout?.addEventListener("change", this._layoutHandler);
    // Re-render rail icons whenever a new chat message arrives so the
    // unread badge on a docked chat FAB updates without waiting for an
    // unrelated store tick.
    window.__foyer?.chat?.addEventListener?.("change", this._storeHandler);
    document.addEventListener("pointerdown", this._docPointerDown, true);
    // Fab-driven slide-close (×/Undock on the panel header). The fab
    // dispatches `foyer:fab-slide-close` because its local `_open`
    // flag isn't what's keeping the slide column visible — our
    // `_slideOpen` is. Without this listener the X button looked
    // dead and Undock left an empty panel on screen with the
    // floating FAB stuck under it.
    this._slideCloseHandler = (ev) => {
      const id = ev.detail?.id;
      if (!id || id !== this._slideFabId) return;
      this._slideOpen = false;
      this._slideFabId = "";
      saveSlideState(false, "");
      this._announceDockChanged();
      this.requestUpdate();
    };
    window.addEventListener("foyer:fab-slide-close", this._slideCloseHandler);
    // Expose self on the global so shadow-DOM-hidden siblings (FABs,
    // tile-leaf tear-outs) can call methods on us without trying to
    // querySelector past a shadow root boundary.
    if (window.__foyer) window.__foyer.rightDock = this;
    this._refreshMinimized();
    // Restore slide-out if the user had one open before a page
    // refresh. The FAB instance may not be registered yet — it
    // mounts in its own connectedCallback, which may race ours.
    // Poll the layout's `fabInstance(id)` every animation frame
    // until either the fab shows up (and we open the slide) or a
    // short timeout elapses (the fab's UI variant might not be
    // registered in this build — drop the saved state so we don't
    // keep trying).
    const persisted = loadSlideState();
    if (persisted.open && persisted.fabId) {
      const target = persisted.fabId;
      const deadline = performance.now() + 5_000;
      const tryRestore = () => {
        if (this._slideOpen) return; // already restored / changed
        const layout = window.__foyer?.layout;
        if (layout?.fabInstance?.(target) && layout.isFabDocked?.(target)) {
          this._toggleSlideForFab(target);
          return;
        }
        if (performance.now() > deadline) {
          // Give up cleanly — the variant probably doesn't include
          // this fab. Don't clobber state in case the variant is
          // still loading in another tab.
          return;
        }
        requestAnimationFrame(tryRestore);
      };
      requestAnimationFrame(tryRestore);
    }
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._storeHandler);
    window.__foyer?.layout?.removeEventListener("change", this._layoutHandler);
    window.__foyer?.chat?.removeEventListener?.("change", this._storeHandler);
    document.removeEventListener("pointerdown", this._docPointerDown, true);
    if (this._slideCloseHandler) {
      window.removeEventListener("foyer:fab-slide-close", this._slideCloseHandler);
    }
    if (window.__foyer?.rightDock === this) window.__foyer.rightDock = null;
    super.disconnectedCallback();
  }

  _refreshMinimized() {
    const layout = window.__foyer?.layout;
    const entries = layout?.floating?.() || [];
    this._minimized = entries.filter((e) => e.minimized);
    // Open widgets across both layers (floating tiles + plugin floats).
    // The dock surfaces them all, regardless of which renderer paints
    // them, so the user has a single inventory + group-control surface.
    this._widgets = layout?.allWidgets?.() || [];
    // If a slide-out is currently open for a FAB that just got
    // undocked (via the panel's own tear-out button, a right-click
    // on the rail icon, etc.), close the slide and exit slide-mode
    // on that fab so we don't strand an empty panel hiding the
    // newly-floating FAB underneath.
    //
    // Key detail: read the raw dock flag via `isFabDocked` rather
    // than filtering `dockedFabs()` through the registry. When a
    // FAB enters slide-mode it gets reparented into our host, which
    // briefly fires disconnectedCallback → unregisterFab →
    // _emit() → us, then connectedCallback re-registers. During
    // that transient the registry-filtered list excludes the FAB
    // even though `_dockedFabs[id]` is still true; closing the
    // slide there is what caused the "click once to hide, twice to
    // show again" bug.
    if (this._slideOpen && this._slideFabId) {
      const stillDocked = !!layout?.isFabDocked?.(this._slideFabId);
      if (!stillDocked) {
        const fab = layout?.fabInstance?.(this._slideFabId);
        try { fab?.exitSlideMode?.(); } catch {}
        this._slideOpen = false;
        this._slideFabId = "";
        saveSlideState(false, "");
      }
    }
  }

  /** Spawn-menu dismissal: a pointerdown anywhere outside the menu
   *  closes it. Bound on connect, removed on disconnect. */
  _maybeCloseSpawnMenu(ev) {
    if (!this._spawnOpen) return;
    const path = ev.composedPath?.() || [];
    if (path.includes(this)) return;
    this._spawnOpen = false;
  }

  /** Rect of the rail, used by floating-tiles to hit-test for rail docking. */
  railRect() {
    const rail = this.renderRoot?.querySelector(".rail");
    return rail ? rail.getBoundingClientRect() : null;
  }

  /**
   * Rect of the ENTIRE right-dock surface, rail + expanded panel +
   * anything else we render. The workspace uses this to compute the
   * usable area — when the dock's panel opens, the workspace shrinks,
   * and docked floats re-flow to match.
   */
  outerRect() {
    return this.getBoundingClientRect();
  }

  setDropHighlight(on) {
    this._dropHighlight = !!on;
    if (on) this.setAttribute("drop-ready", "");
    else this.removeAttribute("drop-ready");
  }

  /** Minimize the given floating window and stash it in the rail. */
  dockFloat(id) {
    window.__foyer?.layout?.floatSet(id, { minimized: true });
  }

  /** Fire after any change that affects how much horizontal space the
   *  dock consumes, so layouts that reserve the workspace rect can
   *  reflow on this tick. Still useful for external listeners even
   *  though the rail itself no longer resizes — docked FAB panels
   *  appear to the left of the rail and may overlap with floats.
   */
  _announceDockChanged() {
    this.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, composed: true })
    );
    window.dispatchEvent(new CustomEvent("foyer:dock-resized"));
  }

  render() {
    // Slide-out + rail layout. The slide-out is a width-resizable
    // container hosting whatever docked FAB the user has activated;
    // the FAB physically reparents into a `<slot name="slide-out">`
    // inside this dock's host so the FAB's own shadow-root styles
    // still apply (no template-into-foreign-shadow-root mistake).
    // Rail itself stays at the right edge with the FAB icons +
    // widgets dock.
    const slidePx = this._slideOpen ? `width:${this._slideWidth}px` : "width:0";
    return html`
      ${this._slideOpen ? html`
        <div class="resize" @pointerdown=${(ev) => this._startResize(ev)}></div>
        <div class="slide-out" style=${slidePx}>
          <slot name="slide-out"></slot>
        </div>
      ` : null}
      <div class="rail">
        ${this._dropHighlight ? html`
          <div class="dock-ghost" title="Release here to dock">
            ${icon("arrow-down", 16)}
          </div>
        ` : null}
        ${this._renderWidgetsDock({ leadingSep: false })}
        <div class="rail-spacer"></div>
        ${this._renderDockedFabs({ leadingSep: false })}
      </div>
    `;
  }

  // ── slide-out panel ─────────────────────────────────────────────

  _updateAttrs() {
    if (this._open) this.removeAttribute("collapsed");
    else this.setAttribute("collapsed", "");
  }

  _persistPanel() {
    savePanelState({ open: this._open, width: this._width, panel: this._panel });
  }

  /// Toggle the dock-panel for a given key. Tapping the same FAB
  /// twice closes; tapping a different FAB swaps content without
  /// flickering closed.
  _togglePanel(panelKey) {
    if (this._open && this._panel === panelKey) {
      this._open = false;
    } else {
      this._open = true;
      this._panel = panelKey;
    }
    this._updateAttrs();
    this._persistPanel();
    this._announceDockChanged();
  }

  _toggleSlideForFab(id) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const fab = layout.fabInstance?.(id);
    if (!fab) return;
    if (this._slideOpen && this._slideFabId === id) {
      // Same FAB tapped twice — close. `exitSlideMode` deliberately
      // leaves `_open` alone (the tear-out flow relies on it staying
      // true), so we explicitly close here.
      try { fab.exitSlideMode?.(); } catch {}
      fab._open = false;
      try { fab._persist?.(); } catch {}
      fab.requestUpdate?.();
      this._slideOpen = false;
      this._slideFabId = "";
      saveSlideState(false, "");
      this._announceDockChanged();
      return;
    }
    // Switch — exit any prior fab's slide mode, then enter the new one.
    if (this._slideFabId && this._slideFabId !== id) {
      const prev = layout.fabInstance?.(this._slideFabId);
      try { prev?.exitSlideMode?.(); } catch {}
      if (prev) {
        prev._open = false;
        try { prev._persist?.(); } catch {}
        prev.requestUpdate?.();
      }
    }
    this._slideOpen = true;
    this._slideFabId = id;
    saveSlideState(true, id);
    // Defer reparent until after our next render so the slot exists.
    this.requestUpdate();
    queueMicrotask(() => {
      try { fab.enterSlideMode?.(this); } catch (e) { console.warn("slide-mode enter failed", e); }
      try { fab.onDockPanelOpen?.(); } catch {}
      this._announceDockChanged();
    });
  }

  _startResize(ev) {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = this._slideOpen ? this._slideWidth : this._width;
    const move = (e) => {
      const dx = startX - e.clientX;
      const next = Math.max(200, Math.min(640, startW + dx));
      if (this._slideOpen) this._slideWidth = next;
      else this._width = next;
      this._announceDockChanged();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        if (this._slideOpen) localStorage.setItem("foyer.rightdock.slide.w", String(this._slideWidth));
      } catch {}
      this._persistPanel();
      this._announceDockChanged();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /// Render the active panel's content. Delegates to the FAB's
  /// `dockPanelContent()` (or `_renderPanelContent()`). The slide-out
  /// only adds its own `<header>` when the FAB doesn't bring one
  /// (`dockPanelHasOwnHeader() === false`); otherwise we trust the
  /// FAB's chrome and avoid the double-header glitch.
  _renderPanel() {
    if (!this._panel?.startsWith("fab:")) return null;
    const id = this._panel.slice(4);
    const layout = window.__foyer?.layout;
    const fab = layout?.fabInstance?.(id);
    const meta = layout?.fabMeta?.(id) || {};
    if (!fab) return html`<header>${meta.label || id}</header>`;
    const content =
      typeof fab.dockPanelContent === "function"
        ? fab.dockPanelContent()
        : typeof fab._renderPanelContent === "function"
          ? fab._renderPanelContent()
          : html``;
    const ownsHeader = typeof fab.dockPanelHasOwnHeader === "function"
      && fab.dockPanelHasOwnHeader();
    if (ownsHeader) {
      // FAB renders its own chrome — slide-out is a transparent
      // frame. The body div still scrolls + pads but no extra header.
      return html`<div class="content owns-header">${content}</div>`;
    }
    return html`
      <header>${meta.label || id}</header>
      <div class="content">${content}</div>
    `;
  }

  // ── widgets dock ─────────────────────────────────────────────────
  //
  // Sandwiched between the FAB rail and the legacy minimized-floats
  // rail. Lists every open widget (floating tile OR plugin float)
  // and exposes group operations + the visibility/sticky toggles.

  _renderWidgetsDock({ leadingSep = true } = {}) {
    const layout = window.__foyer?.layout;
    if (!layout) return null;
    const visible = layout.widgetsVisible?.() ?? true;
    const sticky  = layout.widgetsSticky?.()  ?? false;
    const widgets = (this._widgets || []).slice().sort((a, b) => (b.z | 0) - (a.z | 0));
    return html`
      ${leadingSep ? html`<div class="rail-sep"></div>` : null}
      <div class="widgets-dock">
        <button
          class=${visible ? "toggle-active" : ""}
          title=${visible ? "Hide widgets layer" : "Show widgets layer"}
          @click=${() => layout.toggleWidgetsVisible()}
        >${icon(visible ? "eye" : "eye-slash", 16)}</button>
        <button
          class=${sticky ? "toggle-active" : ""}
          title=${sticky ? "Sticky on — clicking a tile won't hide widgets" : "Sticky off — click a tile to hide widgets"}
          @click=${() => layout.toggleWidgetsSticky()}
        >${icon(sticky ? "lock-closed" : "lock-open", 16)}</button>
        <button
          title="Tile all widgets"
          ?disabled=${widgets.length === 0}
          @click=${() => layout.tileAllWidgets()}
        >${icon("squares-2x2", 16)}</button>
        <div class="spawn-anchor">
          <button
            title="Spawn a widget"
            @click=${(ev) => { ev.stopPropagation(); this._spawnOpen = !this._spawnOpen; }}
          >${icon("plus", 16)}</button>
          ${this._spawnOpen ? this._renderSpawnMenu() : null}
        </div>

        ${widgets.length > 0 ? html`<div class="rail-sep"></div>` : null}
        <div class="open-list">
          ${widgets.map((w) => this._renderWidgetIcon(w))}
        </div>

        ${widgets.length > 0 ? html`<div class="rail-sep"></div>` : null}
        <div class="group-controls">
          <button
            title="Restore all widgets"
            ?disabled=${widgets.length === 0}
            @click=${() => layout.restoreAllWidgets()}
          >${icon("arrows-pointing-out", 14)}</button>
        </div>
      </div>
    `;
  }

  _renderWidgetIcon(w) {
    const fallback = w.kind === "external" ? (w.icon || "document") : "document";
    const ic = VIEW_ICON[w.view] || fallback;
    const cls = w.minimized ? "dock-icon minimized" : "dock-icon";
    if (w.kind === "tile") {
      return html`
        <button
          class=${cls}
          title=${this._titleForWidget(w)}
          @click=${() => this._focusTileWidget(w)}
          @contextmenu=${(ev) => this._onTileWidgetContext(ev, w)}
        >${icon(ic, 16)}</button>
      `;
    }
    // External widget (foyer-window). Plugins, track editor, MIDI
    // editor, beat sequencer, console, diagnostics all flow through
    // here on the same code path.
    return html`
      <button
        class=${cls}
        title=${`${w.title || w.view} · click to ${w.minimized ? "restore" : "focus"} · right-click to close`}
        @click=${() => this._focusExternalWidget(w)}
        @contextmenu=${(ev) => this._onExternalWidgetContext(ev, w)}
      >${icon(ic, 16)}</button>
    `;
  }

  _focusExternalWidget(w) {
    const layout = window.__foyer?.layout;
    const ew = layout?.externalWidget?.(w.id);
    if (!ew) return;
    if (w.minimized) layout.setExternalMinimized(w.id, false);
    try { ew.focus(); } catch {}
  }
  _onExternalWidgetContext(ev, w) {
    ev.preventDefault();
    const ew = window.__foyer?.layout?.externalWidget?.(w.id);
    try { ew?.close?.(); } catch {}
  }

  _renderSpawnMenu() {
    const state = window.__foyer?.store?.state;
    const visible = SPAWNABLE_WIDGETS.filter((s) => !s.requires || s.requires(state));
    // Group entries while preserving the catalog order. A `null` group
    // is rendered ungrouped (no header) for back-compat with any future
    // entry that doesn't opt in.
    const byGroup = new Map();
    for (const s of visible) {
      const k = s.group || "";
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(s);
    }
    return html`
      <div class="spawn-menu" @click=${(ev) => ev.stopPropagation()}>
        ${[...byGroup.entries()].map(([groupLabel, items], idx) => html`
          ${groupLabel && idx > 0 ? html`<div class="spawn-sep"></div>` : null}
          ${groupLabel ? html`<div class="spawn-header">${groupLabel}</div>` : null}
          ${items.map((s) => html`
            <button @click=${() => this._spawnWidget(s)}>
              ${icon(s.icon, 14)} ${s.label}
            </button>
          `)}
        `)}
      </div>
    `;
  }

  _spawnWidget(entry) {
    this._spawnOpen = false;
    // Modal-style entries provide their own `open()` (Audio Pool,
    // Preferences, Group Manager, Remote Access). Window-style entries
    // (Console, Diagnostics, Scripts, MIDI Devices, On-screen
    // Keyboard) name a registered `view` and go through
    // `spawnWindowKind` so they inherit foyer-window chrome + the
    // shared storageKey idempotency (clicking the row twice focuses
    // the existing window instead of stacking).
    if (typeof entry === "string") entry = { view: entry };
    if (typeof entry?.open === "function") {
      Promise.resolve(entry.open()).catch((e) =>
        console.warn("spawn-menu open failed", entry?.view, e));
      return;
    }
    const view = entry?.view;
    if (!view) return;
    if (view === "console")     { _spawnConsole();     return; }
    if (view === "diagnostics") { _spawnDiagnostics(); return; }
    if (view === "scripts")     { _spawnScripts();     return; }
    if (view === "midi-devices")  { spawnWindowKind("midi-devices");  return; }
    if (view === "soft-keyboard") { spawnWindowKind("soft-keyboard"); return; }
    // Fallback for any future view we haven't special-cased — legacy openWidget.
    const layout = window.__foyer?.layout;
    if (!layout) return;
    if (typeof layout.openWidget === "function") layout.openWidget(view);
    else {
      layout.openFloat?.(view);
    }
  }

  _titleForWidget(w) {
    const base = this._labelFor({ view: w.view, props: w.props });
    return w.minimized ? `Restore ${base}` : `Focus ${base}`;
  }

  _focusTileWidget(w) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    if (w.minimized) layout.floatSet?.(w.id, { minimized: false });
    layout.raiseFloatToGlobalFront?.(w.id);
  }

  _onTileWidgetContext(ev, w) {
    ev.preventDefault();
    window.__foyer?.layout?.removeFloat?.(w.id);
  }

  _renderDockedFabs({ leadingSep = true } = {}) {
    const fabs = window.__foyer?.layout?.dockedFabs?.() || [];
    if (fabs.length === 0) return null;
    // Stable, deterministic order so the rail doesn't reshuffle on
    // reload — docked FABs come in via Map iteration order which
    // reflects registration order (non-deterministic across dynamic
    // imports). Core/app-critical FABs pinned to the top.
    const ORDER = [
      // foyer.actions / foyer.session-info / foyer.agent / foyer.windows
      // retired — see app.js. Order kept stable for the survivors so the
      // rail doesn't reshuffle as variants register in different dynamic-
      // import orders.
      "foyer.layout-fab.v1",
      "foyer.chat",
    ];
    const rank = (id) => {
      const i = ORDER.indexOf(id);
      return i < 0 ? ORDER.length : i;
    };
    const sorted = [...fabs].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return html`
      ${leadingSep ? html`<div class="rail-sep"></div>` : null}
      ${sorted.map(({ id, meta }) => {
        const fab = window.__foyer?.layout?.fabInstance?.(id);
        const badge = (typeof fab?.dockBadge === "function") ? fab.dockBadge() : 0;
        return html`
          <button
            class="dock-icon fab-dock"
            title="${meta.label || id} — click to open · drag off rail to undock · right-click menu"
            @pointerdown=${(ev) => this._onFabIconPointerDown(ev, id)}
            @contextmenu=${(ev) => this._onFabIconContext(ev, id)}
          >
            ${icon(meta.icon || "squares-2x2", 16)}
            ${badge > 0 ? html`<span class="fab-badge">${badge > 99 ? "99+" : badge}</span>` : null}
          </button>
        `;
      })}
    `;
  }

  /**
   * Unified pointer handler: a small drag is a click (open panel); a
   * big drag off the rail tears the FAB out as a floating button again.
   */
  _onFabIconPointerDown(ev, id) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const iconTop = ev.currentTarget.getBoundingClientRect().top;
    const TEAR_THRESHOLD = 18;
    let tore = false;

    const move = (e) => {
      if (tore) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Drag left off the rail (dx < -threshold) or any distance past
      // threshold squared → tear out.
      if (dx < -TEAR_THRESHOLD || dx * dx + dy * dy > TEAR_THRESHOLD * TEAR_THRESHOLD) {
        tore = true;
        cleanup();
        this._tearFabFromRail(id, e.clientX, e.clientY);
      }
    };
    const up = () => {
      if (!tore) {
        // Tap: open the FAB inside the slide-out slot. Reparents the
        // FAB into our host so its scoped shadow-root styles still
        // cascade — the prior slide-out templated content into our
        // shadow root and dropped CSS, which Rich called ugly. Now
        // we use slot projection: the FAB lives in our LIGHT DOM as
        // <slot name="slide-out"> child, but its own shadow root
        // owns the styling. (Rich, TODO #41.)
        this._toggleSlideForFab(id);
      }
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /**
   * Undock a rail FAB and keep it glued to the cursor until the user
   * releases. The pointer is already down when this fires, so we hook
   * window-level pointermove/pointerup and drive the FAB's `(right,
   * bottom)` anchors directly — effectively "hand off the drag" without
   * the user having to re-click.
   */
  _tearFabFromRail(id, x, y) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const fab = layout.fabInstance?.(id);
    // Exit slide-out before undocking so the FAB is back on body before
    // the floating-FAB drag handler takes over.
    if (this._slideFabId === id) {
      try { fab?.exitSlideMode?.(); } catch {}
      this._slideOpen = false;
      this._slideFabId = "";
    }
    layout.undockFab(id);
    // If our slide-out panel is currently showing this FAB, close it
    // — the FAB is leaving the rail and there's nothing to render.
    if (this._panel === `fab:${id}` && this._open) {
      this._open = false;
      this._updateAttrs();
      this._persistPanel();
      this._announceDockChanged();
    }
    // Collapse the FAB's own docked panel — it's about to fly away
    // as a floating button, and leaving `_open=true` would leave a
    // ghost copy pinned at the old rail anchor.
    if (fab?._open) fab.closeFromDock?.();
    this._announceDockChanged();
    if (!fab) return;

    const size = 48;
    const place = (cx, cy) => {
      const right = Math.max(0, Math.min(window.innerWidth - size, window.innerWidth - cx - size / 2));
      const bottom = Math.max(0, Math.min(window.innerHeight - size, window.innerHeight - cy - size / 2));
      fab._fabRight = right;
      fab._fabBottom = bottom;
      fab._open = false;
      fab.requestUpdate?.();
    };
    place(x, y);

    const move = (e) => place(e.clientX, e.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      fab._persist?.();
      fab.requestUpdate?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _onFabIconContext(ev, id) {
    ev.preventDefault();
    // Right-click undocks the FAB and closes its docked panel. Same
    // effect as drag-off but via keyboard-friendly gesture.
    window.__foyer?.layout?.undockFab(id);
    const fab = window.__foyer?.layout?.fabInstance?.(id);
    fab?.closeFromDock?.();
    this._announceDockChanged();
  }

  /// Tear a FAB out of the slide-out to a fresh floating-panel
  /// position with its panel pre-opened. Called from the tear-out
  /// icon inside each docked panel header. We stagger position so
  /// multiple simultaneous tear-outs don't pile on top of each
  /// other — important on first use, where every FAB shares the
  /// same default (right:24, bottom:24).
  tearFabToFloating(id) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const fab = layout.fabInstance?.(id);
    if (!fab) return;
    // Build the set of (right, bottom) anchors already in use by
    // OTHER floating FABs so we can avoid them.
    const occupied = new Set();
    for (const [otherId, entry] of layout._fabRegistry?.entries?.() || []) {
      if (otherId === id) continue;
      if (layout.isFabDocked?.(otherId)) continue;
      const inst = entry.instance;
      if (!inst) continue;
      const r = Number(inst._fabRight);
      const b = Number(inst._fabBottom);
      if (Number.isFinite(r) && Number.isFinite(b)) {
        occupied.add(`${Math.round(r)}:${Math.round(b)}`);
      }
    }
    // Try a sequence of bottom-right anchored slots, stepping
    // leftward in 90 px chunks. Wraps to a higher row when the
    // bottom row is full. 56 px FAB + 24 px margin = 80 px stride;
    // bump to 90 to leave a little air.
    const STEP = 90;
    let chosen = null;
    for (let row = 0; row < 6 && !chosen; row++) {
      for (let col = 0; col < 6 && !chosen; col++) {
        const r = 24 + col * STEP;
        const b = 24 + row * STEP;
        if (!occupied.has(`${r}:${b}`)) chosen = { r, b };
      }
    }
    if (chosen) {
      fab._fabRight = chosen.r;
      fab._fabBottom = chosen.b;
      try { fab._persist?.(); } catch {}
    }
    // Exit slide-mode, open the floating panel, and remove from
    // the rail in that order. Order matters: exitSlideMode
    // reparents the fab back to body before render runs.
    try { fab.exitSlideMode?.(); } catch {}
    fab._open = true;
    try { fab._persist?.(); } catch {}
    fab.requestUpdate?.();
    if (this._slideFabId === id) {
      this._slideOpen = false;
      this._slideFabId = "";
    }
    layout.undockFab(id);
    this._announceDockChanged();
  }

  _labelFor(e) {
    if (e.view === "plugin_panel") {
      const pid = e.props?.plugin_id;
      const session = window.__foyer?.store?.state?.session;
      if (pid && session) {
        for (const t of session.tracks || []) {
          for (const p of t.plugins || []) {
            if (p.id === pid) return p.name;
          }
        }
      }
      return "Plugin";
    }
    return e.view;
  }

  _onDockContextMenu(ev, e) {
    ev.preventDefault();
    // Close the floating window entirely.
    window.__foyer?.layout?.removeFloat(e.id);
  }

}
customElements.define("foyer-right-dock", RightDock);
