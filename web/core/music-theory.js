// Shared music-theory helpers — scale interval tables + chord-on-click
// resolution. Used by both `<foyer-midi-editor>` (piano roll) and
// `<foyer-beat-sequencer>` (pitched-mode grid) so the chord-modifier
// behavior is identical across editors.
//
// Pure data + pure functions: no DOM, no Lit, no global state. Safe
// to import from anywhere in the web tree.

/** Scale interval sets in semitones from the root, ordered by how
 *  often we expect users to reach for them. */
export const SCALES = {
  major:           { label: "Major",            iv: [0, 2, 4, 5, 7, 9, 11] },
  minor:           { label: "Minor (natural)",  iv: [0, 2, 3, 5, 7, 8, 10] },
  dorian:          { label: "Dorian",           iv: [0, 2, 3, 5, 7, 9, 10] },
  phrygian:        { label: "Phrygian",         iv: [0, 1, 3, 5, 7, 8, 10] },
  lydian:          { label: "Lydian",           iv: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian:      { label: "Mixolydian",       iv: [0, 2, 4, 5, 7, 9, 10] },
  locrian:         { label: "Locrian",          iv: [0, 1, 3, 5, 6, 8, 10] },
  harmonic_minor:  { label: "Harmonic minor",   iv: [0, 2, 3, 5, 7, 8, 11] },
  melodic_minor:   { label: "Melodic minor",    iv: [0, 2, 3, 5, 7, 9, 11] },
  pentatonic_maj:  { label: "Pentatonic major", iv: [0, 2, 4, 7, 9] },
  pentatonic_min:  { label: "Pentatonic minor", iv: [0, 3, 5, 7, 10] },
  blues:           { label: "Blues",            iv: [0, 3, 5, 6, 7, 10] },
  chromatic:       { label: "Chromatic (off)",  iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const PITCH_CLASS_LABELS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** True if `pitch` (MIDI note number) is in the scale rooted at `root`
 *  (pitch class 0..11) using the named `mode`. */
export function inScale(pitch, root, mode) {
  const set = SCALES[mode]?.iv;
  if (!set) return true;
  const cls = ((pitch - root) % 12 + 12) % 12;
  return set.includes(cls);
}

/**
 * Resolve a list of intervals (semitones above the root) for a chord
 * triggered by a digit key + optional modifiers. The encoding the
 * UI uses:
 *
 *   - digit alone:           diatonic stack-of-thirds within `mode`
 *                            rooted at the clicked pitch.
 *   - Shift + digit:         major-flavored chromatic chord
 *   - Ctrl/Cmd + digit:      minor-flavored chromatic chord
 *   - Ctrl + Shift + digit:  dominant / "third option" (sus4, dim,
 *                            etc. depending on the digit)
 *
 * Returns an array starting with `0` (the root). The clicked pitch
 * is the root; every other note stacks above.
 */
export function chordIntervals(digit, modShift, modCtrl, scaleRoot, scaleMode, rootPitch) {
  const CHROMATIC = {
    3: { major: [0, 4, 7],          minor: [0, 3, 7],          third: [0, 5, 7] },        // sus4
    4: { major: [0, 5, 7],          minor: [0, 3, 5, 7],       third: [0, 5, 7, 10] },    // 7sus4
    5: { major: [0, 7],             minor: [0, 3, 6],          third: [0, 4, 8] },        // pwr / dim / aug
    6: { major: [0, 4, 7, 9],       minor: [0, 3, 7, 9],       third: [0, 4, 7, 9, 14] }, // maj6/min6/6/9
    7: { major: [0, 4, 7, 11],      minor: [0, 3, 7, 10],      third: [0, 4, 7, 10] },    // dom7
    9: { major: [0, 4, 7, 11, 14],  minor: [0, 3, 7, 10, 14],  third: [0, 4, 7, 10, 14] },// dom9
  };
  if (modShift || modCtrl) {
    const tab = CHROMATIC[digit];
    if (!tab) return [0];
    if (modShift && modCtrl) return tab.third || tab.major;
    if (modCtrl) return tab.minor;
    return tab.major;
  }
  // Diatonic — stack thirds within the scale starting at the clicked
  // pitch. Falls back to chromatic major when the scale is off.
  const set = SCALES[scaleMode]?.iv;
  if (!set || scaleMode === "chromatic" || !set.length) {
    return CHROMATIC[digit]?.major || [0];
  }
  const out = [0];
  const rootCls = ((rootPitch - scaleRoot) % 12 + 12) % 12;
  const scaleDegrees = [];
  for (let octave = 0; octave < 3 && scaleDegrees.length < 9; octave++) {
    for (const iv of set) {
      const offset = (iv - rootCls + 12) % 12 + octave * 12;
      if (offset > 0) scaleDegrees.push(offset);
    }
  }
  scaleDegrees.sort((a, b) => a - b);
  // digit gives total chord size (3=triad → 3 notes, so add 2 stacked
  // thirds); cap at 7 notes to avoid runaway high octaves.
  const noteCount = Math.min(7, Math.max(2, Math.floor(digit / 2) + 2));
  for (let i = 0; i < scaleDegrees.length && out.length < noteCount; i += 2) {
    out.push(scaleDegrees[i]);
  }
  return out;
}
