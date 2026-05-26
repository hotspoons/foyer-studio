// Per-costume FX catalog. Each entry is one of the toggleable
// effects that surface in the sequencer editor's left rail + the
// advanced section of the settings panel.
//
// "Enabled" is computed from the slot's TRACK plugin chain — i.e.
// the backend is the source of truth (per the project's "shared
// session state lives on the backend" rule). Toggling sends
// add_plugin / remove_plugin to the backend; the snapshot echo
// repaints the UI. No localStorage caching of FX state.
//
// FX URIs are LV2. We prefer Ardour's built-in `a-*` plugins
// because they ship in every Foyer-bundled Ardour build; the
// fallback list catches non-canonical builds. Autotune + vocoder
// land here once the foyer-server's audio ingress path is wired
// (per Rich's 2026-05-25 ask) — they only make sense on the
// Phantom sprunki since they process incoming mic audio.

export const FX_CATALOG = [
  {
    id: "echo",
    label: "Echo",
    glyph: "⤴",
    uri: "urn:ardour:a-delay",
    fallback_uris: [],
    category: "time",
  },
  {
    // Ardour's bundled `a-*` kit has Delay/Reverb/EQ but no
    // built-in chorus, so we fall through to system LV2 plugins.
    // Calf MultiChorus is rich + kid-friendly (gentle warble
    // defaults); guitarix's gx_chorus_stereo is a slimmer
    // fallback for builds without calf. URIs verified
    // 2026-05-25 against /usr/lib/lv2/.
    id: "chorus",
    label: "Chorus",
    glyph: "~",
    uri: "http://calf.sourceforge.net/plugins/MultiChorus",
    fallback_uris: [
      "http://guitarix.sourceforge.net/plugins/gx_chorus_stereo#_chorus_stereo",
    ],
    category: "mod",
  },
  {
    id: "reverb",
    label: "Reverb",
    glyph: "☴",
    uri: "urn:ardour:a-reverb",
    fallback_uris: [],
    category: "space",
  },
  {
    id: "filter",
    label: "Filter",
    glyph: "○",
    uri: "urn:ardour:a-eq",
    fallback_uris: [],
    category: "tone",
  },
];

/** Per-FX URI sets used for matching plugin entries already on a
 *  track. Order doesn't matter — any match counts. */
export function fxUrisFor(fxId) {
  const entry = FX_CATALOG.find((f) => f.id === fxId);
  if (!entry) return [];
  return [entry.uri, ...(entry.fallback_uris || [])].filter(Boolean);
}

/** FX-only filter for ingress sprunkis. Autotune + vocoder are
 *  gated to slots whose patch declares `accepts_audio_ingress`
 *  (currently only Phantom). The settings panel surfaces the
 *  whole list per-slot but greys out anything not applicable. */
export const INGRESS_ONLY_FX = [
  {
    id: "autotune",
    label: "Autotune",
    glyph: "♪",
    uri: "http://gareus.org/oss/lv2/fat1",
    fallback_uris: ["http://x42-plugins.com/x42/x42-autotune"],
    category: "pitch",
    ingress: true,
  },
  {
    id: "vocoder",
    label: "Vocoder",
    glyph: "ɸ",
    uri: "http://drobilla.net/plugins/blop/vocoder",
    fallback_uris: ["urn:ardour:a-vocoder"],
    category: "synth",
    ingress: true,
  },
];

export function allFxFor(patch) {
  const base = [...FX_CATALOG];
  if (patch?.accepts_audio_ingress) base.push(...INGRESS_ONLY_FX);
  return base;
}
