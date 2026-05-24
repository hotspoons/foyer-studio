// Sprunki App — top-level shell.
//
// Orchestrates:
//   - Pattern selection (Intro / Verse / Chorus / Drop)
//   - Character board (beat grid per character)
//   - Transport bar (play/stop/BPM)
//
// When a user toggles a beat cell for a character, we:
//   1. Mutate the local layout object
//   2. Build a sequencer layout blob matching the beat-sequencer's format
//   3. Persist via `ws.send({ type: "set_sequencer_layout", ... })`
//
// The sequencer engine expands this to MIDI notes, and the DAW
// plays them through the GM synth (x42-gmsynth or similar).

import { LitElement, html } from "lit";
import { appStyles } from "./styles.js";
import "./components/character-board.js";
import "./components/transport-bar.js";
import {
  CHARACTERS,
  DEFAULT_PATTERNS,
  STEPS_PER_PATTERN,
  DEFAULT_RESOLUTION,
} from "./components/sound-catalog.js";

export class SprunkiApp extends LitElement {
  static styles = appStyles;

  static properties = {
    /** Current selected pattern index */
    _patternIdx: { type: Number, state: true },
    /** Layout state per pattern */
    _patterns: { type: Object, state: true },
    /** Are we connected to a backend yet? */
    _connected: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this._patternIdx = 0;
    this._connected = false;
    // Each pattern stores: { rows: { [charId]: { cells: [{step, active}] } } }
    this._patterns = DEFAULT_PATTERNS.map(() => ({ rows: {} }));
  }

  connectedCallback() {
    super.connectedCallback();
    // Wait for core bootstrap to finish, then set up.
    const check = () => {
      if (window.__foyer?.ws) {
        this._connected = true;
        // Load any existing layout state
        this._readStore();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  }

  _readStore() {
    // Initialize transport tempo to default if not set
    const store = window.__foyer?.store;
    if (!store) return;
    const tempo = store.get?.("transport.tempo");
    if (!tempo || Number(tempo) <= 0) {
      window.__foyer?.ws?.controlSet?.("transport.tempo", 120);
    }
  }

  /**
   * Get the layout for the current pattern.
   * @returns {{ rows: Record<string, {cells: Array<{step: number, active: boolean}>}> }}
   */
  _currentLayout() {
    return this._patterns[this._patternIdx] || { rows: {} };
  }

  /**
   * Select a pattern tab.
   * @param {number} idx
   */
  _selectPattern(idx) {
    this._patternIdx = idx;
    this.requestUpdate();
  }

  /**
   * Handle step toggle from the character board.
   * @param {CustomEvent} e
   */
  _onStepToggle(e) {
    const { charId, stepIndex } = e.detail;
    const pattern = { ...this._patterns[this._patternIdx] };
    const rows = { ...(pattern.rows || {}) };
    const row = { ...(rows[charId] || { cells: [] }) };
    const cells = [...(row.cells || [])];

    const existingIdx = cells.findIndex(c => c.step === stepIndex);
    if (existingIdx >= 0) {
      // Toggle off
      cells.splice(existingIdx, 1);
    } else {
      // Toggle on
      cells.push({ step: stepIndex, active: true });
    }

    rows[charId] = { ...row, cells };
    pattern.rows = rows;

    const newPatterns = [...this._patterns];
    newPatterns[this._patternIdx] = pattern;
    this._patterns = newPatterns;

    this._persistLayout(pattern);
    this.requestUpdate();
  }

  /**
   * Convert our simple layout to the beat-sequencer format
   * and send to the backend.
   * @param {object} pattern
   */
  _persistLayout(pattern) {
    const ws = window.__foyer?.ws;
    if (!ws) return;

    const rows = pattern.rows || {};

    // Build the sequencer layout blob in drum mode.
    // Rows = characters, each with cells at their pitch.
    const sequencerRows = [];
    for (const char of CHARACTERS) {
      const rowData = rows[char.id];
      if (!rowData?.cells?.length) continue;

      sequencerRows.push({
        pitch: char.pitch,
        label: char.name,
        cells: rowData.cells.map(c => ({
          step: c.step,
          velocity: 100,
        })),
      });
    }

    // Create a single pattern containing all active rows.
    const patternId = `sprunki-${this._patternIdx}`;
    const layout = {
      version: 2,
      mode: "drum",
      resolution: DEFAULT_RESOLUTION,
      pattern_steps: STEPS_PER_PATTERN,
      active: true,
      rows: sequencerRows,
      patterns: [
        {
          id: patternId,
          name: DEFAULT_PATTERNS[this._patternIdx]?.name || "Pattern",
          color: DEFAULT_PATTERNS[this._patternIdx]?.color || "#6c5ce7",
          cells: [],
          free_notes: [],
        },
      ],
      arrangement: [
        {
          pattern_id: patternId,
          bar: 0,
          arrangement_row: 0,
        },
      ],
    };

    // Use Foyer's sequencer protocol.
    // We need a region_id to write into. For Sprunki, we create a
    // dedicated MIDI region on track 1. In the stub backend, this
    // will be a no-op; with a real DAW, it writes MIDI notes.
    //
    // The set_sequencer_layout command takes:
    //   { type: "set_sequencer_layout", region_id, layout }
    //
    // For now, we use a well-known region ID and the backend
    // creates/updates it automatically. On a real DAW, the user
    // would need a MIDI track armed with a GM synth.
    ws.send({
      type: "set_sequencer_layout",
      region_id: "sprunki-main",
      layout,
    });
  }

  render() {
    if (!this._connected) {
      return html`
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:18px;">
          🎵 Connecting to Foyer...
        </div>
      `;
    }

    return html`
      <!-- Header: Pattern tabs -->
      <div class="sprunki-header">
        <div class="sprunki-title">🎵 Sprunki Beats</div>
        <div class="sprunki-pattern-tabs">
          ${DEFAULT_PATTERNS.map((pat, idx) => html`
            <button
              class="sprunki-pattern-tab ${this._patternIdx === idx ? 'active' : ''}"
              style="--tab-color: ${pat.color}"
              @click=${() => this._selectPattern(idx)}
            >
              ${pat.name}
            </button>
          `)}
        </div>
      </div>

      <!-- Main: Character Beat Grid -->
      <div class="sprunki-main">
        <sprunki-character-board
          .layout=${this._currentLayout()}
          .resolution=${DEFAULT_RESOLUTION}
          @step-toggle=${this._onStepToggle}
        ></sprunki-character-board>
      </div>

      <!-- Footer: Transport -->
      <div class="sprunki-footer">
        <sprunki-transport-bar></sprunki-transport-bar>
      </div>
    `;
  }
}

customElements.define("sprunki-app", SprunkiApp);
