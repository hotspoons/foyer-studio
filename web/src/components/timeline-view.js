// Linear editor. Each track is a horizontal lane; regions are laid at their
// sample positions with waveform peaks rendered inside each region.
//
// Features:
//   - Zoom slider (10..400 px/s)
//   - Playhead rendered from transport.position, click ruler to seek
//   - Major (every 5s) + minor (every 1s) grid lines
//   - Drag region body to move; drag edges to resize — optimistic + UpdateRegion
//   - Waveforms via WaveformCache; resolution picked from current zoom level
//
// All sample-math uses `sample_rate` from the TimelineMeta payload so
// different sessions with different rates render correctly.

import { LitElement, html, css } from "lit";
import { WaveformCache, drawPeaks } from "../layout/waveform-cache.js";
import { scrollbarStyles } from "../shared-styles.js";
import { showContextMenu } from "./context-menu.js";

const LANE_HEIGHT_DEFAULT = 52;
const LANE_HEIGHT_MIN = 28;
const LANE_HEIGHT_MAX = 240;
const RULER_HEIGHT = 26;
const HEAD_WIDTH = 140;
const EDGE_GRAB = 6;
const TIERS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];
const LANE_HEIGHT_KEY = "foyer.timeline.lane-heights.v1";

function pickTier(samplesPerPx) {
  let best = TIERS[0];
  for (const t of TIERS) if (t <= samplesPerPx) best = t;
  return best;
}

export class TimelineView extends LitElement {
  static properties = {
    session: { type: Object },
    _regionsByTrack: { state: true, type: Object },
    _timeline: { state: true, type: Object },
    _zoom: { state: true, type: Number },
    _playheadSamples: { state: true, type: Number },
  };

  static styles = css`
    ${scrollbarStyles}
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; background: var(--color-surface); }
    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 11px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toolbar input[type=range] { width: 200px; }
    .toolbar button {
      font: inherit; font-size: 10px;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      cursor: pointer;
    }
    .toolbar button:hover { color: var(--color-text); border-color: var(--color-accent); }
    .scroll { flex: 1; overflow: auto; }
    .grid { position: relative; min-width: 100%; }
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
      border-left: 1px solid color-mix(in oklab, var(--color-border) 30%, transparent);
    }
    .lane-gridlines .gl.major {
      border-left-color: color-mix(in oklab, var(--color-border) 60%, transparent);
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
      position: sticky; left: 0; z-index: 2;
      width: ${HEAD_WIDTH}px; height: 100%;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 10px;
      background: var(--color-surface-elevated);
      border-right: 1px solid var(--color-border);
    }
    .lane-name { font-size: 11px; font-weight: 600; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lane-kind { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted); }
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
    }
    .region.dragging { cursor: grabbing; filter: brightness(1.15); }
    .region:hover { filter: brightness(1.08); }
    .region .name {
      position: absolute;
      top: 2px; left: 6px;
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
    .region .edge {
      position: absolute;
      top: 0; bottom: 0;
      width: ${EDGE_GRAB}px;
      cursor: ew-resize;
      z-index: 3;
    }
    .region .edge.left  { left: 0; }
    .region .edge.right { right: 0; }

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
  `;

  constructor() {
    super();
    this._regionsByTrack = {};
    this._timeline = { sample_rate: 48_000, length_samples: 48_000 * 60 };
    this._zoom = 60;
    this._playheadSamples = 0;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._wfCache = null;
    this._onWfUpdate = () => this._repaintWaveforms();
    this._drag = null;
    this._laneHeights = this._loadLaneHeights();
  }

  _loadLaneHeights() {
    try {
      return JSON.parse(localStorage.getItem(LANE_HEIGHT_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }
  _saveLaneHeights() {
    try {
      localStorage.setItem(LANE_HEIGHT_KEY, JSON.stringify(this._laneHeights));
    } catch {}
  }
  _laneHeightFor(trackId) {
    return this._laneHeights[trackId] || LANE_HEIGHT_DEFAULT;
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      this._wfCache = new WaveformCache(ws);
      this._wfCache.addEventListener("update", this._onWfUpdate);
    }
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    this._wfCache?.removeEventListener("update", this._onWfUpdate);
    this._wfCache?.dispose();
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("session")) this._fetchRegions();
    this._repaintWaveforms();
  }

  _fetchRegions() {
    const tracks = this.session?.tracks ?? [];
    const ws = window.__foyer?.ws;
    if (!ws) return;
    for (const t of tracks) ws.send({ type: "list_regions", track_id: t.id });
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "regions_list") {
      this._regionsByTrack = { ...this._regionsByTrack, [body.track_id]: body.regions };
      this._timeline = body.timeline;
    } else if (body.type === "region_updated") {
      const r = body.region;
      const list = this._regionsByTrack[r.track_id];
      if (list) {
        const idx = list.findIndex(x => x.id === r.id);
        if (idx >= 0) {
          const copy = list.slice();
          copy[idx] = r;
          this._regionsByTrack = { ...this._regionsByTrack, [r.track_id]: copy };
        }
      }
    } else if (body.type === "region_removed") {
      const { track_id, region_id } = body;
      const list = this._regionsByTrack[track_id];
      if (list) {
        this._regionsByTrack = {
          ...this._regionsByTrack,
          [track_id]: list.filter((r) => r.id !== region_id),
        };
      }
    } else if (body.type === "control_update" && body.update?.id === "transport.position") {
      this._playheadSamples = Number(body.update.value) || 0;
    }
  }

