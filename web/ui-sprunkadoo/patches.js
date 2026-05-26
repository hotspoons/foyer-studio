// Sprunki patches — the library the kid drags from.
//
// A *patch* is one tile in the palette. It carries:
//   * a costume        (face, color, idle/play art id),
//   * an instrument    (LV2 URI + GM program + GM channel),
//   * 1+ sequencer rows (one per voice — a Drum Kit has kick / snare
//                        / hat / crash rows on the same avldrums
//                        instance; a Warm Pad has root / third /
//                        fifth chord-tone rows on the same gmsynth
//                        instance),
//   * a default loop   (per-row step pattern).
//
// When a patch is dragged onto a sprunki on stage, that sprunki's
// backend slot-track gets the patch's instrument loaded onto it,
// the rows become the audible sequencer rows, and the default loop
// seeds the active section if the slot was previously empty.
//
// Composites live at the *row* level, not the track level. One
// patch ⇒ one backend track ⇒ one instrument plugin. That keeps
// the slot ↔ track mapping clean and reuses the SequencerLayout
// shape we already ship over the wire (`rows[]` + `patterns[].cells`).

/**
 * @typedef {object} PatchRow
 * @property {string} id              — unique within the patch
 * @property {string} label           — surface label (UI / shim diag)
 * @property {string} [color]         — accent for this row in the grid editor
 * @property {number} [pitch]         — absolute MIDI pitch (drum mode + FX);
 *                                       wins over chord_tone / scale_degree.
 * @property {"root"|"third"|"fifth"|"seventh"} [chord_tone]
 *                                    — pitched-mode row anchored to a chord tone
 * @property {number} [scale_degree]  — pitched-mode row anchored to a scale degree
 * @property {number} [octave_offset] — integer octave shift on top of the above (default 0)
 * @property {number[]} [default_loop] — step indices (0..15) to seed when first placed
 */

/**
 * @typedef {object} Patch
 * @property {string} id
 * @property {string} label
 * @property {string} color            — accent (also drives the no-art fallback
 *                                       chip — a colored circle carrying the
 *                                       label's first letter)
 * @property {"drum"|"pitched"} mode
 * @property {string} instrument_uri   — LV2 URI; fallback chain runs if it misses
 * @property {string[]} [instrument_uri_fallbacks]
 * @property {number} gm_program       — 0..127
 * @property {number} gm_channel       — 0..15 (9 = GM drums)
 * @property {PatchRow[]} rows
 * @property {string} [sprunki_id]     — OG sprunki character id this patch styles after
 *                                       (drives the SVG costume lookup when the asset
 *                                       pack is downloaded).
 */

import {
  STEPS_PER_BAR,
  STEPS_PER_PATTERN,
} from "./components/sound-catalog.js";

// ── instrument shortcuts ───────────────────────────────────────────

const AVLDRUMS_BLACK_PEARL = "http://gareus.org/oss/lv2/avldrums#BlackPearl";
const AVLDRUMS_RED_ZEPPELIN = "http://gareus.org/oss/lv2/avldrums#RedZeppelin";
const GMSYNTH = "http://gareus.org/oss/lv2/gmsynth";
const A_FLUIDSYNTH = "urn:ardour:a-fluidsynth";

const DRUM_FALLBACKS = [AVLDRUMS_RED_ZEPPELIN, GMSYNTH];
const SYNTH_FALLBACKS = [A_FLUIDSYNTH, GMSYNTH];

// ── PATCH LIBRARY ──────────────────────────────────────────────────
//
// 20 patches, mapped 1:1 to the OG sprunki character cast (in the
// same display order). Each patch styles after exactly one OG
// character, so the palette tile is just the character's icon and
// the on-stage sprite is that character. Two rows of ten tiles
// matches the OG gallery layout.
//
// Audio side: drum characters (1-5) all sit on AVLDRUMS RedZeppelin
// (heavy kit, designed for layering — drop multiple drum sprunkis
// on stage and they thicken the groove). Tonal characters use
// GMSYNTH with character-appropriate GM programs. Vocal characters
// use GM 52-54 (choir aahs / voice oohs / synth voice). Phantom
// sits behind the scary-mode gate; for now it's a placeholder
// patch that won't play until the parental unlock lands.

