// Hydrogen-style beat sequencer for a single MIDI region.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │ toolbar: name · steps · resolution · transport · close  │
//   ├───────────┬──────────────────────────────────────────────┤
//   │ row labels│  grid of cells (rows × steps)                │
//   │ M S  Kick │  ○ ● ○ ○ ● ○ ○ ○ ● ○ ○ ○ ● ○ ○ ○             │
//   │ M S  Snare│  ○ ○ ○ ○ ● ○ ○ ○ ○ ○ ○ ○ ● ○ ○ ○             │
//   ├───────────┴──────────────────────────────────────────────┤
//   │ velocity lane — one bar per step showing max velocity    │
//   └──────────────────────────────────────────────────────────┘
//
// Owns the region's note list when `.layout` is present — every
// cell toggle / velocity tweak is persisted via SetSequencerLayout
// (stored in the region's `_extra_xml` on the shim side so Ardour
// save/load preserves it), AND the corresponding MidiNote is
// add/delete'd via the existing AddNote / DeleteNote commands so
// the region renders normally inside Ardour.
//
// Interactions:
//   * Click cell       → toggle on/off at the toolbar's default velocity
//   * Drag across cells → paint (on if first cell was off, off otherwise)
//   * Right-click cell  → velocity slider (brief popup — TODO, for now
//                         use Shift-wheel like the piano roll)
//   * Shift-wheel       → adjust velocity on the hovered cell
//   * M / S per row     → mute / solo (visual; shim still plays all
//                         cells — solo-mute enforcement is a follow-up)

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

const PPQN = 960;

// Default pattern lengths in steps.
const STEP_COUNTS = [8, 16, 32, 64];
// Resolution options: subdivisions per beat.
const RESOLUTIONS = [
  { label: "1/4",  subdiv: 1 },
  { label: "1/8",  subdiv: 2 },
  { label: "1/16", subdiv: 4 },
  { label: "1/32", subdiv: 8 },
];

function defaultLayout() {
  return {
    version: 1,
    mode: "drum",
    resolution: 4,
    steps: 16,
    rows: [
      { pitch: 36, label: "Kick",     channel: 9, color: "#f59e0b" },
      { pitch: 38, label: "Snare",    channel: 9, color: "#a78bfa" },
      { pitch: 42, label: "HH closed", channel: 9, color: "#22d3ee" },
      { pitch: 46, label: "HH open",   channel: 9, color: "#67e8f9" },
      { pitch: 49, label: "Crash",    channel: 9, color: "#fb7185" },
      { pitch: 51, label: "Ride",     channel: 9, color: "#fda4af" },
      { pitch: 45, label: "Mid tom",  channel: 9, color: "#fcd34d" },
      { pitch: 41, label: "Low tom",  channel: 9, color: "#fbbf24" },
    ],
    cells: [],
  };
}

function keyOf(row, step) { return `${row}|${step}`; }

