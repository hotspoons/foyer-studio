// Mixer density presets. Each preset is a bag of sizing + visibility knobs
// that the mixer + track-strip components read; pure data, no DOM.
//
// Width-lock mode:
//   "relative": strips flex to fill the mixer's container (width scales)
//   "absolute": every strip is exactly `trackWidth` px; mixer horizontally
//   scrolls if it overflows. Matches the "hold widths through resize"
//   workflow pro mixers want on bigger consoles.

export const DENSITIES = {
  wide: {
    label: "Wide",
    trackWidth: 120,
    plugins: true,
    pluginsLines: 5,
    sendsLines: 2,
    meterWidth: 10,
    showKind: true,
    showColorBar: true,
    labelSize: 12,
  },
  normal: {
    label: "Normal",
    trackWidth: 92,
    plugins: true,
    pluginsLines: 3,
    sendsLines: 0,
    meterWidth: 8,
    showKind: true,
    showColorBar: true,
    labelSize: 11,
  },
  compact: {
    label: "Compact",
    trackWidth: 58,
    plugins: false,
    pluginsLines: 0,
    sendsLines: 0,
    meterWidth: 6,
    showKind: false,
    showColorBar: true,
    labelSize: 10,
  },
  narrow: {
    label: "Narrow",
    trackWidth: 36,
    plugins: false,
    pluginsLines: 0,
    sendsLines: 0,
    meterWidth: 4,
    showKind: false,
    showColorBar: false,
    labelSize: 9,
  },
};

const KEY = "foyer.mixer.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  density: "normal",
  widthMode: "relative", // "relative" | "absolute"
  /** per-track-id absolute width override (only honored when widthMode=absolute). */
  widthOverrides: {},
});

export function loadMixerSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveMixerSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