/** @type {Patch[]} */
export const PATCHES = [
  // ── Headline composite: full Drum Kit on a single track ────────────
  //
  // Sits in front of the atomic-drum tiles. Composite means one
  // backend track + one BlackPearl instance hosts kick / snare / hat
  // / crash voices simultaneously — drops a complete kit groove the
  // moment a kid lands it on stage. Stack atomic RedZeppelin drums
  // on TOP of this to thicken the beat ("Robot" + accents pattern
  // Rich pointed at). Styles after Fun Bot because the robotic kit
  // costume matches the "this is the drum machine" visual identity.
  {
    id: "drum-kit", label: "Drum Kit",
    color: "#ffc633", mode: "drum",
    instrument_uri: AVLDRUMS_BLACK_PEARL, instrument_uri_fallbacks: DRUM_FALLBACKS,
    gm_program: 0, gm_channel: 9,
    sprunki_id: "fun-bot",
    rows: [
      { id: "kick",  label: "Kick",  pitch: 36, color: "#ffc633", default_loop: [0, 4, 8, 12] },
      { id: "snare", label: "Snare", pitch: 38, color: "#ff6f00", default_loop: [4, 12] },
      { id: "hat",   label: "Hat",   pitch: 42, color: "#babebf", default_loop: [2, 6, 10, 14] },
      { id: "crash", label: "Crash", pitch: 49, color: "#ffe9b3", default_loop: [0] },
    ],
  },

  // ── Drum atomics (top row of the OG palette) ──────────────────────
  {
    id: "oren-kick",  label: "Kick",
    color: "#ff6f00", mode: "drum",
    instrument_uri: AVLDRUMS_RED_ZEPPELIN, instrument_uri_fallbacks: DRUM_FALLBACKS,
    gm_program: 0, gm_channel: 9,
    sprunki_id: "oren",
    rows: [
      { id: "kick", label: "Kick", pitch: 36, color: "#ff6f00", default_loop: [0, 4, 8, 12] },
    ],
  },
  {
    id: "raddy-snare", label: "Snare",
    color: "#b30000", mode: "drum",
    instrument_uri: AVLDRUMS_RED_ZEPPELIN, instrument_uri_fallbacks: DRUM_FALLBACKS,
    gm_program: 0, gm_channel: 9,
    sprunki_id: "raddy",
    rows: [
      { id: "snare", label: "Snare", pitch: 38, color: "#b30000", default_loop: [4, 12] },
    ],
  },
  {
    id: "clukr-hat", label: "Hat",
    color: "#babebf", mode: "drum",
    instrument_uri: AVLDRUMS_RED_ZEPPELIN, instrument_uri_fallbacks: DRUM_FALLBACKS,
    gm_program: 0, gm_channel: 9,
    sprunki_id: "clukr",
    rows: [
      { id: "hat", label: "Hat", pitch: 42, color: "#babebf", default_loop: [2, 6, 10, 14] },
    ],
  },
  // Note: a tom+clap "Break" patch styled after Fun Bot was retired
  // here — Drum Kit (above) already uses fun-bot, and Rich asked for
  // 20 unique characters, no reuse. The tom/clap voices are still
  // reachable inside the Drum Kit composite as additional rows if we
  // want to wire them per-voice in a later pass.
  {
    id: "vineria-shaker", label: "Shaker",
    color: "#00ff15", mode: "drum",
    instrument_uri: AVLDRUMS_RED_ZEPPELIN, instrument_uri_fallbacks: DRUM_FALLBACKS,
    gm_program: 0, gm_channel: 9,
    sprunki_id: "vineria",
    rows: [
      { id: "shaker", label: "Shaker", pitch: 70, color: "#00ff15", default_loop: [0, 2, 4, 6, 8, 10, 12, 14] },
    ],
  },

  // ── Bass + vocal/SFX cluster (middle of the OG palette) ───────────
  {
    id: "gray-bass", label: "Bass",
    color: "#808080", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 38, gm_channel: 0,  // GM Synth Bass 1
    sprunki_id: "gray",
    rows: [
      { id: "root",  label: "Root",  chord_tone: "root",  octave_offset: -2, color: "#808080", default_loop: [0, 4, 8, 12] },
      { id: "fifth", label: "Fifth", chord_tone: "fifth", octave_offset: -2, color: "#a29bfe", default_loop: [2, 10] },
    ],
  },
  {
    id: "brud-glitch", label: "Vox Glitch",
    color: "#7a4a1f", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 102, gm_channel: 0,  // GM FX 7 (echoes)
    sprunki_id: "brud",
    rows: [
      { id: "stab", label: "Stab", scale_degree: 0, octave_offset: 1, color: "#7a4a1f", default_loop: [3, 11] },
    ],
  },
  {
    id: "garnold-arp", label: "Arpeggio",
    color: "#ffc107", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 81, gm_channel: 0,  // GM Lead 2 (sawtooth)
    sprunki_id: "garnold",
    rows: [
      { id: "tonic",   label: "Tonic",   scale_degree: 0, octave_offset: 1, color: "#ffc107", default_loop: [0, 8] },
      { id: "mediant", label: "Mediant", scale_degree: 2, octave_offset: 1, color: "#ffe69a", default_loop: [2, 10] },
      { id: "dom",     label: "Dom",     scale_degree: 4, octave_offset: 1, color: "#ffeaa7", default_loop: [4, 12] },
    ],
  },
  {
    id: "owakcx-riser", label: "Riser",
    color: "#caff2a", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 96, gm_channel: 0,  // GM FX 1 (rain)
    sprunki_id: "owakcx",
    rows: [
      { id: "riser", label: "Riser", pitch: 84, color: "#caff2a", default_loop: [12] },
    ],
  },
  {
    id: "sky-musicbox", label: "Music Box",
    color: "#7ec8e3", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 10, gm_channel: 0,  // GM Music Box
    sprunki_id: "sky",
    rows: [
      { id: "tonic", label: "Tonic", scale_degree: 0, octave_offset: 1, color: "#7ec8e3", default_loop: [0, 6] },
      { id: "third", label: "Third", chord_tone: "third", octave_offset: 1, color: "#a8dce8", default_loop: [3, 11] },
    ],
  },
  {
    // Added 2026-05-25 — Rich's 8yo asked for a purple-flower character
    // with a "disgusted" face. Asset agent shipped the SVG cast
    // (`flower-*.svg` in builtin-assets); we wire the patch here with
    // a Celesta-leaning Music Box program. OG pack has no `flower`
    // character, so this falls back to the no-art chip when source=og.
    id: "flower-chime", label: "Chime",
    color: "#a45fc9", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 9, gm_channel: 0,  // GM Celesta — pretty + gentle
    sprunki_id: "flower",
    rows: [
      { id: "high",   label: "High",   scale_degree: 0, octave_offset: 2, color: "#d8b6ee", default_loop: [0, 4, 8, 12] },
      { id: "petal",  label: "Petal",  chord_tone: "third", octave_offset: 2, color: "#ec9bff", default_loop: [2, 10] },
    ],
  },

  // ── Tonal melody + vocals (bottom row of the OG palette) ──────────
  {
    id: "mr-sun-piano", label: "Piano",
    color: "#ffd200", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 0, gm_channel: 0,  // GM Acoustic Grand
    sprunki_id: "mr-sun",
    rows: [
      { id: "root",  label: "Root",  chord_tone: "root",  octave_offset: 0, color: "#ffd200", default_loop: [0, 8] },
      { id: "third", label: "Third", chord_tone: "third", octave_offset: 0, color: "#ffea7a", default_loop: [4, 12] },
    ],
  },
  {
    id: "durple-brass", label: "Brass",
    color: "#7d2dbd", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 56, gm_channel: 0,  // GM Trumpet
    sprunki_id: "durple",
    rows: [
      { id: "tonic", label: "Tonic", scale_degree: 0, octave_offset: 0, color: "#7d2dbd", default_loop: [0, 8] },
      { id: "fifth", label: "Fifth", chord_tone: "fifth", octave_offset: 0, color: "#b56aff", default_loop: [4, 12] },
    ],
  },
  {
    id: "mr-tree-organ", label: "Organ",
    color: "#3a7a26", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 16, gm_channel: 0,  // GM Drawbar Organ
    sprunki_id: "mr-tree",
    rows: [
      { id: "root",  label: "Root",  chord_tone: "root",  octave_offset: 0, color: "#3a7a26", default_loop: [0, 8] },
      { id: "fifth", label: "Fifth", chord_tone: "fifth", octave_offset: 0, color: "#7fbf5c", default_loop: [4, 12] },
    ],
  },
  {
    id: "simon-square", label: "Square",
    color: "#ffeb3b", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 80, gm_channel: 0,  // GM Lead 1 (square)
    sprunki_id: "simon",
    rows: [
      { id: "tonic", label: "Tonic", scale_degree: 0, octave_offset: 1, color: "#ffeb3b", default_loop: [4, 8, 14] },
    ],
  },
  {
    id: "tunner-whistle", label: "Whistle",
    color: "#d8b27a", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 78, gm_channel: 0,  // GM Whistle
    sprunki_id: "tunner",
    rows: [
      { id: "tonic", label: "Tonic", scale_degree: 0, octave_offset: 2, color: "#d8b27a", default_loop: [0, 4, 8, 12] },
    ],
  },
  {
    // Mr Fun Computer = Performer Sprunki. His head is literally
    // a CRT monitor, which is a perfect "plug your keyboard into
    // me" affordance. `accepts_midi_ingress` makes
    // _onStageChanged arm Web MIDI on this slot's track when he's
    // dropped on stage — every keypress the kid plays gets
    // auto-snapped to the active key's scale and routed through
    // his gmsynth voice. No sequencer beats are pushed for this
    // character (his row is a placeholder that the snap path
    // overrides on every Note On). Clearing the slot disarms.
    id: "mfc-keys", label: "Keys",
    color: "#222222", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 4, gm_channel: 0,  // GM Electric Piano (mellow lead for keys)
    sprunki_id: "mr-fun-computer",
    accepts_midi_ingress: true,
    rows: [
      { id: "tonic", label: "Live", scale_degree: 0, octave_offset: 0, color: "#222222", default_loop: [] },
    ],
  },
  {
    id: "wenda-hey",  label: "Hey!",
    color: "#ffffff", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 53, gm_channel: 0,  // GM Voice Oohs
    sprunki_id: "wenda",
    rows: [
      { id: "tonic", label: "Tonic", scale_degree: 0, octave_offset: 0, color: "#ffffff", default_loop: [0, 8] },
    ],
  },
  {
    id: "pinki-choir", label: "F Choir",
    color: "#ff80c0", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 52, gm_channel: 0,  // GM Choir Aahs
    sprunki_id: "pinki",
    rows: [
      { id: "root",  label: "Root",  chord_tone: "root",  octave_offset: 0, color: "#ff80c0", default_loop: [0, 8] },
      { id: "third", label: "Third", chord_tone: "third", octave_offset: 0, color: "#ffbfdb", default_loop: [0, 8] },
    ],
  },
  {
    id: "jevin-male-choir", label: "M Choir",
    color: "#1f2bd6", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 54, gm_channel: 0,  // GM Synth Voice
    sprunki_id: "jevin",
    rows: [
      { id: "root",  label: "Root",  chord_tone: "root",  octave_offset: -1, color: "#1f2bd6", default_loop: [0, 8] },
      { id: "fifth", label: "Fifth", chord_tone: "fifth", octave_offset: -1, color: "#6b75ff", default_loop: [0, 8] },
    ],
  },
  {
    // The Phantom is also the audio-ingress costume — moving him on
    // stage prompts for mic access and routes the live signal onto
    // his track (post any selected ingress-only FX like autotune
    // or vocoder). Without ingress permission he stays a regular
    // synth pad so the slot doesn't go dead.
    id: "black-phantom", label: "Phantom",
    color: "#0d0d0d", mode: "pitched",
    instrument_uri: GMSYNTH, instrument_uri_fallbacks: SYNTH_FALLBACKS,
    gm_program: 88, gm_channel: 0,  // GM Pad 1 (new age) — placeholder until scary-mode lands
    sprunki_id: "black",
    requires_scary_mode: false,
    accepts_audio_ingress: true,
    rows: [
      { id: "drone", label: "Drone", chord_tone: "root", octave_offset: -1, color: "#0d0d0d", default_loop: [0, 8] },
    ],
  },
];

