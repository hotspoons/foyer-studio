// <foyer-waveform-gl> — vector waveform renderer with
// viewport-cropped canvas.
//
// ── Algorithm provenance ────────────────────────────────────────
//
// The connected-line drawing routine (_draw) is a direct port of
// Ardour's WaveView, which is what the Ardour DAW uses for every
// waveform in its Editor canvas. Source:
//
//   Ardour — libs/waveview/wave_view.cc :: WaveView::draw_image,
//   specifically the per-peak loop at lines 684-702 (as of Ardour
//   9.2). https://github.com/Ardour/ardour/blob/master/libs/waveview/wave_view.cc
//   Licensed GPLv2+.
//
// That loop's contract: for each pixel column i, inspect tips[i]
// (this column's min/max in pixel space) vs. tips[i+1] and either:
//
//   · draw a vertical 1-px stroke from tips[i].top to tips[i].bot
//     (overlapping ranges — the signal stayed loud); or
//   · draw a diagonal 1-px stroke from tips[i].bot to tips[i+1].bot
//     if the signal fell smoothly; or
//   · draw a diagonal stroke from tips[i].top to tips[i+1].top if
//     the signal rose smoothly.
//
// The "connected segment" cases are what make the waveform look
// continuous at any zoom instead of a series of disconnected bars.
// Reference: https://lac.linuxaudio.org/2013/papers/36.pdf (Fig 3).
//
// We only port the algorithm, not any Ardour code or headers — the
// drawing loop below implements the same decision rules in plain
// JS and Canvas2D, which keeps the GPL boundary where it already
// is (the shim), not in the web app.
//
// ── Viewport cropping ───────────────────────────────────────────
//
// A secondary trick: the component listens to scroll on its nearest
// scrollable ancestor and sizes its own canvas to match the visible
// intersection, positioned via absolute CSS. At 4000 px/s zoom
// across a 30s region the region div is 120000 px wide — far past
// any browser's MAX_CANVAS_SIZE cap (typically 16k). Cropping to
// the viewport keeps the backing store tiny and every pixel column
// sample-accurate. Canvas2D's path-stroke is vector-rendered on
// GPU-backed backends (Skia in Chrome/Firefox), so the "we have
// GPUs, use them" bar is met.

import { LitElement, html, css } from "lit";
import { getVizPrefs, resolvePalette } from "./viz-settings.js";

export class WaveformGl extends LitElement {
  static properties = {
    peaks: { attribute: false },
    underrunMask: { attribute: false },
    bg: { type: String },
  };

  static styles = css`
    :host {
      display: block;
      position: absolute;
      inset: 0;
      /* inset:0 defaults the canvas to the region's full extent;
       * _updateViewport overrides left + width inline to the
       * visible slice. */
    }
    canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
  `;

  constructor() {
    super();
    this.peaks = null;
    this.underrunMask = null;
    this.bg = "transparent";
    this._prefs = getVizPrefs();
    this._prefsHandler = () => { this._prefs = getVizPrefs(); this._draw(); };
    this._scrollHandler = () => this._onScroll();
    this._scrollParent = null;
    // Range of the source-region's pixel span that's on-screen right
    // now, relative to the region div's left edge. Updated on scroll.
    this._visibleLeft = 0;
    this._visibleWidth = 0;
    this._regionWidth = 0;
    this._rafPending = false;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("foyer:viz-prefs-changed", this._prefsHandler);
  }
  disconnectedCallback() {
    window.removeEventListener("foyer:viz-prefs-changed", this._prefsHandler);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unhookScroll();
    super.disconnectedCallback();
  }

  firstUpdated() {
    this._hookScroll();
    this._updateViewport();
    this._draw();
    const host = this;
    if ("ResizeObserver" in window) {
      this._resizeObserver = new ResizeObserver(() => {
        this._updateViewport();
        this._draw();
      });
      this._resizeObserver.observe(host);
      const region = host.parentElement;
      if (region) this._resizeObserver.observe(region);
    }
    requestAnimationFrame(() => { this._updateViewport(); this._draw(); });
  }

  updated() {
    this._updateViewport();
    this._draw();
  }

