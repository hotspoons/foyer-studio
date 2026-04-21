// Beat sequencer for a single MIDI region — Hydrogen-style.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────┐
//   │ toolbar: mode · pattern_steps · res · vel · tempo · clear  │
//   ├────────────────────────────────────────────────────────────┤
//   │ seek bar (session position, click to seek)                 │
//   ├────────────────────────────────────────────────────────────┤
//   │ ARRANGEMENT  (top — Hydrogen song view)                    │
//   │   rows = patterns                                          │
//   │   cols = song bars                                         │
//   │   cells = pattern triggers                                 │
//   ├────────────────────────────────────────────────────────────┤
//   │ PATTERN EDITOR (bottom — the cell grid for selected pat)   │
//   │   rows = drum hits / pitches                               │
//   │   cols = steps within ONE bar                              │
//   ├────────────────────────────────────────────────────────────┤
//   │ velocity lane (drum mode only)                             │
//   └────────────────────────────────────────────────────────────┘
//
// The whole thing serializes into ONE region's `_extra_xml` blob.
// The arrangement extent (highest-bar slot) drives the region's
// length on the shim side. No multi-region "+New pattern" dance —
// patterns live INSIDE the layout and are arranged on the song
// grid. This matches Hydrogen's data model and Rich's 2026-04-21
// redesign ask.
//
// Frontend just ships SetSequencerLayout with the full layout
// blob; the sidecar regenerates notes via expand_sequencer_layout
// and the shim does the atomic ReplaceRegionNotes.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

const PPQN = 960;

const STEP_COUNTS = [8, 16, 32, 64];
const RESOLUTIONS = [
  { label: "1/4",  subdiv: 1 },
  { label: "1/8",  subdiv: 2 },
  { label: "1/16", subdiv: 4 },
  { label: "1/32", subdiv: 8 },
];
const CELL_WIDTHS = [10, 14, 20, 28, 40, 56, 80];

const PITCH_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
function isBlackKey(p) { return BLACK_KEYS.has(p % 12); }
function pitchLabel(p) {
  const oct = Math.floor(p / 12) - 1;
  return `${PITCH_LABELS[p % 12]}${oct}`;
}

const PATTERN_COLORS = [
  "#7c5cff", "#f59e0b", "#22d3ee", "#fb7185", "#34d399", "#a78bfa",
  "#fcd34d", "#fda4af", "#67e8f9", "#6ee7b7",
];
function pickPatternColor(idx) {
  return PATTERN_COLORS[idx % PATTERN_COLORS.length];
}
function newPatternId() {
  return `p.${Math.random().toString(36).slice(2, 9)}`;
}

function defaultPitchedRows() {
  const out = [];
  for (let pitch = 84; pitch >= 36; pitch--) {
    out.push({
      pitch,
      label: pitchLabel(pitch),
      channel: 0,
      color: isBlackKey(pitch) ? "#6b7280" : "#7c5cff",
    });
  }
  return out;
}

function defaultDrumRows() {
  return [
    { pitch: 36, label: "Kick",     channel: 9, color: "#f59e0b" },
    { pitch: 38, label: "Snare",    channel: 9, color: "#a78bfa" },
    { pitch: 42, label: "HH closed", channel: 9, color: "#22d3ee" },
    { pitch: 46, label: "HH open",   channel: 9, color: "#67e8f9" },
    { pitch: 49, label: "Crash",    channel: 9, color: "#fb7185" },
    { pitch: 51, label: "Ride",     channel: 9, color: "#fda4af" },
    { pitch: 45, label: "Mid tom",  channel: 9, color: "#fcd34d" },
    { pitch: 41, label: "Low tom",  channel: 9, color: "#fbbf24" },
  ];
}