export function getPatch(id) {
  return PATCHES.find((p) => p.id === id);
}

/** Default loop as a `{ [rowId]: number[] }` map — the canonical
 *  shape sprunkiStore.boards holds for each slot.
 *
 *  Each patch's row authors `default_loop` in 1-bar / 16-step
 *  terms (step indices 0..15). Patterns are now 4 bars long
 *  (STEPS_PER_PATTERN=64), so we tile that 1-bar seed across all
 *  four bars — kicks on 0,4,8,12 become 0,4,8,12,16,20,24,28,
 *  …,60 so the kid hears a continuous groove the moment a tile
 *  lands on stage. The kid is still free to edit individual bars
 *  separately from the detail editor; tiling just sets the
 *  initial feel. */
export function patchDefaultBoard(patch) {
  const out = {};
  const tileCount = Math.max(1, Math.floor(STEPS_PER_PATTERN / STEPS_PER_BAR));
  for (const row of patch.rows) {
    if (!Array.isArray(row.default_loop) || !row.default_loop.length) continue;
    const tiled = [];
    for (let bar = 0; bar < tileCount; bar++) {
      for (const s of row.default_loop) {
        const step = s + bar * STEPS_PER_BAR;
        if (step < STEPS_PER_PATTERN) tiled.push(step);
      }
    }
    out[row.id] = tiled;
  }
  return out;
}
