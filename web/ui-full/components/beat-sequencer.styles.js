// SPDX-License-Identifier: Apache-2.0
//
// CSS extracted from beat-sequencer.js so the component file stays readable.
// Interpolated JS constants are re-exported here as the source of
// truth; the component imports them back from this module.

import { css } from "lit";


export const sequencerStyles = css`
    /* Force border-box throughout so padding + border don't drift
       our cell heights away from the row-head heights. Same fix we
       used in timeline-view after the lane-head width bug. */
    :host, *, *::before, *::after { box-sizing: border-box; }
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: transparent;
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 11px;
    }
    /* Row split: main column fills, side-strip docks to the right. */
    .root {
      flex: 1; min-height: 0; min-width: 0;
      display: flex; flex-direction: row;
      overflow: hidden;
    }
    .main {
      flex: 1 1 auto; min-width: 0; min-height: 0;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .side-strip {
      flex: 0 0 auto;
      display: flex; flex-direction: row;
      border-left: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      transition: width 0.18s ease;
      width: 32px;           /* rail-only */
      min-width: 0;
    }
    .side-strip.open {
      width: var(--strip-w, 420px);
      max-width: 65%;
    }
    .strip-handle {
      flex: 0 0 32px;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: 0;
      color: var(--color-text-muted);
      cursor: pointer;
      border-right: 1px solid var(--color-border);
    }
    .strip-handle:hover { color: var(--color-accent); }
    .strip-resize {
      flex: 0 0 8px;
      cursor: ew-resize;
      border-right: 1px solid var(--color-border);
      background: transparent;
    }
    .strip-resize:hover {
      background: color-mix(in oklab, var(--color-accent, #7c5cff) 20%, transparent);
    }
    .side-strip foyer-midi-manager {
      flex: 1; min-width: 0;
      overflow: auto;
    }
    .tb {
      display: flex; align-items: center; gap: 10px;
      flex-wrap: wrap; row-gap: 6px;
      padding: 6px 12px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      flex: 0 0 auto;
    }
    .tb .title { color: var(--color-text); font-weight: 600; }
    .tb label {
      display: inline-flex; align-items: center; gap: 6px;
    }
    .tb select, .tb button, .tb input[type="number"] {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 2px 8px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
      /* Center any iconographic content (icon spans, unicode glyphs)
       * in the button's box. Without this the SVG span sits at the
       * baseline and looks top-heavy next to the textual buttons. */
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 22px;
      line-height: 1;
    }
    .tb button > span,
    .tb button > svg {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .tb button:hover, .tb select:hover { background: var(--color-surface-muted); }
    .tb input[type="range"] { flex: 0 0 90px; vertical-align: middle; }
    .tb input[type="number"] { width: 58px; font-variant-numeric: tabular-nums; }
    /* Pull the spacer out of the line-flow when the bar wraps; without
     * flex 1 0 100 percent the spacer would still try to push later
     * items to the second row, leaving big gaps. With wrap+full-width
     * the second row starts cleanly with the buttons that come after. */
    .tb .tb-spacer { flex: 1 1 auto; min-width: 0; }
    /* Transport strip — only rendered when the host foyer-window is
     * maximized. Holds the tempo widget + play/stop. Sits between
     * the main toolbar and the seek bar. */
    .transport-strip {
      display: flex; align-items: center; gap: 12px;
      padding: 6px 12px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font: inherit; font-size: 11px;
    }
    .transport-strip foyer-number { flex: 0 0 auto; }
    .transport-strip button {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 10px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 13px;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 36px; min-height: 28px;
    }
    .transport-strip button:hover { background: var(--color-surface-muted); }

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
      display: flex; flex-direction: column;
      background: var(--color-surface);
      border-bottom: 2px solid var(--color-border);
      overflow: hidden;
      position: relative;
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
      background: transparent;
      border: 1px dashed var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 8px; border-radius: 4px;
      cursor: pointer; font: inherit; font-size: 10px;
    }
    .arr-head .add:hover {
      color: var(--color-text); border-color: var(--color-accent);
    }
    /* The "+ Pattern" button sits at the left side of arr-head so
       it's visually *above* the pattern label column. Rich's ask
       2026-04-21: "add pattern button should be above the patterns
       boxes". Putting it inline in arr-head keeps the alignment
       clean (no spacer row in the cell grid to drift out of sync
       with the column header). */
    .arr-head .add.add-pattern {
      margin-left: 0;
      padding: 1px 8px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .arr-head .add.bars { margin-left: auto; }
    .arr-body {
      display: grid;
      grid-template-columns: 160px 1fr;
      flex: 1; min-height: 0;
      overflow: auto;
    }
    .arr-resize {
      position: absolute;
      left: 0; right: 0; bottom: -3px;
      height: 7px; cursor: ns-resize;
      z-index: 2;
    }
    .arr-resize:hover { background: color-mix(in oklab, var(--color-accent) 35%, transparent); }
    .arr-pat-list { display: flex; flex-direction: column; background: var(--color-surface-elevated); border-right: 1px solid var(--color-border); }
    .arr-pat {
      display: grid;
      grid-template-columns: 12px 1fr 18px;
      align-items: center; gap: 6px;
      padding: 4px 8px;
      height: 22px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
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
      height: 22px;
      border-right: 1px solid rgba(255,255,255,0.10);
      border-bottom: 1px solid rgba(255,255,255,0.10);
      cursor: pointer;
    }
    .arr-cell.beat-edge { border-right-color: rgba(255,255,255,0.28); }
    .arr-cell:hover { background: rgba(255,255,255,0.06); }
    .arr-cell.on { background: var(--cell-color, var(--color-accent, #7c5cff)); }
    .arr-cell.on:hover { filter: brightness(1.15); }

    /* ── PATTERN EDITOR (cell grid) ────────────────────── */
    /*
     * Outer flex split:
     *    .body      — rows column + grid, scrolls together
     *    .velocity  — pinned to the bottom, mirrors the grid's
     *                 column layout, does not scroll with the body
     *
     * Previous design put velocity inside .body as a grid-area
     * "velocity" row. That made it scroll with the grid when the
     * rows column exceeded viewport height. Moving velocity to a
     * sibling fixes the "velocity scrolls off the bottom" issue.
     */
    .body {
      flex: 1; min-height: 0;
      display: grid;
      grid-template-columns: 180px 1fr;
      grid-template-areas: "rows grid";
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
      /* box-sizing inherits from the :host border-box rule, so
         --row-h is the *total* row height including the bottom
         border — matches .row-head's border-box height exactly. */
    }
    .cell {
      border-right: 1px solid rgba(255, 255, 255, 0.10);
      cursor: pointer;
      position: relative;
    }
    .cell.beat { border-right-color: rgba(255, 255, 255, 0.32); }
    .cell:hover { background: rgba(255, 255, 255, 0.06); }
    .cell.on { background: var(--row-color, var(--color-accent, #7c5cff)); }
    .cell.on:hover { filter: brightness(1.15); }
    .cell.on .vel {
      position: absolute; inset: 2px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.18);
      pointer-events: none;
    }
    /* Right-edge resize grip for pitched-mode cells — drag to
       extend a note across multiple steps without needing to
       switch to a separate editor. */
    .cell.on .resize-r {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 6px;
      cursor: ew-resize;
      z-index: 2;
    }
    .cell.on .resize-r:hover {
      background: rgba(255, 255, 255, 0.35);
    }

    .velocity {
      flex: 0 0 auto;
      height: 70px;
      display: grid;
      align-items: flex-end;
      background: var(--color-surface-muted);
      border-top: 1px solid var(--color-border);
      padding-top: 6px;
      /* 180px spacer mirrors the rows column above so velocity
         bars line up with the pattern cells. The velocity lane
         is a sibling of .body (not inside it) so it stays pinned
         to the bottom when the body scrolls vertically. */
      padding-left: 180px;
      overflow: hidden;
      flex: 0 0 76px;
    }
    .vel-col {
      height: 100%;
      display: flex; align-items: flex-end; justify-content: center;
      gap: 1px;
      border-right: 1px solid rgba(255, 255, 255, 0.03);
    }
    .vel-col .bar {
      flex: 1;
      background: var(--color-accent, #7c5cff);
      border-radius: 2px 2px 0 0; min-height: 1px;
      max-width: 10px;
    }

    .hint {
      padding: 4px 10px;
      font-size: 10px;
      color: var(--color-text-muted);
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }

    .tb label.chk {
      display: inline-flex; align-items: center; gap: 4px;
      color: var(--color-text-muted); cursor: pointer;
      user-select: none;
    }
    .tb label.chk input { accent-color: var(--color-accent, #7c5cff); }

    /* Archived-layout banner — mirror of the piano-roll banner so
       both directions of the conversion read as the same amber
       "not-the-authoritative-view" cue. */
    .archived-banner {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: color-mix(in oklab, #fbbf24 22%, var(--color-surface-elevated));
      border-bottom: 1px solid color-mix(in oklab, #fbbf24 40%, var(--color-border));
      color: var(--color-text);
      font-size: 11px;
    }
    .archived-banner .icon { font-size: 14px; }
    .archived-banner .text { flex: 1; }
    .archived-banner .text strong { color: #fbbf24; }
    .archived-banner button {
      background: #fbbf24;
      border: 1px solid #fbbf24;
      color: #000;
      font: inherit; font-weight: 600; font-size: 11px;
      padding: 3px 10px; border-radius: 4px;
      cursor: pointer;
    }
    .archived-banner button:hover { filter: brightness(1.1); }

    /* "+ Drum" row at bottom of row-head column, drum mode only. */
    .add-drum-row {
      height: var(--row-h);
      display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 10px; letter-spacing: 0.06em;
      cursor: pointer;
    }
    .add-drum-row:hover { color: var(--color-accent); }

    /* modal shim — reused by drum picker and preset manager */
    .modal {
      position: fixed; inset: 0; z-index: 2000;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
    }
    .modal .panel {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 6px;
      min-width: 320px; max-width: 480px;
      padding: 14px 16px;
      display: flex; flex-direction: column; gap: 10px;
      color: var(--color-text);
      box-shadow: 0 10px 40px rgba(0,0,0,0.55);
    }
    .modal h3 { margin: 0; font-size: 13px; font-weight: 600; }
    .modal .row-f {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; color: var(--color-text-muted);
    }
    .modal input[type="text"], .modal select, .modal input[type="number"] {
      flex: 1;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 8px; border-radius: 4px;
      font: inherit; font-size: 11px;
    }
    .modal .actions {
      display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;
    }
    .modal button {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 10px; border-radius: 4px;
      font: inherit; font-size: 11px; cursor: pointer;
    }
    .modal button.primary {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }
    .modal button:hover { filter: brightness(1.1); }

    .preset-list {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 240px; overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: 4px;
      background: var(--color-surface-elevated);
    }
    .preset-list .empty { padding: 12px; color: var(--color-text-muted); font-size: 11px; text-align: center; }
    .preset-list .item {
      display: grid; grid-template-columns: 1fr auto auto auto;
      gap: 6px; align-items: center;
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 11px;
    }
    .preset-list .item:last-child { border-bottom: 0; }
    .preset-list .item button { padding: 2px 8px; font-size: 10px; }
`;
