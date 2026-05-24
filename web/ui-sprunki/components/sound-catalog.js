// Sprunki sound catalog — pre-baked instrument character presets.
//
// Each character maps to a General MIDI pitch + bank/program preset.
// The sequencer engine sends `set_sequencer_layout` with a drum-mode
// layout where each "row" is one character's pitch. When the user
// clicks a beat cell for a character, we toggle that step in the
// character's row pattern.
//
// CHARACTERS:
//   Each character is a personality + sound combo. The character list
//   is designed to give a complete band when all are active:
//
//     Drums    — kick, snare, hi-hat, clap, crash
//     Bass     — deep synth bass
//     Chords   — warm pad chords
//     Lead     — bright melodic lead
//     FX       — riser / impact one-shots
//
// Sound design rationale: uses GM bank 0 (standard) program numbers
// so that any GM-compatible synth (including the Autovocoder +
// Ardour's General MIDI synth) can render them.

/**
 * A Sprunki character — personality name, emoji avatar, GM sound mapping.
 * @typedef {object} SprunkiCharacter
 * @property {string} id        — unique key
 * @property {string} name      — display name
 * @property {string} emoji     — avatar emoji
 * @property {string} color     — CSS color for the character card
 * @property {number} pitch     — GM MIDI pitch number
 * @property {string} category  — "drums" | "bass" | "chords" | "lead" | "fx"
 * @property {string[]} [tags]  — descriptive tags
 */

/** @type {SprunkiCharacter[]} */
export const CHARACTERS = [
  // ── Drums ──────────────────────────────────────────────────────────
  { id: "kick",    name: "Boomer",   emoji: "🦶", color: "#ff6b35", pitch: 36, category: "drums", tags: ["kick", "thump"] },
  { id: "snare",   name: "Snappy",   emoji: "👏", color: "#f7c948", pitch: 38, category: "drums", tags: ["snare", "crack"] },
  { id: "hihat",   name: "Ticky",    emoji: "🥁", color: "#7ec8e3", pitch: 42, category: "drums", tags: ["hi-hat", "tick"] },
  { id: "clap",    name: "Clappy",   emoji: "🙌", color: "#c3aed6", pitch: 39, category: "drums", tags: ["clap", "snap"] },
  { id: "crash",   name: "Crashy",   emoji: "💥", color: "#ff9ff3", pitch: 49, category: "drums", tags: ["crash", "cymbal"] },
  { id: "ride",    name: "Ringy",    emoji: "🔔", color: "#48dbfb", pitch: 51, category: "drums", tags: ["ride", "ting"] },
  { id: "tom_hi",  name: "Tom-Tom",  emoji: "🪘", color: "#feca57", pitch: 50, category: "drums", tags: ["tom", "high"] },
  { id: "tom_lo",  name: "Boom-Tom", emoji: "🫗", color: "#ff9f43", pitch: 45, category: "drums", tags: ["tom", "low"] },

  // ── Bass ───────────────────────────────────────────────────────────
  { id: "bass_deep",  name: "WubWub", emoji: "🐙", color: "#6c5ce7", pitch: 36, category: "bass",  tags: ["bass", "deep", "wobble"] },
  { id: "bass_punch", name: "Thumper", emoji: "🐘", color: "#a29bfe", pitch: 40, category: "bass",  tags: ["bass", "punch", "sub"] },

  // ── Chords ─────────────────────────────────────────────────────────
  { id: "pad_warm",   name: "Warmy",   emoji: "🌈", color: "#00b894", pitch: 60, category: "chords", tags: ["pad", "warm", "chord"] },
  { id: "pad_bright", name: "Shiny",   emoji: "✨", color: "#00cec9", pitch: 64, category: "chords", tags: ["pad", "bright", "shimmer"] },
  { id: "pad_dark",   name: "Moody",   emoji: "🌙", color: "#636e72", pitch: 55, category: "chords", tags: ["pad", "dark", "minor"] },

  // ── Lead ───────────────────────────────────────────────────────────
  { id: "lead_sq",   name: "Beepy",   emoji: "🤖", color: "#e17055", pitch: 72, category: "lead", tags: ["lead", "square", "beep"] },
  { id: "lead_saw",  name: "Buzz-Buzz", emoji: "🐝", color: "#fab1a0", pitch: 76, category: "lead", tags: ["lead", "saw", "buzzy"] },
  { id: "lead_pluck", name: "Plucky", emoji: "🎸", color: "#ffeaa7", pitch: 67, category: "lead", tags: ["lead", "pluck", "short"] },

  // ── FX ─────────────────────────────────────────────────────────────
  { id: "fx_riser",   name: "Whoosh",   emoji: "🚀", color: "#fd79a8", pitch: 84, category: "fx", tags: ["fx", "riser", "woosh"] },
  { id: "fx_hit",     name: "Bam!",     emoji: "💢", color: "#d63031", pitch: 48, category: "fx", tags: ["fx", "hit", "impact"] },
  { id: "fx_zap",     name: "Zappy",    emoji: "⚡", color: "#fdcb6e", pitch: 90, category: "fx", tags: ["fx", "zap", "laser"] },
];

/**
 * Look up a character by ID.
 * @param {string} id
 * @returns {SprunkiCharacter|undefined}
 */
export function getCharacter(id) {
  return CHARACTERS.find(c => c.id === id);
}

/**
 * Return characters grouped by category.
 * @returns {Record<string, SprunkiCharacter[]>}
 */
export function charactersByCategory() {
  /** @type {Record<string, SprunkiCharacter[]>} */
  const byCat = {};
  for (const c of CHARACTERS) {
    (byCat[c.category] ??= []).push(c);
  }
  return byCat;
}

/**
 * Available patterns / song sections the user can switch between.
 * In Sprunki, each "pattern" is a 16-step loop. The default is just
 * "Pattern 1" — the user can add more as sections (A, B, C...).
 */
export const DEFAULT_PATTERNS = [
  { id: 1, name: "Intro",  color: "#6c5ce7" },
  { id: 2, name: "Verse",  color: "#00b894" },
  { id: 3, name: "Chorus", color: "#e17055" },
  { id: 4, name: "Drop",   color: "#fd79a8" },
];

/** Beat grid constants */
export const STEPS_PER_PATTERN = 16;
export const DEFAULT_BPM = 120;
export const DEFAULT_RESOLUTION = 4; // 16th notes
