// Sprunki asset-pack bridge.
//
// Resolves OG-sprunki SVG art (idle / play costumes) for our
// patches so the stage renders real reverse-engineered artwork
// when the asset pack has been downloaded — emoji fallback
// otherwise.
//
// Each patch in `patches.js` declares a `sprunki_id` pointing at
// an OG sprunki character in the reverse-engineered manifest
// (`sprunki-assets.json`). Multiple patches may share the same
// sprunki_id (e.g. atomic "Kick" and composite "Drum Kit" both
// style after Oren); that's fine.
//
// The asset pack extracts to `$XDG_DATA_HOME/foyer/asset-packs/sprunki/`
// on disk and is served at `/asset-packs/sprunki/`. We probe two
// candidate paths the first time we resolve a URL, and cache the
// winner.

const MANIFEST_URL = new URL("./sprunki-assets.json", import.meta.url).href;
// Order matters: the working path goes first to keep the dev
// console clean. See SPRUNKI_VISION.md → "404 probe noise."
const ASSET_BASE_CANDIDATES = [
  "/asset-packs/sprunki/assets/",
  "/asset-packs/sprunki/sprunki-website/assets/",
];

let _manifestPromise = null;
let _resolvedBase = null;
let _manifest = null;

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

export function manifestSync() {
  return _manifest;
}

/** OG character record for a given sprunki_id (the one declared
 *  on the patch), or null when the manifest isn't loaded yet. */
export function ogCharacterById(sprunkiId) {
  if (!_manifest || !sprunkiId) return null;
  return _manifest.characters.find((c) => c.id === sprunkiId) || null;
}

/** Idle-costume URL (resting pose) for an OG sprunki id. First
 *  frame only — for cycling through all available idle frames
 *  (the blink + look-around magic from OG), use
 *  `allIdleCostumeUrlsFor`. */
export function idleCostumeUrlFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return null;
  const file = og.costumes?.idle?.[0]?.file;
  return file ? `${_resolvedBase}${file}` : null;
}

/** Safe (default-mode) idle frames for a character.
 *
 *  After the manifest re-extraction the `idle` bucket holds *only*
 *  the verified-safe resting pose — the horror variant (project
 *  name `idle2`) lives in `idle_alternate` and is gated behind
 *  scary mode. As of today every character has exactly one safe
 *  idle frame so this returns a 1-element list and the stage's
 *  blink-cycler stays inert; if a future asset drop adds more
 *  safe blink/look-around frames, drop them into `costumes.idle`
 *  and the cycler picks them up automatically. */
export function allIdleCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return [];
  return (og.costumes?.idle || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${_resolvedBase}${f}`);
}

/** Scary-mode idle frames (project `idle2`). Only surface these
 *  when scaryMode + parental unlock both say yes. */
export function alternateIdleCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return [];
  return (og.costumes?.idle_alternate || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${_resolvedBase}${f}`);
}

/** Play-costume URL (first play-cycle frame) for an OG sprunki id. */
export function playCostumeUrlFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return null;
  const file = og.costumes?.play?.[0]?.file;
  return file ? `${_resolvedBase}${file}` : null;
}

/** ALL play-cycle frames for a character. Used by the stage when
 *  a sprunki's track is actively making sound — rotate through
 *  play frames in sync with the beat. */
export function allPlayCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return [];
  return (og.costumes?.play || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${_resolvedBase}${f}`);
}

/** OG sprunki id we fall back to for empty stage slots. Kept
 *  for any consumers that still need a manifest id; the actual
 *  empty visual now uses the plain-gray Polo "0" sprite via
 *  `emptySprunkiUrl()` below. */
export const EMPTY_SLOT_SPRUNKI_ID = "raddy";

/** The OG game uses a dedicated "Polo" sprite as the gray,
 *  unactivated stage slot. Costume "0" of every Polo target is
 *  the canonical mid-gray body (`#808080` torso + `#666666`
 *  shadow, no accessories). The project file's `currentCostume`
 *  field reflects a saved game state at export time and isn't
 *  the boot visual — the boot visual is costume "0", which we
 *  hard-code here. Re-run scripts/dev/build-sprunki-manifest.py
 *  if the OG asset pack ever changes. */
const EMPTY_SLOT_FILE = "65c6f48ea19105ebd99a6b53e24842f3.svg";
export function emptySprunkiUrl() {
  return _resolvedBase ? `${_resolvedBase}${EMPTY_SLOT_FILE}` : null;
}

/** OG stage backdrop. The Scratch project ships seven backdrops
 *  (`backdrop`, `backdropcute`, `backdropevil`, …); `backdropcute`
 *  is the cheerful 680×321 illustrated sky-and-hills scene OG
 *  defaults to in showcase mode. Hard-coded by md5 so we don't
 *  have to plumb stage costumes through the manifest yet. */
const BACKDROP_FILE = "1c282eae03a608f17b842c01ceacf74e.svg";
export function backdropUrl() {
  return _resolvedBase ? `${_resolvedBase}${BACKDROP_FILE}` : null;
}

/** OG Mute Buttons SVGs — the three S/M/× icons that ride on top
 *  of every active sprunki. Costume names map straight to the
 *  intent here. */
const MUTE_BUTTON_FILES = {
  base:   "9803b5d3d73856f9961959093454b2b1.svg",
  mute:   "73903442b0f1ccf295e8d77861b01931.svg",
  solo:   "7a86c3b3e1fd3e3bef80bb5cd5cd1df2.svg",
  remove: "5d14b470589678ccbc9c5dd1e638aea9.svg",
};
export function muteButtonUrl(kind) {
  const file = MUTE_BUTTON_FILES[kind];
  return file && _resolvedBase ? `${_resolvedBase}${file}` : null;
}

/** OG palette icon for a character. The manifest stores the
 *  three variants emitted by the `Icons` sprite:
 *    normal   — full-color tile (default)
 *    pressed  — shadowed / actively-being-dragged
 *    dimmed   — grayscale (e.g. already on stage)
 *  Returns null if the manifest isn't loaded yet. */
export function iconUrlFor(sprunkiId, variant = "normal") {
  const og = ogCharacterById(sprunkiId);
  if (!og || !_resolvedBase) return null;
  const file = og.icon?.[variant];
  return file ? `${_resolvedBase}${file}` : null;
}

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
    } catch (_) { /* try next */ }
  }
  return null;
}

export function invalidateAssetBase() {
  _resolvedBase = null;
}