export class BeatSequencer extends LitElement {
  static properties = {
    regionId:   { type: String, attribute: "region-id" },
    regionName: { type: String, attribute: "region-name" },
    // Input: the layout object (same shape as foyer_schema::SequencerLayout).
    // Null/undefined → start with a default drum kit.
    layout:     { attribute: false },
    // Input: current note list — used to derive the velocity of
    // populated cells when the server-side layout didn't carry it.
    notes:      { attribute: false },
    _tick:      { state: true, type: Number },
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
    .tb select, .tb button {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 2px 8px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
    }
    .tb button:hover, .tb select:hover {
      background: var(--color-surface-muted);
    }
    .tb input[type="range"] { flex: 0 0 90px; }

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
    .row-head .mute.on   { background: var(--color-danger, #ef4444); color: #fff; border-color: transparent; }
    .row-head .solo.on   { background: #fbbf24; color: #000; border-color: transparent; }
    .row-head .label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--color-text);
    }

    .grid {
      grid-area: grid;
      position: relative;
      background: var(--color-surface);
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
    /* Every 4th column gets a stronger divider so the eye can parse
     * beats in a 16-step pattern. */
    .cell.beat { border-right-color: rgba(255, 255, 255, 0.18); }
    .cell:hover { background: rgba(255, 255, 255, 0.04); }
    .cell.on { background: var(--row-color, var(--color-accent, #7c5cff)); }
    .cell.on:hover { filter: brightness(1.15); }
    .cell.on .vel {
      position: absolute;
      inset: 2px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.18);
      pointer-events: none;
    }

    .velocity {
      grid-area: velocity;
      height: 80px;
      display: flex;
      align-items: flex-end;
      background: var(--color-surface-muted);
      border-top: 1px solid var(--color-border);
      padding-top: 6px;
    }
    .vel-col {
      flex: 1;
      height: 100%;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      border-right: 1px solid rgba(255, 255, 255, 0.03);
    }
    .vel-col .bar {
      width: 70%;
      background: var(--color-accent, #7c5cff);
      border-radius: 2px 2px 0 0;
      min-height: 1px;
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
    this.layout = null;
    this.notes = [];
    this._tick = 0;
    this._defaultVelocity = 100;
    this._paintState = null;  // { mode: "on"|"off" } during drag
  }

  _ensureLayout() {
    // If the region doesn't have a layout yet, spin one up locally.
    // First edit will send SetSequencerLayout which persists it.
    if (!this.layout) {
      this.layout = defaultLayout();
    }
  }

  _currentLayout() {
    this._ensureLayout();
    return this.layout;
  }

  _isOn(row, step) {
    const L = this._currentLayout();
    return L.cells.some((c) => c.row === row && c.step === step);
  }

  _velocityAt(row, step) {
    const L = this._currentLayout();
    const c = L.cells.find((cc) => cc.row === row && cc.step === step);
    return c?.velocity ?? this._defaultVelocity;
  }

  _maxVelocityForStep(step) {
    const L = this._currentLayout();
    let max = 0;
    for (const c of L.cells) if (c.step === step && c.velocity > max) max = c.velocity;
    return max;
  }

  // ── mutation helpers ──────────────────────────────────────────────
  _setCell(row, step, on, velocity) {
    const L = this._currentLayout();
    const idx = L.cells.findIndex((c) => c.row === row && c.step === step);
    if (on) {
      const vel = Math.min(127, Math.max(1, Math.round(velocity ?? this._defaultVelocity)));
      if (idx >= 0) {
        L.cells[idx] = { ...L.cells[idx], velocity: vel };
      } else {
        L.cells.push({ row, step, velocity: vel });
      }
    } else if (idx >= 0) {
      L.cells.splice(idx, 1);
    }
    // Local re-render.
    this.layout = { ...L, cells: [...L.cells] };
    this._tick++;
    // Persist + regenerate the underlying MIDI note.
    this._persistLayout();
    this._syncNote(row, step, on, velocity);
  }

  _persistLayout() {
    const ws = window.__foyer?.ws;
    if (!ws || !this.regionId) return;
    ws.send({
      type: "set_sequencer_layout",
      region_id: this.regionId,
      layout: this.layout,
    });
  }

  /** Translate a cell toggle into an AddNote / DeleteNote command so
   * the region's actual MIDI content stays in sync with the grid. */
  _syncNote(row, step, on, velocity) {
    const ws = window.__foyer?.ws;
    if (!ws || !this.regionId) return;
    const L = this._currentLayout();
    const rowDef = L.rows[row];
    if (!rowDef) return;
    const stepTicks = this._ticksPerStep();
    const startTicks = step * stepTicks;
    if (on) {
      ws.send({
        type: "add_note",
        region_id: this.regionId,
        note: {
          id: `note.opt.${Math.random().toString(36).slice(2)}`,
          pitch: rowDef.pitch,
          velocity: Math.min(127, Math.max(1, Math.round(velocity ?? this._defaultVelocity))),
          channel: rowDef.channel ?? 9,
          start_ticks: startTicks,
          length_ticks: Math.max(1, Math.round(stepTicks * 0.9)),
        },
      });
    } else {
      // Find any existing note whose start + pitch match this cell
      // and delete it. Matching by position isn't bulletproof (a
      // stray free-form edit could overlap) but for sequencer-owned
      // regions it's reliable enough for a first pass.
      const match = (this.notes || []).find((n) =>
        n.pitch === rowDef.pitch
        && Math.abs((n.start_ticks || 0) - startTicks) < stepTicks / 4
      );
      if (match) {
        ws.send({
          type: "delete_note",
          region_id: this.regionId,
          note_id: match.id,
        });
      }
    }
  }

  _ticksPerStep() {
    const L = this._currentLayout();
    // Ticks per beat = PPQN. Steps per beat = resolution (e.g. 4 = 16ths).
    return Math.max(1, Math.round(PPQN / Math.max(1, L.resolution)));
  }

  // ── toolbar handlers ──────────────────────────────────────────────
  _setSteps(n) {
    const L = this._currentLayout();
    this.layout = { ...L, steps: n };
    this._persistLayout();
    this._tick++;
  }
  _setResolution(r) {
    const L = this._currentLayout();
    this.layout = { ...L, resolution: r };
    this._persistLayout();
    this._tick++;
  }
  _setMode(m) {
    const L = this._currentLayout();
    this.layout = { ...L, mode: m };
    this._persistLayout();
    this._tick++;
  }
  _toggleRowFlag(row, field) {
    const L = this._currentLayout();
    const rows = L.rows.slice();
    rows[row] = { ...rows[row], [field]: !rows[row][field] };
    this.layout = { ...L, rows };
    this._persistLayout();
    this._tick++;
  }
  _clearAll() {
    const L = this._currentLayout();
    // Collect on-cells before clearing so we can delete the matching notes.
    const toDelete = L.cells.map((c) => ({ ...c }));
    this.layout = { ...L, cells: [] };
    this._persistLayout();
    for (const c of toDelete) this._syncNote(c.row, c.step, false);
    this._tick++;
  }

  // ── cell interaction ──────────────────────────────────────────────
  _onCellDown(ev, row, step) {
    ev.preventDefault();
    const wasOn = this._isOn(row, step);
    this._paintState = { mode: wasOn ? "off" : "on" };
    this._setCell(row, step, !wasOn);
    // Watch pointer move until up.
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
    const isOn = this._isOn(row, step);
    if (this._paintState.mode === "on" && !isOn) this._setCell(row, step, true);
    else if (this._paintState.mode === "off" && isOn) this._setCell(row, step, false);
  }

  _onCellWheel(ev, row, step) {
    if (!ev.shiftKey) return;
    ev.preventDefault();
    if (!this._isOn(row, step)) return;
    const v = this._velocityAt(row, step);
    const next = Math.min(127, Math.max(1, v + (ev.deltaY < 0 ? +4 : -4)));
    if (next !== v) this._setCell(row, step, true, next);
  }

  render() {
    const L = this._currentLayout();
    const steps = L.steps;
    const rowH = 28;
    return html`
      <div class="tb" style="--row-h:${rowH}px">
        <span class="title">Beat</span>
        <span>${this.regionName || "—"}</span>
        <span style="flex:1"></span>
        <label>Mode
          <select @change=${(e) => this._setMode(e.currentTarget.value)}>
            <option value="drum" ?selected=${L.mode === "drum"}>Drum</option>
            <option value="pitched" ?selected=${L.mode === "pitched"}>Pitched</option>
          </select>
        </label>
        <label>Steps
          <select @change=${(e) => this._setSteps(Number(e.currentTarget.value))}>
            ${STEP_COUNTS.map((n) => html`
              <option value=${n} ?selected=${n === steps}>${n}</option>
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
        <button title="Play" @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", 1)}>▶</button>
        <button title="Stop" @click=${() => window.__foyer?.ws?.controlSet?.("transport.playing", 0)}>■</button>
        <button title="Clear pattern" @click=${() => this._clearAll()}>Clear</button>
      </div>

      <div class="body" style="--row-h:${rowH}px">
        <div class="rows">
          ${L.rows.map((row, i) => html`
            <div class="row-head">
              <button class="mute ${row.muted ? "on" : ""}"
                      title="Mute (UI only for now)"
                      @click=${() => this._toggleRowFlag(i, "muted")}>M</button>
              <button class="solo ${row.soloed ? "on" : ""}"
                      title="Solo (UI only for now)"
                      @click=${() => this._toggleRowFlag(i, "soloed")}>S</button>
              <div class="label" title="pitch ${row.pitch} · ch ${row.channel + 1}">${row.label}</div>
            </div>
          `)}
        </div>
        <div class="grid">
          ${L.rows.map((row, i) => html`
            <div class="grid-row"
                 style="grid-template-columns:repeat(${steps}, minmax(14px, 1fr));--row-color:${row.color || "var(--color-accent, #7c5cff)"}">
              ${Array.from({ length: steps }).map((_, s) => {
                const on = this._isOn(i, s);
                const vel = on ? this._velocityAt(i, s) : 0;
                const alpha = on ? 0.55 + (vel / 127) * 0.45 : 1;
                const beatEvery = Math.max(1, L.resolution || 4);
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
          `)}
        </div>
        <div class="velocity" style="grid-template-columns:repeat(${steps}, 1fr);display:grid;">
          ${Array.from({ length: steps }).map((_, s) => {
            const v = this._maxVelocityForStep(s);
            const h = v > 0 ? (v / 127) * 100 : 0;
            return html`
              <div class="vel-col"><div class="bar" style="height:${h}%"></div></div>
            `;
          })}
        </div>
      </div>

      <div class="hint">
        Click + drag to paint cells · Shift-wheel on a cell to adjust its velocity ·
        Mute/solo are visual-only for this pass
      </div>
    `;
  }
}
customElements.define("foyer-beat-sequencer", BeatSequencer);
