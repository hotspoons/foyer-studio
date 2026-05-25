// Sprunki asset-pack bridge.
//
// Resolves OG-sprunki SVG art + sample paths for our characters so
// the UI can render the real reverse-engineered artwork (when the
// asset pack has been downloaded) instead of placeholder emoji.
//
// Two parts:
//   1. A lazy fetch of `sprunki-assets.json`, the reverse-engineered
//      manifest of the OG Sprunki characters + their costume / sound
//      buckets. Lives next to this module in the variant tree.
//   2. A static mapping from our [[sound-catalog]] character ids to
//      OG sprunki character ids — our roster has 18 characters across
//      5 categories, OG has 30 across 6. The map is best-effort
//      role-matching (kick→oren, hihat→vineria, …); duplicates are
//      fine since multiple of our characters can share OG art.
//
// The asset pack extracts to `$XDG_DATA_HOME/foyer/asset-packs/sprunki/`
// on disk and is served at `/asset-packs/sprunki/` (see
// `crates/foyer-server/src/asset_packs.rs`). The archive ships with a
// `sprunki-website/assets/` prefix; we probe both layouts at first
// use so a future strip_prefix change in the server doesn't break us.

const MANIFEST_URL = new URL("./sprunki-assets.json", import.meta.url).href;
const ASSET_BASE_CANDIDATES = [
  "/asset-packs/sprunki/sprunki-website/assets/",
  "/asset-packs/sprunki/assets/",
];

/** Our character id → OG sprunki id. */
export const SPRUNKI_ID_MAP = {
  // Drums (8 ours → 5 OG, re-using OG ids where roles overlap).
  kick:   "oren",
  snare:  "raddy",
  hihat:  "vineria",
  clap:   "fun-bot",
  crash:  "clukr",
  ride:   "clukr",
  tom_hi: "raddy",
  tom_lo: "oren",

  // Bass (1 OG character — both ours map to it).
  bass_deep:  "gray",
  bass_punch: "gray",

  // Chords (pads): map to OG melody characters with mellower timbres.
  pad_warm:   "mr-tree", // organ
  pad_bright: "sky",     // music box
  pad_dark:   "durple",  // brass

  // Lead: brighter melody picks.
  lead_sq:    "simon",   // square synth
  lead_saw:   "garnold", // arpeggio
  lead_pluck: "mr-sun",  // piano

  // FX: matches OG fx category.
  fx_riser:   "owakcx",  // buildup
  fx_hit:     "brud",    // vocal glitch
  fx_zap:     "tunner",  // whistle
};

let _manifestPromise = null;
let _resolvedBase = null;
let _manifest = null;

/** Fetch + cache the sprunki-assets.json manifest. */
export function loadSprunkiManifest() {
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = fetch(MANIFEST_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`manifest fetch HTTP ${r.status}`);
      return r.json();
    })
    .then((m) => { _manifest = m; return m; })
    .catch((e) => {
      console.warn("[sprunki-assets] failed to load manifest:", e);
      _manifestPromise = null;
      throw e;
    });
  return _manifestPromise;
}

/** Return the cached manifest, or `null` if it hasn't been loaded
 *  yet. Useful for sync render paths. */
export function manifestSync() {
  return _manifest;
}

/** OG character record for one of our `CHARACTERS[].id`, or null
 *  when the mapping or manifest isn't ready. Sync — caller is
 *  expected to have awaited `loadSprunkiManifest()` first. */
export function ogCharacter(ourId) {
  if (!_manifest) return null;
  const ogId = SPRUNKI_ID_MAP[ourId];
  if (!ogId) return null;
  return _manifest.characters.find((c) => c.id === ogId) || null;
}

/** First idle costume file (the resting frame) for our character.
 *  Returns the resolved URL or null. */
export function idleCostumeUrl(ourId) {
  const og = ogCharacter(ourId);
  if (!og || !_resolvedBase) return null;
  const file = og.costumes?.idle?.[0]?.file;
  return file ? `${_resolvedBase}${file}` : null;
}

/** First play costume (the animation cycle's lead frame). */
export function playCostumeUrl(ourId) {
  const og = ogCharacter(ourId);
  if (!og || !_resolvedBase) return null;
  const file = og.costumes?.play?.[0]?.file;
  return file ? `${_resolvedBase}${file}` : null;
}

/** Probe which `/asset-packs/sprunki/...` prefix the server is
 *  exposing. Done once per session via a HEAD against the
 *  manifest's first known file. Calling this BEFORE the asset
 *  pack is downloaded just yields `null` — caller should re-probe
 *  on the `AssetPackUpdated` event when state flips to `ready`. */
export async function probeAssetBase() {
  if (_resolvedBase) return _resolvedBase;
  if (!_manifest) await loadSprunkiManifest();
  const probeFile = _manifest?.characters?.[0]?.costumes?.idle?.[0]?.file;
  if (!probeFile) return null;
  for (const base of ASSET_BASE_CANDIDATES) {
    try {
      const r = await fetch(`${base}${probeFile}`, { method: "HEAD" });
      if (r.ok) {
        _resolvedBase = base;
        console.info(`[sprunki-assets] asset base resolved: ${base}`);
        return base;
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

/** Clear the resolved-base cache — call this when the asset pack
 *  state flips back to non-ready (e.g. user deleted the pack). */
export function invalidateAssetBase() {
  _resolvedBase = null;
}
