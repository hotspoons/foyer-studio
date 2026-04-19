// Per-tab peak cache, keyed by (region_id, tier). Keeps the promise open
// while a request is in flight so multiple canvases render as soon as the
// same tier lands.
//
// Tiers are powers of two in samples-per-peak (matches the stub backend's
// tier table). The client picks the nearest-tier ≤ requested so cache hits
// line up across slight zoom wobbles.

const TIERS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];
const BUCKET_WIDTH_PX = 1; // one bucket = one px column

export function pickTier(samplesPerPeak) {
  let best = TIERS[0];
  for (const t of TIERS) if (t <= samplesPerPeak) best = t;
  return best;
}

export class WaveformCache extends EventTarget {
  constructor(ws) {
    super();
    this.ws = ws;
    this._peaks = new Map();     // `${id}@${tier}` -> WaveformPeaks
    this._pending = new Map();   // `${id}@${tier}` -> resolver
    this._onEnvelope = (ev) => this._handle(ev.detail);
    ws.addEventListener("envelope", this._onEnvelope);
  }

  dispose() {
    this.ws.removeEventListener("envelope", this._onEnvelope);
  }

  key(regionId, tier) { return `${regionId}@${tier}`; }

  get(regionId, tier) { return this._peaks.get(this.key(regionId, tier)) || null; }

  /**
   * Given a requested zoom (samples per px), request the matching tier if
   * not cached. Returns the *current best tier at or below* the request, or
   * null if nothing's cached yet.
   */
  ensure(regionId, samplesPerPx) {
    const tier = pickTier(Math.max(1, Math.floor(samplesPerPx)));
    const k = this.key(regionId, tier);
    if (this._peaks.has(k)) return this._peaks.get(k);
    if (!this._pending.has(k)) {
      this._pending.set(k, true);
      this.ws.send({ type: "list_waveform", region_id: regionId, samples_per_peak: tier });
    }
    // See if we have any lower-tier cached that we can display while we wait.
    for (const t of TIERS) {
      if (t <= tier) {
        const maybe = this._peaks.get(this.key(regionId, t));
        if (maybe) return maybe;
      }
    }
    return null;
  }

  invalidate(regionId) {
    for (const k of Array.from(this._peaks.keys())) {
      if (k.startsWith(regionId + "@")) this._peaks.delete(k);
    }
  }

  _handle(env) {
    const body = env?.body;
    if (body?.type === "waveform_data") {
      const p = body.peaks;
      const k = this.key(p.region_id, p.samples_per_peak);
      this._peaks.set(k, p);
      this._pending.delete(k);
      this.dispatchEvent(new CustomEvent("update", {
        detail: { regionId: p.region_id, tier: p.samples_per_peak },
      }));
    } else if (body?.type === "region_updated") {
      this.invalidate(body.region.id);
      this.dispatchEvent(new CustomEvent("update", {
        detail: { regionId: body.region.id, tier: null },
      }));
    } else if (body?.type === "waveform_cache_cleared") {
      this._peaks.clear();
      this._pending.clear();
      this.dispatchEvent(new CustomEvent("update", { detail: { regionId: null, tier: null } }));
    }
  }
}

/**
 * Paint peaks into a canvas. Scales peaks to canvas size (resampling if the
 * available tier is coarser than requested). `peaks` is a WaveformPeaks.
 */
export function drawPeaks(canvas, peaks, color = "#c4b5fd") {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!peaks || peaks.bucket_count === 0) return;
  ctx.fillStyle = color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const bucket = Math.floor((x / w) * peaks.bucket_count);
    const min = peaks.peaks[bucket * 2];
    const max = peaks.peaks[bucket * 2 + 1];
    const y0 = mid - max * (h / 2 - 1);
    const y1 = mid - min * (h / 2 - 1);
    ctx.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)));
  }
}

export { BUCKET_WIDTH_PX };
