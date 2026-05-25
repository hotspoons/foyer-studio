// Sprunki sound catalog — characters + per-category instrument defaults.
//
// Each character is a fixed pitch/timbre slot. They group into five
// CATEGORIES (drums / bass / chords / lead / fx), and each category
// owns ONE backend MIDI track + one MIDI region. The region carries
// a sequencer layout whose `rows` are the characters in that
// category and whose `patterns[]` mirrors the four player-visible
// pattern tabs (Intro / Verse / Chorus / Drop).
//
// Why per-category tracks instead of one big track:
//   * Different timbres need different programs (GM drums on ch9
//     with a kit, bass on ch1 with a synth bass, pads with a warm
//     pad, etc.). gmsynth doesn't multitimbral-mix across one
//     channel; separate tracks give each category its own program
//     and its own plugin slot if the user later swaps it out via
//     the preferences modal.
//   * Drum-mode auto-routing on the server side forces ch9 for any
//     `mode: "drum"` layout — that's why the drum track uses drum
//     mode while bass/chords/lead/fx use `pitched` mode.

/**
 * @typedef {object} SprunkiCharacter
 * @property {string} id
 * @property {string} name
 * @property {string} emoji
 * @property {string} color
 * @property {number} pitch        — MIDI pitch (drums: GM-percussion; tonal: any pitch in their idiom)
 * @property {string} category     — one of CATEGORIES[].id
 */

/**
 * @typedef {object} SprunkiCategory
 * @property {string} id
 * @property {string} label
 * @property {string} mode                       — "drum" | "pitched" (sequencer layout mode)
 * @property {string} default_instrument_uri     — backend plugin URI for the synth slot
 * @property {number} default_gm_program         — 0..127 (GM program)
 * @property {number} default_gm_channel         — 0..15 (9 for GM drums)
 * @property {string} track_name                 — backend-visible name (used as create_track key)
 */

/** @type {SprunkiCategory[]} */
export const CATEGORIES = [
  {
    id: "drums",
    label: "Drums",
    mode: "drum",
    // avldrums "Black Pearl" is Ardour's stock sampled drum kit —
    // real recorded shells + cymbals, no SoundFont required, and
    // the GM percussion pitch map (kick=36, snare=38, hat=42, …)
    // is the same one our sound-catalog targets. gmsynth's GM
    // drum patch sounds tinny by comparison; the prefs modal
    // surfaces it as a fallback for environments without
    // avldrums installed.
    default_instrument_uri: "http://gareus.org/oss/lv2/avldrums#BlackPearl",
    /// Try these in order if `default_instrument_uri` doesn't load
    /// — `add_plugin` returns an error event when the URI isn't
    /// in the host's catalog. `setup.js` walks this list and
    /// stops at the first that lands.
    instrument_uri_fallbacks: [
      "http://gareus.org/oss/lv2/avldrums#RedZeppelin",
      "http://drumkv1.sourceforge.net/lv2",
      "urn:ardour:a-fluidsynth",
      "http://gareus.org/oss/lv2/gmsynth",
    ],
    default_gm_program: 0,
    default_gm_channel: 9,
    track_name: "Sprunki / Drums",
  },
  {
    id: "bass",
    label: "Bass",
    mode: "pitched",
    default_instrument_uri: "http://gareus.org/oss/lv2/gmsynth",
    default_gm_program: 38,  // GM Synth Bass 1
    default_gm_channel: 0,
    track_name: "Sprunki / Bass",
  },
  {
    id: "chords",
    label: "Chords",
    mode: "pitched",
    default_instrument_uri: "http://gareus.org/oss/lv2/gmsynth",
    default_gm_program: 89,  // GM Pad 2 (warm)
    default_gm_channel: 0,
    track_name: "Sprunki / Chords",
  },
  {
    id: "lead",
    label: "Lead",
    mode: "pitched",
    default_instrument_uri: "http://gareus.org/oss/lv2/gmsynth",
    default_gm_program: 80,  // GM Lead 1 (square)
    default_gm_channel: 0,
    track_name: "Sprunki / Lead",
  },
  {
    id: "fx",
    label: "FX",
    mode: "pitched",
    default_instrument_uri: "http://gareus.org/oss/lv2/gmsynth",
    default_gm_program: 96,  // GM FX 1 (rain)
    default_gm_channel: 0,
    track_name: "Sprunki / FX",
  },
];

/** Look up a category by id. */
export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id);
}

