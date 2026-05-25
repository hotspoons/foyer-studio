// Sprunki music-theory primitives.
//
// The "no wrong notes" promise relies on every tonal note being
// stored as a *relative* spec (scale-degree or chord-tone), not as an
// absolute MIDI pitch. This module owns the resolution from spec ×
// (key, chord) → MIDI pitch so the rest of the sprunki UI doesn't
// have to know what semitone count "the third of an F minor chord"
// works out to.
//
// Drums are exempt — their `pitch` is a GM percussion pitch
// (kick=36, snare=38, …) and stays absolute regardless of key/chord.
// We only run resolution for `mode === "pitched"` rows.

// ── Keys / scales ────────────────────────────────────────────────

/** Semitone offsets from the key root for each scale degree.
 *  Indexed by mode then by degree (1-based externally; we expose
 *  helpers that take 1-7). */
const MODE_INTERVALS = {
  // Ionian / major: 2-2-1-2-2-2-1
  major:    [0, 2, 4, 5, 7, 9, 11],
  // Aeolian / natural minor: 2-1-2-2-1-2-2
  minor:    [0, 2, 3, 5, 7, 8, 10],
  // Dorian — minor with raised 6, gives "Scarborough Fair" vibes.
  dorian:   [0, 2, 3, 5, 7, 9, 10],
  // Mixolydian — major with flat 7, "Sweet Home Alabama" vibes.
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** Roman-numeral → (degree, quality) lookup. Convention:
 *    upper-case  = major triad on that scale degree
 *    lower-case  = minor triad
 *    suffix "°"  = diminished (we accept "dim" too)
 *    suffix "7"  = dominant 7
 *    suffix "maj7" = major 7
 *  Used by the chord strip when the user picks "I-V-vi-IV". */
const NUMERAL_RE = /^(b|#)?([ivIV]+)(°|dim|maj7|m7|7)?$/;

/** Pitch-class names for display + dropdowns. */
export const KEY_ROOTS = [
  { id: "C",  label: "C",  semitones_from_c: 0 },
  { id: "Db", label: "D♭", semitones_from_c: 1 },
  { id: "D",  label: "D",  semitones_from_c: 2 },
  { id: "Eb", label: "E♭", semitones_from_c: 3 },
  { id: "E",  label: "E",  semitones_from_c: 4 },
  { id: "F",  label: "F",  semitones_from_c: 5 },
  { id: "Gb", label: "G♭", semitones_from_c: 6 },
  { id: "G",  label: "G",  semitones_from_c: 7 },
  { id: "Ab", label: "A♭", semitones_from_c: 8 },
  { id: "A",  label: "A",  semitones_from_c: 9 },
  { id: "Bb", label: "B♭", semitones_from_c: 10 },
  { id: "B",  label: "B",  semitones_from_c: 11 },
];

export const MODES = [
  { id: "major",      label: "Major (happy)" },
  { id: "minor",      label: "Minor (sad)" },
  { id: "dorian",     label: "Dorian (mysterious)" },
  { id: "mixolydian", label: "Mixolydian (bluesy)" },
];

/** MIDI middle-C = 60, so the root pitch for key K is `60 +
 *  semitones_from_c(K)`. We anchor every relative spec to this
 *  octave and let the spec's own `octave_offset` push it up/down. */
const KEY_ROOT_MIDI = 60;

// ── Chord qualities ───────────────────────────────────────────────

/** Interval stack (semitones from chord root) for each quality. */
const QUALITY_INTERVALS = {
  major:    [0, 4, 7],
  minor:    [0, 3, 7],
  dim:      [0, 3, 6],
  aug:      [0, 4, 8],
  dom7:     [0, 4, 7, 10],
  maj7:     [0, 4, 7, 11],
  min7:     [0, 3, 7, 10],
  sus2:     [0, 2, 7],
  sus4:     [0, 5, 7],
};

/** Diatonic chord quality at each scale degree of each mode.
 *  Drives "auto-build the I-V-vi-IV in the current key" so the
 *  user doesn't have to know that the vi of C major is A minor. */
const DIATONIC_QUALITIES = {
  major:    ["major", "minor", "minor", "major", "major", "minor", "dim"],
  minor:    ["minor", "dim",   "major", "minor", "minor", "major", "major"],
  dorian:   ["minor", "minor", "major", "major", "minor", "dim",   "major"],
  mixolydian: ["major", "minor", "dim",  "major", "minor", "minor", "major"],
};

/** Common progression presets the chord strip can offer the user.
 *  Stored as 0-based scale degrees + an optional quality override
 *  (a `null` quality means "use whatever the mode says"). */
export const PROGRESSIONS = [
  { id: "I-V-vi-IV",  label: "Pop (I–V–vi–IV)",       degrees: [0, 4, 5, 3] },
  { id: "I-IV-V-I",   label: "Classic (I–IV–V–I)",    degrees: [0, 3, 4, 0] },
  { id: "vi-IV-I-V",  label: "Sad pop (vi–IV–I–V)",   degrees: [5, 3, 0, 4] },
  { id: "i-VI-III-VII", label: "Epic minor (i–VI–III–VII)", degrees: [0, 5, 2, 6] },
  { id: "ii-V-I",     label: "Jazz turnaround (ii–V–I–I)", degrees: [1, 4, 0, 0] },
  { id: "static-I",   label: "Drone on I",            degrees: [0, 0, 0, 0] },
];

// ── Public API ────────────────────────────────────────────────────

/**
 * @typedef {object} Key
 * @property {string} root   — id from KEY_ROOTS (e.g. "C", "Eb")
 * @property {string} mode   — id from MODES
 */

/**
 * @typedef {object} Chord
 * @property {number} degree   — 0..6, scale degree the chord is built on
 * @property {string} [quality]— "major" | "minor" | "dim" | … overrides diatonic
 */

/**
 * @typedef {object} NoteSpec  — One row in a sprunki "patch". The
 *   resolver below turns this into a MIDI pitch given live key+chord.
 *
 * Exactly one of `scale_degree` / `chord_tone` is set; both blank
 * means "rest" (caller is responsible for skipping those).
 *
 * @property {number} [scale_degree]   — 0..6, relative to the key
 * @property {"root"|"third"|"fifth"|"seventh"} [chord_tone]
 * @property {number} [octave_offset]  — integer octave shift (default 0)
 */

/** Build the four-chord progression for `progressionId` in the
 *  given key. Returns Chord[] of length 4 with diatonic qualities
 *  inferred from the mode. */
export function buildProgression(progressionId, key) {
  const def = PROGRESSIONS.find((p) => p.id === progressionId)
            ?? PROGRESSIONS[0];
  const qualities = DIATONIC_QUALITIES[key.mode] || DIATONIC_QUALITIES.major;
  return def.degrees.map((degree) => ({
    degree,
    quality: qualities[degree] || "major",
  }));
}

/** Convert a chord at scale-degree D in key K to its root MIDI pitch
 *  (in the anchor octave). */
function chordRootMidi(chord, key) {
  const keyRoot = (KEY_ROOTS.find((k) => k.id === key.root)
                   ?? KEY_ROOTS[0]).semitones_from_c;
  const intervals = MODE_INTERVALS[key.mode] || MODE_INTERVALS.major;
  return KEY_ROOT_MIDI + keyRoot + (intervals[chord.degree] ?? 0);
}

/** Resolve a NoteSpec to a MIDI pitch in [0..127], clamped.
 *  Drums (`mode === "drum"`) bypass this entirely — pass them
 *  through with their absolute pitch. */
export function resolveNote(spec, key, chord) {
  const oct = (spec.octave_offset ?? 0) * 12;
  // chord_tone wins when both are present — chord tones are the
  // safest "always sounds right" anchor.
  if (spec.chord_tone) {
    const root = chordRootMidi(chord, key);
    const stack = QUALITY_INTERVALS[chord.quality] || QUALITY_INTERVALS.major;
    const idx = { root: 0, third: 1, fifth: 2, seventh: 3 }[spec.chord_tone] ?? 0;
    const interval = stack[Math.min(idx, stack.length - 1)] ?? 0;
    return clamp(root + interval + oct);
  }
  if (typeof spec.scale_degree === "number") {
    const keyRoot = (KEY_ROOTS.find((k) => k.id === key.root)
                     ?? KEY_ROOTS[0]).semitones_from_c;
    const intervals = MODE_INTERVALS[key.mode] || MODE_INTERVALS.major;
    const interval = intervals[spec.scale_degree % 7] ?? 0;
    const wrap = Math.floor(spec.scale_degree / 7) * 12;
    return clamp(KEY_ROOT_MIDI + keyRoot + interval + wrap + oct);
  }
  // Neither field — caller passed garbage. Return middle C and let
  // the operator notice.
  console.warn("[sprunki-theory] noteSpec without scale_degree or chord_tone:", spec);
  return KEY_ROOT_MIDI;
}

/** Human-readable label for a chord — used by the chord strip's
 *  pill text. `C`, `Am`, `G7`, `Bdim`, etc. */
export function labelChord(chord, key) {
  const intervals = MODE_INTERVALS[key.mode] || MODE_INTERVALS.major;
  const keyRoot = (KEY_ROOTS.find((k) => k.id === key.root)
                   ?? KEY_ROOTS[0]).semitones_from_c;
  const pc = (keyRoot + (intervals[chord.degree] ?? 0)) % 12;
  // Spell using the key's natural accidental flavour so a key of
  // E♭ doesn't show G♯ when we mean A♭.
  const usesFlats = key.root.endsWith("b") || key.mode === "minor";
  const SHARP = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
  const FLAT  = ["C","D♭","D","E♭","E","F","G♭","G","A♭","A","B♭","B"];
  const name = (usesFlats ? FLAT : SHARP)[pc];
  const suffix = chord.quality === "minor"  ? "m"
              : chord.quality === "dim"    ? "°"
              : chord.quality === "aug"    ? "+"
              : chord.quality === "dom7"   ? "7"
              : chord.quality === "maj7"   ? "M7"
              : chord.quality === "min7"   ? "m7"
              : chord.quality === "sus2"   ? "sus2"
              : chord.quality === "sus4"   ? "sus4"
              : "";
  return `${name}${suffix}`;
}

function clamp(midi) {
  return Math.max(0, Math.min(127, Math.round(midi)));
}
