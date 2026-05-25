// Sprunki UI styles — fun, colorful, kid-friendly.
// Uses Lit's css tagged template for scoped component styles.

import { css } from "lit";

export const sprunkiBase = css`
  :host {
    display: block;
    width: 100%;
    height: 100vh;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    color: #f0f0f0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
`;

export const appStyles = css`
  :host {
    /* header / chord-strip / stage (flex 1fr) / palette / footer */
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    width: 100%;
    height: 100vh;
    overflow: hidden;
  }

  .sprunki-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 2px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }

  .sprunki-title {
    font-size: 22px;
    font-weight: 800;
    background: linear-gradient(90deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: 1px;
  }

  .sprunki-pattern-tabs {
    display: flex;
    gap: 6px;
  }

  .sprunki-pattern-tab {
    padding: 6px 16px;
    border-radius: 20px;
    border: 2px solid transparent;
    background: rgba(255, 255, 255, 0.08);
    color: #ccc;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .sprunki-pattern-tab:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .sprunki-pattern-tab.active {
    border-color: var(--tab-color, #6c5ce7);
    background: color-mix(in srgb, var(--tab-color, #6c5ce7) 30%, transparent);
    color: white;
  }

  .sprunki-main {
    display: flex;
    min-height: 0;
    overflow: hidden;
    padding: 12px;
  }
  /* The new sprunki-stage component has its own aspect-ratio but
     should fill the available horizontal space; flex item grows
     to width but is height-bounded by the grid row. */
  .sprunki-main sprunki-stage {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .sprunki-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 12px 20px;
    background: rgba(0, 0, 0, 0.4);
    border-top: 2px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  /* Header right-side toolbar (clear / preferences). */
  .sprunki-toolbar {
    display: flex;
    gap: 6px;
  }
  .sprunki-icon-btn {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: #f0f0f0;
    font-size: 16px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .sprunki-icon-btn:hover {
    background: rgba(255, 255, 255, 0.18);
    border-color: rgba(255, 255, 255, 0.28);
  }

  /* Boot / provisioning / error screen. */
  .sprunki-bootscreen {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: #cdd;
    font-size: 17px;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    text-align: center;
    padding: 0 24px;
  }
`;

