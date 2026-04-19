// Parameter scale + formatting helpers.
//
// Every rendering widget works in normalized [0..1] "UI space" so drag math,
// knob angle, fader height all share one contract. The scale helpers convert
// to/from the parameter's native unit (dB, Hz, linear, log).
//
// These are pure functions; no Lit imports. Import them from knob.js,
// param-control.js, fader math, etc.

/** Clamp `v` to `[lo, hi]`. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize raw `v` in `[min,max]` to UI-space `[0,1]` for the given scale. */
export function toNorm(v, range, scale) {
  if (!range) return clamp(Number(v) || 0, 0, 1);
  const [lo, hi] = range;
  if (hi === lo) return 0;
  const x = clamp(v, lo, hi);
  switch (scale) {
    case "logarithmic":
    case "hertz": {
      const loL = Math.log(Math.max(lo, 1e-6));
      const hiL = Math.log(Math.max(hi, 1e-6));
      return (Math.log(Math.max(x, 1e-6)) - loL) / (hiL - loL);
    }
    case "decibels": {
      // Approximate audio-fader-style curve: -60..+6 dB, we place -20 dB
      // near 40% travel to keep the useful range in the middle.
      const norm = (x - lo) / (hi - lo);
      const shaped = Math.pow(norm, 1 / 1.8);
      return clamp(shaped, 0, 1);
    }
    case "linear":
    default:
      return (x - lo) / (hi - lo);
  }
}

/** Inverse of `toNorm`: UI-space `[0,1]` back to raw native value. */
export function fromNorm(n, range, scale) {
  n = clamp(n, 0, 1);
  if (!range) return n;
  const [lo, hi] = range;
  switch (scale) {
    case "logarithmic":
    case "hertz": {
      const loL = Math.log(Math.max(lo, 1e-6));
      const hiL = Math.log(Math.max(hi, 1e-6));
      return Math.exp(loL + (hiL - loL) * n);
    }
    case "decibels": {
      const shaped = Math.pow(n, 1.8);
      return lo + (hi - lo) * shaped;
    }
    case "linear":
    default:
      return lo + (hi - lo) * n;
  }
}

/** Pretty-print a numeric value with its unit, chosen for the scale. */
export function formatValue(v, unit, scale) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  let s;
  switch (scale) {
    case "hertz": {
      if (Math.abs(n) >= 1000) s = (n / 1000).toFixed(2) + "k";
      else s = n.toFixed(0);
      break;
    }
    case "decibels": {
      s = n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
      break;
    }
    case "logarithmic": {
      if (Math.abs(n) >= 10) s = n.toFixed(1);
      else if (Math.abs(n) >= 1) s = n.toFixed(2);
      else s = n.toFixed(3);
      break;
    }
    default: {
      if (Math.abs(n) >= 100) s = n.toFixed(0);
      else if (Math.abs(n) >= 10) s = n.toFixed(1);
      else s = n.toFixed(2);
    }
  }
  return unit ? `${s} ${unit}` : s;
}

/** Default display value when a raw value isn't provided (e.g. meters pre-seed). */
export function defaultForParam(param) {
  if (!param) return 0;
  if (param.kind === "trigger") return false;
  if (param.kind === "enum") return 0;
  const rng = param.range;
  if (rng) return (rng[0] + rng[1]) * 0.5;
  return 0;
}

/** Coerce a raw value from the wire to what the widget expects. */
export function coerceValue(raw, kind) {
  if (raw === undefined || raw === null) return undefined;
  switch (kind) {
    case "trigger":
      return !!raw;
    case "enum":
    case "discrete":
      return typeof raw === "number" ? raw : Number(raw) || 0;
    case "text":
      return String(raw);
    default:
      return typeof raw === "number" ? raw : Number(raw) || 0;
  }
}