  _samplesPerPx() {
    const sr = this._timeline?.sample_rate || 48_000;
    return sr / Math.max(1, this._zoom);
  }

  render() {
    const tracks = this.session?.tracks ?? [];
    const sr = this._timeline?.sample_rate || 48_000;
    const totalSec = Math.max(30, (this._timeline?.length_samples || sr * 30) / sr);
    const widthPx = totalSec * this._zoom;
    const gridWidth = widthPx + HEAD_WIDTH;

    const majorEvery = this._zoom < 40 ? 10 : this._zoom < 100 ? 5 : 1;
    const minorEvery = majorEvery / 5;
    const ticks = [];
    for (let t = 0; t <= totalSec + 1e-6; t += minorEvery) {
      const major = Math.abs(t / majorEvery - Math.round(t / majorEvery)) < 1e-6;
      ticks.push({ t, major });
    }

    return html`
      <div class="toolbar">
        <span>Zoom</span>
        <input type="range" min="10" max="400" step="1" .value=${String(this._zoom)}
               @input=${(e) => { this._zoom = Number(e.currentTarget.value); }}>
        <span>${this._zoom} px/s · tier=${pickTier(this._samplesPerPx())}</span>
        <span style="flex:1"></span>
        <button @click=${this._clearCache} title="Drop all cached peak files">Clear peak cache</button>
        <span>${totalSec.toFixed(1)}s · ${sr} Hz · wheel to zoom · Alt-wheel for lane height</span>
      </div>
      <div class="scroll" @wheel=${(e) => this._onWheel(e)}>
        <div class="grid" style="width:${gridWidth}px">
          <div class="ruler"
               @click=${(e) => this._seekFromRuler(e)}
               @wheel=${(e) => this._onRulerWheel(e)}
               @pointerdown=${(e) => this._onRulerPointerDown(e)}
               @contextmenu=${(e) => e.preventDefault()}>
            ${ticks.map(({ t, major }) => html`
              <span class="tick ${major ? 'major' : 'minor'}"
                    style="left:${HEAD_WIDTH + t * this._zoom}px">
                ${major ? html`<span style="padding-left:4px">${t.toFixed(0)}s</span>` : null}
              </span>
            `)}
          </div>
          <div class="lane-gridlines" style="width:${widthPx}px">
            ${ticks.map(({ t, major }) => html`
              <span class="gl ${major ? 'major' : ''}" style="left:${t * this._zoom}px"></span>
            `)}
          </div>
          ${tracks.map(t => this._renderLane(t))}
          ${this._renderPlayhead()}
        </div>
      </div>
    `;
  }

  _renderPlayhead() {
    const sr = this._timeline?.sample_rate || 48_000;
    const x = HEAD_WIDTH + (this._playheadSamples / sr) * this._zoom;
    return html`<div class="playhead" style="left:${x}px"></div>`;
  }

  _renderLane(track) {
    const regions = this._regionsByTrack[track.id] || [];
    const sr = this._timeline?.sample_rate || 48_000;
    const h = this._laneHeightFor(track.id);
    return html`
      <div class="lane" style="height:${h}px">
        <div class="lane-head" style="height:${h}px">
          <div class="lane-name" title=${track.name}>${track.name}</div>
          <div class="lane-kind">${track.kind}</div>
        </div>
        ${regions.map(r => {
          const leftPx = HEAD_WIDTH + (r.start_samples / sr) * this._zoom;
          const widthPx = Math.max(10, (r.length_samples / sr) * this._zoom);
          return html`
            <div class="region" data-id=${r.id}
                 style="left:${leftPx}px;width:${widthPx}px;top:4px;bottom:4px"
                 @pointerdown=${(e) => this._startDrag(e, r, "move")}
                 @contextmenu=${(e) => this._regionContextMenu(e, r)}>
              <canvas width=${Math.round(widthPx)} height=${h - 8}></canvas>
              <div class="name">${r.name}</div>
              <div class="edge left"  @pointerdown=${(e) => this._startDrag(e, r, "resize-left")}></div>
              <div class="edge right" @pointerdown=${(e) => this._startDrag(e, r, "resize-right")}></div>
            </div>
          `;
        })}
        <div class="lane-resize"
             title="Drag to resize lane"
             @pointerdown=${(e) => this._startLaneResize(e, track.id)}></div>
      </div>
    `;
  }

