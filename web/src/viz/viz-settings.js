// User-configurable visualization preferences.
//
// Mirrors the pattern from transport-settings.js — a localStorage-backed
// object with typed getters/setters and a CustomEvent dispatched on
// change so active viz instances can react without polling.
//
// Keep this file pure data: no component imports, no DOM. That lets
// unit tests (and future settings-panel components) import it without
// dragging in the GL renderer.

const KEY = "foyer.viz.prefs.v1";

export const WAVEFORM_STYLE_IDS = ["mirrored", "bar", "ghost"];
export const WAVEFORM_STYLES = {
  mirrored: { label: "Mirrored" },
  bar:      { label: "Bar" },
  ghost:    { label: "Ghost" },
};
export const WAVEFORM_PALETTES_ORDER = ["aurora", "cyan", "magma", "sunset", "chlorophyll", "graphite"];
const PALETTE_LABELS = {
  aurora: "Aurora", cyan: "Cyan", magma: "Magma",
  sunset: "Sunset", chlorophyll: "Chlorophyll", graphite: "Graphite",
};
export const WAVEFORM_PALETTES_RAW = {
  aurora:   { fill: "#a78bfa", edge: "#c4b5fd", clip: "#ef4444", underrun: "#f59e0b" },
  cyan:     { fill: "#22d3ee", edge: "#67e8f9", clip: "#ef4444", underrun: "#f59e0b" },
  magma:    { fill: "#f97316", edge: "#fb923c", clip: "#fde047", underrun: "#f59e0b" },
  sunset:   { fill: "#f472b6", edge: "#fbcfe8", clip: "#ef4444", underrun: "#f59e0b" },
  chlorophyll: { fill: "#34d399", edge: "#6ee7b7", clip: "#ef4444", underrun: "#f59e0b" },
  graphite: { fill: "#e5e7eb", edge: "#ffffff", clip: "#ef4444", underrun: "#f59e0b" },
};
// Labeled map consumed by UI (settings modal, viz picker). Keeps the
// colours and labels aligned — one source of truth.
export const WAVEFORM_PALETTES = Object.fromEntries(
  WAVEFORM_PALETTES_ORDER.map((id) => [id, {
    label: PALETTE_LABELS[id] || id,
    ...WAVEFORM_PALETTES_RAW[id],
  }]),
);

export const DEFAULT_VIZ_PREFS = Object.freeze({
  /** Visual style for waveforms — matches the shader's u_style enum. */
  waveformStyle: "mirrored",
  /** Named palette from WAVEFORM_PALETTES. */
  palette: "aurora",
  /** 0..1 glow multiplier; 0 disables the "energy bloom" effect. */
  glow: 0.25,
  /** 0..1 normalized sample threshold above which a clip marker paints.
   *  At 0.99 ≈ -0.087 dBFS, which is the widely-used "nearly 0 dB"
   *  trigger in most DAWs. */
  clipThreshold: 0.99,
  /** Whether underrun markers are painted (require shim-side underrun
   *  data; until that lands, setting this `true` simply does nothing). */
  showUnderruns: true,
});

function read() {
  try {
    return { ...DEFAULT_VIZ_PREFS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULT_VIZ_PREFS };
  }
}
function write(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
}

export function getVizPrefs() {
  return read();
}

export function getVizPref(key) {
  return read()[key];
}

export function setVizPref(key, value) {
  const prefs = read();
  prefs[key] = value;
  write(prefs);
  window.dispatchEvent(
    new CustomEvent("foyer:viz-prefs-changed", { detail: { key, value } }),
  );
}

export function resolvePalette() {
  const name = getVizPref("palette");
  return WAVEFORM_PALETTES[name] || WAVEFORM_PALETTES.aurora;
}

/** Convert `#rrggbb` to `[r, g, b, a]` floats in 0..1. */
export function hexToRgba(hex, alpha = 1) {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b, alpha];
}
