// Sprunki Interior — the zoom-in editor for a single sprunki on
// stage. Click a sprunki on the stage → the parent app opens this
// overlay with the slot in question.
//
// Layout:
//   * Huge faded sprunki silhouette behind the editor (the
//     sprunki you clicked, still alive — same idle sway + meter
//     pulse as on stage, just bigger and toned down to ~25% so
//     the grid in front stays readable).
//   * Vertical bar rail on the left — one tab per bar in the
//     pattern (1..BARS_PER_PATTERN). The kid picks which bar
//     they're authoring; only that bar's 16 steps render. Keeps
//     the grid huge and tappable regardless of voice count.
//   * Per-voice step grids stacked vertically inside the editor —
//     one row per `patch.rows[]` entry. Each row is a single
//     16-cell strip for the active bar.
//   * Section tabs (Intro / Verse / Chorus / Drop) at the top so
//     the kid can author each section's variant.
//   * Close button + ESC + click-outside dismiss.
//   * Click-drag paint: hold pointer down on one step and drag
//     across others to paint a run on (or off, if the first cell
//     started ON). Single tap still toggles one cell.
//
// State source: the live sprunki store. Mutations go through
// `sprunkiStore.toggleCell(slotId, rowId, step)` — no local copy.

import { LitElement, html, css } from "lit";
import { getPatch } from "../patches.js";
import { idleCostumeUrlFor, playCostumeUrlFor } from "../sprunki-assets.js";
import {
  BARS_PER_PATTERN,
  STEPS_PER_BAR,
} from "./sound-catalog.js";
import { allFxFor } from "../fx-catalog.js";

