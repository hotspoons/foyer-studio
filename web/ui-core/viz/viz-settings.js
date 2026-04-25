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

// MIDI-strip themes — independent from waveforms since MIDI regions
// are a different visual primitive (notes as horizontal bars, no
// sample peaks). Each theme maps to a color the timeline's
// `<foyer-midi-strip>` uses for its note rectangles.
export const MIDI_PALETTES_ORDER = [
  "violet", "mint", "amber", "coral", "steel", "match",
];
const MIDI_PALETTE_LABELS = {
  violet: "Violet",
  mint:   "Mint",
  amber:  "Amber",
  coral:  "Coral",
  steel:  "Steel",
  match:  "Match track color",
};
export const MIDI_PALETTES_RAW = {
  violet: { note: "#c4b5fd" },
  mint:   { note: "#6ee7b7" },
  amber:  { note: "#fcd34d" },
  coral:  { note: "#fda4af" },
  steel:  { note: "#cbd5e1" },
  // Special sentinel — `foyer-midi-strip` falls back to `track.color`
  // if set, otherwise the default violet.
  match:  { note: null },
};
export const MIDI_PALETTES = Object.fromEntries(
  MIDI_PALETTES_ORDER.map((id) => [id, {
    label: MIDI_PALETTE_LABELS[id] || id,
    ...MIDI_PALETTES_RAW[id],
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

  /** Named palette from MIDI_PALETTES for the timeline's inline MIDI
   *  strip. "match" follows the track's own color; everything else
   *  pins a fixed color. */
  midiPalette: "match",
  /** Velocity shading on MIDI note bars (0..1 alpha multiplier on the
   *  velocity-driven component). 0 = flat color, 1 = full dynamic range. */
  midiVelocityShading: 0.6,

  /** Color of the timeline's seconds-tick gridlines (`.lane-gridlines .gl`).
   *  Distinct from the BPM-quantized grid below so the user can tell them
   *  apart at a glance. (Rich, 2026-04-26.) */
  timeGridColor:    "#3a3a44",
  /** Alpha (0..1) applied to `timeGridColor`. Lets users dim the grid
   *  without losing the hue choice. */
  timeGridAlpha:    1.0,
  /** Color of the BPM-quantized grid overlay (`.quant-line`). Defaults to
   *  a saturated accent so it reads as a different layer from the seconds
   *  grid. */
  quantGridColor:   "#7c5cff",
  /** Alpha (0..1) applied to `quantGridColor`. */
  quantGridAlpha:   0.5,
});

/** Resolve the current MIDI note color, falling through to `trackColor`
 *  when the "match" palette is active and a track color exists. */
export function resolveMidiNoteColor(trackColor) {
  const name = read().midiPalette || "match";
  const pal = MIDI_PALETTES[name];
  if (pal?.note) return pal.note;
  if (trackColor) return trackColor;
  return MIDI_PALETTES.violet.note;
}

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