/** @type {SprunkiCharacter[]} */
export const CHARACTERS = [
  // ── Drums (GM percussion pitches on channel 9) ─────────────────
  { id: "kick",    name: "Boomer",    emoji: "🦶", color: "#ff6b35", pitch: 36, category: "drums" },
  { id: "snare",   name: "Snappy",    emoji: "👏", color: "#f7c948", pitch: 38, category: "drums" },
  { id: "hihat",   name: "Ticky",     emoji: "🥁", color: "#7ec8e3", pitch: 42, category: "drums" },
  { id: "clap",    name: "Clappy",    emoji: "🙌", color: "#c3aed6", pitch: 39, category: "drums" },
  { id: "crash",   name: "Crashy",    emoji: "💥", color: "#ff9ff3", pitch: 49, category: "drums" },
  { id: "ride",    name: "Ringy",     emoji: "🔔", color: "#48dbfb", pitch: 51, category: "drums" },
  { id: "tom_hi",  name: "Tom-Tom",   emoji: "🪘", color: "#feca57", pitch: 50, category: "drums" },
  { id: "tom_lo",  name: "Boom-Tom",  emoji: "🫗", color: "#ff9f43", pitch: 45, category: "drums" },

  // ── Bass — pentatonic root + fifth in two octaves ─────────────
  { id: "bass_deep",  name: "WubWub",  emoji: "🐙", color: "#6c5ce7", pitch: 36, category: "bass"  },
  { id: "bass_punch", name: "Thumper", emoji: "🐘", color: "#a29bfe", pitch: 40, category: "bass"  },

  // ── Chords — major-triad voicings in a comfortable register ───
  { id: "pad_warm",   name: "Warmy",   emoji: "🌈", color: "#00b894", pitch: 60, category: "chords" },
  { id: "pad_bright", name: "Shiny",   emoji: "✨", color: "#00cec9", pitch: 64, category: "chords" },
  { id: "pad_dark",   name: "Moody",   emoji: "🌙", color: "#636e72", pitch: 55, category: "chords" },

  // ── Lead ─────────────────────────────────────────────────────
  { id: "lead_sq",    name: "Beepy",     emoji: "🤖", color: "#e17055", pitch: 72, category: "lead" },
  { id: "lead_saw",   name: "Buzz-Buzz", emoji: "🐝", color: "#fab1a0", pitch: 76, category: "lead" },
  { id: "lead_pluck", name: "Plucky",    emoji: "🎸", color: "#ffeaa7", pitch: 67, category: "lead" },

  // ── FX ───────────────────────────────────────────────────────
  { id: "fx_riser",   name: "Whoosh", emoji: "🚀", color: "#fd79a8", pitch: 84, category: "fx" },
  { id: "fx_hit",     name: "Bam!",   emoji: "💢", color: "#d63031", pitch: 48, category: "fx" },
  { id: "fx_zap",     name: "Zappy",  emoji: "⚡", color: "#fdcb6e", pitch: 90, category: "fx" },
];

/** Look up a character by id. */
export function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id);
}

/** All characters in a given category, in display order. */
export function charactersInCategory(categoryId) {
  return CHARACTERS.filter((c) => c.category === categoryId);
}

/** Map char id → row index inside its category. The row index is
 *  what the sequencer layout's `cells[].row` references. */
export function rowIndexFor(charId) {
  const char = getCharacter(charId);
  if (!char) return -1;
  const peers = charactersInCategory(char.category);
  return peers.findIndex((p) => p.id === charId);
}

/** Characters grouped by category, in CATEGORIES order. Convenient
 *  for roster + board rendering. */
export function charactersByCategory() {
  /** @type {Record<string, SprunkiCharacter[]>} */
  const byCat = {};
  for (const cat of CATEGORIES) byCat[cat.id] = [];
  for (const c of CHARACTERS) (byCat[c.category] ??= []).push(c);
  return byCat;
}

/** Pattern tabs the player switches between. Each pattern lives at
 *  its own bar offset in the arrangement (Intro=0, Verse=1, …). */
export const DEFAULT_PATTERNS = [
  { id: "intro",  name: "Intro",  color: "#6c5ce7", bar: 0 },
  { id: "verse",  name: "Verse",  color: "#00b894", bar: 1 },
  { id: "chorus", name: "Chorus", color: "#e17055", bar: 2 },
  { id: "drop",   name: "Drop",   color: "#fd79a8", bar: 3 },
];

/** Curated GM program presets surfaced in the preferences modal.
 *  Each entry covers one category so the picker can show a focused
 *  short list rather than all 128 GM programs. The picker still
 *  allows a raw 0..127 entry as an escape hatch. */
export const GM_PRESETS = {
  drums: [
    { program: 0,  label: "Standard Kit" },
    // GM doesn't put alt kits at unique program numbers — gmsynth
    // exposes its alt kits as different patches that the user can
    // dial via the in-app patch picker (or via this modal once a
    // dedicated drum-kit plugin like drumkv1 is wired up).
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

/** Beat-grid constants. 16 steps × 4 sixteenth-notes per beat = 1 bar of 4/4. */
export const STEPS_PER_PATTERN = 16;
export const DEFAULT_BPM = 120;
export const DEFAULT_RESOLUTION = 4;