  /**
   * Mouse-wheel zoom. Plain wheel adjusts temporal zoom (px/s); Alt- or
   * Ctrl-wheel adjusts the lane height of whichever track the pointer is
   * over. Horizontal scroll still works by holding Shift (browser default)
   * or by scrolling on empty areas — we only preventDefault when we actually
   * consume the event so normal scroll in the lane area still works when
   * content overflows.
   */
  _onWheel(ev) {
    const dy = ev.deltaY;
    if (!dy) return;
    if (ev.altKey || ev.ctrlKey) {
      // Vertical (lane-height) zoom. Find the lane the pointer is over.
      const lane = ev.target?.closest?.(".lane");
      if (!lane) return;
      const trackId = this._trackIdForLane(lane);
      if (!trackId) return;
      ev.preventDefault();
      const cur = this._laneHeightFor(trackId);
      const step = Math.max(4, Math.round(cur * 0.12));
      const next = dy < 0
        ? Math.min(LANE_HEIGHT_MAX, cur + step)
        : Math.max(LANE_HEIGHT_MIN, cur - step);
      this._laneHeights = { ...this._laneHeights, [trackId]: next };
      this._saveLaneHeights();
      this.requestUpdate();
      // Give the canvas a beat to resize before repainting.
      requestAnimationFrame(() => this._repaintWaveforms());
      return;
    }
    // Temporal zoom — anchor around the pointer's current time so the user's
    // cursor stays over the same sample while the scale changes.
    ev.preventDefault();
    const scroll = ev.currentTarget;
    const bounds = scroll.getBoundingClientRect();
    const pointerX = ev.clientX - bounds.left + scroll.scrollLeft - HEAD_WIDTH;
    const sr = this._timeline?.sample_rate || 48_000;
    const t0 = pointerX / this._zoom;
    const factor = dy < 0 ? 1.18 : 1 / 1.18;
    const next = Math.max(10, Math.min(400, Math.round(this._zoom * factor)));
    if (next === this._zoom) return;
    this._zoom = next;
    // Keep `t0` under the cursor: the new scroll position lines up so the
    // sample at t0 sits under the pointer.
    requestAnimationFrame(() => {
      const newPointerX = t0 * this._zoom;
      scroll.scrollLeft = newPointerX - (ev.clientX - bounds.left - HEAD_WIDTH);
      void sr;
    });
  }

  /** Which track does a given lane DOM element belong to? */
  _trackIdForLane(laneEl) {
    const tracks = this.session?.tracks || [];
    const lanes = this.renderRoot.querySelectorAll(".lane");
    const idx = Array.prototype.indexOf.call(lanes, laneEl);
    return idx >= 0 ? tracks[idx]?.id : null;
  }

  _regionContextMenu(ev, region) {
    ev.preventDefault();
    ev.stopPropagation();
    showContextMenu(ev, [
      { heading: region.name || region.id },
      {
        label: region.muted ? "Unmute" : "Mute",
        icon: region.muted ? "speaker-wave" : "speaker-x-mark",
        action: () => window.__foyer?.ws?.send({
          type: "update_region",
          id: region.id,
          patch: { muted: !region.muted },
        }),
      },
      { separator: true },
      {
        label: "Delete region",
        icon: "trash",
        tone: "danger",
        action: () => window.__foyer?.ws?.send({ type: "delete_region", id: region.id }),
      },
    ]);
  }