  /** Force setter used by the timeline cache when the peaks object
   *  reference is unchanged. */
  setPeaks(peaks) {
    this.peaks = peaks;
    this._updateViewport();
    this._draw();
  }

  _hookScroll() {
    // Walk up the composed tree for the nearest scrollable ancestor.
    // For our embed inside <foyer-timeline-view>'s `.scroll` div we
    // need to pierce the timeline's shadow root — `getRootNode()`
    // then `.host.parentNode` gets us across.
    let node = this.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      const overflowX = style.overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        this._scrollParent = node;
        break;
      }
      if (node.parentElement) {
        node = node.parentElement;
      } else {
        const root = node.getRootNode?.();
        node = root && root.host ? root.host : null;
      }
    }
    if (this._scrollParent) {
      this._scrollParent.addEventListener("scroll", this._scrollHandler, { passive: true });
    }
  }
  _unhookScroll() {
    if (this._scrollParent) {
      this._scrollParent.removeEventListener("scroll", this._scrollHandler);
      this._scrollParent = null;
    }
  }

  _onScroll() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._updateViewport();
      this._draw();
    });
  }

  /** Compute the visible slice of our host div in its own pixel
   *  frame. Returns { left, width } in CSS px. */
  _updateViewport() {
    const region = this.parentElement;
    if (!region) return;
    const regionRect = region.getBoundingClientRect();
    this._regionWidth = regionRect.width;

    const sp = this._scrollParent;
    if (!sp || regionRect.width < 1) {
      this._visibleLeft = 0;
      this._visibleWidth = Math.max(0, regionRect.width);
    } else {
      const spRect = sp.getBoundingClientRect();
      // Visible window in page-space.
      const visLeftPage = Math.max(regionRect.left, spRect.left);
      const visRightPage = Math.min(regionRect.right, spRect.right);
      const visWidthPage = Math.max(0, visRightPage - visLeftPage);
      // Translate to region-local space.
      this._visibleLeft = Math.max(0, visLeftPage - regionRect.left);
      this._visibleWidth = visWidthPage;
    }

    // Position the host over the visible slice.
    this.style.left = `${this._visibleLeft}px`;
    this.style.right = "auto";
    this.style.width = `${this._visibleWidth}px`;
  }

  _sizeBackingStore(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Host is now sized to the visible slice; clientWidth is clamped
    // to ≤ the scroll container's width, so MAX_CANVAS is never a
    // concern at any zoom.
    const wCss = this._visibleWidth || canvas.clientWidth || 1;
    const hCss = canvas.clientHeight || canvas.parentElement?.clientHeight || 1;
    const w = Math.max(1, Math.floor(wCss * dpr));
    const h = Math.max(1, Math.floor(hCss * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, dpr };
  }

  _draw() {
    const canvas = this.renderRoot?.querySelector?.("canvas");
    if (!canvas) return;
    const { w, h, dpr } = this._sizeBackingStore(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks || !this.peaks.bucket_count || !this.peaks.peaks?.length) return;
    if (w < 2 || h < 2) return;
    if (!this._regionWidth || this._regionWidth < 1) return;

    const palette = resolvePalette();
    const clipTh = this._prefs.clipThreshold || 0.99;

    const buckets = this.peaks.bucket_count;
    const src = this.peaks.peaks;

    // Source-bucket range that corresponds to the visible slice. The
    // peaks array spans the WHOLE region; pick just the slice we need.
    const uStart = this._visibleLeft / this._regionWidth;
    const uEnd = (this._visibleLeft + this._visibleWidth) / this._regionWidth;
    const bStart = Math.max(0, Math.floor(uStart * buckets));
    const bEnd = Math.min(buckets, Math.ceil(uEnd * buckets));
    const bCount = Math.max(1, bEnd - bStart);

    // n = canvas column count (backing-store px). Resample bCount
    // source buckets into n columns; each column aggregates min/max
    // from the fractional source bucket window that maps to it.
    const n = w;
    const tops = new Float32Array(n);
    const bots = new Float32Array(n);
    const clipMax = new Uint8Array(n);
    const clipMin = new Uint8Array(n);
    const mid = (h - 1) * 0.5;
    const ySpan = h - 1;

    if (bCount >= n) {
      // More source buckets than pixels → downsample via min/max.
      const step = bCount / n;
      for (let x = 0; x < n; x++) {
        const s0 = bStart + Math.floor(x * step);
        const s1 = bStart + Math.min(bCount, Math.ceil((x + 1) * step));
        let lo = Infinity, hi = -Infinity;
        for (let b = s0; b < s1; b++) {
          const mn = src[b * 2] || 0;
          const mx = src[b * 2 + 1] || 0;
          if (mn < lo) lo = mn;
          if (mx > hi) hi = mx;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
        tops[x] = mid - hi * (ySpan * 0.5);
        bots[x] = mid - lo * (ySpan * 0.5);
        if (hi >= clipTh) clipMax[x] = 1;
        if (-lo >= clipTh) clipMin[x] = 1;
      }
    } else {
      // Fewer source buckets than pixels → UPSAMPLE with linear
      // interpolation between (min, max) of adjacent buckets. Each
      // pixel maps to a fractional source-bucket index; mix the
      // bracketing buckets by the fractional part.
      for (let x = 0; x < n; x++) {
        const t = (x / Math.max(1, n - 1)) * Math.max(0, bCount - 1);
        const i = Math.floor(t);
        const f = t - i;
        const ia = Math.min(bCount - 1, i);
        const ib = Math.min(bCount - 1, i + 1);
        const minA = src[(bStart + ia) * 2] || 0;
        const maxA = src[(bStart + ia) * 2 + 1] || 0;
        const minB = src[(bStart + ib) * 2] || 0;
        const maxB = src[(bStart + ib) * 2 + 1] || 0;
        const mn = minA + (minB - minA) * f;
        const mx = maxA + (maxB - maxA) * f;
        tops[x] = mid - mx * (ySpan * 0.5);
        bots[x] = mid - mn * (ySpan * 0.5);
        if (mx >= clipTh) clipMax[x] = 1;
        if (-mn >= clipTh) clipMin[x] = 1;
      }
    }

    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.imageSmoothingEnabled = false;
    ctx.translate(0.5, 0.5);
    ctx.strokeStyle = palette.fill;
    ctx.beginPath();

    // ─── Ardour's connected-segment draw loop ───────────────────
    // Port of libs/waveview/wave_view.cc :: WaveView::draw_image
    // lines 684-702 (Ardour 9.2). Reference paper:
    // https://lac.linuxaudio.org/2013/papers/36.pdf Fig 3.
    for (let i = 0; i < n; i++) {
      const t = tops[i];
      const b = bots[i];
      if (i + 1 >= n) {
        // Last column: just the vertical.
        ctx.moveTo(i, t);
        ctx.lineTo(i, b);
      } else if (t >= bots[i + 1]) {
        // Falling signal — my top is below next bot in pixel Y.
        ctx.moveTo(i - 0.5, b);
        ctx.lineTo(i + 0.5, bots[i + 1]);
      } else if (b <= tops[i + 1]) {
        // Rising signal — my bot is above next top in pixel Y.
        ctx.moveTo(i - 0.5, t);
        ctx.lineTo(i + 0.5, tops[i + 1]);
      } else {
        // Ranges overlap (loud): full vertical span.
        ctx.moveTo(i, t);
        ctx.lineTo(i, b);
      }
    }
    ctx.stroke();

    // Clip markers: small vertical stubs at the top/bottom of clipped columns.
    if (clipMax.some((v) => v) || clipMin.some((v) => v)) {
      const clipHeight = Math.min(7 * dpr, Math.ceil(h * 0.05));
      ctx.strokeStyle = palette.clip;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (clipMax[i]) {
          ctx.moveTo(i, tops[i]);
          ctx.lineTo(i, Math.min(tops[i] + clipHeight, bots[i]));
        }
        if (clipMin[i]) {
          ctx.moveTo(i, bots[i]);
          ctx.lineTo(i, Math.max(bots[i] - clipHeight, tops[i]));
        }
      }
      ctx.stroke();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  render() {
    return html`<canvas></canvas>`;
  }
}
customElements.define("foyer-waveform-gl", WaveformGl);