export class SprunkiInterior extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: flex;
      flex-direction: column;
      background: rgba(8, 10, 24, 0.92);
      backdrop-filter: blur(6px);
      animation: fade-in 220ms ease-out;
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      position: relative;
      z-index: 3;
    }
    .header-title {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      letter-spacing: 0.02em;
    }
    .header-sub {
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .header-spacer { flex: 1; }
    /* High-contrast red close — matches the settings panel + the
       per-sprunki send-home X so all "dismiss / clear" gestures
       read as the same gesture. */
    .close-btn {
      width: 36px; height: 36px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.85);
      background: #e54d3a;
      color: #fff;
      font: 800 20px/1 system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      transition: transform 100ms ease, background 100ms ease;
    }
    .close-btn:hover { background: #c33a28; transform: scale(1.08); }
    .close-btn:active { transform: scale(0.94); }

    /* Header-action chips: solo, reset. Pill-shaped, small, inert-
       looking until hovered. Solo toggles to a bright orange when
       active (matching the stage ribbon's solo glow). Reset is a
       muted danger button — confirmation lives inside this panel
       so the kid never sees a native dialog. */
    .header-action {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.10);
      color: rgba(255, 255, 255, 0.78);
      font: 700 11px system-ui, sans-serif;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease,
                  border-color 120ms ease, transform 110ms ease;
    }
    .header-action:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
    .header-action.solo.active {
      background: linear-gradient(135deg, #e6a91c 0%, #ff6f00 100%);
      color: #fff;
      border-color: rgba(255, 200, 120, 0.65);
      box-shadow: 0 0 12px rgba(230, 169, 28, 0.40);
    }
    .header-action.reset:hover {
      background: rgba(229, 77, 58, 0.20);
      color: #ffcdc4;
      border-color: rgba(229, 77, 58, 0.45);
    }
    .header-action svg { width: 16px; height: 16px; }

    /* In-editor confirm overlay for the reset action. Same shape as
       the prefs modal's confirm; gated behind a button on the
       header so it can't fire by accident. */
    .reset-veil {
      position: absolute;
      inset: 0;
      background: rgba(8, 10, 16, 0.78);
      display: grid; place-items: center;
      z-index: 50;
    }
    .reset-panel {
      background: #1c1f2c;
      border: 1px solid #3a2828;
      border-radius: 12px;
      padding: 22px 26px;
      max-width: 380px;
      width: calc(100% - 40px);
      box-shadow: 0 14px 40px rgba(0,0,0,0.55);
    }
    .reset-title { font: 800 16px system-ui, sans-serif; color: #fff; margin-bottom: 8px; }
    .reset-body  { font-size: 13px; color: rgba(255,255,255,0.72); line-height: 1.45; margin-bottom: 16px; }
    .reset-actions { display: flex; gap: 10px; justify-content: flex-end; }
    .reset-actions button {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: #e5e8ee;
      padding: 8px 16px;
      border-radius: 8px;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
    }
    .reset-actions button:hover { background: rgba(255,255,255,0.14); }
    .reset-actions button.go {
      background: #e54d3a;
      border-color: rgba(255,255,255,0.85);
      color: #fff;
      box-shadow: 0 3px 10px rgba(229, 77, 58, 0.35);
    }
    .reset-actions button.go:hover { background: #c33a28; }

    .stage {
      position: relative;
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      /* Bottom padding creates a deliberate dismiss strip below
         the grid — kids can click the area between the last bar
         block and the bottom of the screen to close. Without
         this the body fills 100% of stage height and there's no
         "outside the grid" area to click. */
      padding-bottom: 36px;
      box-sizing: border-box;
    }
    /* Giant faded sprunki behind the editor. Stays alive — same
       sway / meter pulse the stage sprunki has, just scaled and
       de-saturated so the grid in front reads. */
    .stage-sprunki {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      pointer-events: none;
      z-index: 1;
      opacity: 0.28;
      filter: blur(0.5px);
    }
    .stage-sprunki img,
    .stage-sprunki .sprunki-chip {
      height: 130vh;
      max-width: none;
      object-fit: contain;
      object-position: top center;
      animation: sway 3.4s ease-in-out infinite;
      transform-origin: bottom center;
      /* Combine three scale sources: --vol-scale (the slot's
         volume/y position, set by the volume fader), --meter (live
         audio peak feedback), and the baseline translateY shim. */
      transform: scale(calc(var(--vol-scale, 1) * (1 + var(--meter, 0) * 0.10)))
                 translateY(20vh);
      filter: drop-shadow(0 12px 32px rgba(0,0,0,0.5));
    }
    /* No-art fallback chip when the OG asset pack hasn't resolved.
       Mirrors the stage component's chip but scaled to fill the
       interior backdrop. */
    .stage-sprunki .sprunki-chip {
      width: 50vh;
      height: 50vh;
      border-radius: 999px;
      background: var(--cc, #fff);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 800 28vh system-ui, sans-serif;
      line-height: 1;
      box-shadow: inset 0 0 0 4px rgba(255,255,255,0.18);
      text-shadow: 0 2px 6px rgba(0,0,0,0.45);
    }
    @keyframes sway {
      0%, 100% { translate: 0 0; }
      50%      { translate: 0 -8px; }
    }

    /* Bar rail + editor grid. The rail on the left selects which
       bar(s) of the pattern render. Modes:
       - "all" (default): all 4 bars stack in mini grids, with
         dividers between them. Cells auto-scale so the whole
         pattern fits the viewport regardless of voice count.
       - 0..3 (single bar): one bar fills the editor with bigger,
         tappable cells. Best for fine-tuning a specific bar. */
    .body {
      position: relative;
      z-index: 2;
      flex: 1;
      display: grid;
      /* Left rail widened 2026-05-26 — the effects pill labels
         (Echo / Chorus / Reverb / Filter) were clipping at the old
         88 px width, showing "Choru" and "Rever". 116 px fits the
         longest label with comfortable inner padding. */
      grid-template-columns: 116px 1fr;
      overflow: hidden;
    }
    .bar-rail {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 24px 10px;
      background: rgba(0, 0, 0, 0.22);
      border-right: 1px solid rgba(255, 255, 255, 0.06);
      overflow-y: auto;
    }
    /* FX rail — sits below the bar selector in the same left
       column. One toggle per effect on the costume, plus the
       ingress-only effects (Autotune / Vocoder) when the slot's
       patch declares accepts_ingress (currently Phantom). Tap
       toggles the plugin on the slot's backend track. */
    .fx-rail {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 4px 14px;
      margin-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    /* Volume fader — mirrors the on-stage volume gesture (drag the
       sprunki up/down). Vertical track + thumb the kid can drag.
       slot.y goes 0..1 (top=loud, bottom=quiet); we render the
       thumb at (1 - y) * 100% so dragging UP raises the volume,
       matching DAW fader convention. */
    .vol-rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 10px 0;
      margin-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .vol-rail-label {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.45);
    }
    .vol-track {
      position: relative;
      width: 14px;
      height: 130px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      cursor: ns-resize;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    /* Filled portion below the thumb — visual cue that "more fill =
       louder". Heights are set inline via --vol-pct. */
    .vol-fill {
      position: absolute;
      left: 1px; right: 1px; bottom: 1px;
      height: calc(var(--vol-pct, 50) * 1% - 2px);
      border-radius: 6px;
      background: linear-gradient(180deg,
        rgba(108, 92, 255, 0.55) 0%,
        rgba(108, 92, 255, 0.32) 100%);
      pointer-events: none;
    }
    .vol-thumb {
      position: absolute;
      left: 50%;
      width: 26px;
      height: 14px;
      border-radius: 4px;
      transform: translate(-50%, -50%);
      top: calc((100% - var(--vol-pct, 50) * 1%));
      background: linear-gradient(180deg, #f4f6ff 0%, #c8cce0 100%);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6),
                  inset 0 0 0 1px rgba(0, 0, 0, 0.25);
      pointer-events: none;
    }
    .vol-rail.dragging .vol-thumb { box-shadow: 0 4px 12px rgba(108, 92, 255, 0.7), inset 0 0 0 1px rgba(0,0,0,0.25); }
    .vol-readout {
      font-size: 10px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.55);
      font-variant-numeric: tabular-nums;
    }

    .fx-rail-label {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.45);
      text-align: center;
      margin: 4px 0 6px;
    }
    /* Effects buttons — pill rows that read as toggleable chips.
       Restyled 2026-05-26: uniform height, centered glyph block,
       crisper "on" gradient so active vs inactive reads at a glance
       on the dark backdrop. */
    .fx-tab {
      display: grid;
      grid-template-columns: 20px 1fr;
      gap: 6px;
      align-items: center;
      height: 32px;
      padding: 0 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.62);
      font: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      cursor: pointer;
      text-align: left;
      /* Prevent the label from wrapping mid-word into a second line
         when the rail is tight; the parent column is fixed so
         overflow stays clipped under the rail's edge. */
      white-space: nowrap;
      overflow: hidden;
      transition: background 120ms ease, color 120ms ease,
                  border-color 120ms ease;
    }
    .fx-tab:hover {
      background: rgba(255, 255, 255, 0.10);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.14);
    }
    .fx-tab.on {
      background: linear-gradient(135deg, #e6a91c 0%, #ff6f00 100%);
      color: #fff;
      border-color: rgba(255, 200, 120, 0.55);
      box-shadow: 0 0 12px rgba(230, 169, 28, 0.35);
    }
    .fx-tab.ingress {
      border-style: dashed;
      opacity: 0.7;
    }
    .fx-tab.ingress.on { opacity: 1; border-style: solid; }
    .fx-glyph {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 13px/1 system-ui, sans-serif;
      color: inherit;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
    }
    .fx-tab.on .fx-glyph { background: rgba(255, 255, 255, 0.20); }
    .bar-tab {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 14px 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      color: rgba(255, 255, 255, 0.62);
      font-family: inherit;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease, transform 120ms ease;
    }
    .bar-tab:hover { background: rgba(255, 255, 255, 0.08); }
    .bar-tab.active {
      background: linear-gradient(135deg, #4f4ac9 0%, #6c5cff 100%);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: 0 0 16px rgba(108, 92, 255, 0.4);
      transform: translateX(2px);
    }
    .bar-num {
      font-size: 22px;
      font-weight: 800;
      line-height: 1;
    }
    .bar-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .editor {
      overflow: auto;
      padding: 14px 18px 18px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    /* "All" view: a bar block per bar, containing one labeled
       voice row per instrument. Labels sit on the LEFT (the
       outer grouping is bar; the inner is voice). Single-bar
       view: keep the legacy by-voice layout. */
    .row-block {
      width: 100%;
      max-width: 1100px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .row-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .row-swatch {
      width: 16px; height: 16px;
      border-radius: 6px;
      background: var(--rc, #fff);
      box-shadow: 0 0 0 2px rgba(255,255,255,0.08);
    }
    .row-name {
      font-size: 14px;
      font-weight: 600;
      color: #f0f0f5;
    }
    .row-meta {
      margin-left: auto;
      font-size: 10px;
      color: rgba(255,255,255,0.45);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    /* By-bar grouping for "All" view. Each .bar-block is one bar,
       with 4 voice rows (label + 16-step strip) stacked inside.
       Labels live on the LEFT so the strips line up. Cells scale
       vertically to fit the viewport given the total row count
       (4 bars × N voices). */
    .bar-block {
      width: 100%;
      max-width: 1320px;
    }
    /* Inter-bar gap tightened 2026-05-26 so a 16:9 / 2:1 viewport
       fits 4 bars × 4 voices without scrolling — Rich's call:
       "we need to see the whole pattern at once on a wide screen."
       The thin divider keeps bars visually separated even at 6px. */
    .bar-block + .bar-block { margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.08); }
    .bar-block-header {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.55);
      margin: 0 0 3px 4px;
    }
    .voice-row {
      display: grid;
      grid-template-columns: 78px 1fr;
      gap: 8px;
      align-items: center;
      margin-bottom: 2px;
    }
    .voice-label {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
      font-weight: 700;
      color: #f0f0f5;
      overflow: hidden;
    }
    .voice-label .row-swatch {
      width: 12px; height: 12px;
      flex: 0 0 12px;
    }
    .voice-label-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Single-bar grid: 16 cells in one horizontal strip, big
       and tappable. Used when a specific bar tab (1..4) is
       active. */
    .step-grid {
      display: grid;
      grid-template-columns: repeat(16, 1fr);
      gap: 5px;
      touch-action: none;
    }
    /* All-bars grid: stacks 4 mini-strips of 16 cells with a
       divider between bars. Used when the "All" tab is active.
       Cell height is clamped against viewport so the full pattern
       fits regardless of voice count — 4-voice composite + 4 bars
       = 16 rows × 16 cells and still scales cleanly. */
    .step-grid.mini {
      gap: 2px;
    }
    .step-grid.mini + .step-grid.mini {
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px dashed rgba(255, 255, 255, 0.16);
    }
    .bar-mini-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.40);
      margin: 0 0 4px 2px;
    }
    .step {
      aspect-ratio: 1;
      max-height: 76px;
      min-height: 36px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      cursor: pointer;
      touch-action: none;
      transition: background 80ms ease,
                  border-color 80ms ease,
                  transform 80ms ease;
    }
    /* All-bars mode: cells shrink to fit the stacked 16-row grid.
       Clamp against viewport so multi-voice composites still fit
       on standard laptop heights. Tightened 2026-05-26 to fit
       4 bars × 4 voices on a 2:1 viewport without scrolling. */
    .step-grid.mini .step {
      max-height: clamp(14px, 4.6vh, 56px);
      min-height: 12px;
      border-radius: 5px;
    }
    .step.beat {
      background: rgba(255,255,255,0.08);
    }
    /* Every 4th cell gets a slim left-side separator so the
       16 cells read as 4 beat groups of 4 sixteenths. */
    .step.beat-start {
      margin-left: 4px;
    }
    .step.active {
      background: var(--rc, #6c5cff);
      border-color: color-mix(in srgb, var(--rc, #6c5cff) 50%, #fff);
      box-shadow: 0 0 12px color-mix(in srgb, var(--rc, #6c5cff) 60%, transparent);
      transform: scale(1.04);
    }
    .step:hover { border-color: rgba(255,255,255,0.25); }
  `;

  static properties = {
    /** The slot being edited (live reference from the store). */
    slot: { type: Object },
    /** Active pattern id (which section's authoring we're editing). */
    patternId: { type: String },
    /** True when OG sprunki art is available. */
    assetsReady: { type: Boolean },
    /** Which bar of the pattern is visible. `"all"` shows every bar
     *  stacked with dividers; 0..BARS_PER_PATTERN-1 shows just that
     *  bar at full cell size. Defaults to "all" so the kid sees
     *  the whole pattern when they zoom in. */
    _activeBar: { state: true },
    /** Set of FX ids that are currently enabled on the slot's track,
     *  pushed down from the parent app (computed from the live
     *  plugin chain on each session_snapshot). Source of truth =
     *  backend, not localStorage. */
    enabledFx: { type: Object },
    /** Whether the slot is currently soloed on the backend. Pushed
     *  down from the app shell so the header chip's active state
     *  echoes the live DAW control. */
    soloed: { type: Boolean },
    /** Whether this is the FIRST part in the palette. Only the
     *  first part can be reset to its patch's default board — for
     *  other parts the "default" concept is meaningless (the kid
     *  authored them from scratch). */
    canReset: { type: Boolean },
    /** When true, render the in-panel "Reset this part?" confirm. */
    _confirmingReset: { state: true },
  };

  constructor() {
    super();
    this.slot = null;
    this.patternId = "intro";
    this.assetsReady = false;
    this.enabledFx = new Set();
    this.soloed = false;
    this.canReset = false;
    this._confirmingReset = false;
    this._activeBar = "all";
    this._levels = {};
    // Click-drag paint gesture state — lives only during a stroke.
    this._paintRowId = null;
    this._paintMode = null;
    this._paintedSteps = null;
    this._paintInitialActiveSet = null;
    this._paintHandlers = null;
    this._onKey = (e) => {
      if (e.key === "Escape") this._close();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKey);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKey);
  }

  updateLevels(bySlot) {
    if (!this.slot) return;
    const db = bySlot?.[this.slot.id];
    if (typeof db !== "number") return;
    const lin = Math.max(0, Math.min(1, (db + 50) / 50));
    const intensity = lin * lin;
    const el = this.renderRoot?.querySelector(".stage-sprunki");
    if (el) el.style.setProperty("--meter", intensity.toFixed(3));
  }

  _close() {
    this.dispatchEvent(new CustomEvent("interior-close", {
      bubbles: true, composed: true,
    }));
  }
  _onToggleSolo() {
    this.dispatchEvent(new CustomEvent("interior-toggle-solo", {
      detail: { slotId: this.slot?.id },
      bubbles: true, composed: true,
    }));
  }
  _onResetClick() {
    this._confirmingReset = true;
  }
  _cancelReset() {
    this._confirmingReset = false;
  }
  _confirmReset() {
    this.dispatchEvent(new CustomEvent("interior-reset-part", {
      detail: { slotId: this.slot?.id },
      bubbles: true, composed: true,
    }));
    this._confirmingReset = false;
  }
  /** Dismiss the interior when the click lands OUTSIDE the actual
   *  authoring grid (bar blocks + bar rail) and isn't on any
   *  interactive control. This means clicks to the left/right of
   *  the visible cell grid dismiss naturally, matching the settings
   *  panel's backdrop behaviour. Clicks NEAR but missing a step
   *  cell stay protected because the .bar-block / .row-block
   *  wrappers swallow them. */
  _onBackdropClick(e) {
    // A click-drag PAINT stroke that ended off-grid would otherwise
    // dismiss here — the kid starts on a cell, drags off the grid
    // edge, releases. That release fires `click` on whatever's
    // under the pointer. Suppress this dismiss when a paint stroke
    // just resolved, or while one is still in flight.
    if (this._paintJustEnded) {
      this._paintJustEnded = false;
      return;
    }
    if (this._paintRowId) return;
    const interactive = e.target.closest?.(
      ".step, .bar-rail, .bar-tab, .fx-tab, .fx-rail, button, " +
      ".header-title, .header-sub, .bar-block, .row-block"
    );
    if (interactive) return;
    this._close();
  }
  _onStepToggle(rowId, step) {
    this.dispatchEvent(new CustomEvent("interior-step-toggle", {
      detail: { slotId: this.slot?.id, rowId, step },
      bubbles: true, composed: true,
    }));
  }
  _setActiveBar(bar) {
    if (bar === this._activeBar) return;
    this._activeBar = bar;
  }
  /** Vertical volume fader for the left rail. Mirrors the on-stage
   *  drag-up-for-volume gesture but as a dedicated control so the
   *  kid doesn't have to dismiss the editor to adjust gain. slot.y
   *  is the canonical position (0=bottom/quiet, 1=top/loud); the
   *  app handler maps that onto track.gain via levelDb(y) AND
   *  re-renders the on-stage scale. */
  _renderVolumeFader() {
    // slot.y is INVERTED from screen direction: y=0 is top-of-stage
    // (LOUD), y=1 is bottom (quiet). The fader thumb's visual
    // position is what the kid expects (top = loud), so we render
    // pct = (1 - y) * 100.
    const y = typeof this.slot?.y === "number" ? this.slot.y : 0.85;
    const pct = Math.round((1 - y) * 100);
    return html`
      <div class="vol-rail ${this._volDragging ? "dragging" : ""}">
        <div class="vol-rail-label">Volume</div>
        <div
          class="vol-track"
          style="--vol-pct: ${pct};"
          title="Drag up to make this sprunki louder + bigger"
          @pointerdown=${this._onVolPointerDown}
        >
          <div class="vol-fill"></div>
          <div class="vol-thumb"></div>
        </div>
        <div class="vol-readout">${pct}%</div>
      </div>
    `;
  }
  /** Mirror the stage's `levelScale(y)` math so the interior
   *  silhouette scales the same way as the on-stage sprunki when
   *  the fader moves. y=0.85 is the neutral baseline; ±range maps
   *  to ±15% size. Locally derived (not re-imported) to keep the
   *  interior independent of the stage component. */
  _volScaleForY(y) {
    const yy = typeof y === "number" ? y : 0.85;
    const baseline = 0.85;
    // Match the stage's levelT: t = (baseline - y) / baseline.
    // y < baseline (slot higher on stage / louder) → t > 0 → scale > 1
    // y > baseline (slot lower / quieter)            → t < 0 → scale < 1
    // The previous (yy - baseline) sign made the silhouette grow
    // when quieter and shrink when louder — opposite of the
    // on-stage behaviour and the kid's expectation.
    const t = Math.max(-1, Math.min(1, (baseline - yy) / baseline));
    return (1 + t * 0.15).toFixed(3);
  }
  _onVolPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget;
    track.setPointerCapture?.(e.pointerId);
    this._volDragging = true;
    this.requestUpdate();
    const apply = (clientY) => {
      const r = track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      // t = distance from top of fader (0 at top, 1 at bottom).
      // slot.y uses stage convention: y=0 is top-of-stage = LOUD;
      // y=1 is bottom = QUIET. Dragging the thumb up (cursor moves
      // up, t decreases) should make the slot LOUDER (y decreases).
      // So y = t — no inversion. (The previous `y = 1 - t` made
      // the fader run backwards.)
      const y = t;
      this.dispatchEvent(new CustomEvent("interior-volume-change", {
        detail: { slotId: this.slot?.id, y },
        bubbles: true, composed: true,
      }));
    };
    apply(e.clientY);
    const onMove = (ev) => apply(ev.clientY);
    const onUp = (ev) => {
      track.releasePointerCapture?.(ev.pointerId);
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", onUp);
      track.removeEventListener("pointercancel", onUp);
      this._volDragging = false;
      this.requestUpdate();
    };
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onUp);
  };
  /** Toggle an FX on the slot's track. The parent app owns the
   *  add_plugin / remove_plugin dispatch — we just emit. The
   *  enabled-set is updated optimistically (so the toggle visually
   *  flips immediately) and reconciled when the next snapshot
   *  arrives. */
  _onToggleFx(fx) {
    const isOn = this.enabledFx?.has?.(fx.id);
    this.dispatchEvent(new CustomEvent("interior-toggle-fx", {
      detail: { slotId: this.slot?.id, fxId: fx.id, on: !isOn },
      bubbles: true, composed: true,
    }));
    const next = new Set(this.enabledFx || []);
    if (isOn) next.delete(fx.id); else next.add(fx.id);
    this.enabledFx = next;
  }

  // ── click-drag paint ──────────────────────────────────────────────
  // Hold pointer on a cell + drag across others to paint a run.
  // First cell toggles (its NEW state defines paint mode); subsequent
  // cells we drag over get set to that mode if they don't already
  // match. Single tap with no drag still just toggles the cell.
  _onStepPointerDown(e, row, step, wasActive) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const board = this.slot?.boards?.[this.patternId] || {};
    this._paintInitialActiveSet = new Set(board[row.id] || []);
    this._paintMode = !wasActive;
    this._paintRowId = row.id;
    this._paintedSteps = new Set([step]);
    this._onStepToggle(row.id, step);
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    this._paintHandlers = {
      move: (ev) => this._onPaintMove(ev),
      end:  (ev) => this._onPaintEnd(ev),
    };
    target.addEventListener("pointermove", this._paintHandlers.move);
    target.addEventListener("pointerup", this._paintHandlers.end);
    target.addEventListener("pointercancel", this._paintHandlers.end);
  }
  _onPaintMove(e) {
    if (!this._paintRowId) return;
    // The captured pointer fires events on the original cell, but
    // we want to find the cell currently UNDER the pointer. Walk
    // the shadow root with elementFromPoint.
    const root = this.renderRoot;
    const hit = root?.elementFromPoint?.(e.clientX, e.clientY);
    const stepEl = hit?.closest?.(".step");
    if (!stepEl) return;
    const rowId = stepEl.dataset.row;
    const stepIdx = Number(stepEl.dataset.step);
    // Paint stays in the row where the gesture started — diagonal
    // drags don't bleed into neighboring voices.
    if (rowId !== this._paintRowId) return;
    if (!Number.isFinite(stepIdx) || this._paintedSteps.has(stepIdx)) return;
    this._paintedSteps.add(stepIdx);
    const wasActive = this._paintInitialActiveSet.has(stepIdx);
    if (wasActive !== this._paintMode) {
      this._onStepToggle(rowId, stepIdx);
    }
  }
  _onPaintEnd(e) {
    if (!this._paintRowId) return;
    const target = e.currentTarget;
    target.releasePointerCapture?.(e.pointerId);
    if (this._paintHandlers) {
      target.removeEventListener("pointermove", this._paintHandlers.move);
      target.removeEventListener("pointerup", this._paintHandlers.end);
      target.removeEventListener("pointercancel", this._paintHandlers.end);
    }
    this._paintRowId = null;
    this._paintMode = null;
    this._paintedSteps = null;
    this._paintInitialActiveSet = null;
    this._paintHandlers = null;
    // Flag for the upcoming `click` event that fires when the
    // pointer is released — gates _onBackdropClick so a paint
    // stroke that overshoots the grid edge doesn't dismiss.
    this._paintJustEnded = true;
  }

  _renderStep(row, step, activeSet) {
    const isActive = activeSet.has(step);
    const stepInBar = step % STEPS_PER_BAR;
    const isBeat = stepInBar % 4 === 0;
    const isBeatStart = isBeat && stepInBar !== 0;
    return html`
      <div
        class="step ${isBeat ? "beat" : ""} ${isBeatStart ? "beat-start" : ""} ${isActive ? "active" : ""}"
        data-row=${row.id}
        data-step=${String(step)}
        style="--rc:${row.color || "#6c5cff"};"
        title="Bar ${Math.floor(step / STEPS_PER_BAR) + 1}, step ${stepInBar + 1}"
        @pointerdown=${(e) => this._onStepPointerDown(e, row, step, isActive)}
      ></div>
    `;
  }

  /** Single-bar view: by-voice rows (each row is one instrument
   *  across 16 steps of the active bar). Used when the kid focuses
   *  on a specific bar (1..4) via the bar rail. */
  _renderRowSingleBar(row) {
    const board = this.slot?.boards?.[this.patternId] || {};
    const activeSet = new Set(board[row.id] || []);
    const pitchHint = typeof row.pitch === "number"
      ? `MIDI ${row.pitch}`
      : row.chord_tone
        ? `chord-${row.chord_tone}`
        : typeof row.scale_degree === "number"
          ? `scale ${row.scale_degree}`
          : "";
    const barStart = this._activeBar * STEPS_PER_BAR;
    return html`
      <div class="row-block">
        <div class="row-header">
          <div class="row-swatch" style="--rc:${row.color || "#6c5cff"};"></div>
          <div class="row-name">${row.label}</div>
          <div class="row-meta">${pitchHint}</div>
        </div>
        <div class="step-grid">
          ${Array.from({ length: STEPS_PER_BAR }, (_, i) =>
            this._renderStep(row, barStart + i, activeSet))}
        </div>
      </div>
    `;
  }

  /** "All" view: by-bar grouping. Each bar block contains a row
   *  per voice with the instrument label pinned on the LEFT. This
   *  is the layout Rich asked for in the 2026-05-25 review pass —
   *  outer grouping = bar, inner = voice (the inverse of the
   *  prior arrangement). Cells scale vertically to fit. */
  _renderBarBlockAllBars(barIdx, rows) {
    const board = this.slot?.boards?.[this.patternId] || {};
    const barStart = barIdx * STEPS_PER_BAR;
    return html`
      <div class="bar-block" data-bar=${barIdx}>
        <div class="bar-block-header">Bar ${barIdx + 1}</div>
        ${rows.map((row) => {
          const activeSet = new Set(board[row.id] || []);
          return html`
            <div class="voice-row">
              <div class="voice-label" title=${row.label}>
                <div class="row-swatch" style="--rc:${row.color || "#6c5cff"};"></div>
                <span class="voice-label-name">${row.label}</span>
              </div>
              <div class="step-grid mini">
                ${Array.from({ length: STEPS_PER_BAR }, (_, i) =>
                  this._renderStep(row, barStart + i, activeSet))}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }

  _renderBarRail() {
    // "All" tab sits at the top so the default mode is one click
    // away from any other selection. Specific-bar tabs follow.
    const tabs = [
      { id: "all", num: "All", label: "Bars" },
      ...Array.from({ length: BARS_PER_PATTERN }, (_, b) => ({
        id: b, num: String(b + 1), label: "Bar",
      })),
    ];
    const patch = this.slot?.patch_id ? getPatch(this.slot.patch_id) : null;
    const fxList = allFxFor(patch);
    return html`
      <nav class="bar-rail" aria-label="Bar selector">
        ${tabs.map((t) => html`
          <button
            class="bar-tab ${t.id === this._activeBar ? "active" : ""}"
            title=${t.id === "all"
              ? `Show all ${BARS_PER_PATTERN} bars stacked`
              : `Focus on bar ${t.id + 1}`}
            @click=${() => this._setActiveBar(t.id)}
          >
            <span class="bar-num">${t.num}</span>
            <span class="bar-label">${t.label}</span>
          </button>
        `)}
        ${this._renderVolumeFader()}
        <div class="fx-rail">
          <div class="fx-rail-label">Effects</div>
          ${fxList.map((fx) => {
            const on = this.enabledFx?.has?.(fx.id);
            return html`
              <button
                class="fx-tab ${on ? "on" : ""} ${fx.ingress ? "ingress" : ""}"
                title=${fx.ingress
                  ? `${fx.label} (mic-ingress only)`
                  : `Toggle ${fx.label}`}
                @click=${() => this._onToggleFx(fx)}
              >
                <span class="fx-glyph">${fx.glyph}</span>
                <span>${fx.label}</span>
              </button>
            `;
          })}
        </div>
      </nav>
    `;
  }

  render() {
    const patch = this.slot?.patch_id ? getPatch(this.slot.patch_id) : null;
    if (!patch) {
      // No-op view — render an empty overlay that backdrop-clicks
      // dismiss. Shouldn't really land here because the stage
      // doesn't emit interior-click on empty slots, but defend.
      return html`<div @click=${this._onBackdropClick}></div>`;
    }
    const art = this.assetsReady
      ? (playCostumeUrlFor(patch.sprunki_id) || idleCostumeUrlFor(patch.sprunki_id))
      : null;
    return html`
      <div class="header" @click=${this._onBackdropClick}>
        <div>
          <div class="header-title">${patch.label}</div>
          <div class="header-sub">${patch.rows.length === 1 ? "1 voice" : `${patch.rows.length} voices`}</div>
        </div>
        <div class="header-spacer"></div>
        <button
          class="header-action solo ${this.soloed ? "active" : ""}"
          title=${this.soloed ? "Stop soloing" : "Solo this sprunki"}
          aria-pressed=${this.soloed ? "true" : "false"}
          @click=${this._onToggleSolo}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path d="M4 13a8 8 0 0 1 16 0"/>
            <rect x="3" y="13" width="4" height="6" rx="1.2"/>
            <rect x="17" y="13" width="4" height="6" rx="1.2"/>
          </svg>
          <span>Solo</span>
        </button>
        ${this.canReset ? html`
          <button
            class="header-action reset"
            title="Reset this part to the patch's default board"
            @click=${this._onResetClick}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7"/>
              <path d="M3 4v5h5"/>
            </svg>
            <span>Reset</span>
          </button>
        ` : ""}
        <button class="close-btn" title="Close (Esc)" aria-label="Close" @click=${this._close}>
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor"
               stroke-width="3" fill="none" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="stage" @click=${this._onBackdropClick}>
        <div class="stage-sprunki" style="--cc:${patch.color};--vol-scale:${this._volScaleForY(this.slot?.y)};">
          ${art
            ? html`<img src=${art} alt=${patch.label} />`
            : html`<span class="sprunki-chip">${(patch.label || "?").charAt(0).toUpperCase()}</span>`}
        </div>
        <div class="body">
          ${this._renderBarRail()}
          <div class="editor">
            ${this._activeBar === "all"
              ? Array.from({ length: BARS_PER_PATTERN }, (_, b) =>
                  this._renderBarBlockAllBars(b, patch.rows))
              : patch.rows.map((r) => this._renderRowSingleBar(r))}
          </div>
        </div>
      </div>
      ${this._confirmingReset ? html`
        <div class="reset-veil" @click=${(e) => e.stopPropagation()}>
          <div class="reset-panel">
            <div class="reset-title">Reset this part?</div>
            <div class="reset-body">
              Restores ${patch.label}'s default beat for this part. Any notes
              you authored here will be erased. Other parts and other sprunkis
              are unaffected.
            </div>
            <div class="reset-actions">
              <button @click=${this._cancelReset}>Cancel</button>
              <button class="go" @click=${this._confirmReset}>Yes, reset</button>
            </div>
          </div>
        </div>
      ` : ""}
    `;
  }
}

customElements.define("sprunki-interior", SprunkiInterior);