  _startLaneResize(ev, trackId) {
    ev.preventDefault();
    ev.stopPropagation();
    const start = ev.clientY;
    const h0 = this._laneHeightFor(trackId);
    const move = (e) => {
      const dy = e.clientY - start;
      const h = Math.max(LANE_HEIGHT_MIN, Math.min(LANE_HEIGHT_MAX, h0 + dy));
      this._laneHeights = { ...this._laneHeights, [trackId]: h };
      this.requestUpdate();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._saveLaneHeights();
      this._repaintWaveforms();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _repaintWaveforms() {
    const canvases = this.renderRoot.querySelectorAll(".region canvas");
    const spp = this._samplesPerPx();
    for (const c of canvases) {
      const regionEl = c.parentElement;
      const id = regionEl?.dataset.id;
      if (!id) continue;
      const rect = c.getBoundingClientRect();
      if (rect.width > 0 && c.width !== Math.round(rect.width)) c.width = Math.round(rect.width);
      const peaks = this._wfCache?.ensure(id, spp);
      drawPeaks(c, peaks, "#c4b5fd");
    }
  }

  _seekFromRuler(ev) {
    // Suppress the seek if the click came out of a middle/right-button pan.
    if (this._rulerPanSwallowClick) { this._rulerPanSwallowClick = false; return; }
    const rulerRect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rulerRect.left - HEAD_WIDTH;
    if (x < 0) return;
    const sr = this._timeline?.sample_rate || 48_000;
    const samples = Math.max(0, Math.round((x / this._zoom) * sr));
    this._playheadSamples = samples;
    window.__foyer?.ws?.controlSet("transport.position", samples);
  }

  /**
   * Wheel over the ruler scrolls horizontally instead of zooming — the
   * ruler is a navigation surface, the waveforms underneath are for zoom.
   * Vertical wheel delta translates to horizontal scroll; any native
   * horizontal delta (from trackpads) is honored too. Stop propagation so
   * the outer `.scroll` wheel handler doesn't also zoom.
   */
  _onRulerWheel(ev) {
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return;
    ev.preventDefault();
    ev.stopPropagation();
    const dx = ev.deltaX || 0;
    const dy = ev.deltaY || 0;
    // Shift on trackpads already yields deltaX; on mice it flips the axis
    // too. Either way the right answer is "combine the axes and scroll."
    scroll.scrollLeft += (Math.abs(dx) > Math.abs(dy) ? dx : dy);
  }

  /**
   * Middle-click (button 1) or right-click (button 2) on the ruler starts
   * a scrub-pan of the view. Left-click still seeks via `@click`. We flag
   * `_rulerPanSwallowClick` on drag so the click-seek fires only for true
   * clicks, not at the end of a pan-drag.
   */
  _onRulerPointerDown(ev) {
    if (ev.button !== 1 && ev.button !== 2) return;
    const scroll = this.renderRoot.querySelector(".scroll");
    if (!scroll) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const origScroll = scroll.scrollLeft;
    let moved = false;
    const target = ev.currentTarget;
    try { target.setPointerCapture?.(ev.pointerId); } catch {}
    const prevCursor = target.style.cursor;
    target.style.cursor = "grabbing";
    const move = (e) => {
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      scroll.scrollLeft = origScroll - dx;
    };
    const up = () => {
      target.style.cursor = prevCursor;
      try { target.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved && ev.button === 0) this._rulerPanSwallowClick = true;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _startDrag(ev, region, mode) {
    ev.preventDefault();
    ev.stopPropagation();
    const el = this.renderRoot.querySelector(`.region[data-id="${region.id}"]`);
    el?.classList.add("dragging");
    const sr = this._timeline?.sample_rate || 48_000;
    const startX = ev.clientX;
    const origStart = region.start_samples;
    const origLen = region.length_samples;
    const pxPerSec = this._zoom;
    let lastSent = 0;

    const move = (e) => {
      const dxPx = e.clientX - startX;
      const dxSamples = Math.round((dxPx / pxPerSec) * sr);
      let patch = null;
      const preview = { ...region };
      if (mode === "move") {
        preview.start_samples = Math.max(0, origStart + dxSamples);
        patch = { start_samples: preview.start_samples };
      } else if (mode === "resize-right") {
        preview.length_samples = Math.max(4800, origLen + dxSamples);
        patch = { length_samples: preview.length_samples };
      } else if (mode === "resize-left") {
        const newStart = Math.max(0, origStart + dxSamples);
        const newLen = Math.max(4800, origLen - (newStart - origStart));
        preview.start_samples = newStart;
        preview.length_samples = newLen;
        patch = { start_samples: newStart, length_samples: newLen };
      }
      this._patchRegionLocally(preview);
      const now = performance.now();
      if (now - lastSent > 80) {
        lastSent = now;
        window.__foyer?.ws?.send({ type: "update_region", id: region.id, patch });
      }
    };
    const up = () => {
      el?.classList.remove("dragging");
      const r = this._regionForId(region.id);
      if (r) {
        window.__foyer?.ws?.send({
          type: "update_region",
          id: r.id,
          patch: { start_samples: r.start_samples, length_samples: r.length_samples },
        });
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _regionForId(id) {
    for (const list of Object.values(this._regionsByTrack)) {
      const f = list.find(r => r.id === id);
      if (f) return f;
    }
    return null;
  }

  _patchRegionLocally(region) {
    const list = this._regionsByTrack[region.track_id];
    if (!list) return;
    const idx = list.findIndex(r => r.id === region.id);
    if (idx < 0) return;
    const copy = list.slice();
    copy[idx] = region;
    this._regionsByTrack = { ...this._regionsByTrack, [region.track_id]: copy };
  }

  _clearCache() {
    this._wfCache?.invalidate?.("");
    window.__foyer?.ws?.send({ type: "clear_waveform_cache" });
  }
}
customElements.define("foyer-timeline-view", TimelineView);
