// Sprunki Interior — the zoom-in editor for a single sprunki on
// stage. Click a sprunki on the stage → the parent app opens this
// overlay with the slot in question.
//
// Layout:
//   * Huge faded sprunki silhouette behind the editor (the
//     sprunki you clicked, still alive — same idle sway + meter
//     pulse as on stage, just bigger and toned down to ~25% so
//     the grid in front stays readable).
//   * Per-row step grids stacked vertically — one grid per
//     `patch.rows[]` entry. Atomic patches = 1 grid. Drum Kit =
//     4 grids stacked.
//   * Pattern tabs (Intro / Verse / Chorus / Drop) at the top so
//     the kid can author each section's variant.
//   * Close button + ESC + click-outside dismiss.
//
// State source: the live sprunki store. Mutations go through
// `sprunkiStore.toggleCell(slotId, rowId, step)` — no local copy.

import { LitElement, html, css } from "lit";
import { getPatch } from "../patches.js";
import { idleCostumeUrlFor, playCostumeUrlFor } from "../sprunki-assets.js";
import {
  DEFAULT_PATTERNS,
  STEPS_PER_BAR,
  STEPS_PER_PATTERN,
} from "./sound-catalog.js";

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
    .pattern-tabs {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }
    .pattern-tab {
      padding: 6px 14px;
      background: #232844;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      color: #ccc;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease;
    }
    .pattern-tab.active {
      background: linear-gradient(135deg, #4f4ac9 0%, #6c5cff 100%);
      color: #fff;
      box-shadow: 0 0 12px rgba(108,92,255,0.4);
    }
    .close-btn {
      width: 32px; height: 32px;
      border-radius: 999px;
      border: none;
      background: rgba(255,255,255,0.08);
      color: #fff;
      font-size: 18px;
      cursor: pointer;
    }
    .close-btn:hover { background: rgba(255,255,255,0.16); }

    .stage {
      position: relative;
      flex: 1;
      overflow: hidden;
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
    .stage-sprunki .sprunki-emoji {
      height: 130vh;
      max-width: none;
      object-fit: contain;
      object-position: top center;
      animation: sway 3.4s ease-in-out infinite;
      transform-origin: bottom center;
      transform: scale(calc(1 + var(--meter, 0) * 0.10)) translateY(20vh);
      filter: drop-shadow(0 12px 32px rgba(0,0,0,0.5));
    }
    .stage-sprunki .sprunki-emoji {
      font-size: 720px;
      color: var(--cc, #fff);
      line-height: 1;
    }
    @keyframes sway {
      0%, 100% { translate: 0 0; }
      50%      { translate: 0 -8px; }
    }

    .editor {
      position: relative;
      z-index: 2;
      flex: 1;
      overflow: auto;
      padding: 24px 32px 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }
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

    /* 16 cells per bar; multi-bar patterns fall onto new visual
       rows automatically thanks to grid auto-flow. The bar-start
       and bar-end classes add separators between bars so the
       grid reads as discrete bars rather than one long blob. */
    .step-grid {
      display: grid;
      grid-template-columns: repeat(16, 1fr);
      column-gap: 4px;
      row-gap: 8px;
    }
    .step {
      aspect-ratio: 1;
      max-height: 60px;
      min-height: 28px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      cursor: pointer;
      transition: background 80ms ease,
                  border-color 80ms ease,
                  transform 80ms ease;
    }
    .step.beat {
      background: rgba(255,255,255,0.08);
    }
    .step.bar-start {
      border-left: 2px solid rgba(255,255,255,0.18);
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
  };

  constructor() {
    super();
    this.slot = null;
    this.patternId = "intro";
    this.assetsReady = false;
    this._levels = {};
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
  _onBackdropClick(e) {
    if (e.target === e.currentTarget) this._close();
  }
  _onSelectPattern(id) {
    this.dispatchEvent(new CustomEvent("interior-pattern-change", {
      detail: { id },
      bubbles: true, composed: true,
    }));
  }
  _onStepToggle(rowId, step) {
    this.dispatchEvent(new CustomEvent("interior-step-toggle", {
      detail: { slotId: this.slot?.id, rowId, step },
      bubbles: true, composed: true,
    }));
  }

  _renderStep(row, step, activeSet) {
    const isActive = activeSet.has(step);
    const isBeat = step % 4 === 0;
    const isBarStart = step % STEPS_PER_BAR === 0 && step !== 0;
    const barIdx = Math.floor(step / STEPS_PER_BAR);
    const stepInBar = (step % STEPS_PER_BAR) + 1;
    return html`
      <div
        class="step ${isBeat ? "beat" : ""} ${isBarStart ? "bar-start" : ""} ${isActive ? "active" : ""}"
        style="--rc:${row.color || "#6c5cff"};"
        title="Bar ${barIdx + 1}, step ${stepInBar}"
        @click=${() => this._onStepToggle(row.id, step)}
      ></div>
    `;
  }

  _renderRow(row) {
    const board = this.slot?.boards?.[this.patternId] || {};
    const activeSet = new Set(board[row.id] || []);
    const pitchHint = typeof row.pitch === "number"
      ? `MIDI ${row.pitch}`
      : row.chord_tone
        ? `chord-${row.chord_tone}`
        : typeof row.scale_degree === "number"
          ? `scale ${row.scale_degree}`
          : "";
    return html`
      <div class="row-block">
        <div class="row-header">
          <div class="row-swatch" style="--rc:${row.color || "#6c5cff"};"></div>
          <div class="row-name">${row.label}</div>
          <div class="row-meta">${pitchHint}</div>
        </div>
        <div class="step-grid">
          ${Array.from({ length: STEPS_PER_PATTERN }, (_, i) =>
            this._renderStep(row, i, activeSet))}
        </div>
      </div>
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
      <div class="header">
        <div>
          <div class="header-title">${patch.label}</div>
          <div class="header-sub">${patch.rows.length === 1 ? "1 voice" : `${patch.rows.length} voices`}</div>
        </div>
        <div class="pattern-tabs">
          ${DEFAULT_PATTERNS.map((p) => html`
            <button
              class="pattern-tab ${p.id === this.patternId ? "active" : ""}"
              @click=${() => this._onSelectPattern(p.id)}
            >${p.name}</button>
          `)}
        </div>
        <button class="close-btn" title="Close (Esc)" @click=${this._close}>×</button>
      </div>
      <div class="stage" @click=${this._onBackdropClick}>
        <div class="stage-sprunki" style="--cc:${patch.color};">
          ${art
            ? html`<img src=${art} alt=${patch.label} />`
            : html`<span class="sprunki-emoji">${patch.emoji}</span>`}
        </div>
        <div class="editor">
          ${patch.rows.map((r) => this._renderRow(r))}
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-interior", SprunkiInterior);
