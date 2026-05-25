// Character Board — drag-and-drop Sprunki beat grid.
//
// TWO DRAG MECHANICS:
//   1. Drag a character from the roster → drop onto a beat slot
//      to place them at that step.
//   2. Drag a placed character within the grid to move it.
//   3. Click a placed character to remove it.
//
// The roster (left panel) shows all available characters by category.
// The beat grid (right) is a 16-step timeline. Drag a character onto
// any step to activate it; it plays its signature sound on that beat.
// Multiple characters can stack on one step (layering).
//
// All state flows up via `step-toggle` custom events. The parent
// persists the layout to the sequencer engine.

import { LitElement, html } from "lit";
import { characterBoardStyles } from "../styles.js";
import {
  CHARACTERS,
  charactersByCategory,
  STEPS_PER_PATTERN,
} from "./sound-catalog.js";
import { idleCostumeUrl, playCostumeUrl } from "../sprunki-assets.js";

export class CharacterBoard extends LitElement {
  static styles = characterBoardStyles;

  static properties = {
    /** `{ [charId]: number[] }` — active step indices per character.
     *  The shape mirrors the player-facing state in
     *  `sprunkiStore`; the sequencer-bridge translates it into the
     *  schema-correct `SequencerCell` shape before shipping. */
    board: { type: Object },
    resolution: { type: Number },
    /** When true, the OG sprunki asset pack has been downloaded
     *  and we should render SVG art instead of emoji placeholders.
     *  The parent app (sprunki-app) flips this on the
     *  `AssetPackUpdated` event. */
    assetsReady: { type: Boolean },
    _dragChar: { type: Object, state: true },
    _dragOverStep: { type: Number, state: true },
  };

  constructor() {
    super();
    this.board = {};
    this.resolution = 4;
    this.assetsReady = false;
    /** @type {object|null} character being dragged from roster */
    this._dragChar = null;
    /** @type {number} step we're hovering over, or -1 */
    this._dragOverStep = -1;
  }

  /** Render the character's "face" — OG sprunki SVG art when the
   *  asset pack is downloaded, emoji fallback otherwise. */
  _renderCharFace(char, kind /* "idle" | "play" */) {
    if (this.assetsReady) {
      const url = kind === "play"
        ? (playCostumeUrl(char.id) || idleCostumeUrl(char.id))
        : idleCostumeUrl(char.id);
      if (url) {
        return html`<img class="char-art" src="${url}" alt="${char.name}" draggable="false" />`;
      }
    }
    return html`<span class="char-emoji">${char.emoji}</span>`;
  }

  /* ── Drag handlers (roster → beat slot) ── */

  _onDragStart(e, char) {
    this._dragChar = char;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", char.id);
    // Set a ghost image: a colored chip with emoji
    const ghost = document.createElement("div");
    ghost.textContent = char.emoji;
    ghost.style.cssText = `
      font-size:36px;width:48px;height:48px;display:flex;
      align-items:center;justify-content:center;
      background:${char.color}33;border-radius:12px;
      position:absolute;top:-1000px;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 24, 24);
    requestAnimationFrame(() => ghost.remove());
  }

  _onDragEnd() {
    this._dragChar = null;
    this._dragOverStep = -1;
    this.requestUpdate();
  }

  _onDragOver(e, stepIndex) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    this._dragOverStep = stepIndex;
    this.requestUpdate();
  }

  _onDragLeave() {
    this._dragOverStep = -1;
    this.requestUpdate();
  }

  _onDrop(e, stepIndex) {
    e.preventDefault();
    if (!this._dragChar) return;

    this.dispatchEvent(new CustomEvent("step-toggle", {
      detail: { charId: this._dragChar.id, stepIndex },
      bubbles: true,
      composed: true,
    }));

    this._dragChar = null;
    this._dragOverStep = -1;
    this.requestUpdate();
  }

  /* ── Click to remove from slot ── */

  _onSlotClick(e, charId, stepIndex) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("step-toggle", {
      detail: { charId, stepIndex },
      bubbles: true,
      composed: true,
    }));
  }

  /* ── Helpers ── */

  _getActiveCharsAt(stepIndex) {
    const board = this.board || {};
    const active = [];
    for (const [charId, steps] of Object.entries(board)) {
      if (!Array.isArray(steps)) continue;
      if (steps.includes(stepIndex)) {
        const char = CHARACTERS.find((c) => c.id === charId);
        if (char) active.push(char);
      }
    }
    return active;
  }

  _isActive(charId, stepIndex) {
    const steps = this.board?.[charId];
    return Array.isArray(steps) && steps.includes(stepIndex);
  }

  render() {
    const byCat = charactersByCategory();
    const categories = ["drums", "bass", "chords", "lead", "fx"];

    return html`
      <div class="sprunki-layout">
        <!-- ── LEFT: Roster (drag source) ── -->
        <div class="roster-panel">
          <div class="roster-header">Characters</div>
          <div class="roster-instruction">Drag onto the beat grid ↓</div>

          ${categories.map(cat => {
            const chars = byCat[cat] || [];
            if (!chars.length) return null;
            return html`
              <div class="category-label">${cat}</div>
              <div class="roster-chars">
                ${chars.map(char => html`
                  <div
                    class="roster-chip"
                    draggable="true"
                    style="--chip-color: ${char.color}"
                    @dragstart=${(e) => this._onDragStart(e, char)}
                    @dragend=${this._onDragEnd}
                  >
                    <span class="chip-emoji">${this._renderCharFace(char, "idle")}</span>
                    <span class="chip-name">${char.name}</span>
                  </div>
                `)}
              </div>
            `;
          })}
        </div>

        <!-- ── RIGHT: Beat timeline with placed characters ── -->
        <div class="timeline-panel">
          <div class="timeline-header">
            <span>Beat Timeline</span>
            <span class="timeline-hint">Drop characters here</span>
          </div>

          <div class="beat-labels">
            ${Array.from({ length: STEPS_PER_PATTERN }, (_, i) => html`
              <span class="beat-label-num">${i + 1}</span>
            `)}
          </div>

          <div class="beat-timeline">
            ${Array.from({ length: STEPS_PER_PATTERN }, (_, i) => {
              const activeChars = this._getActiveCharsAt(i);
              const isOver = this._dragOverStep === i;
              const isAccent = i % 4 === 0;
              return html`
                <div
                  class="beat-slot ${isOver ? 'drag-over' : ''} ${isAccent ? 'accent' : ''} ${activeChars.length ? 'has-chars' : ''}"
                  @dragover=${(e) => this._onDragOver(e, i)}
                  @dragleave=${(e) => this._onDragLeave(e, i)}
                  @drop=${(e) => this._onDrop(e, i)}
                >
                  ${activeChars.map(char => html`
                    <div
                      class="slot-char"
                      style="--cc: ${char.color}"
                      title="${char.name} — click to remove"
                      @click=${(e) => this._onSlotClick(e, char.id, i)}
                    >
                      ${this._renderCharFace(char, "play")}
                    </div>
                  `)}
                  ${isOver && !activeChars.length ? html`
                    <div class="drop-hint">+</div>
                  ` : null}
                </div>
              `;
            })}
          </div>

          <!-- Beat position indicators (small dots under timeline) -->
          <div class="beat-dots">
            ${Array.from({ length: STEPS_PER_PATTERN }, (_, i) => html`
              <span class="dot ${i % 4 === 0 ? 'downbeat' : ''}"></span>
            `)}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-character-board", CharacterBoard);