export const characterBoardStyles = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .sprunki-layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    height: 100%;
    gap: 0;
  }

  /* ── LEFT: Roster ── */

  .roster-panel {
    background: rgba(0, 0, 0, 0.25);
    border-right: 2px solid rgba(255, 255, 255, 0.06);
    padding: 12px 8px;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .roster-header {
    font-size: 13px;
    font-weight: 800;
    color: rgba(255, 255, 255, 0.8);
    margin-bottom: 2px;
    padding: 0 8px;
  }

  .roster-instruction {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.3);
    margin-bottom: 12px;
    padding: 0 8px;
  }

  .roster-chars {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }

  .roster-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 2px solid rgba(255, 255, 255, 0.06);
    cursor: grab;
    transition: all 0.12s;
    user-select: none;
  }

  .roster-chip:hover {
    background: color-mix(in srgb, var(--chip-color, #666) 15%, rgba(255,255,255,0.05));
    border-color: color-mix(in srgb, var(--chip-color, #666) 40%, transparent);
    transform: translateX(3px);
  }

  .roster-chip:active {
    cursor: grabbing;
    transform: scale(1.05);
    box-shadow: 0 0 12px color-mix(in srgb, var(--chip-color, #666) 30%, transparent);
  }

  .chip-emoji {
    font-size: 18px;
    width: 24px;
    text-align: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* OG-sprunki SVG art when the asset pack is downloaded. The
     emoji fallback (.char-emoji) is intentionally untouched so
     pre-pack and post-pack rosters line up visually. */
  .char-art {
    width: 28px;
    height: 28px;
    object-fit: contain;
    pointer-events: none;
  }
  .char-emoji {
    font-size: inherit;
  }
  .slot-char .char-art {
    width: 100%;
    height: 100%;
  }

  /* ── Audio-reactive pulse ──
     Every chip / slot-char carries a data-cat attribute naming
     its category; the parent app pushes a per-category dBFS
     reading 30 times per second via the --meter custom property
     (0..1, where 0 = silent and 1 = clipping). Scale + glow
     scale linearly with --meter. CSS transitions ease the change
     so the surface isn't twitchy. */
  .roster-chip[data-cat],
  .slot-char[data-cat] {
    transform: scale(calc(1 + var(--meter, 0) * 0.18));
    box-shadow:
      0 0 calc(var(--meter, 0) * 18px)
        color-mix(in srgb, var(--chip-color, var(--cc, #fff)) 80%, transparent);
    filter: brightness(calc(1 + var(--meter, 0) * 0.45));
    transition: transform 60ms ease-out,
                box-shadow 80ms ease-out,
                filter 80ms ease-out;
  }

  .chip-name {
    font-size: 12px;
    font-weight: 600;
    color: #ddd;
  }

  /* ── RIGHT: Timeline ── */

  .timeline-panel {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    overflow-x: auto;
  }

  .timeline-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.6);
  }

  .timeline-hint {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.3);
    font-weight: 400;
  }

  /* Beat number row */
  .beat-labels {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
    padding: 0 2px;
  }

  .beat-label-num {
    flex: 1;
    min-width: 52px;
    text-align: center;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.25);
    font-weight: 500;
  }

  /* The big drop zone */
  .beat-timeline {
    display: flex;
    gap: 4px;
    padding: 2px;
  }

  .beat-slot {
    flex: 1;
    min-width: 52px;
    min-height: 120px;
    border-radius: 12px;
    border: 2px dashed rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.02);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    transition: all 0.15s;
    position: relative;
  }

  .beat-slot:hover {
    border-color: rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.04);
  }

  .beat-slot.accent {
    border-style: solid;
    border-color: rgba(255, 255, 255, 0.15);
  }

  .beat-slot.has-chars {
    border-style: solid;
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .beat-slot.drag-over {
    border-color: #feca57;
    background: rgba(254, 202, 87, 0.1);
    box-shadow: inset 0 0 16px rgba(254, 202, 87, 0.15);
    transform: scale(1.03);
    z-index: 2;
  }

  /* Placed character chip in a slot */
  .slot-char {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    background: color-mix(in srgb, var(--cc, #666) 25%, transparent);
    border: 2px solid color-mix(in srgb, var(--cc, #666) 60%, transparent);
    cursor: pointer;
    transition: all 0.1s;
    position: relative;
  }

  .slot-char:hover {
    transform: scale(1.15);
    box-shadow: 0 0 12px color-mix(in srgb, var(--cc, #666) 40%, transparent);
    /* Show a little × on hover */
    &::after {
      content: "×";
      position: absolute;
      top: -6px;
      right: -6px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(0,0,0,0.7);
      color: #ff6b6b;
      font-size: 10px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .drop-hint {
    font-size: 24px;
    color: #feca57;
    font-weight: 700;
    opacity: 0.6;
  }

  /* Beat position dots under the timeline */
  .beat-dots {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    padding: 0 2px;
    justify-content: center;
  }

  .dot {
    flex: 1;
    min-width: 52px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.08);
  }

  .dot.downbeat {
    background: rgba(255, 255, 255, 0.2);
  }

  .category-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.3);
    padding: 10px 8px 4px;
  }
`;

export const transportStyles = css`
  :host {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .transport-btn {
    min-width: 44px;
    height: 40px;
    padding: 0 14px;
    border-radius: 20px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.1);
    color: #f0f0f0;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.15s;
  }
  .transport-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
    transform: translateY(-1px);
  }
  .transport-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .transport-btn.play {
    background: #00b894;
    color: white;
    box-shadow: 0 0 14px rgba(0, 184, 148, 0.35);
  }
  .transport-btn.play:hover:not(:disabled) {
    background: #00d2a7;
    box-shadow: 0 0 18px rgba(0, 184, 148, 0.55);
  }
  .transport-btn.play.playing {
    background: #e17055;
    box-shadow: 0 0 14px rgba(225, 112, 85, 0.45);
  }

  .transport-btn.stop {
    background: rgba(255, 255, 255, 0.1);
    color: white;
    min-width: 40px;
    padding: 0 10px;
  }
  .transport-btn.stop:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
  }

  .transport-btn.on {
    background: rgba(108, 140, 255, 0.35);
    border-color: #6c8cff;
    color: #fff;
  }

  .bpm-display {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 10px;
  }

  .bpm-label {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.5);
    font-weight: 600;
    text-transform: uppercase;
  }

  .bpm-value {
    font-size: 24px;
    font-weight: 800;
    color: #feca57;
    font-variant-numeric: tabular-nums;
    cursor: ns-resize;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    padding: 0 4px;
    border-radius: 6px;
    transition: background-color 100ms ease;
  }
  .bpm-value:hover {
    background: rgba(254, 202, 87, 0.10);
  }
  .bpm-value.dragging {
    background: rgba(254, 202, 87, 0.18);
    cursor: grabbing;
  }

  .bpm-buttons {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .bpm-buttons button {
    width: 20px;
    height: 18px;
    border: none;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    padding: 0;
  }

  .bpm-buttons button:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  .position-display {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
    min-width: 60px;
  }
`;
