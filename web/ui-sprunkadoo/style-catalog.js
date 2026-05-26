// Sprunkadoo style catalog — the "Style" combo in the top bar.
//
// Picking a style REWRITES the entire cast: every stage slot's
// patch_id, its per-row step pattern, the global tempo, and the
// chord progression all flip to a coherent vibe. This is a
// destructive op — if the kid has authored their own beats we
// confirm before clobbering.
//
// Shape:
//   { id, label, color, bpm, progressionId, cast: [CastEntry] }
//
// CastEntry:
//   { patch_id, board: { [rowId]: number[] } }
//
// `board` is authored as a 1-bar (16-step) pattern; the store
// tiles it across BARS_PER_PATTERN like patchDefaultBoard does so
// the kid hears a continuous groove the moment the style lands.
// Row ids must match the patch's row ids in `patches.js` — extra
// keys are silently dropped, missing rows fall back to silence
// (deliberate: a "Lo-Fi" entry can deliberately omit the snare
// without ending up with the patch's default snare bleeding in).
//
// Cast entries are applied in array order — stage[0] gets cast[0],
// stage[1] gets cast[1], etc. If the cast is shorter than the
// stage, the trailing slots are CLEARED (the style takes over).
// If longer, the tail is truncated. Default stages are 7 slots
// wide; every style here ships exactly 7 cast entries.

/** @typedef {{ patch_id: string, board: Record<string, number[]> }} CastEntry */
/** @typedef {{ id: string, label: string, color: string, bpm: number,
 *              progressionId: string, cast: CastEntry[] }} Style */

