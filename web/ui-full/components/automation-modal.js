// Automation editor — full-window editor for every automation lane on a
// track, with a left-panel legend tree (Core controls + each plugin's
// params) and a right-panel stack of expandable per-lane editors.
//
// Spawned via `openAutomationModal({ trackId, focusControlId? })` from
// the timeline (double-click the "A" button on a lane head, or click an
// automation polyline on the overlay). Lives outside the timeline view
// because (1) it's heavy and rarely open, (2) it needs to span beyond
// the timeline's lane row, and (3) we want a single instance shared
// across tracks via the top-bar track switcher.
//
// Pan/zoom is ALWAYS synced with the active timeline-view: the modal
// polls `pxPerSec` + `scrollLeft` on rAF and mirrors them on its own
// scroll container. The zoom slider in the modal's top bar writes
// back to the timeline's `_zoom`, so panning/zooming in the modal
// also pans/zooms the underlying timeline. Closing + reopening
// preserves the timeline's state by virtue of being one-way mirror
// at boot, two-way during interaction.
//
// Plugin parameter lanes aren't exposed by the Ardour shim yet — the
// legend lists them under expandable per-plugin sections with a
// "soon" tag so the UI shape is in place the moment that work lands.
// Core lanes (gain/pan/mute/solo) are fully editable today through
// the embedded `foyer-automation-lane` element.

import { LitElement, html, css } from "lit";
import { openWindow } from "foyer-ui-core/widgets/window.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import { icon } from "foyer-ui-core/icons.js";
import "./automation-lane.js";
import "foyer-ui-core/viz/waveform-gl.js";
import "./midi-strip.js";
import "./patch-picker.js";

const STORAGE_KEY = "foyer-automation-modal";
// Per-track visible-control set (legend checkboxes). UI pref, not
// shared session state — see CLAUDE.md "Per-client preferences".
const VISIBLE_PREFIX = "foyer.automation.visible.";
// Per-track expanded/collapsed state for editor cards.
const EXPANDED_PREFIX = "foyer.automation.expanded.";
// Per-track expanded/collapsed state for legend plugin sections.
const PLUGIN_EXPANDED_PREFIX = "foyer.automation.plugin-expanded.";

const RULER_HEIGHT = 22;
// Padding the editor scroll-area applies before the first sample. The
// underlying timeline-view uses HEAD_WIDTH=140 for its lane heads;
// here the legend column already serves that purpose, so we add a
// smaller left gutter (just enough for stroke + endpoint markers).
const CONTENT_PAD_LEFT = 8;

function readJsonSet(key, fallback = new Set()) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return fallback;
  }
}
function writeJsonSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

/** Mirror of automation-lane.js LANE_META for the modal's label hints. */
const CORE_META = {
  gain: { label: "Gain", color: "#f59e0b" },
  pan:  { label: "Pan",  color: "#22d3ee" },
  mute: { label: "Mute", color: "#fbbf24" },
  solo: { label: "Solo", color: "#f87171" },
};

function laneSuffix(controlId) {
  return String(controlId || "").split(".").pop() || "param";
}

const NO_BANK_SENTINELS = new Set([-1, 0xffff, 0xffffff, 0x7fff]);
function normalizePatchBank(bank) {
  if (bank == null) return -1;
  const n = Number(bank);
  if (!Number.isFinite(n) || NO_BANK_SENTINELS.has(n) || n < 0) return -1;
  return Math.max(0, Math.min(16383, n)) & 0x3fff;
}

/** Flatten MIDNAM `_patchNames.banks` into a search-friendly list:
 *  `{ bank, bankName, program, name }` rows, including a synthetic
 *  `bank: -1` row per bank-less program (1–128) so the search can
 *  always return something even on a track without a MIDNAM map. */
function flattenPatchNames(patchNames) {
  const out = [];
  const banks = patchNames?.banks || [];
  if (banks.length) {
    for (const b of banks) {
      const bk = normalizePatchBank(b.bank);
      if (bk < 0) continue;
      const bankName = b.name || `Bank ${bk}`;
      const programs = (b.programs || []).filter((p) =>
        Number.isFinite(Number(p.program)));
      for (const p of programs) {
        const prog = Math.max(0, Math.min(127, Number(p.program) || 0));
        out.push({
          bank: bk,
          bankName,
          program: prog,
          name: p.name || `Program ${prog + 1}`,
        });
      }
    }
    if (out.length) return out;
  }
  // Fallback when MIDNAM is silent: GM 1..128 with bank = -1.
  for (let i = 0; i < 128; i += 1) {
    out.push({
      bank: -1,
      bankName: "General MIDI",
      program: i,
      name: `Program ${i + 1}`,
    });
  }
  return out;
}

/** Walk shadow roots to find the active timeline-view, if any. The
 *  modal mirrors its pxPerSec + scrollLeft so the user always edits
 *  automation at the same scale they're seeing on the timeline. */
