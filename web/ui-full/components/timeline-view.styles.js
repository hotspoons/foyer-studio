// SPDX-License-Identifier: Apache-2.0
//
// Timeline-view CSS, split out of the 6500-line component file so
// the class body sits at a reasonable size. Imported as a `CSSResult`
// via Lit's tagged-template `css` so `static styles` keeps its
// non-static type expectations.
//
// The three layout constants below (RULER_HEIGHT / HEAD_WIDTH /
// EDGE_GRAB) are referenced by CSS interpolation. Kept in this
// module rather than imported from timeline-view.js so the CSS
// has no runtime dependency on the component module; timeline-view.js
// re-imports them from here to keep one source of truth.

import { css } from "lit";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

export const RULER_HEIGHT = 26;
export const HEAD_WIDTH = 140;
export const EDGE_GRAB = 6;

export const timelineStyles = css`
    ${scrollbarStyles}
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; background: var(--color-surface); outline: none; }
    /* Subtle focus ring so keyboard users can see WHICH view their
     * arrow / Enter is targeting. Inset 1px so it doesn't push
     * adjacent layout. focus-visible (not :focus) keeps the ring off
     * for mouse-only clicks — pointer interactions move focus too. */
    :host(:focus-visible) {
      box-shadow: inset 0 0 0 1px var(--color-accent, #7c5cff);
    }
    /* Selected-track highlight in keyboard nav. The .selected class
     * already exists on .lane; this just makes the row read clearly
     * on a focused timeline. */
    :host(:focus-within) .lane.selected .lane-head {
      box-shadow: inset 2px 0 0 var(--color-accent, #7c5cff);
    }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 11px;
      flex-wrap: wrap;
      min-width: 0;
    }
    /* Toolbar chips — match tb-menu summaries + viz-picker (same padding/weight). */
    .toolbar button,
    .toolbar select {
      font: inherit; font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--color-text-muted);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      cursor: pointer;
      display: inline-flex; align-items: center;
      gap: 4px;
      min-height: 22px;
      box-sizing: border-box;
      transition: color 0.1s ease, border-color 0.1s ease;
    }
    .zoom-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .zoom-toolbar .zoom-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .toolbar input.zoom-range {
      -webkit-appearance: none;
      appearance: none;
      width: 120px;
      height: 6px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
      cursor: pointer;
    }
    .toolbar input.zoom-range:focus-visible {
      outline: 2px solid color-mix(in oklab, var(--color-accent) 50%, transparent);
      outline-offset: 2px;
    }
    .toolbar input.zoom-range::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
    }
    .toolbar input.zoom-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin-top: -4px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    }
    .toolbar input.zoom-range::-moz-range-track {
      height: 6px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
    }
    .toolbar input.zoom-range::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    }
    .toolbar button:hover,
    .toolbar select:hover { color: var(--color-text); border-color: var(--color-accent); }
    .toolbar select { padding-right: 4px; }
    .toolbar label {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; color: var(--color-text-muted);
    }
    .toolbar details.tb-menu {
      position: relative;
      border: none;
      background: transparent;
    }
    .toolbar details.tb-menu > summary {
      list-style: none;
      cursor: pointer;
      font-family: var(--font-sans);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 22px;
      box-sizing: border-box;
      transition: color 0.1s ease, border-color 0.1s ease;
    }
    .toolbar details.tb-menu > summary:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .toolbar details.tb-menu > summary::-webkit-details-marker { display: none; }
    .toolbar details.tb-menu > summary::after {
      content: "▾";
      font-size: 9px;
      opacity: 0.75;
      margin-left: 2px;
      font-weight: 400;
      letter-spacing: normal;
    }
    .toolbar details.tb-menu[open] > summary {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .toolbar .tb-panel {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 40;
      min-width: 200px;
      max-width: 280px;
      padding: 8px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      font-size: 10px;
      color: var(--color-text);
    }
    .toolbar .tb-panel .tb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 4px 0;
    }
    .toolbar .tb-panel .tb-row input { accent-color: var(--color-accent); }
    .toolbar .tb-panel .tb-hint {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--color-border);
      font-size: 9px;
      color: var(--color-text-muted);
      line-height: 1.35;
    }
    .toolbar .tb-panel button.mi {
      display: block;
      width: 100%;
      text-align: left;
      margin: 2px 0;
      padding: 4px 6px;
      font-size: 10px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: transparent;
      color: var(--color-text);
      cursor: pointer;
    }
    .toolbar .tb-panel button.mi:hover {
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .toolbar .tb-panel button.mi:disabled {
      opacity: 0.45;
      cursor: default;
    }
    /* Force border-box throughout this component. Tailwind sets it
       globally on the document, but Lit shadow DOM doesn't inherit
       that — so width:140px + padding + border was producing a
       163px-wide lane-head while regions positioned at 140px got
       covered by its opaque background. */
    :host, *, *::before, *::after { box-sizing: border-box; }
    .scroll { flex: 1; overflow: auto; min-height: 0; }
    .grid { position: relative; min-width: 100%; }

    /* Ardour-style summary strip — mini whole-session view + draggable
       viewport rectangle. Pinned to the bottom of the timeline-view.
       Hidden when the overviewStripOn viz pref is false. Resizable
       from its top edge via the .overview-resize handle. */
    .overview-strip {
      position: relative;
      flex: 0 0 auto;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      overflow: hidden;
      user-select: none;
    }
    .overview-resize {
      position: absolute; left: 0; right: 0; top: -3px;
      height: 6px; cursor: ns-resize; z-index: 4;
    }
    .overview-resize::after {
      content: "";
      position: absolute; left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      width: 36px; height: 2px;
      background: color-mix(in oklab, var(--color-border) 70%, transparent);
      border-radius: 1px;
    }
    .overview-svg {
      display: block; width: 100%; height: 100%;
      cursor: pointer;
    }
    .overview-viewport {
      fill: color-mix(in oklab, var(--color-accent) 18%, transparent);
      stroke: var(--color-accent);
      stroke-width: 1.5;
      cursor: grab;
      pointer-events: all;
    }
    .overview-viewport.dragging { cursor: grabbing; }
    .overview-viewport-edge {
      cursor: ew-resize; fill: transparent;
      pointer-events: all;
    }
    .overview-playhead {
      stroke: var(--color-error);
      stroke-width: 1; opacity: 0.9; pointer-events: none;
    }
    .overview-track-row.audio { fill: color-mix(in oklab, var(--color-accent-3) 70%, transparent); }
    .overview-track-row.midi { fill: color-mix(in oklab, var(--color-accent-2) 70%, transparent); }
    .overview-track-row.sequencer { fill: color-mix(in oklab, var(--color-accent-2) 80%, transparent); }
    .overview-track-row.master { fill: color-mix(in oklab, var(--color-text-muted) 50%, transparent); }
    .ruler {
      position: sticky; top: 0; z-index: 3;
      height: ${RULER_HEIGHT}px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      cursor: crosshair;
    }
    .ruler .tick {
      position: absolute;
      top: 0; bottom: 0;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      pointer-events: none;
    }
    .ruler .tick.major { border-left: 1px solid var(--color-border); padding-left: 4px; }
    .ruler .tick.minor { border-left: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent); }
    .lane-gridlines {
      position: absolute;
      left: ${HEAD_WIDTH}px;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      pointer-events: none;
    }
    .lane-gridlines .gl {
      position: absolute; top: 0; bottom: 0;
      /* --foyer-time-grid is set on the host from viz prefs (Viz
       * menu → Timeline grid colors). Falls back to the prior
       * border-mix if unset. */
      border-left: 1px solid var(--foyer-time-grid, color-mix(in oklab, var(--color-border) 30%, transparent));
    }
    .lane-gridlines .gl.major {
      border-left-color: var(--foyer-time-grid-major, color-mix(in oklab, var(--color-border) 60%, transparent));
    }
    .lane {
      position: relative;
      border-bottom: 1px solid var(--color-border);
    }
    .lane-resize {
      position: absolute;
      left: 0; right: 0;
      bottom: -3px;
      height: 6px;
      cursor: ns-resize;
      z-index: 5;
    }
    .lane-resize:hover {
      background: color-mix(in oklab, var(--color-accent) 40%, transparent);
    }
    .lane-head {
      /* z-index 10 keeps the sticky lane-head above the crossfade
       * overlay (z:5), crossfade badge (z:6), and automation
       * overlay (z:6). Otherwise a wide crossfade badge or a long
       * automation polyline paints into the lane-head's column at
       * the scroll origin. */
      position: sticky; left: 0; z-index: 10;
      width: ${HEAD_WIDTH}px; height: 100%;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 10px;
      background: var(--color-surface-elevated);
      border-right: 1px solid var(--color-border);
      border-left: 3px solid transparent;
      gap: 3px;
      cursor: pointer;
      transition: background 0.1s ease, border-left-color 0.1s ease;
    }
    .lane-head:hover {
      background: color-mix(in oklab, var(--color-accent) 6%, var(--color-surface-elevated));
    }
    .lane.selected .lane-head {
      background: color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-elevated));
      border-left-color: var(--color-accent);
    }
    .lane-name { font-size: 11px; font-weight: 600; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lane-kind {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
      display: inline-flex; align-items: center; gap: 5px;
    }
    .seq-chip {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 1px 4px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-accent) 24%, transparent);
      color: var(--color-accent);
    }
    .lane-controls {
      display: flex;
      gap: 3px;
      margin-top: 2px;
    }
    .lane-ctl-btn {
      flex: 1;
      font-family: var(--font-sans);
      font-size: 9px;
      font-weight: 700;
      padding: 2px 0;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
      text-align: center;
    }
    .lane-ctl-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-text);
    }
    .lane-ctl-btn.on.mute {
      background: color-mix(in oklab, var(--color-warning) 35%, transparent);
      border-color: var(--color-warning);
      color: var(--color-warning);
    }
    .lane-ctl-btn.on.solo {
      background: color-mix(in oklab, #dece5c 35%, transparent);
      border-color: #dece5c;
      color: #dece5c;
    }
    .lane-ctl-btn.on.rec {
      background: color-mix(in oklab, var(--color-danger, #d04040) 35%, transparent);
      border-color: var(--color-danger, #d04040);
      color: var(--color-danger, #d04040);
    }
    .lane-ctl-btn.on.auto {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 35%, transparent);
      border-color: var(--color-accent-2, #22d3ee);
      color: var(--color-accent-2, #22d3ee);
    }
    /* Slot-keeper for tracks that don't have a record-arm or
     * automation control (master, busses, etc.). Same flex weight as
     * a real button but invisible — keeps M/S/●/A aligned across
     * every track in the lane head. Non-interactive. */
    .lane-ctl-btn.placeholder {
      background: transparent;
      border-color: transparent;
      pointer-events: none;
      cursor: default;
    }
    .lane-ctl-btn.placeholder:hover { border-color: transparent; }
    /* The record-arm button uses "●" as its label to match the
     * mixer. Bump the glyph size so it reads visually similar to
     * "M" / "S" / "A" at the same 9px font size. */
    .lane-ctl-btn.rec { font-size: 11px; line-height: 1; }
    .automation-stack {
      position: absolute;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      z-index: 1;
    }
    .automation-stack foyer-automation-lane { width: 100%; }
    .region {
      position: absolute;
      top: 4px; bottom: 4px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--color-accent) 28%, var(--color-surface-elevated) 72%);
      border: 1px solid color-mix(in oklab, var(--color-accent-2) 60%, transparent);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      cursor: grab;
      transition: filter 0.1s ease;
      /* Force a new stacking context per region. Without this, the
       * z-indexed handles + gain strip live in the LANE's stacking
       * context and pop through the body of a later-DOM neighboring
       * region in the overlap zone — producing the visual flicker
       * Rich saw with overlapping clips. Isolated, each region's
       * handles are confined to that region's z-space, so the
       * front region's body cleanly covers the back region's
       * controls in the overlap. */
      isolation: isolate;
    }
    .region.dragging { cursor: grabbing; filter: brightness(1.15); }
    /* Visible hint while the cursor is over a foreign lane during a
     * move drag — the region will be relocated to that lane on
     * pointer-up. A dashed accent outline + soft glow reads as
     * "this is the drop target" without needing a real DOM reparent
     * during the drag (we keep the lozenge in its source lane and
     * commit the move on release). */
    .region.cross-track-pending {
      outline: 2px dashed var(--color-accent-2, #22d3ee);
      outline-offset: 2px;
      box-shadow: 0 0 14px color-mix(in oklab, var(--color-accent-2, #22d3ee) 60%, transparent);
    }
    /* Drop-target ghost shown on the destination lane while a
     * cross-track region drag is in flight. Sized to match the
     * source region; positioned at the live drag offset so the
     * user can sight the landing spot before releasing. Pure
     * outline (no fill) so the meter/grid behind stays readable. */
    .cross-track-ghost {
      position: absolute;
      top: 4px;
      bottom: 4px;
      border: 2px dashed var(--color-accent-2, #22d3ee);
      border-radius: 4px;
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 12%, transparent);
      box-shadow: 0 0 14px color-mix(in oklab, var(--color-accent-2, #22d3ee) 50%, transparent);
      pointer-events: none;
      z-index: 4;
    }
    /* Lane drag-over feedback for an audio-pool drop. Soft accent
     * tint over the whole lane so the user knows where the dropped
     * source will land before releasing. */
    .lane.pool-drop-target {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 12%, transparent);
      box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--color-accent-2, #22d3ee) 50%, transparent);
    }
    .cross-track-ghost .ghost-label {
      position: absolute;
      top: 4px;
      left: 6px;
      font-size: 10px;
      font-weight: 600;
      color: var(--color-text);
      background: rgba(0, 0, 0, 0.55);
      padding: 1px 5px;
      border-radius: 3px;
      pointer-events: none;
      white-space: nowrap;
    }
    .region:hover { filter: brightness(1.08); }
    /* Focus ring for keyboard tab-through. focus-visible keeps the
     * ring off for mouse-clicks (which also move focus to the region
     * but don't need the affordance). The dashed outline plus inset
     * shadow reads against any region color. */
    .region:focus-visible {
      outline: 2px dashed var(--color-accent, #7c5cff);
      outline-offset: -2px;
      box-shadow:
        0 0 0 1px var(--color-accent, #7c5cff),
        0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .region.selected {
      border-color: color-mix(in oklab, var(--color-accent-3) 75%, #fff 25%);
      box-shadow:
        0 0 0 1px color-mix(in oklab, var(--color-accent-3) 45%, transparent),
        0 1px 3px rgba(0, 0, 0, 0.35);
      filter: brightness(1.08);
    }
    /* Automation overlay — color-coded polylines drawn over the
     * regions, one per active automation lane on the track. Sits
     * above region bodies (z-index above .region's stacking context
     * since .region uses isolation: isolate, which means the SVG
     * sibling at z-index 6 stays on top of every region). Pointer
     * events are off by default; individual path children opt in
     * via pointer-events:stroke so clicking the line opens the
     * modal but the user can still click regions through the gaps. */
    .automation-overlay {
      position: absolute;
      pointer-events: none;
      z-index: 6;
      overflow: visible;
    }
    /* Group-membership indicator: a 3 px tinted bar at the very top
     * of the lozenge, color derived from the group_id so every
     * sibling reads as one unit at a glance. Sits BEHIND the gain
     * strip (which is also at top:0) — gain strip's left:12px /
     * right:12px gap means a sliver of the group bar peeks out at
     * each corner, which is enough visual signal without arguing
     * with the gain UI. */
    .region .group-bar {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      z-index: 3;
      pointer-events: none;
      border-radius: 3px 3px 0 0;
    }
    /* Resize-preview placeholder: while a left-edge resize-drag is
     * extending the region beyond the source bounds we have peaks
     * for, the new (out-of-bounds) span paints as a striped
     * neutral-grey scrim. Mirrors the recording-placeholder pattern
     * but desaturated since this isn't a recording state — it's a
     * "no decoded data here yet" hint. */
    .region .resize-preview-placeholder {
      position: absolute;
      top: 4px; bottom: 4px;
      background: repeating-linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.04),
        rgba(255, 255, 255, 0.04) 6px,
        rgba(255, 255, 255, 0.10) 6px,
        rgba(255, 255, 255, 0.10) 12px
      );
      border-left: 1px dashed rgba(255, 255, 255, 0.35);
      pointer-events: none;
      z-index: 1;
    }

    /* Cut-pending slice overlay: a translucent scrim positioned over
     * the slice the user has queued for delete-on-paste. For whole-
     * region cuts the overlay spans 0..100% and looks like the legacy
     * dim. For time-range slice cuts the overlay covers ONLY the
     * carved-out portion so the user can see exactly what's leaving
     * vs. what's staying behind. The dashed border is on the overlay
     * (not the region) so the lozenge boundary still reads cleanly. */
    .region .cut-slice-overlay {
      position: absolute;
      top: 0; bottom: 0;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.55);
      border: 1px dashed rgba(255, 255, 255, 0.5);
      box-sizing: border-box;
      z-index: 2;
    }
    .region .name {
      position: absolute;
      top: 2px; left: 6px; right: 6px;
      /* Clip + ellipsize so the region name never spills past the
       * region container. Without max-width and overflow controls,
       * a long take name on a narrow region renders past the right
       * edge — and with absolutely-positioned viz children, that
       * spillover was visually poking over adjacent track header
       * strips. */
      max-width: calc(100% - 12px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-sans);
      font-size: 10px;
      font-weight: 600;
      color: #fff;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      z-index: 2;
    }
    .region canvas {
      position: absolute;
      left: 0; top: 0; width: 100%; height: 100%;
      pointer-events: none;
    }
    .region .viz {
      position: absolute;
      left: 0; top: 0; right: 0; bottom: 0;
      pointer-events: none;
    }
    .region .edge {
      position: absolute;
      top: 0; bottom: 0;
      width: ${EDGE_GRAB}px;
      cursor: ew-resize;
      z-index: 3;
    }
    .region .edge.left  { left: 0; }
    .region .edge.right { right: 0; }

    /* Fade SVG overlay — covers the lozenge so the curve sits over the
     * waveform. The path itself is what shows the shape; the fill below
     * dims the still-attenuated portion so the user reads the fade
     * envelope at a glance even without the waveform helping. */
    .region .fade-svg {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2;
      overflow: visible;
    }
    .region .fade-svg .fade-fill {
      fill: rgba(0, 0, 0, 0.42);
      stroke: none;
    }
    .region .fade-svg .fade-line {
      fill: none;
      stroke: rgba(255, 255, 255, 0.9);
      stroke-width: 1.25;
      vector-effect: non-scaling-stroke;
    }
    /* Crossfade curves render at the lane level (between regions on
     * the same track) using their own SVG layer. The overlap zone is
     * the only place the user can confirm a crossfade is doing
     * anything, so the visual has to read at a glance even when both
     * regions are painting opaque waveforms underneath it. Strategy:
     *   - bright stroked X-curves with a contrasting dark halo
     *   - diagonal-hatch fill on the overlap rectangle so the band
     *     itself is recognizable as a crossfade zone, separate from
     *     either region's body
     *   - hatch dims when fades fully cover the overlap (clean
     *     crossfade); brightens when fades don't cover (call-to-
     *     action: snap fades to overlap). */
    .crossfade-svg {
      position: absolute;
      pointer-events: none;
      z-index: 5;
      overflow: visible;
    }
    .crossfade-svg .xfade-line-out {
      fill: none;
      stroke: #ffd166;
      stroke-width: 2;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));
      vector-effect: non-scaling-stroke;
    }
    .crossfade-svg .xfade-line-in {
      fill: none;
      stroke: #78dbff;
      stroke-width: 2;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));
      vector-effect: non-scaling-stroke;
    }
    /* Hash-pattern overlap-zone band — confirms the user that
     * "this region is a crossfade zone" even when both regions paint
     * identical-looking waveforms underneath. Defined via inline SVG
     * pattern in the renderer (see _renderCrossfadeOverlaysForTrack). */
    .crossfade-svg .xfade-zone {
      stroke: rgba(255, 255, 255, 0.32);
      stroke-width: 1;
    }
    .crossfade-svg .xfade-zone.incomplete {
      stroke: rgba(255, 209, 102, 0.7);
      stroke-dasharray: 4 3;
    }
    /* Small badge at the top of the overlap zone naming both regions
     * + showing the overlap length. Plain DOM, lives in a sibling
     * absolutely-positioned div so it can pick up text rendering. */
    .crossfade-badge {
      position: absolute;
      top: 0;
      transform: translateY(-100%);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--font-sans);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.04em;
      background: rgba(0, 0, 0, 0.72);
      color: #fff;
      pointer-events: none;
      z-index: 6;
      white-space: nowrap;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
    .crossfade-badge.incomplete {
      background: rgba(120, 70, 0, 0.85);
      color: #ffd166;
    }

    /* Fade-length grab handle — a small triangle anchored to the
     * inside endpoint of the fade. When no fade exists the handle
     * sits at the lozenge corner; drag inward to extend. Hold Alt
     * to rotate the curve shape; Shift+click clears the fade.
     *
     * Visibility is INTENTIONALLY stable (no hover transition):
     * overlapping regions used to flip a :hover rule on/off as the
     * cursor crossed the boundary, popping each region's handles in
     * and out and producing a strobe. A constant baseline opacity
     * makes the handles always discoverable without requiring the
     * cursor to first claim hover ownership of the right region. */
    .region .fade-handle {
      position: absolute;
      top: 0;
      width: 10px;
      height: 14px;
      cursor: ew-resize;
      z-index: 5;
      opacity: 0.85;
    }
    .region .fade-handle.dragging,
    .region .fade-handle.active { opacity: 1; }
    .region .fade-handle::before {
      content: "";
      position: absolute;
      top: 0;
      width: 0;
      height: 0;
      border-style: solid;
    }
    .region .fade-handle.in::before {
      left: 0;
      border-width: 14px 10px 0 0;
      border-color: rgba(255, 255, 255, 0.9) transparent transparent transparent;
    }
    .region .fade-handle.out::before {
      right: 0;
      border-width: 14px 0 0 10px;
      border-color: transparent transparent transparent rgba(255, 255, 255, 0.9);
    }
    .region .fade-handle.in  { transform: translateX(-2px); }
    .region .fade-handle.out { transform: translateX(2px); }

    /* Per-region gain strip — a thin bar across the lozenge top
     * that drags vertically to set gain. Shows the linear-gain dB
     * label while dragging. Audio-only; MIDI regions don't render
     * this strip (Ardour's set_scale_amplitude isn't meaningful
     * for MIDI).
     *
     * Always-on baseline (same rationale as .fade-handle above):
     * hiding the strip behind :hover flickers when two regions
     * overlap and the cursor oscillates over the boundary. A subtle
     * resting opacity is enough to advertise it without competing
     * visually with the waveform underneath. */
    .region .gain-strip {
      position: absolute;
      top: 0; left: 12px; right: 12px;
      height: 6px;
      cursor: ns-resize;
      z-index: 4;
      background: linear-gradient(180deg,
        color-mix(in oklab, var(--color-accent-3, #f59e0b) 75%, transparent),
        color-mix(in oklab, var(--color-accent-3, #f59e0b) 25%, transparent));
      border-radius: 0 0 3px 3px;
      opacity: 0.25;
    }
    .region .gain-strip.dragging,
    .region .gain-strip.nonunity { opacity: 0.85; }
    .region .gain-readout {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      font-family: var(--font-sans);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      pointer-events: none;
      z-index: 5;
      white-space: nowrap;
    }
    /* Floating label that follows the fade-handle drag, showing the
     * current fade length and shape so the user has feedback while
     * they tune the curve. Lives inside the region (not body-level)
     * so positioning is simple. */
    .region .fade-readout {
      position: absolute;
      top: 18px;
      font-family: var(--font-sans);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      pointer-events: none;
      z-index: 6;
      white-space: nowrap;
    }
    .region.stretch-active {
      outline: 1px dashed color-mix(in oklab, var(--color-accent) 70%, transparent);
      z-index: 1;
    }
    .region.stretch-active::after {
      content: attr(data-stretch-mode);
      position: absolute;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--color-accent) 35%, transparent);
      color: var(--color-text);
      pointer-events: none;
      z-index: 4;
    }

    .playhead {
      position: absolute;
      top: 0; bottom: 0;
      width: 2px;
      background: linear-gradient(180deg, var(--color-danger), color-mix(in oklab, var(--color-danger) 40%, transparent));
      z-index: 4;
      pointer-events: none;
      box-shadow: 0 0 8px color-mix(in oklab, var(--color-danger) 60%, transparent);
    }
    .playhead::before {
      content: "";
      position: absolute; top: 0; left: -5px;
      border: 6px solid transparent;
      border-top-color: var(--color-danger);
    }

    /* Recording placeholder - full stack when no track is record-armed */
    .recording-placeholder {
      position: absolute;
      top: ${RULER_HEIGHT}px; bottom: 0;
      background: color-mix(in oklab, var(--color-danger) 12%, transparent);
      border-left: 2px solid var(--color-danger);
      z-index: 2;
      pointer-events: none;
      animation: rec-pulse 1s ease-in-out infinite;
    }
    /* Per-lane strip while recording into armed tracks */
    .recording-lane-fill {
      position: absolute;
      top: 4px;
      bottom: 4px;
      background: color-mix(in oklab, var(--color-danger) 14%, transparent);
      border-left: 2px solid var(--color-danger);
      z-index: 1;
      pointer-events: none;
      animation: rec-pulse 1s ease-in-out infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    /* Left-click-drag selection range. Drawn in two pieces so the ruler
     * reads as a bright highlight while the body overlay is just a dim
     * wash — same pattern as pretty much every DAW's ruler selection. */
    .selection-body {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
      border-left: 1px solid color-mix(in oklab, var(--color-accent) 70%, transparent);
      border-right: 1px solid color-mix(in oklab, var(--color-accent) 70%, transparent);
      pointer-events: none;
      z-index: 3;
    }
    .selection-ruler {
      position: absolute;
      top: 0;
      height: ${RULER_HEIGHT}px;
      background: color-mix(in oklab, var(--color-accent) 55%, transparent);
      border-left: 1px solid var(--color-accent);
      border-right: 1px solid var(--color-accent);
      pointer-events: none;
      z-index: 4;
    }
    /* Resize handles for the time-range selection. Visible only on
     * hover (the band itself stays visually quiet at rest); pointer-
     * events auto so the cursor flips to ew-resize. Drag mutates
     * selection.{start,end}Samples and fires a fresh
     * timeline-selection event on release. (Rich, TODO #51.) */
    .selection-handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
      pointer-events: auto;
      z-index: 5;
      background: transparent;
    }
    .selection-handle:hover,
    .selection-handle.dragging {
      background: color-mix(in oklab, var(--color-accent) 65%, transparent);
    }
    .selection-handle.left  { transform: translateX(-4px); }
    .selection-handle.right { transform: translateX(-4px); }
    /* Vertical line that follows the mouse pointer across the
     * timeline, distinct from the playhead so the user can sight a
     * future seek / region edge without committing. */
    .cursor-line {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      width: 1px;
      background: color-mix(in oklab, var(--color-text-muted) 60%, transparent);
      pointer-events: none;
      z-index: 2;
    }
    /* BPM-quantized grid lines, drawn over the time-based gridlines.
     * Beat boundaries are stronger; in-beat subdivisions are lighter. */
    .quant-line {
      position: absolute;
      top: ${RULER_HEIGHT}px;
      bottom: 0;
      width: 1px;
      pointer-events: none;
      z-index: 1;
    }
    .quant-line.bar {
      /* Bar boundaries are the strongest line. Twice the width of a
       * beat line so they stand out against the per-beat grid; uses
       * the same accent color so the user's viz prefs apply. */
      background: var(--foyer-quant-grid, var(--color-accent-2));
      width: 2px;
    }
    .quant-line.beat {
      /* --foyer-quant-grid is set from viz prefs as a full rgba() so
       * the user's chosen alpha is already baked in. Beat lines use
       * the value as-is; in-beat subdivisions (.sub) drop to 50% of
       * the user's alpha for a visible hierarchy. */
      background: var(--foyer-quant-grid, var(--color-accent-2));
    }
    .quant-line.sub {
      background: var(--foyer-quant-grid, var(--color-accent-2));
      opacity: 0.5;
    }
`;