function defaultLayout() {
  const id = newPatternId();
  return {
    version: 2,
    mode: "drum",
    resolution: 4,
    pattern_steps: 16,
    rows: defaultDrumRows(),
    patterns: [{ id, name: "Pattern 1", color: pickPatternColor(0), cells: [], free_notes: [] }],
    arrangement: [{ pattern_id: id, bar: 0, arrangement_row: 0 }],
  };
}

// Migrate a v1 layout (top-level cells, no patterns) into a v2
// shape with one synthesized "Pattern 1" containing those cells.
// Returns the input untouched if it's already v2.
function migrateToV2(layout) {
  if (!layout) return defaultLayout();
  if (layout.patterns && layout.patterns.length > 0) return layout;
  const id = newPatternId();
  return {
    ...layout,
    version: 2,
    pattern_steps: layout.pattern_steps ?? layout.steps ?? 16,
    patterns: [{
      id,
      name: "Pattern 1",
      color: pickPatternColor(0),
      cells: layout.cells || [],
      free_notes: layout.free_notes || [],
    }],
    arrangement: layout.arrangement && layout.arrangement.length
      ? layout.arrangement
      : [{ pattern_id: id, bar: 0, arrangement_row: 0 }],
    cells: [],
    free_notes: [],
  };
}

export class BeatSequencer extends LitElement {
  static properties = {
    regionId:   { type: String, attribute: "region-id" },
    regionName: { type: String, attribute: "region-name" },
    trackId:    { type: String, attribute: "track-id" },
    layout:     { attribute: false },
    notes:      { attribute: false },
    trackRegions: { attribute: false },
    _tick:      { state: true, type: Number },
    _cellW:     { state: true, type: Number },
    _selectedPatternId: { state: true, type: String },
    _arrCols:   { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 11px;
    }
    .tb {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      flex: 0 0 auto;
    }
    .tb .title { color: var(--color-text); font-weight: 600; }
    .tb select, .tb button, .tb input[type="number"] {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 2px 8px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
    }
    .tb button:hover, .tb select:hover { background: var(--color-surface-muted); }
    .tb input[type="range"] { flex: 0 0 90px; }
    .tb input[type="number"] { width: 58px; font-variant-numeric: tabular-nums; }

    .seek {
      position: relative; height: 18px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      cursor: pointer; flex: 0 0 auto;
    }
    .seek .track { position: absolute; inset: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 6px; }
    .seek .ph { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--color-accent, #7c5cff); pointer-events: none; }
    .seek .region-marker { position: absolute; top: 4px; bottom: 4px; background: rgba(124,92,255,0.25); border: 1px solid rgba(124,92,255,0.6); border-radius: 3px; pointer-events: none; }
    .seek .region-marker.active { background: rgba(124,92,255,0.45); }

    /* ── ARRANGEMENT ──────────────────────────────────── */
    .arr {
      flex: 0 0 auto;
      max-height: 220px;
      display: flex; flex-direction: column;
      background: var(--color-surface);
      border-bottom: 2px solid var(--color-border);
      overflow: hidden;
    }
    .arr-head {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px;
      background: var(--color-surface-muted);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .arr-head .add {
      margin-left: auto;
      background: transparent;
      border: 1px dashed var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 8px; border-radius: 4px;
      cursor: pointer; font: inherit; font-size: 10px;
    }
    .arr-head .add:hover { color: var(--color-text); border-color: var(--color-accent); }
    .arr-body {
      display: grid;
      grid-template-columns: 160px 1fr;
      flex: 1; min-height: 0;
      overflow: auto;
    }
    .arr-pat-list { display: flex; flex-direction: column; background: var(--color-surface-elevated); border-right: 1px solid var(--color-border); }
    .arr-pat {
      display: grid;
      grid-template-columns: 12px 1fr 18px;
      align-items: center; gap: 6px;
      padding: 4px 8px;
      height: 22px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      font-size: 11px;
    }
    .arr-pat:hover { background: var(--color-surface-muted); }
    .arr-pat.active {
      background: color-mix(in oklab, var(--color-accent, #7c5cff) 18%, transparent);
    }
    .arr-pat .swatch { width: 10px; height: 10px; border-radius: 2px; }
    .arr-pat .name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: transparent; border: 0; color: var(--color-text);
      font: inherit; font-size: 11px; padding: 0;
    }
    .arr-pat .name:focus { outline: 1px solid var(--color-accent); outline-offset: 1px; background: var(--color-surface); }
    .arr-pat .x {
      background: transparent; border: 0; color: var(--color-text-muted);
      cursor: pointer; font-size: 14px; line-height: 1;
    }
    .arr-pat .x:hover { color: var(--color-danger, #ef4444); }
    .arr-grid {
      position: relative;
      display: grid;
      grid-auto-rows: 22px;
      grid-template-columns: var(--arr-cols-tpl, repeat(16, 16px));
    }
    .arr-cell {
      border-right: 1px solid rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
    }
    .arr-cell.beat-edge { border-right-color: rgba(255,255,255,0.18); }
    .arr-cell:hover { background: rgba(255,255,255,0.04); }
    .arr-cell.on { background: var(--cell-color, var(--color-accent, #7c5cff)); }
    .arr-cell.on:hover { filter: brightness(1.15); }

    /* ── PATTERN EDITOR (cell grid) ────────────────────── */
    .body {
      flex: 1; min-height: 0;
      display: grid;
      grid-template-columns: 180px 1fr;
      grid-template-rows: 1fr auto;
      grid-template-areas:
        "rows grid"
        "rows velocity";
      overflow: auto;
    }
    .rows {
      grid-area: rows;
      display: flex; flex-direction: column;
      background: var(--color-surface-elevated);
      border-right: 1px solid var(--color-border);
      position: sticky; left: 0; z-index: 1;
    }
    .row-head {
      display: grid;
      grid-template-columns: 30px 30px 1fr;
      align-items: center;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border);
      gap: 4px;
      height: var(--row-h);
      box-sizing: border-box;
    }
    .row-head .mute, .row-head .solo {
      width: 22px; height: 18px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      border-radius: 3px;
      font: inherit; font-size: 10px;
      cursor: pointer;
    }
    .row-head .mute.on { background: var(--color-danger, #ef4444); color: #fff; border-color: transparent; }
    .row-head .solo.on { background: #fbbf24; color: #000; border-color: transparent; }
    .row-head .label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--color-text);
    }
    .body.pitched .row-head { padding: 2px 8px; }
    .body.pitched .row-head .mute, .body.pitched .row-head .solo { display: none; }
    .body.pitched .row-head.black-key { background: color-mix(in oklab, var(--color-surface-elevated) 55%, #000 45%); }
    .body.pitched .row-head.c-row { border-top: 1px solid var(--color-accent, #7c5cff); }
    .body.pitched .row-head .label { font-size: 10px; color: var(--color-text-muted); }
    .body.pitched .grid-row.black-key { background: rgba(0, 0, 0, 0.18); }

    .grid {
      grid-area: grid;
      position: relative;
      background: var(--color-surface);
      overflow: auto;
    }
    .grid-row {
      display: grid;
      border-bottom: 1px solid var(--color-border);
      height: var(--row-h);
    }
    .cell {
      border-right: 1px solid rgba(255, 255, 255, 0.04);
      cursor: pointer;
      position: relative;
    }
    .cell.beat { border-right-color: rgba(255, 255, 255, 0.18); }
    .cell:hover { background: rgba(255, 255, 255, 0.04); }
    .cell.on { background: var(--row-color, var(--color-accent, #7c5cff)); }
    .cell.on:hover { filter: brightness(1.15); }
    .cell.on .vel {
      position: absolute; inset: 2px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.18);
      pointer-events: none;
    }

    .velocity {
      grid-area: velocity;
      height: 70px;
      display: grid;
      align-items: flex-end;
      background: var(--color-surface-muted);
      border-top: 1px solid var(--color-border);
      padding-top: 6px;
    }
    .vel-col {
      height: 100%;
      display: flex; align-items: flex-end; justify-content: center;
      border-right: 1px solid rgba(255, 255, 255, 0.03);
    }
    .vel-col .bar {
      width: 70%; background: var(--color-accent, #7c5cff);
      border-radius: 2px 2px 0 0; min-height: 1px;
    }

    .hint {
      padding: 4px 10px;
      font-size: 10px;
      color: var(--color-text-muted);
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
  `;

  constructor() {
    super();
    this.regionId = "";
    this.regionName = "";
    this.trackId = "";
    this.layout = null;
    this.notes = [];
    this.trackRegions = [];
    this._tick = 0;
    this._cellW = 28;
    this._defaultVelocity = 100;
    this._paintState = null;
    this._selectedPatternId = "";
    this._arrCols = 16;
    this._onStoreControl = (ev) => {
      if (ev.detail === "transport.position"
          || ev.detail === "transport.tempo"
          || ev.detail === "transport.playing") {
        this.requestUpdate();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("control", this._onStoreControl);
    window.__foyer?.store?.addEventListener("change", this._onStoreControl);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("control", this._onStoreControl);
    window.__foyer?.store?.removeEventListener("change", this._onStoreControl);
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("layout") || changed.has("regionId")) {
      // Migrate legacy v1 layouts on receive so the rest of the
      // component sees a uniform v2 shape.
      if (this.layout && (!this.layout.patterns || this.layout.patterns.length === 0)) {
        this.layout = migrateToV2(this.layout);
      }
      // Default the pattern selection to the first pattern of the
      // current layout.
      const L = this._currentLayout();
      if (!L.patterns.find((p) => p.id === this._selectedPatternId)) {
        this._selectedPatternId = L.patterns[0]?.id || "";
      }
    }
  }

  _currentLayout() {
    if (!this.layout) this.layout = defaultLayout();
    if (!this.layout.patterns || this.layout.patterns.length === 0) {
      this.layout = migrateToV2(this.layout);
    }
    return this.layout;
  }
  _selectedPattern() {
    const L = this._currentLayout();
    return L.patterns.find((p) => p.id === this._selectedPatternId) || L.patterns[0];
  }

  // ── persistence ──────────────────────────────────────────────────
  _persistLayout() {
    const ws = window.__foyer?.ws;
    if (!ws || !this.regionId) return;
    ws.send({
      type: "set_sequencer_layout",
      region_id: this.regionId,
      layout: this.layout,
    });
  }

  _commit(mutator) {
    // Apply `mutator(layout)` immutably-ish, persist, re-render.
    const L = this._currentLayout();
    const next = JSON.parse(JSON.stringify(L));
    mutator(next);
    this.layout = next;
    this._persistLayout();
    this._tick++;
  }

  // ── pattern grid ops ─────────────────────────────────────────────
  _isOnInPattern(pattern, row, step) {
    return pattern?.cells?.some((c) => c.row === row && c.step === step);
  }
  _velocityInPattern(pattern, row, step) {
    return pattern?.cells?.find((c) => c.row === row && c.step === step)?.velocity
      ?? this._defaultVelocity;
  }
  _maxVelocityInPattern(pattern, step) {
    let max = 0;
    for (const c of pattern?.cells || []) if (c.step === step && c.velocity > max) max = c.velocity;
    return max;
  }

  _setCell(row, step, on, velocity) {
    const targetId = this._selectedPatternId;
    this._commit((L) => {
      const pat = L.patterns.find((p) => p.id === targetId);
      if (!pat) return;
      const idx = pat.cells.findIndex((c) => c.row === row && c.step === step);
      if (on) {
        const vel = Math.min(127, Math.max(1, Math.round(velocity ?? this._defaultVelocity)));
        if (idx >= 0) pat.cells[idx] = { ...pat.cells[idx], velocity: vel };
        else pat.cells.push({ row, step, velocity: vel });
      } else if (idx >= 0) {
        pat.cells.splice(idx, 1);
      }
    });
  }

  _ticksPerStep() {
    return Math.max(1, Math.round(PPQN / Math.max(1, this._currentLayout().resolution)));
  }

  // ── arrangement ops ──────────────────────────────────────────────
  _isPatternAtBar(patternId, bar) {
    return this._currentLayout().arrangement.some(
      (s) => s.pattern_id === patternId && s.bar === bar,
    );
  }
  _toggleArrCell(patternId, bar) {
    this._commit((L) => {
      const idx = L.arrangement.findIndex(
        (s) => s.pattern_id === patternId && s.bar === bar,
      );
      const row = L.patterns.findIndex((p) => p.id === patternId);
      if (idx >= 0) L.arrangement.splice(idx, 1);
      else L.arrangement.push({ pattern_id: patternId, bar, arrangement_row: row });
    });
  }
  _addPattern() {
    this._commit((L) => {
      const id = newPatternId();
      const idx = L.patterns.length;
      L.patterns.push({
        id,
        name: `Pattern ${idx + 1}`,
        color: pickPatternColor(idx),
        cells: [],
        free_notes: [],
      });
      this._selectedPatternId = id;
    });
  }
  _renamePattern(patternId, name) {
    this._commit((L) => {
      const p = L.patterns.find((q) => q.id === patternId);
      if (p) p.name = name;
    });
  }
  _deletePattern(patternId) {
    if (!confirm("Delete this pattern? It will be removed from the arrangement too.")) return;
    this._commit((L) => {
      L.patterns = L.patterns.filter((p) => p.id !== patternId);
      L.arrangement = L.arrangement.filter((s) => s.pattern_id !== patternId);
      if (this._selectedPatternId === patternId) {
        this._selectedPatternId = L.patterns[0]?.id || "";
      }
    });
  }

  // ── toolbar ──────────────────────────────────────────────────────
  _setSteps(n)      { this._commit((L) => { L.pattern_steps = n; }); }
  _setResolution(r) { this._commit((L) => { L.resolution    = r; }); }
  _setMode(m) {
    this._commit((L) => {
      L.mode = m;
      // Swap row defaults when crossing the drum/pitched boundary,
      // unless the user has clearly customized the rows.
      const looksDrum    = L.rows.every((r) => r.channel === 9);
      const looksPitched = L.rows.every((r) => r.channel === 0);
      if (m === "pitched" && looksDrum)    L.rows = defaultPitchedRows();
      else if (m === "drum" && looksPitched) L.rows = defaultDrumRows();
    });
  }
  _toggleRowFlag(row, field) {
    this._commit((L) => {
      L.rows[row] = { ...L.rows[row], [field]: !L.rows[row][field] };
    });
  }
  _clearSelectedPattern() {
    const targetId = this._selectedPatternId;
    this._commit((L) => {
      const pat = L.patterns.find((p) => p.id === targetId);
      if (pat) { pat.cells = []; pat.free_notes = []; }
    });
  }

  _currentTempo() {
    return Number(window.__foyer?.store?.get?.("transport.tempo") ?? 120);
  }
  _setTempo(bpm) {
    const v = Math.max(20, Math.min(300, Number(bpm) || 120));
    window.__foyer?.ws?.controlSet?.("transport.tempo", v);
  }

  _playheadSamples() {
    return Number(window.__foyer?.store?.get?.("transport.position") ?? 0);
  }
  _sessionLengthSamples() {
    return Number(window.__foyer?.store?.state?.session?.timeline?.length_samples
      ?? (48_000 * 120));
  }
  _sampleRate() {
    return Number(window.__foyer?.store?.state?.session?.timeline?.sample_rate ?? 48_000);
  }
  _onSeekClick(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const sampleTarget = Math.round(ratio * this._sessionLengthSamples());
    // Locate routes through the server's transport.position
    // ControlSet, so we don't need to also fire a controlSet from
    // here (was firing both, hence multiple "Locate accepted but
    // not wired" toasts per click).
    window.__foyer?.ws?.send({ type: "locate", samples: sampleTarget });
  }

  // ── pattern-cell interaction ─────────────────────────────────────
  _onCellDown(ev, row, step) {
    ev.preventDefault();
    const pat = this._selectedPattern();
    if (!pat) return;
    const wasOn = this._isOnInPattern(pat, row, step);
    this._paintState = { mode: wasOn ? "off" : "on" };
    this._setCell(row, step, !wasOn);
    const onMove = (e) => this._paintOnCellAt(e);
    const onUp = () => {
      this._paintState = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  _paintOnCellAt(ev) {
    if (!this._paintState) return;
    const el = this.renderRoot.elementFromPoint
      ? this.renderRoot.elementFromPoint(ev.clientX, ev.clientY)
      : document.elementFromPoint(ev.clientX, ev.clientY);
    const cell = el?.closest?.(".cell");
    if (!cell) return;
    const row = Number(cell.dataset.row);
    const step = Number(cell.dataset.step);
    if (Number.isNaN(row) || Number.isNaN(step)) return;
    const pat = this._selectedPattern();
    const isOn = this._isOnInPattern(pat, row, step);
    if (this._paintState.mode === "on" && !isOn) this._setCell(row, step, true);
    else if (this._paintState.mode === "off" && isOn) this._setCell(row, step, false);
  }
  _onGridWheel(ev) {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const dir = ev.deltaY < 0 ? +1 : -1;
      const idx = Math.max(0, Math.min(
        CELL_WIDTHS.length - 1,
        CELL_WIDTHS.indexOf(this._cellW) + dir));
      if (CELL_WIDTHS[idx] !== this._cellW) this._cellW = CELL_WIDTHS[idx];
    }
  }
  _onCellWheel(ev, row, step) {
    if (ev.ctrlKey || ev.metaKey) return;
    if (!ev.shiftKey) return;
    ev.preventDefault();
    const pat = this._selectedPattern();
    if (!this._isOnInPattern(pat, row, step)) return;
    const v = this._velocityInPattern(pat, row, step);
    const next = Math.min(127, Math.max(1, v + (ev.deltaY < 0 ? +4 : -4)));
    if (next !== v) this._setCell(row, step, true, next);
  }

  // ── render ───────────────────────────────────────────────────────
  render() {
    const L = this._currentLayout();
    return html`
      ${this._renderToolbar(L)}
      ${this._renderSeekBar()}
      ${this._renderArrangement(L)}
      ${this._renderPatternEditor(L)}
    `;
  }

  _renderToolbar(L) {
    const tempo = this._currentTempo();
    return html`
      <div class="tb">
        <span class="title">Beat</span>
        <span>${this.regionName || "—"}</span>
        <span style="flex:1"></span>
        <label>Mode
          <select @change=${(e) => this._setMode(e.currentTarget.value)}>
            <option value="drum" ?selected=${L.mode === "drum"}>Drum</option>
            <option value="pitched" ?selected=${L.mode === "pitched"}>Pitched (piano roll)</option>
          </select>
        </label>
        <label>Steps/bar
          <select @change=${(e) => this._setSteps(Number(e.currentTarget.value))}>
            ${STEP_COUNTS.map((n) => html`
              <option value=${n} ?selected=${n === L.pattern_steps}>${n}</option>
            `)}
          </select>
        </label>
        <label>Res
          <select @change=${(e) => this._setResolution(Number(e.currentTarget.value))}>
            ${RESOLUTIONS.map((r) => html`
              <option value=${r.subdiv} ?selected=${r.subdiv === L.resolution}>${r.label}</option>
            `)}
          </select>
        </label>
        <label>Vel
          <input type="range" min="1" max="127" step="1"
                 .value=${String(this._defaultVelocity)}
                 @input=${(e) => { this._defaultVelocity = Number(e.currentTarget.value); this._tick++; }}>
          <span style="min-width:22px;text-align:right;color:var(--color-accent,#7c5cff);font-variant-numeric:tabular-nums">${this._defaultVelocity}</span>
        </label>
        <label>Tempo
          <input type="number" min="20" max="300" step="0.1"
                 .value=${tempo.toFixed(1)}
                 @change=${(e) => this._setTempo(e.currentTarget.value)}>
          <span style="color:var(--color-text-muted);font-size:10px">BPM</span>
        </label>
        <button title="Play" @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", 1)}>▶</button>
        <button title="Stop" @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", 0)}>■</button>
        <button title="Clear selected pattern" @click=${() => this._clearSelectedPattern()}>Clear</button>
      </div>
    `;
  }

  _renderSeekBar() {
    const len = this._sessionLengthSamples();
    const pos = this._playheadSamples();
    const ratio = len > 0 ? Math.min(1, Math.max(0, pos / len)) : 0;
    const regions = this.trackRegions || [];
    return html`
      <div class="seek" @click=${(e) => this._onSeekClick(e)}
           title="Click to seek · current ${(pos / this._sampleRate()).toFixed(1)}s">
        <div class="track"></div>
        ${regions.map((r) => {
          if (!len) return null;
          const left = 100 * (r.start_samples || 0) / len;
          const width = 100 * Math.max(0.2, (r.length_samples || 0) / len);
          return html`
            <div class="region-marker ${r.id === this.regionId ? "active" : ""}"
                 style="left:${left}%;width:${width}%"></div>
          `;
        })}
        <div class="ph" style="left:${ratio * 100}%"></div>
      </div>
    `;
  }

  _renderArrangement(L) {
    // Ensure the visible bar count is at least one past the highest
    // populated bar so the user always sees a "next bar" they can
    // click into. Capped so a giant arrangement scrolls instead of
    // exploding the layout.
    const maxBar = L.arrangement.reduce((m, s) => Math.max(m, s.bar), -1);
    const cols = Math.max(this._arrCols, maxBar + 4);
    const cellPx = 16;
    return html`
      <div class="arr">
        <div class="arr-head">
          <span>Arrangement · ${L.patterns.length} pattern${L.patterns.length === 1 ? "" : "s"} · ${maxBar + 1} bar${maxBar + 1 === 1 ? "" : "s"}</span>
          <button class="add" title="Add a new empty pattern"
                  @click=${() => this._addPattern()}>+ Pattern</button>
          <button class="add" title="Show more bars in the arrangement"
                  @click=${() => { this._arrCols = Math.min(cols + 8, 256); }}>+ 8 bars</button>
        </div>
        <div class="arr-body" style="--arr-cols-tpl:repeat(${cols}, ${cellPx}px)">
          <div class="arr-pat-list">
            ${L.patterns.map((p) => html`
              <div class="arr-pat ${p.id === this._selectedPatternId ? "active" : ""}"
                   @click=${() => { this._selectedPatternId = p.id; this._tick++; }}>
                <span class="swatch" style="background:${p.color || pickPatternColor(0)}"></span>
                <input class="name" .value=${p.name}
                       @click=${(e) => e.stopPropagation()}
                       @change=${(e) => this._renamePattern(p.id, e.currentTarget.value)}>
                <button class="x" title="Delete pattern"
                        @click=${(e) => { e.stopPropagation(); this._deletePattern(p.id); }}>×</button>
              </div>
            `)}
          </div>
          <div class="arr-grid" style="grid-template-rows:repeat(${L.patterns.length}, 22px)">
            ${L.patterns.map((p) => html`
              ${Array.from({ length: cols }).map((_, b) => {
                const on = this._isPatternAtBar(p.id, b);
                return html`
                  <div class="arr-cell ${on ? "on" : ""} ${(b + 1) % 4 === 0 ? "beat-edge" : ""}"
                       style=${on ? `--cell-color:${p.color || pickPatternColor(0)}` : ""}
                       title="bar ${b + 1}"
                       @click=${() => this._toggleArrCell(p.id, b)}></div>
                `;
              })}
            `)}
          </div>
        </div>
      </div>
    `;
  }

  _renderPatternEditor(L) {
    const pat = this._selectedPattern();
    if (!pat) return html`<div class="hint">No pattern selected.</div>`;
    const rowH = L.mode === "pitched" ? 18 : 28;
    const steps = L.pattern_steps;
    const beatEvery = Math.max(1, L.resolution || 4);
    const gridTpl = `repeat(${steps}, ${this._cellW}px)`;
    return html`
      <div class="body ${L.mode === "pitched" ? "pitched" : ""}" style="--row-h:${rowH}px"
           @wheel=${(e) => this._onGridWheel(e)}>
        <div class="rows">
          ${L.rows.map((row, i) => {
            const black = L.mode === "pitched" && isBlackKey(row.pitch);
            const cRow = L.mode === "pitched" && (row.pitch % 12 === 0);
            return html`
              <div class="row-head ${black ? "black-key" : ""} ${cRow ? "c-row" : ""}">
                <button class="mute ${row.muted ? "on" : ""}"
                        title="Mute this row"
                        @click=${() => this._toggleRowFlag(i, "muted")}>M</button>
                <button class="solo ${row.soloed ? "on" : ""}"
                        title="Solo this row"
                        @click=${() => this._toggleRowFlag(i, "soloed")}>S</button>
                <div class="label" title="pitch ${row.pitch} · ch ${row.channel + 1}">${row.label}</div>
              </div>
            `;
          })}
        </div>
        <div class="grid">
          ${L.rows.map((row, i) => {
            const black = L.mode === "pitched" && isBlackKey(row.pitch);
            return html`
              <div class="grid-row ${black ? "black-key" : ""}"
                   style="grid-template-columns:${gridTpl};--row-color:${row.color || "var(--color-accent, #7c5cff)"}">
                ${Array.from({ length: steps }).map((_, s) => {
                  const on = this._isOnInPattern(pat, i, s);
                  const vel = on ? this._velocityInPattern(pat, i, s) : 0;
                  const alpha = on ? 0.55 + (vel / 127) * 0.45 : 1;
                  return html`
                    <div class="cell ${on ? "on" : ""} ${(s + 1) % beatEvery === 0 ? "beat" : ""}"
                         data-row=${i} data-step=${s}
                         style=${on ? `opacity:${alpha}` : ""}
                         @pointerdown=${(e) => this._onCellDown(e, i, s)}
                         @wheel=${(e) => this._onCellWheel(e, i, s)}>
                      ${on ? html`<div class="vel" style="height:${Math.round(40 + vel / 127 * 40)}%"></div>` : null}
                    </div>
                  `;
                })}
              </div>
            `;
          })}
        </div>
        <div class="velocity" style="grid-template-columns:${gridTpl}">
          ${Array.from({ length: steps }).map((_, s) => {
            const v = this._maxVelocityInPattern(pat, s);
            const h = v > 0 ? (v / 127) * 100 : 0;
            return html`<div class="vel-col"><div class="bar" style="height:${h}%"></div></div>`;
          })}
        </div>
      </div>
      <div class="hint">
        Editing <strong>${pat.name}</strong> · arrangement decides where it plays · click+drag = paint · Shift-wheel = velocity · Ctrl-wheel = zoom
      </div>
    `;
  }
}
customElements.define("foyer-beat-sequencer", BeatSequencer);