function findTimelineView() {
  const walk = (root) => {
    if (!root) return null;
    try {
      const hit = root.querySelector("foyer-timeline-view");
      if (hit) return hit;
    } catch {}
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

export class AutomationModal extends LitElement {
  static properties = {
    trackId: { type: String, attribute: "track-id" },
    focusControlId: { type: String, attribute: "focus-control-id" },
    _visible: { state: true, type: Object },
    _expanded: { state: true, type: Object },
    _pluginExpanded: { state: true, type: Object },
    _filterText: { state: true, type: String },
    _pxPerSec: { state: true, type: Number },
    _scrollLeft: { state: true, type: Number },
    _patchNames: { state: true, type: Object },
    _patchNamesFor: { state: true, type: String },
    _patchNamesLoading: { state: true, type: Boolean },
    _patchPicker: { state: true, type: Object },
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      flex: 0 0 auto;
    }
    .top .track-switch {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .top select {
      font: inherit;
      font-size: 12px;
      padding: 4px 8px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text);
    }
    .top .spacer { flex: 1; }
    .top .filter {
      font-size: 11px;
      padding: 4px 8px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text);
      width: 200px;
    }
    .top button.clear-all {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .top button.clear-all:hover {
      color: var(--color-danger, #f87171);
      border-color: var(--color-danger, #f87171);
    }
    .top .zoom-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .top .zoom-row input[type=range] { width: 100px; }
    .top .zoom-row .num {
      font-family: var(--font-mono);
      font-size: 10px;
      min-width: 38px;
      text-align: right;
    }
    .top .sync-chip {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 20%, transparent);
      color: var(--color-accent-2, #22d3ee);
    }
    .body {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .legend {
      flex: 0 0 280px;
      border-right: 1px solid var(--color-border);
      overflow-y: auto;
      padding: 4px 0 8px;
      background: color-mix(in oklab, var(--color-surface) 92%, var(--color-surface-elevated) 8%);
    }
    .legend .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      cursor: pointer;
      user-select: none;
    }
    .legend .section-head:hover { color: var(--color-text); }
    .legend .section-head .name { flex: 1; }
    .legend .section-head .count {
      font-family: var(--font-mono);
      font-weight: 500;
      color: var(--color-text-muted);
      letter-spacing: 0;
      text-transform: none;
      font-size: 9px;
    }
    .legend .section-body {
      padding-bottom: 4px;
      border-bottom: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent);
    }
    .legend .section.collapsed .section-body { display: none; }
    .legend .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px 4px 22px;
      cursor: pointer;
      font-size: 12px;
      user-select: none;
    }
    .legend .row:hover { background: color-mix(in oklab, var(--color-accent) 8%, transparent); }
    .legend .row.disabled { color: var(--color-text-muted); opacity: 0.6; cursor: not-allowed; }
    .legend .row.disabled:hover { background: transparent; }
    /* Marker on rows whose lane already carries automation data.
     * A 2-px accent stripe on the left edge + a brighter label
     * + a tinted "pt(s)" hint reads as "this control has stuff
     * in it" at a scan even when its editor card is hidden.
     * Pure cosmetic — visibility / behavior unchanged. */
    .legend .row.has-automation {
      border-left: 2px solid var(--color-accent-2, #22d3ee);
      padding-left: 20px;
    }
    .legend .row.has-automation .name {
      color: var(--color-text);
      font-weight: 600;
    }
    .legend .row.has-automation .hint {
      color: var(--color-accent-2, #22d3ee);
      font-weight: 700;
    }
    .legend .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex: 0 0 auto;
    }
    .legend .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .legend .hint {
      font-size: 9px;
      color: var(--color-text-muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-left: auto;
    }
    .editor-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .ruler {
      flex: 0 0 ${RULER_HEIGHT}px;
      height: ${RULER_HEIGHT}px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      position: relative;
      overflow: hidden;
    }
    .ruler-content {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      pointer-events: none;
    }
    .ruler-tick {
      position: absolute;
      bottom: 0;
      width: 1px;
      background: color-mix(in oklab, var(--color-text-muted) 60%, transparent);
    }
    .ruler-tick.major { background: color-mix(in oklab, var(--color-text) 75%, transparent); height: 60%; }
    .ruler-tick.minor { height: 35%; opacity: 0.65; }
    .ruler-label {
      position: absolute;
      top: 1px;
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--color-text-muted);
      transform: translateX(2px);
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-x: auto;
      overflow-y: auto;
      padding: 12px;
    }
    .scroll-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md, 6px);
      overflow: hidden;
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      background: color-mix(in oklab, var(--color-surface-elevated) 80%, var(--color-surface) 20%);
      border-bottom: 1px solid var(--color-border);
      position: sticky;
      left: 0;
      z-index: 2;
    }
    .card-head .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }
    .card-head .title {
      font-size: 12px;
      font-weight: 600;
    }
    .card-head .control-id {
      font-size: 10px;
      color: var(--color-text-muted);
      margin-left: auto;
      font-family: var(--font-mono);
    }
    .card-body {
      padding: 0;
      /* Resizable: the native CSS handle (a tiny SE-corner triangle)
       * is invisible on dark themes, so we add an explicit grip bar
       * at the bottom (see .resize-grip below). The native
       * resize:vertical rule still does the actual work — the bar
       * is pure visual affordance.
       *
       * Defaults to 180 px / max 600 px / min 60 px. Dragging
       * taller gives finer dB-per-pixel control on continuous
       * params (the original "gain snaps almost always" complaint —
       * 1.65 dB/px on a -60..+6 gain at 48 px, ~0.18 dB/px at
       * 360 px).
       *
       * IMPORTANT: overflow:auto (not hidden) is what lets the
       * native resize handle actually appear. With overflow:hidden
       * some browsers hide the handle entirely. */
      height: 180px;
      min-height: 60px;
      max-height: 600px;
      resize: vertical;
      overflow: auto;
      position: relative;
    }
    /* Draggable grip bar at the bottom of every card. Spans the full
     * width so the user can click anywhere along the bottom edge to
     * resize. Drives a manual height adjustment of the card-body
     * via _startCardResize — the native resize:vertical corner
     * triangle is invisible on dark themes, so this is the actual
     * affordance. */
    .card .resize-grip {
      position: relative;
      height: 10px;
      background: color-mix(in oklab, var(--color-surface-elevated) 95%, var(--color-accent-2) 5%);
      border-top: 1px solid var(--color-border);
      cursor: ns-resize;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
      user-select: none;
    }
    .card .resize-grip::after {
      content: "";
      display: block;
      width: 36px;
      height: 3px;
      border-radius: 2px;
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 70%, transparent);
    }
    .card .resize-grip:hover,
    .card .resize-grip.dragging {
      background: color-mix(in oklab, var(--color-accent-2) 22%, var(--color-surface-elevated));
    }
    .card .resize-grip:hover::after,
    .card .resize-grip.dragging::after {
      background: var(--color-accent-2, #22d3ee);
      width: 52px;
    }
    .card.collapsed .card-body { display: none; }
    .card.collapsed .resize-grip { display: none; }
    .grid-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
    }
    /* Waveform background — one foyer-waveform-gl per region on the
     * track, positioned at the same x scale as the automation lane
     * above it. Dimmed so the automation polyline reads on top, but
     * present so the user can align edits to audible events without
     * flipping back to the timeline. */
    .wf-bg {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0.6;
    }
    .wf-bg .wf-region {
      position: absolute;
      top: 0;
      bottom: 0;
      display: block;
    }
    /* Patches lane — specialized card for per-track patch-change
     * events. Each chip is a labeled marker anchored at the patch
     * change's timeline sample, sized to be clearly hittable. */
    .patches-body {
      cursor: crosshair;
    }
    .patches-track {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2;
    }
    .patch-chip {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 6px;
      border-radius: 4px;
      background: linear-gradient(180deg, #b69bff, #8b6df0);
      color: #fff;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.2);
      user-select: none;
      white-space: nowrap;
    }
    .patch-chip:hover {
      box-shadow: 0 0 0 2px var(--color-accent-2, #22d3ee), 0 2px 8px rgba(0, 0, 0, 0.6);
    }
    .patch-chip .ch {
      padding: 0 4px;
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.35);
      font-size: 9px;
    }
    .patch-chip .prg {
      letter-spacing: 0.02em;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 12px;
    }
    .empty strong { color: var(--color-text); font-weight: 600; }
    foyer-automation-lane {
      width: 100%;
      display: block;
      position: relative;
      z-index: 2;
    }
    /* Tri-state checkbox visual for plugin master select with
     * indeterminate state. Lit doesn't expose .indeterminate as a
     * property in static templates, so we set it manually after
     * render via the updated() hook. */
    input[type=checkbox].master {
      transform: translateY(1px);
    }
    /* Patch picker overlay. Single-form, MIDNAM-driven, search +
     * scrolling program list. Centered as a floating panel; the
     * scrim closes on click-outside. */
    .pp-scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pp-panel {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
      width: 480px;
      max-width: 92vw;
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .pp-head {
      padding: 12px 16px 10px;
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pp-head .title {
      font-weight: 600;
      font-size: 13px;
      color: var(--color-text);
      flex: 1;
    }
    .pp-head .x {
      cursor: pointer;
      background: transparent;
      color: var(--color-text-muted);
      border: 0;
      font-size: 14px;
      padding: 2px 6px;
    }
    .pp-head .x:hover { color: var(--color-text); }
    .pp-controls {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 10px;
      row-gap: 8px;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent);
    }
    .pp-controls label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .pp-controls select,
    .pp-controls input[type=search] {
      font: inherit;
      font-size: 12px;
      padding: 6px 8px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 4px;
      color: var(--color-text);
      width: 100%;
    }
    .pp-controls input[type=search]:focus,
    .pp-controls select:focus {
      outline: 1px solid var(--color-accent-2, #22d3ee);
      outline-offset: -1px;
    }
    .pp-hint {
      grid-column: 1 / -1;
      font-size: 10px;
      color: var(--color-text-muted);
      margin-top: -2px;
    }
    .pp-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 6px 0;
    }
    .pp-row {
      padding: 6px 16px;
      display: grid;
      grid-template-columns: 38px 1fr auto;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      font-size: 12px;
      color: var(--color-text);
      border-left: 2px solid transparent;
    }
    .pp-row:hover {
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
    }
    .pp-row.active {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 18%, transparent);
      border-left-color: var(--color-accent-2, #22d3ee);
    }
    .pp-row .prog {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .pp-row.active .prog { color: var(--color-text); }
    .pp-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-row .bk {
      font-size: 9px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .pp-empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .pp-foot {
      padding: 10px 16px;
      border-top: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pp-foot .summary {
      flex: 1;
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .pp-foot .summary strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .pp-foot button {
      font: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      cursor: pointer;
    }
    .pp-foot button:hover { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-surface)); }
    .pp-foot button.primary {
      background: var(--color-accent-2, #22d3ee);
      border-color: var(--color-accent-2, #22d3ee);
      color: #001a20;
      font-weight: 600;
    }
    .pp-foot button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.trackId = "";
    this.focusControlId = "";
    this._visible = new Set();
    this._expanded = new Set();
    this._pluginExpanded = new Set();
    this._filterText = "";
    this._pxPerSec = 60;
    this._scrollLeft = 0;
    this._syncRaf = 0;
    this._patchNames = null;
    this._patchNamesFor = "";
    this._patchNamesLoading = false;
    // Picker stage. `null` = closed. When open, holds the
    // in-progress edit/add session: target region + (optional)
    // existing patch_change id + working channel/bank/program +
    // free-text search filter. A single Save commit dispatches
    // add_patch_change / update_patch_change.
    this._patchPicker = null;
    // Last committed selection across all chips (per-modal-instance
    // memory). New add-flows seed from this so the typical workflow
    // (drop several copies of the same patch around a track) doesn't
    // force the user back through channel/bank every time.
    this._lastPatchPick = null;
    this._onStoreChange = () => this.requestUpdate();
    this._onScroll = (ev) => this._onScrollChanged(ev);
    this._onEnvelope = (ev) => this._onWsEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    store?.addEventListener?.("change", this._onStoreChange);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    this._loadPersistedState();
    this._startTimelineSync();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    const store = window.__foyer?.store;
    store?.removeEventListener?.("change", this._onStoreChange);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
    this._stopTimelineSync();
  }

  _onWsEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "midi_patch_names_listed"
        && body.track_id === this.trackId) {
      this._patchNames = body.names || null;
      this._patchNamesFor = `${this.trackId}:${body.names?.channel ?? 0}`;
      this._patchNamesLoading = false;
    }
  }

  _requestPatchNamesForChannel(ch) {
    if (!this.trackId) return;
    const channel = Math.max(0, Math.min(15, Number(ch) || 0));
    const key = `${this.trackId}:${channel}`;
    if (this._patchNamesFor === key && this._patchNames) return;
    this._patchNamesLoading = true;
    window.__foyer?.ws?.send({
      type: "list_midi_patch_names",
      track_id: this.trackId,
      channel,
    });
  }

  /**
   * rAF poll that mirrors the active timeline-view's pxPerSec +
   * scrollLeft onto our internal state. Cheap (one DOM walk + two
   * property reads per frame) and lets the modal stay in lock-step
   * with the timeline through any source — keybind, mouse-wheel,
   * direct property set. Stops when the modal disconnects.
   */
  _startTimelineSync() {
    const tick = () => {
      this._syncRaf = requestAnimationFrame(tick);
      const tl = findTimelineView();
      if (!tl) return;
      // Push fresh waveform peaks into the background layer on
      // every frame. Cheap when there's nothing to do (the cache
      // returns the same object reference on a hit and setPeaks
      // is a no-op in that case for the GL component).
      this._repaintWaveformLayer();
      const pps = Number(tl._zoom);
      if (Number.isFinite(pps) && pps > 0 && pps !== this._pxPerSec) {
        this._pxPerSec = pps;
      }
      const scrollEl = tl.renderRoot?.querySelector?.(".scroll");
      const sl = Number(scrollEl?.scrollLeft || 0);
      // Convert from timeline-coords (which include HEAD_WIDTH=140)
      // to our coords (no head column). We strip 140 px to align.
      const adjusted = Math.max(0, sl - 140);
      if (adjusted !== this._scrollLeft) {
        this._scrollLeft = adjusted;
        const ourScroll = this.renderRoot?.querySelector?.(".scroll");
        if (ourScroll && Math.abs(ourScroll.scrollLeft - adjusted) > 1) {
          // Avoid feedback loop: only push to our scroll if it's
          // off by more than 1 px. The user's own scroll inside the
          // modal calls _onScrollChanged which writes back to the
          // timeline, completing the cycle.
          ourScroll.scrollLeft = adjusted;
        }
      }
    };
    this._syncRaf = requestAnimationFrame(tick);
  }
  _stopTimelineSync() {
    if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
    this._syncRaf = 0;
  }

  /** Modal scroll → write back to the timeline so panning here pans
   *  the timeline behind / above. */
  _onScrollChanged(ev) {
    const sl = Number(ev.currentTarget?.scrollLeft || 0);
    this._scrollLeft = sl;
    const tl = findTimelineView();
    if (!tl) return;
    const scrollEl = tl.renderRoot?.querySelector?.(".scroll");
    if (!scrollEl) return;
    const target = sl + 140; // re-add HEAD_WIDTH
    if (Math.abs(scrollEl.scrollLeft - target) > 1) {
      scrollEl.scrollLeft = target;
    }
  }

  _setZoom(pps) {
    const clamped = Math.max(2, Math.min(4000, Math.round(pps)));
    this._pxPerSec = clamped;
    const tl = findTimelineView();
    if (tl) tl._zoom = clamped;
    this.requestUpdate();
  }

  /** Drag-resize a card's body height via the visible grip bar at
   *  its bottom edge. Updates the `.card-body` element's inline
   *  height while the pointer is down. Native `resize: vertical` on
   *  `.card-body` is kept as a fallback for users who happen to find
   *  the corner triangle. */
  _startCardResize(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grip = ev.currentTarget;
    const card = grip.closest(".card");
    const body = card?.querySelector(".card-body");
    if (!body) return;
    grip.classList.add("dragging");
    try { grip.setPointerCapture?.(ev.pointerId); } catch {}
    const startY = ev.clientY;
    const startH = body.getBoundingClientRect().height;
    const move = (e) => {
      const dy = e.clientY - startY;
      const newH = Math.max(60, Math.min(600, startH + dy));
      body.style.height = `${newH}px`;
    };
    const up = () => {
      grip.classList.remove("dragging");
      try { grip.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  updated(changed) {
    if (changed.has("trackId") || changed.has("focusControlId")) {
      this._loadPersistedState();
      if (this.focusControlId) {
        this._visible.add(this.focusControlId);
        this._expanded.add(this.focusControlId);
        this._persist();
        this.requestUpdate();
      }
    }
    // Patch the indeterminate flag on plugin-master checkboxes after
    // every render. Lit doesn't have a declarative binding for the
    // `indeterminate` property, so we set it imperatively here from
    // the data we already computed in _renderLegend.
    for (const el of this.renderRoot.querySelectorAll(
      "input.master[data-master-indeterminate]",
    )) {
      el.indeterminate = el.dataset.masterIndeterminate === "1";
    }
  }

  _loadPersistedState() {
    if (!this.trackId) return;
    this._visible = readJsonSet(VISIBLE_PREFIX + this.trackId);
    this._expanded = readJsonSet(EXPANDED_PREFIX + this.trackId);
    this._pluginExpanded = readJsonSet(PLUGIN_EXPANDED_PREFIX + this.trackId);
    // Default: every CORE lane visible + expanded on first open.
    // Plugin-param lanes are real now (stub seeds them) but there
    // can be dozens per track — defaulting them all visible would
    // bury the user. They opt-in via the legend checkbox.
    if (this._visible.size === 0) {
      const track = this._track();
      const coreSuffixes = new Set(["gain", "pan", "mute", "solo"]);
      for (const lane of track?.automation_lanes || []) {
        const suffix = String(lane.control_id || "").split(".").pop() || "";
        if (coreSuffixes.has(suffix)) {
          this._visible.add(lane.control_id);
          this._expanded.add(lane.control_id);
        }
      }
      this._persist();
    }
  }

  _persist() {
    if (!this.trackId) return;
    writeJsonSet(VISIBLE_PREFIX + this.trackId, this._visible);
    writeJsonSet(EXPANDED_PREFIX + this.trackId, this._expanded);
    writeJsonSet(PLUGIN_EXPANDED_PREFIX + this.trackId, this._pluginExpanded);
  }

  _session() {
    return window.__foyer?.store?.state?.session || null;
  }

  _track() {
    return (this._session()?.tracks || []).find((t) => t.id === this.trackId) || null;
  }

  _sampleRate() {
    return Number(this._session()?.sample_rate) || 48_000;
  }

  _totalSamples() {
    const tl = findTimelineView();
    const fromTl = Number(tl?._timeline?.length_samples);
    if (Number.isFinite(fromTl) && fromTl > 0) return fromTl;
    const fromSession = Number(this._session()?.length_samples);
    if (Number.isFinite(fromSession) && fromSession > 0) return fromSession;
    return this._sampleRate() * 60;
  }

  /** Look up the Parameter struct backing this lane's control_id. For
   *  the core lanes (gain/pan/mute/solo), the Track carries them
   *  directly as fields. Plugin params would resolve through
   *  `track.plugins[].params` if they were ever exposed as
   *  automation lanes (not yet). Returns null if the lookup fails. */
  _parameterForLane(track, controlId) {
    if (!track || !controlId) return null;
    const suffix = laneSuffix(controlId);
    if (track.gain?.id === controlId || suffix === "gain") return track.gain || null;
    if (track.pan?.id === controlId || suffix === "pan") return track.pan || null;
    if (track.mute?.id === controlId || suffix === "mute") return track.mute || null;
    if (track.solo?.id === controlId || suffix === "solo") return track.solo || null;
    for (const plugin of track.plugins || []) {
      for (const p of plugin.params || []) {
        if (p.id === controlId) return p;
      }
    }
    return null;
  }

  /** Live region list for a track, sourced from the timeline-view's
   *  per-track cache. Updated as regions are added / moved /
   *  resized. Returns [] when the timeline isn't mounted or the
   *  track has no regions yet. */
  _regionsForTrack(trackId) {
    const tl = findTimelineView();
    return tl?._regionsByTrack?.[trackId] || [];
  }

  /** Sentinel control_id for the per-track patch-change lane.
   *  Picked so it can't collide with any real param id. */
  _patchLaneId(trackId) { return `${trackId}.__patches`; }

  /** Resolve PPQN (ticks-per-quarter) for the active session. Ardour
   *  defaults to 1920; older sessions or different DAWs might ship a
   *  different value. */
  _ppqn() {
    const p = Number(this._session()?.ppqn);
    return Number.isFinite(p) && p > 0 ? p : 1920;
  }

  /** Convert ticks (relative to a region's start) to absolute
   *  timeline samples. Uses the live tempo from the transport
   *  controls. Beat math: ticks / PPQN beats × 60/BPM sec ×
   *  sample_rate samples/sec. */
  _ticksToSamples(ticks) {
    const ctls = window.__foyer?.store?.state?.controls;
    const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
    const sr = this._sampleRate();
    const ppqn = this._ppqn();
    return (Number(ticks) / ppqn) * (60 / tempo) * sr;
  }
  /** Inverse of _ticksToSamples. */
  _samplesToTicks(samples) {
    const ctls = window.__foyer?.store?.state?.controls;
    const tempo = Number(ctls?.get?.("transport.tempo")) || 120;
    const sr = this._sampleRate();
    const ppqn = this._ppqn();
    return Math.max(0, Math.round((Number(samples) / sr) * (tempo / 60) * ppqn));
  }

  /** Aggregate every patch-change on the track into a flat list
   *  with absolute sample positions. Each entry remembers its
   *  source region so edit/delete wire commands can target it. */
  _patchChangesForTrack(track) {
    const regions = this._regionsForTrack(track.id);
    const out = [];
    for (const r of regions) {
      const rStart = Number(r.start_samples) || 0;
      for (const pc of (r.patch_changes || [])) {
        const offsetSamples = this._ticksToSamples(pc.start_ticks || 0);
        out.push({
          region_id: r.id,
          patch_change: pc,
          time_samples: rStart + offsetSamples,
        });
      }
    }
    out.sort((a, b) => a.time_samples - b.time_samples);
    return out;
  }

  /** Find the region whose timeline span contains the given sample
   *  position (used when the user clicks on the patch lane to add
   *  a new patch change — we need to know which region to attach
   *  it to). Returns null if the time falls in a gap. */
  _regionAtSample(track, sample) {
    for (const r of this._regionsForTrack(track.id)) {
      const start = Number(r.start_samples) || 0;
      const end = start + (Number(r.length_samples) || 0);
      if (sample >= start && sample < end) return r;
    }
    return null;
  }

  /** Open the patch picker for an add or edit flow.
   *
   *  Replaces the prior three-prompt chain. The picker is a single
   *  floating panel rendered inside the modal that exposes MIDNAM
   *  bank/program data with a search box, dropdowns, and a Save
   *  button. New-add seeds from the last committed selection so a
   *  user dropping multiple copies of the same patch doesn't have
   *  to retrace the same channel + bank every time. */
  _openPatchPicker({ mode, region, patch, sample }) {
    const init = mode === "edit"
      ? {
        channel: patch.patch_change.channel,
        bank: patch.patch_change.bank,
        program: patch.patch_change.program,
      }
      : (this._lastPatchPick || { channel: 0, bank: -1, program: 0 });
    this._patchPicker = {
      mode,
      regionId: region.id,
      patchId: mode === "edit" ? patch.patch_change.id : "",
      sample: sample ?? 0,
      channel: Math.max(0, Math.min(15, Number(init.channel) || 0)),
      bank: normalizePatchBank(init.bank),
      program: Math.max(0, Math.min(127, Number(init.program) || 0)),
    };
  }

  _closePatchPicker() {
    this._patchPicker = null;
  }

  _updatePicker(patch) {
    if (!this._patchPicker) return;
    this._patchPicker = { ...this._patchPicker, ...patch };
  }

  _commitPatchPicker() {
    const p = this._patchPicker;
    if (!p) return;
    const channel = Math.max(0, Math.min(15, Number(p.channel) || 0));
    const bank = normalizePatchBank(p.bank);
    const program = Math.max(0, Math.min(127, Number(p.program) || 0));
    const ws = window.__foyer?.ws;
    if (!ws) {
      this._closePatchPicker();
      return;
    }
    if (p.mode === "edit") {
      ws.send({
        type: "update_patch_change",
        region_id: p.regionId,
        patch_change_id: p.patchId,
        patch: { channel, bank, program },
      });
    } else {
      const region = this._regionsForTrack(this.trackId)
        .find((r) => r.id === p.regionId);
      if (!region) { this._closePatchPicker(); return; }
      const offsetSamples = (p.sample || 0) - (Number(region.start_samples) || 0);
      const start_ticks = this._samplesToTicks(offsetSamples);
      ws.send({
        type: "add_patch_change",
        region_id: p.regionId,
        patch_change: {
          id: `patchchange.opt.${Date.now().toString(36)}`,
          channel,
          program,
          bank,
          start_ticks,
        },
      });
    }
    this._lastPatchPick = { channel, bank, program };
    this._closePatchPicker();
  }

  /** Clear automation points on every lane of `track`. Confirms with
   *  the user (destructive across many lanes at once), wraps the
   *  whole sweep in a single undo group so Ctrl+Z reverses it as
   *  one step, and dispatches a `replace_automation_lane` with an
   *  empty points list per lane that currently has data. Empty
   *  lanes are skipped so the wire is quiet. */
  async _clearAllAutomation(track) {
    const lanes = (track.automation_lanes || [])
      .filter((l) => Array.isArray(l.points) && l.points.length > 0);
    if (lanes.length === 0) {
      const { toast } = await import("foyer-ui-core/widgets/toast.js");
      toast(`No automation to clear on ${track.name}.`, { tone: "info" });
      return;
    }
    const totalPoints = lanes.reduce((n, l) => n + l.points.length, 0);
    const { confirmAction } = await import("foyer-ui-core/widgets/confirm-modal.js");
    const ok = await confirmAction({
      title: "Clear all automation?",
      message:
        `Clear all ${totalPoints} automation point${totalPoints === 1 ? "" : "s"} `
        + `across ${lanes.length} lane${lanes.length === 1 ? "" : "s"} on `
        + `${track.name}? Undo restores everything in one step.`,
      confirmLabel: "Clear all",
      cancelLabel: "Cancel",
      tone: "warning",
    });
    if (!ok) return;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    ws.send({ type: "undo_group_begin", name: `Foyer clear automation · ${track.name}` });
    for (const lane of lanes) {
      ws.send({
        type: "replace_automation_lane",
        lane_id: lane.control_id,
        points: [],
      });
    }
    ws.send({ type: "undo_group_end" });
  }

  /** Mount the reusable `<foyer-patch-picker>` when a patch flow
   *  is active. The picker carries its own MIDNAM subscription and
   *  state; we only feed it the seed values and listen for commit
   *  / cancel events. */
  _renderPatchPicker() {
    const p = this._patchPicker;
    if (!p) return null;
    return html`
      <foyer-patch-picker
        .mode=${p.mode}
        .trackId=${this.trackId}
        .initialChannel=${p.channel}
        .initialBank=${p.bank}
        .initialProgram=${p.program}
        @commit=${(e) => {
          this._patchPicker = {
            ...this._patchPicker,
            channel: e.detail.channel,
            bank: e.detail.bank,
            program: e.detail.program,
          };
          this._commitPatchPicker();
        }}
        @cancel=${() => this._closePatchPicker()}
      ></foyer-patch-picker>
    `;
  }

  /** Background waveform layer behind an automation editor card.
   *  Each region on the track gets its own `<foyer-waveform-gl>`
   *  positioned at the same x scale as the lane SVG so the user
   *  can align automation moves to audible events. Peaks come from
   *  the active timeline-view's WaveformCache (shared via
   *  deep-find); the rAF tick that's already syncing pxPerSec also
   *  pushes peaks into these elements. */
  _renderWaveformLayer(track, pxPerSec) {
    const regions = this._regionsForTrack(track.id);
    if (!regions.length) return null;
    const sr = this._sampleRate();
    const isMidi = track.kind === "midi";
    return html`
      <div class="wf-bg ${isMidi ? "midi" : "audio"}">
        ${regions.map((r) => {
          const leftPx = (Number(r.start_samples) / sr) * pxPerSec;
          const widthPx = Math.max(2, (Number(r.length_samples) / sr) * pxPerSec);
          // MIDI lanes paint the actual note list using the same
          // strip element the timeline uses. Without this MIDI
          // tracks got a synthesized sine from the WaveformCache
          // fallback (no peaks for MIDI regions) — looked like a
          // fake background and didn't align with anything the
          // user could hear.
          if (isMidi) {
            return html`
              <foyer-midi-strip
                class="wf-region"
                .notes=${r.notes || []}
                .region=${r}
                .color=${track.color || ""}
                style="left:${leftPx}px;width:${widthPx}px"
              ></foyer-midi-strip>
            `;
          }
          return html`
            <foyer-waveform-gl
              class="wf-region"
              data-id=${r.id}
              style="left:${leftPx}px;width:${widthPx}px"
            ></foyer-waveform-gl>
          `;
        })}
      </div>
    `;
  }

  /** Push fresh peaks into every `<foyer-waveform-gl>` rendered in
   *  the modal's editor cards. Called from the rAF sync tick. */
  _repaintWaveformLayer() {
    const tl = findTimelineView();
    const wfCache = tl?._wfCache;
    if (!wfCache) return;
    const spp = tl._samplesPerPx?.();
    if (!spp) return;
    // Only push peaks into audio waveform elements — MIDI strips
    // paint notes from their own `.notes` prop and have no setPeaks.
    for (const el of this.renderRoot.querySelectorAll(".wf-bg.audio .wf-region")) {
      const id = el.dataset.id;
      if (!id) continue;
      const peaks = wfCache.ensure(id, spp);
      if (peaks && typeof el.setPeaks === "function") el.setPeaks(peaks);
    }
  }

  _colorForLane(controlId) {
    const suffix = laneSuffix(controlId);
    if (CORE_META[suffix]) return CORE_META[suffix].color;
    let h = 1234;
    for (let i = 0; i < controlId.length; i++) {
      h = (h * 31 + controlId.charCodeAt(i)) & 0xffff;
    }
    return `hsl(${h % 360}, 70%, 60%)`;
  }

  _labelForLane(controlId, paramHint) {
    const suffix = laneSuffix(controlId);
    if (CORE_META[suffix]) return CORE_META[suffix].label;
    return paramHint || suffix;
  }

  _toggleVisible(controlId) {
    if (this._visible.has(controlId)) {
      this._visible.delete(controlId);
    } else {
      this._visible.add(controlId);
      // Newly-shown card defaults to expanded so the user sees the
      // editor immediately. Without this an unchecked → checked
      // toggle would land collapsed if the user had previously
      // collapsed the card, which reads as "I checked the box and
      // nothing happened". Collapsing remains user-controlled via
      // the chevron and persists from there.
      this._expanded.add(controlId);
    }
    this._persist();
    this.requestUpdate();
  }

  _toggleExpanded(controlId) {
    if (this._expanded.has(controlId)) this._expanded.delete(controlId);
    else this._expanded.add(controlId);
    this._persist();
    this.requestUpdate();
  }

  // `_pluginExpanded` is misnamed — it actually stores the COLLAPSED
  // sections (a section in the set = closed). Default for every
  // section is open; users explicitly collapse what they don't care
  // about and it persists.
  _togglePluginSection(sectionId) {
    if (this._pluginExpanded.has(sectionId)) this._pluginExpanded.delete(sectionId);
    else this._pluginExpanded.add(sectionId);
    this._persist();
    this.requestUpdate();
  }
  _isSectionCollapsed(sectionId) {
    return this._pluginExpanded.has(sectionId);
  }

  /** Toggle every control in a plugin section as a unit. If any
   *  child is unchecked, the action is "check all"; otherwise
   *  "uncheck all". Mirrors how DAW group selects behave. */
  _togglePluginMaster(controlIds) {
    const allChecked = controlIds.every((id) => this._visible.has(id));
    if (allChecked) {
      for (const id of controlIds) this._visible.delete(id);
    } else {
      for (const id of controlIds) {
        this._visible.add(id);
        this._expanded.add(id);
      }
    }
    this._persist();
    this.requestUpdate();
  }

  _switchTrack(ev) {
    const nextId = ev.target.value;
    if (nextId && nextId !== this.trackId) {
      this.trackId = nextId;
      this.focusControlId = "";
    }
  }

  render() {
    const session = this._session();
    const track = this._track();
    if (!session || !track) {
      return html`<div class="empty"><strong>Loading session…</strong></div>`;
    }
    const tracks = session.tracks || [];
    return html`
      <div class="top">
        <div class="track-switch">
          ${icon("queue-list", 14)}
          <span>Track</span>
          <select @change=${(e) => this._switchTrack(e)}>
            ${tracks.map((t) => html`
              <option value=${t.id} ?selected=${t.id === this.trackId}>${t.name}</option>
            `)}
          </select>
        </div>
        <div class="zoom-row" title="Zoom synced with the main timeline">
          <span>Zoom</span>
          <input type="range" min="2" max="4000" step="1"
                 .value=${String(this._pxPerSec)}
                 @input=${(e) => this._setZoom(Number(e.currentTarget.value))}>
          <span class="num">${this._pxPerSec} px/s</span>
        </div>
        <span class="sync-chip" title="Pan and zoom in this editor mirror the main timeline.">SYNC</span>
        <div class="spacer"></div>
        <button class="clear-all"
                title="Clear automation points on every lane for this track. Wrapped in one undo group so Ctrl+Z reverses the whole clear."
                @click=${() => this._clearAllAutomation(track)}>
          ${icon("trash", 11)}
          <span>Clear all</span>
        </button>
        <input class="filter"
               placeholder="Filter controls…"
               .value=${this._filterText}
               @input=${(e) => { this._filterText = e.currentTarget.value; }}>
      </div>
      <div class="body">
        ${this._renderLegend(track)}
        ${this._renderEditorPane(track)}
      </div>
      ${this._renderPatchPicker(track)}
    `;
  }

  _matchesFilter(label, controlId) {
    const q = (this._filterText || "").trim().toLowerCase();
    if (!q) return true;
    return label.toLowerCase().includes(q) || controlId.toLowerCase().includes(q);
  }

  _renderLegendSection(sectionId, label, items) {
    if (!items.length) return null;
    const collapsed = this._isSectionCollapsed(sectionId);
    const enabledIds = items.filter((it) => !it.disabled).map((it) => it.controlId);
    const checkedCount = enabledIds.filter((id) => this._visible.has(id)).length;
    const allChecked = enabledIds.length > 0 && checkedCount === enabledIds.length;
    const someChecked = checkedCount > 0 && !allChecked;
    return html`
      <div class="section ${collapsed ? "collapsed" : ""}">
        <div class="section-head" @click=${() => this._togglePluginSection(sectionId)}>
          ${icon(collapsed ? "chevron-right" : "chevron-down", 11)}
          ${enabledIds.length ? html`
            <input type="checkbox" class="master"
                   ?checked=${allChecked}
                   data-master-indeterminate=${someChecked ? "1" : "0"}
                   title=${allChecked ? "Hide all in this group"
                                       : someChecked ? "Some shown — click to show all"
                                       : "Show all in this group"}
                   @click=${(e) => e.stopPropagation()}
                   @change=${() => this._togglePluginMaster(enabledIds)}>
          ` : null}
          <span class="name">${label}</span>
          <span class="count">${checkedCount}/${items.length}</span>
        </div>
        <div class="section-body">
          ${items.map((it) => html`
            <div class="row ${it.disabled ? "disabled" : ""} ${it.hasAutomation ? "has-automation" : ""}"
                 title=${it.title || (it.hasAutomation ? "Has automation data" : "")}
                 @click=${() => { if (!it.disabled) this._toggleVisible(it.controlId); }}>
              <input type="checkbox"
                     ?disabled=${it.disabled}
                     .checked=${this._visible.has(it.controlId)}
                     @click=${(e) => e.stopPropagation()}
                     @change=${() => this._toggleVisible(it.controlId)}>
              <div class="swatch" style="background:${it.color}; ${it.disabled ? "opacity:0.4" : ""}"></div>
              <div class="name">${it.label}</div>
              ${it.hint ? html`<div class="hint">${it.hint}</div>` : null}
            </div>
          `)}
        </div>
      </div>
    `;
  }

  _renderLegend(track) {
    const lanes = track.automation_lanes || [];
    const coreItems = lanes.map((lane) => {
      const label = this._labelForLane(lane.control_id);
      if (!this._matchesFilter(label, lane.control_id)) return null;
      const pts = (lane.points || []).length;
      return {
        controlId: lane.control_id,
        label,
        color: this._colorForLane(lane.control_id),
        hint: pts ? `${pts} pt${pts === 1 ? "" : "s"}` : null,
        disabled: false,
        // Has-automation marker so the legend row can paint an
        // accent indicating "this control already carries data,
        // even if you've hidden its editor card right now".
        hasAutomation: pts > 0
          || String(lane.mode || "off").toLowerCase() !== "off",
      };
    }).filter(Boolean);

    // Synthetic "Patches" lane on MIDI tracks. Aggregates the
    // `patch_changes` from every region on the track into a single
    // editor card with bank/program markers — a specialized view
    // instead of trying to shoehorn discrete bank+program tuples
    // into the continuous Parameter automation model.
    if (track.kind === "midi") {
      const totalPatches = (this._regionsForTrack(track.id) || [])
        .reduce((n, r) => n + ((r.patch_changes || []).length), 0);
      const patchLabel = "Patches";
      if (this._matchesFilter(patchLabel, this._patchLaneId(track.id))) {
        coreItems.push({
          controlId: this._patchLaneId(track.id),
          label: patchLabel,
          color: "#a78bfa",
          hint: totalPatches ? `${totalPatches} chg${totalPatches === 1 ? "" : "s"}` : null,
          disabled: false,
          hasAutomation: totalPatches > 0,
        });
      }
    }

    // Plugin parameter lanes are real now — the stub seeds an
    // automation lane per plugin param at session init so the wire
    // commands round-trip without UI changes. Each plugin section
    // shows its params as a checkable, group-toggle-able list.
    // For the point-count hint, look up the lane on the track and
    // count its points.
    const lanesByControlId = new Map(lanes.map((l) => [l.control_id, l]));
    const pluginSections = (track.plugins || []).map((plugin) => {
      const items = (plugin.params || []).map((param) => {
        // Plugin param ids are full ids like `plugin.X.param.Y` from
        // the backend; the lane's control_id will match exactly.
        const controlId = param.id;
        const label = param.label || param.name || controlId;
        if (!this._matchesFilter(label, controlId)) return null;
        const lane = lanesByControlId.get(controlId);
        const pts = (lane?.points || []).length;
        return {
          controlId,
          label,
          color: this._colorForLane(controlId),
          hint: pts ? `${pts} pt${pts === 1 ? "" : "s"}` : null,
          disabled: false,
          hasAutomation: pts > 0
            || String(lane?.mode || "off").toLowerCase() !== "off",
        };
      }).filter(Boolean);
      if (!items.length) return null;
      return this._renderLegendSection(plugin.id, plugin.name, items);
    }).filter(Boolean);

    const coreSection = coreItems.length
      ? this._renderLegendSection("__core", "Core", coreItems)
      : null;

    return html`
      <div class="legend">
        ${coreSection}
        ${pluginSections}
        ${(!coreItems.length && !pluginSections.length) ? html`
          <div class="empty"><strong>No automation</strong><br>This track has no automation lanes.</div>
        ` : null}
      </div>
    `;
  }

  _renderRuler() {
    const sr = this._sampleRate();
    const totalSec = this._totalSamples() / sr;
    const pxPerSec = this._pxPerSec || 60;
    const totalWidthPx = totalSec * pxPerSec;
    // Pick a tick step that gives ~one major label every 100 px.
    const idealSec = 100 / pxPerSec;
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s >= idealSec) { step = s; break; } }
    const ticks = [];
    const minorPerMajor = step >= 1 ? 5 : 2;
    const minorStep = step / minorPerMajor;
    for (let t = 0; t <= totalSec + 1e-6; t += minorStep) {
      const x = CONTENT_PAD_LEFT + t * pxPerSec;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-3;
      ticks.push({ x, t, isMajor });
    }
    return html`
      <div class="ruler">
        <div class="ruler-content" style="width:${totalWidthPx + CONTENT_PAD_LEFT}px;left:${-this._scrollLeft}px">
          ${ticks.map((tk) => tk.isMajor
            ? html`
                <div class="ruler-tick major" style="left:${tk.x}px"></div>
                <div class="ruler-label" style="left:${tk.x}px">${formatSec(tk.t)}</div>
              `
            : html`<div class="ruler-tick minor" style="left:${tk.x}px"></div>`
          )}
        </div>
      </div>
    `;
  }

  /**
   * Specialized editor card for the synthetic per-track Patches lane.
   * Not a `foyer-automation-lane` — the underlying data is a discrete
   * sequence of bank+program events scattered across regions, not a
   * continuous curve. Each patch change renders as a labeled chip at
   * its absolute timeline position; click empty space to add a new
   * one (anchors to whichever region holds that time), click an
   * existing chip to edit, Alt+click to delete.
   */
  _renderPatchCard(track, pxPerSec, totalWidthPx) {
    const controlId = this._patchLaneId(track.id);
    const expanded = this._expanded.has(controlId);
    const sr = this._sampleRate();
    const patches = this._patchChangesForTrack(track);
    return html`
      <div class="card patches ${expanded ? "" : "collapsed"}">
        <div class="card-head" @click=${() => this._toggleExpanded(controlId)}>
          ${icon(expanded ? "chevron-down" : "chevron-right", 11)}
          <div class="swatch" style="background:#a78bfa"></div>
          <div class="title">Patches</div>
          <div class="control-id">${patches.length} change${patches.length === 1 ? "" : "s"}</div>
        </div>
        <div class="card-body patches-body"
             style="width:${totalWidthPx}px"
             @pointerdown=${(e) => this._onPatchBodyPointerDown(e, track)}>
          ${this._renderWaveformLayer(track, pxPerSec)}
          <div class="patches-track">
            ${patches.map((p) => {
              const leftPx = (p.time_samples / sr) * pxPerSec;
              const pc = p.patch_change;
              const bankLabel = pc.bank < 0 ? "—" : String(pc.bank);
              return html`
                <div class="patch-chip"
                     style="left:${leftPx}px"
                     title=${`Ch ${pc.channel} · Bank ${bankLabel} · Program ${pc.program}\nClick to edit · Alt+click to delete`}
                     @pointerdown=${(e) => this._onPatchChipPointerDown(e, track, p)}>
                  <span class="ch">${pc.channel}</span>
                  <span class="prg">${bankLabel}/${pc.program}</span>
                </div>
              `;
            })}
          </div>
        </div>
        <div class="resize-grip"
             title="Drag to resize this lane vertically."
             @pointerdown=${(e) => this._startCardResize(e)}></div>
      </div>
    `;
  }

  /** Click on empty patches-body → open the picker (add flow).
   *  Picker defaults to the last committed selection so dropping
   *  multiple copies of the same patch doesn't force re-entry. */
  async _onPatchBodyPointerDown(ev, track) {
    if (ev.button !== 0) return;
    // Only react to clicks on the body itself, not on existing chips
    // (which propagate up after their own handler).
    if (!ev.target.classList?.contains("patches-body")
        && !ev.target.classList?.contains("patches-track")) return;
    ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const sample = Math.max(0, (x / (this._pxPerSec || 60)) * this._sampleRate());
    const region = this._regionAtSample(track, sample);
    if (!region) {
      const { toast } = await import("foyer-ui-core/widgets/toast.js");
      toast("Click within a region's timeline span to add a patch change.", { tone: "warn" });
      return;
    }
    this._openPatchPicker({ mode: "add", region, sample });
  }

  /** Click an existing chip → edit or delete. Alt+click deletes
   *  immediately; plain click opens the picker prefilled. Stops
   *  propagation so the body-level "add new" handler doesn't also
   *  fire on the same gesture. */
  async _onPatchChipPointerDown(ev, track, patch) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pc = patch.patch_change;
    if (ev.altKey) {
      window.__foyer?.ws?.send({
        type: "delete_patch_change",
        region_id: patch.region_id,
        patch_change_id: pc.id,
      });
      return;
    }
    const region = this._regionsForTrack(this.trackId)
      .find((r) => r.id === patch.region_id);
    if (!region) return;
    this._openPatchPicker({ mode: "edit", region, patch });
  }

  _renderEditorPane(track) {
    const lanes = track.automation_lanes || [];
    // The Ardour shim seeds AutomationLane entries for core controls
    // only (gain/pan/mute/solo); the stub seeds for every plugin
    // param too. When the user checks a plugin param in the legend
    // that has no matching lane on the live track, synthesize one
    // client-side so the editor card renders. The first
    // add_automation_point fires through the wire, and the backend
    // either creates the lane (stub) or rejects (older shim) — the
    // UI shape stays the same either way.
    const byId = new Map(lanes.map((l) => [l.control_id, l]));
    const patchSentinel = this._patchLaneId(track.id);
    const visibleLanes = [...this._visible]
      .map((controlId) => byId.get(controlId) || {
        control_id: controlId,
        mode: "off",
        points: [],
      })
      .filter((l) => {
        // Filter out controlIds that don't correspond to anything
        // on the current track (e.g. user switched tracks and the
        // persisted _visible set still has stale ids from before).
        // The patches sentinel for MIDI tracks is a synthetic id —
        // not a Parameter and not a real automation lane — but we
        // want to render it.
        if (l.control_id === patchSentinel && track.kind === "midi") return true;
        if (byId.has(l.control_id)) return true;
        const param = this._parameterForLane(track, l.control_id);
        return !!param;
      });
    if (!visibleLanes.length) {
      return html`
        <div class="editor-pane">
          ${this._renderRuler()}
          <div class="scroll">
            <div class="empty">
              <strong>No editors visible</strong><br>
              Tick a control in the legend to start editing its automation.
            </div>
          </div>
        </div>
      `;
    }
    const totalSamples = this._totalSamples();
    const pxPerSec = this._pxPerSec || 60;
    const totalWidthPx = (totalSamples / this._sampleRate()) * pxPerSec + CONTENT_PAD_LEFT;
    return html`
      <div class="editor-pane">
        ${this._renderRuler()}
        <div class="scroll" @scroll=${this._onScroll}>
          <div class="scroll-content" style="min-width:${totalWidthPx}px">
            ${visibleLanes.map((lane) => {
              // Patches lane → specialized renderer (markers, not
              // continuous curves). Sentinel control_id ends in
              // `.__patches` and is created synthetically by
              // `_renderLegend` for MIDI tracks only.
              if (lane.control_id === this._patchLaneId(track.id)) {
                return this._renderPatchCard(track, pxPerSec, totalWidthPx);
              }
              const expanded = this._expanded.has(lane.control_id);
              const color = this._colorForLane(lane.control_id);
              const param = this._parameterForLane(track, lane.control_id);
              // Plugin params often have control_ids whose tail is a
              // numeric suffix (e.g. `plugin.eq.param.4`). Pull the
              // human label from the Parameter struct so the card
              // header reads "Bypass" / "Scale" / "Freq" instead of
              // "4" / "5" / "11".
              const label = this._labelForLane(
                lane.control_id,
                param?.label || param?.name,
              );
              return html`
                <div class="card ${expanded ? "" : "collapsed"}">
                  <div class="card-head" @click=${() => this._toggleExpanded(lane.control_id)}>
                    ${icon(expanded ? "chevron-down" : "chevron-right", 11)}
                    <div class="swatch" style="background:${color}"></div>
                    <div class="title">${label}</div>
                    <div class="control-id">${lane.control_id}</div>
                  </div>
                  <div class="card-body" style="width:${totalWidthPx}px">
                    ${this._renderWaveformLayer(track, pxPerSec)}
                    <foyer-automation-lane
                      .lane=${lane}
                      .totalSamples=${totalSamples}
                      .pxPerSec=${pxPerSec}
                      .sampleRate=${this._sampleRate()}
                      .color=${color}
                      .parameter=${param}
                      .regions=${this._regionsForTrack(track.id)}
                    ></foyer-automation-lane>
                  </div>
                  <div class="resize-grip"
                       title="Drag to resize this lane vertically — taller = finer per-pixel value control."
                       @pointerdown=${(e) => this._startCardResize(e)}></div>
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }
}

function formatSec(t) {
  if (t < 1) return `${(t * 1000).toFixed(0)}ms`;
  if (t < 60) return `${t.toFixed(t >= 10 ? 0 : 1)}s`;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

customElements.define("foyer-automation-modal", AutomationModal);

/**
 * Spawn (or refocus) the automation modal scoped to `trackId`, with
 * an optional `focusControlId` to pre-check and expand. Single
 * instance per session — calling again with a different trackId
 * retargets the existing window instead of stacking duplicates.
 */
export function openAutomationModal({ trackId, focusControlId } = {}) {
  const editor = document.createElement("foyer-automation-modal");
  editor.trackId = trackId || "";
  editor.focusControlId = focusControlId || "";
  return openWindow({
    title: "Automation editor",
    icon: "sparkles",
    storageKey: STORAGE_KEY,
    content: editor,
    width: Math.min(1280, Math.round(window.innerWidth * 0.9)),
    height: Math.min(800, Math.round(window.innerHeight * 0.85)),
    persist: { kind: "automation-editor", id: STORAGE_KEY, props: { trackId, focusControlId } },
    viewKind: "automation-editor",
    viewProps: { trackId, focusControlId },
    onReuse: (existing) => {
      if (!existing) return;
      existing.trackId = trackId || existing.trackId;
      existing.focusControlId = focusControlId || "";
    },
  });
}
