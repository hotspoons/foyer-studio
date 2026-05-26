// Sprunki shared constants — patterns / step grid / GM presets.
//
// The richer "characters + categories" model that used to live
// here was retired when the variant moved to a *patch* model
// (see `patches.js` + `docs/SPRUNKADOO_VISION.md`). This file now
// just holds the grid + section constants that the sequencer
// math depends on and a curated list of GM programs for the
// per-patch instrument picker.

/** Bars per pattern. OG sprunki runs continuous multi-bar loops
 *  (their canonical run is 8 bars long); we approximate with each
 *  section being 4 bars, so the four-section arrangement is 16
 *  bars total. The kid still authors at the sixteenth-note grain
 *  inside a section — there are just four bars' worth of grain
 *  visible in the detail editor now instead of one. */
export const BARS_PER_PATTERN = 4;

/** Pattern tabs the player switches between. Each pattern lives at
 *  its own bar offset in the arrangement (Intro=0, Verse=4, …). */
export const DEFAULT_PATTERNS = [
  { id: "intro",  name: "Intro",  color: "#6c5ce7", bar: 0 },
  { id: "verse",  name: "Verse",  color: "#00b894", bar: BARS_PER_PATTERN },
  { id: "chorus", name: "Chorus", color: "#e17055", bar: BARS_PER_PATTERN * 2 },
  { id: "drop",   name: "Drop",   color: "#fd79a8", bar: BARS_PER_PATTERN * 3 },
];

/** Beat-grid constants. 16 sixteenth-notes per bar; one pattern
 *  spans `BARS_PER_PATTERN` bars so each pattern is 64 steps long. */
export const STEPS_PER_BAR = 16;
export const STEPS_PER_PATTERN = STEPS_PER_BAR * BARS_PER_PATTERN;
export const DEFAULT_BPM = 120;
export const DEFAULT_RESOLUTION = 4;

/** Curated GM program presets surfaced in the preferences modal.
 *  Useful when the user wants to swap a patch's instrument without
 *  authoring a whole new patch — e.g. "make this synth-bass tile
 *  sound like an upright bass." Picker still allows a raw 0..127
 *  entry as an escape hatch. */
export const GM_PRESETS = {
  drums: [
    { program: 0,  label: "Standard Kit" },
  ],
  bass: [
    { program: 32, label: "Acoustic Bass" },
    { program: 33, label: "Electric Bass (finger)" },
    { program: 34, label: "Electric Bass (pick)" },
    { program: 35, label: "Fretless Bass" },
    { program: 36, label: "Slap Bass 1" },
    { program: 38, label: "Synth Bass 1" },
    { program: 39, label: "Synth Bass 2" },
  ],
  chords: [
    { program: 0,  label: "Acoustic Grand" },
    { program: 4,  label: "Electric Piano 1" },
    { program: 16, label: "Drawbar Organ" },
    { program: 88, label: "Pad 1 (new age)" },
    { program: 89, label: "Pad 2 (warm)" },
    { program: 90, label: "Pad 3 (polysynth)" },
    { program: 91, label: "Pad 4 (choir)" },
  ],
  lead: [
    { program: 24, label: "Acoustic Guitar (nylon)" },
    { program: 27, label: "Electric Guitar (clean)" },
    { program: 56, label: "Trumpet" },
    { program: 65, label: "Alto Sax" },
    { program: 80, label: "Lead 1 (square)" },
    { program: 81, label: "Lead 2 (sawtooth)" },
    { program: 84, label: "Lead 5 (charang)" },
  ],
  fx: [
    { program: 96, label: "FX 1 (rain)" },
    { program: 97, label: "FX 2 (soundtrack)" },
    { program: 98, label: "FX 3 (crystal)" },
    { program: 99, label: "FX 4 (atmosphere)" },
    { program: 100, label: "FX 5 (brightness)" },
    { program: 102, label: "FX 7 (echoes)" },
    { program: 126, label: "Applause" },
  ],
};
