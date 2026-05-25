// Chord strip — sits at the top of the sprunki stage and exposes
// the song's *harmony* as a first-class object.
//
// Two layers of control:
//   * Global key: root (C, D♭, …) + mode (major/minor/dorian/…).
//     This is the universe every tonal sprunki tunes to.
//   * Per-section chord: one chord per Intro/Verse/Chorus/Drop tab.
//     Click a chord pill to cycle through the diatonic chords of
//     the current key; long-press (right-click) for a richer
//     picker.
//
// Editing a chord rebuilds every tonal layout via the sprunki
// app's existing `pushAllLayouts(harmony)` path, so the audible
// retuning is immediate. Drum cells are unaffected.

import { LitElement, html, css } from "lit";
import {
  KEY_ROOTS,
  MODES,
  PROGRESSIONS,
  buildProgression,
  labelChord,
} from "../theory.js";
import { DEFAULT_PATTERNS } from "./sound-catalog.js";

export class ChordStrip extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 8px 14px 10px;
      background: linear-gradient(180deg, #1a1d2e 0%, #14172a 100%);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-family: system-ui, -apple-system, sans-serif;
      color: #ddd;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .group-label {
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.45);
      margin-right: 4px;
    }
    select {
      background: #2a2e44;
      color: #eee;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    select:hover { background: #353a55; }
    .chords {
      display: flex;
      gap: 6px;
    }
    .chord-pill {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 64px;
      padding: 6px 10px;
      background: #232844;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      cursor: pointer;
      transition: all 120ms ease;
    }
    .chord-pill:hover {
      background: #2d3358;
      transform: translateY(-1px);
    }
    .chord-pill.active {
      background: linear-gradient(135deg, #4f4ac9 0%, #6c5cff 100%);
      border-color: rgba(255,255,255,0.18);
      box-shadow: 0 0 12px rgba(108,92,255,0.4);
    }
    .section-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: rgba(255,255,255,0.55);
      margin-bottom: 2px;
    }
    .chord-name {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      line-height: 1;
    }
    .hint {
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      margin-left: auto;
    }
  `;

  static properties = {
    /** `{ root, mode }` from sprunkiStore. */
    musicKey: { type: Object },
    /** `{ [patternId]: { degree, quality } }`. */
    sectionChords: { type: Object },
    /** Currently active pattern id — pill renders highlighted. */
    activePatternId: { type: String },
    /** Active progression preset id, or null when hand-edited. */
    progressionId: { type: String },
  };

  constructor() {
    super();
    this.musicKey = { root: "C", mode: "major" };
    this.sectionChords = {};
    this.activePatternId = "intro";
    this.progressionId = null;
  }

  _onRootChange(e) {
    this.dispatchEvent(new CustomEvent("key-change", {
      detail: { root: e.target.value },
      bubbles: true, composed: true,
    }));
  }
  _onModeChange(e) {
    this.dispatchEvent(new CustomEvent("key-change", {
      detail: { mode: e.target.value },
      bubbles: true, composed: true,
    }));
  }
  _onProgressionChange(e) {
    const v = e.target.value;
    if (!v) return;
    this.dispatchEvent(new CustomEvent("progression-change", {
      detail: { progressionId: v },
      bubbles: true, composed: true,
    }));
  }
  /** Click cycles the chord to the next diatonic degree. Holding
   *  Shift goes backwards. Future: long-press for a custom picker. */
  _onChordClick(e, patternId) {
    const back = e.shiftKey;
    const cur = this.sectionChords[patternId] || { degree: 0, quality: "major" };
    const nextDeg = (cur.degree + (back ? 6 : 1)) % 7;
    // Use the diatonic quality for the new degree by asking
    // theory.buildProgression to compute a single-degree progression.
    const fresh = buildProgression("static-I", this.musicKey); // any prog gets us qualities
    // Walk to find a chord with the desired degree.
    const sample = buildProgression("I-V-vi-IV", this.musicKey)
                    .find((c) => c.degree === nextDeg);
    const quality = sample?.quality ?? "major";
    this.dispatchEvent(new CustomEvent("chord-change", {
      detail: { patternId, chord: { degree: nextDeg, quality } },
      bubbles: true, composed: true,
    }));
  }

  render() {
    return html`
      <div class="row">
        <span class="group-label">Key</span>
        <select @change=${this._onRootChange} .value=${this.musicKey.root}>
          ${KEY_ROOTS.map((k) => html`
            <option value=${k.id} ?selected=${k.id === this.musicKey.root}>${k.label}</option>
          `)}
        </select>
        <select @change=${this._onModeChange} .value=${this.musicKey.mode}>
          ${MODES.map((m) => html`
            <option value=${m.id} ?selected=${m.id === this.musicKey.mode}>${m.label}</option>
          `)}
        </select>

        <span class="group-label" style="margin-left:8px;">Progression</span>
        <select @change=${this._onProgressionChange}>
          <option value="" ?selected=${!this.progressionId}>Custom…</option>
          ${PROGRESSIONS.map((p) => html`
            <option value=${p.id} ?selected=${p.id === this.progressionId}>${p.label}</option>
          `)}
        </select>

        <span class="hint">Click a pill to cycle · Shift-click to step back</span>
      </div>

      <div class="row" style="margin-top:8px;">
        <div class="chords">
          ${DEFAULT_PATTERNS.map((p) => {
            const chord = this.sectionChords[p.id] || { degree: 0, quality: "major" };
            const isActive = p.id === this.activePatternId;
            return html`
              <div
                class="chord-pill ${isActive ? 'active' : ''}"
                title="${p.name} chord — click to cycle, Shift-click for previous"
                @click=${(e) => this._onChordClick(e, p.id)}
              >
                <span class="section-label">${p.name}</span>
                <span class="chord-name">${labelChord(chord, this.musicKey)}</span>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-chord-strip", ChordStrip);