/** @type {Style[]} */
export const STYLES = [
  {
    id: "pop",
    label: "Pop",
    color: "#ffd200",
    bpm: 110,
    progressionId: "I-V-vi-IV",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 8],
        snare: [4, 12],
        hat:   [0, 2, 4, 6, 8, 10, 12, 14],
        crash: [0],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 8],
        fifth: [4, 12],
      }},
      { patch_id: "mr-sun-piano", board: {
        root:  [0, 8],
        third: [4, 12],
      }},
      { patch_id: "pinki-choir", board: {
        root:  [0, 8],
        third: [0, 8],
      }},
      { patch_id: "garnold-arp", board: {
        tonic:   [0, 8],
        mediant: [2, 10],
        dom:     [6, 14],
      }},
      { patch_id: "simon-square", board: {
        tonic: [6],
      }},
      { patch_id: "wenda-hey", board: {
        tonic: [14],
      }},
    ],
  },

  {
    id: "hiphop",
    label: "Hip-Hop",
    color: "#a45fc9",
    bpm: 90,
    progressionId: "vi-IV-I-V",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 6, 10],
        snare: [4, 12],
        hat:   [0, 2, 4, 6, 8, 10, 12, 14],
        crash: [],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 6, 10, 14],
        fifth: [],
      }},
      { patch_id: "mr-tree-organ", board: {
        root:  [0, 8],
        fifth: [0, 8],
      }},
      { patch_id: "brud-glitch", board: {
        stab: [5, 13],
      }},
      { patch_id: "owakcx-riser", board: {
        riser: [12],
      }},
      { patch_id: "simon-square", board: {
        tonic: [3, 11],
      }},
      { patch_id: "vineria-shaker", board: {
        shaker: [2, 6, 10, 14],
      }},
    ],
  },

  {
    id: "dance",
    label: "Dance",
    color: "#00d4ff",
    bpm: 128,
    progressionId: "I-V-vi-IV",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 4, 8, 12],
        snare: [4, 12],
        hat:   [2, 6, 10, 14],
        crash: [0],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 2, 4, 6, 8, 10, 12, 14],
        fifth: [],
      }},
      { patch_id: "garnold-arp", board: {
        tonic:   [0, 4, 8, 12],
        mediant: [2, 6, 10, 14],
        dom:     [1, 5, 9, 13],
      }},
      { patch_id: "simon-square", board: {
        tonic: [0, 8],
      }},
      { patch_id: "owakcx-riser", board: {
        riser: [12],
      }},
      { patch_id: "pinki-choir", board: {
        root:  [0, 8],
        third: [0, 8],
      }},
      { patch_id: "brud-glitch", board: {
        stab: [6, 14],
      }},
    ],
  },

  {
    id: "rock",
    label: "Rock",
    color: "#ff3b6f",
    bpm: 150,
    progressionId: "I-IV-V-I",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 8, 12],
        snare: [4, 12],
        hat:   [0, 2, 4, 6, 8, 10, 12, 14],
        crash: [0],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 2, 4, 6, 8, 10, 12, 14],
        fifth: [],
      }},
      { patch_id: "simon-square", board: {
        tonic: [0, 4, 8, 12],
      }},
      { patch_id: "mr-sun-piano", board: {
        root:  [0, 8],
        third: [4, 12],
      }},
      { patch_id: "durple-brass", board: {
        tonic: [0, 8],
        fifth: [4, 12],
      }},
      { patch_id: "clukr-hat", board: {
        hat: [0, 2, 4, 6, 8, 10, 12, 14],
      }},
      { patch_id: "wenda-hey", board: {
        tonic: [14],
      }},
    ],
  },

  {
    id: "metal",
    label: "Metal",
    color: "#7a1a1a",
    bpm: 175,
    progressionId: "i-VI-III-VII",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 2, 4, 6, 8, 10, 12, 14],
        snare: [4, 12],
        hat:   [0, 4, 8, 12],
        crash: [0],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        fifth: [],
      }},
      { patch_id: "mr-tree-organ", board: {
        root:  [0, 8],
        fifth: [0, 8],
      }},
      { patch_id: "jevin-male-choir", board: {
        root:  [0, 8],
        fifth: [0, 8],
      }},
      { patch_id: "simon-square", board: {
        tonic: [0, 4, 8, 12],
      }},
      { patch_id: "raddy-snare", board: {
        snare: [2, 6, 10, 14],
      }},
      { patch_id: "owakcx-riser", board: {
        riser: [12],
      }},
    ],
  },

  {
    id: "lofi",
    label: "Lo-Fi",
    color: "#7ec8e3",
    bpm: 75,
    progressionId: "ii-V-I",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 8],
        snare: [4, 12],
        hat:   [0, 2, 4, 6, 8, 10, 12, 14],
        crash: [],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 8],
        fifth: [],
      }},
      { patch_id: "sky-musicbox", board: {
        tonic: [0, 6],
        third: [3, 11],
      }},
      { patch_id: "mr-sun-piano", board: {
        root:  [0, 8],
        third: [4, 12],
      }},
      { patch_id: "flower-chime", board: {
        high:  [0, 4, 8, 12],
        petal: [2, 10],
      }},
      { patch_id: "tunner-whistle", board: {
        tonic: [0],
      }},
      { patch_id: "vineria-shaker", board: {
        shaker: [0, 2, 4, 6, 8, 10, 12, 14],
      }},
    ],
  },

  {
    id: "spooky",
    label: "Spooky",
    color: "#3a3a45",
    bpm: 80,
    progressionId: "i-VI-III-VII",
    cast: [
      { patch_id: "drum-kit", board: {
        kick:  [0, 8],
        snare: [4, 12],
        hat:   [10],
        crash: [],
      }},
      { patch_id: "gray-bass", board: {
        root:  [0, 8],
        fifth: [4, 12],
      }},
      { patch_id: "mr-tree-organ", board: {
        root:  [0, 8],
        fifth: [4, 12],
      }},
      { patch_id: "jevin-male-choir", board: {
        root:  [0, 8],
        fifth: [],
      }},
      { patch_id: "owakcx-riser", board: {
        riser: [12],
      }},
      { patch_id: "brud-glitch", board: {
        stab: [11],
      }},
      { patch_id: "black-phantom", board: {
        drone: [0, 8],
      }},
    ],
  },
];

export function getStyle(id) {
  return STYLES.find((s) => s.id === id) || null;
}
