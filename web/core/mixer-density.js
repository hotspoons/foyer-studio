// Mixer density presets. Each preset is a bag of sizing + visibility knobs
// that the mixer + track-strip components read; pure data, no DOM.
//
// Width-lock mode:
//   "fill": strips flex to fill the mixer's container (width scales as
//   the window / sidebar resizes).
//   "fixed": every strip is exactly `trackWidth` px; mixer horizontally
//   scrolls if it overflows. Matches the "hold widths through resize"
//   workflow pro mixers want on bigger consoles.
//
// Old persisted values: "relative" / "absolute" are migrated to
// "fill" / "fixed" on load. See `loadMixerSettings` below.

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
    // Keep the plugin strip rendered so the "+" add affordance stays
    // reachable. maxLines=0 means only existing plugins peek through via
    // the "(+N more)" counter and the add button below.
    plugins: true,
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
    plugins: true,
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
  // Default to "fixed": every strip is exactly its density's
  // trackWidth, mixer horizontally scrolls if it overflows. Matches
  // the workflow pro mixers want — strips stay stable across resize
  // instead of squishing as the window or sidebar changes width.
  // Switch to "fill" for fill-the-container behavior.
  widthMode: "fixed", // "fill" | "fixed"
  /** per-track-id pixel width override (only honored when widthMode=fixed). */
  widthOverrides: {},
});

/// Map legacy widthMode values to the current names. Anyone with a
/// saved `relative` / `absolute` setting from before the rename gets
/// silently upgraded next load — no flash of the wrong layout.
function migrateWidthMode(s) {
  if (s?.widthMode === "relative") s.widthMode = "fill";
  else if (s?.widthMode === "absolute") s.widthMode = "fixed";
  return s;
}

export function loadMixerSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    const merged = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    return migrateWidthMode(merged);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveMixerSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
