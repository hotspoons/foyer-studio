// Sprunki asset-pack bridge.
//
// Resolves character SVG art (idle / play costumes, palette icons,
// backdrop, S/M/× buttons) for the patches in patches.js. Each patch
// declares a `sprunki_id` pointing at a character; this module turns
// that id into a URL the stage <img> can render.
//
// Two interchangeable sources live behind the same public API:
//
//   "builtin" — Foyer Originals pack, shipped in-tree under
//               web/ui-sprunki/builtin-assets/. No download required.
//               This is the default.
//
//   "og"      — Reverse-engineered OG sprunki pack, fetched at
//               runtime from archive.org via the asset_packs system
//               and extracted to $XDG_DATA_HOME/foyer/asset-packs/
//               sprunki/. Served at /asset-packs/sprunki/...
//
// Both manifests share the same JSON shape: a `characters[]` list
// keyed by id, each with `costumes.{idle,idle_alternate,play,
// alternate}` and `icon.{normal,pressed,dimmed}`. Switch sources via
// `setAssetSource("builtin"|"og")`; callers don't need to know which
// is active.
//
// Consumer side (sprunki-stage.js, patch-palette.js, ...) imports the
// resolver functions below and ignores which source they came from.
// Switching sources fires `asset-source-changed` on the sprunkiStore
// — that's the cue for the app shell to re-init and re-render.

import { sprunkiStore } from "./state-store.js";

// Per-source configuration. The OG bucket keeps the asset-base
// fallback (the archive.org zip sometimes wraps under sprunki-website/,
// sometimes not — depends on the build).
const SOURCES = {
  builtin: {
    manifestUrl: new URL("./builtin-assets/manifest.json", import.meta.url).href,
    baseCandidates: ["/ui-sprunkadoo/builtin-assets/"],
    // File names below are hard-coded for the OG pack only — the
    // Foyer Originals manifest holds them as explicit fields so we
    // don't carry the md5 lookup table around.
    emptyFile:           "empty.svg",
    emptyHorrorFile:     "empty-horror.svg",
    // Idle gaze variants for the empty placeholder — same scheme as
    // populated sprunkis. Stage cycles between them on the same
    // randomized scheduler so empty slots blink + look around via
    // hard sprite swaps (no inline SVG, no CSS keyframes).
    emptyVariantFiles: {
      "blink":      "empty-idle-blink.svg",
      "look-left":  "empty-idle-look-left.svg",
      "look-right": "empty-idle-look-right.svg",
    },
    backdropFile:        "backdrop.svg",
    backdropHorrorFile:  "backdrop-horror.svg",
    muteButtonFiles: {
      base:   "button-base.svg",
      mute:   "button-mute.svg",
      solo:   "button-solo.svg",
      remove: "button-remove.svg",
    },
  },
  og: {
    manifestUrl: new URL("./sprunki-assets.json", import.meta.url).href,
    // Order matters: the working path goes first to keep the dev
    // console clean. See SPRUNKADOO_VISION.md → "404 probe noise."
    baseCandidates: [
      "/asset-packs/sprunki/assets/",
      "/asset-packs/sprunki/sprunki-website/assets/",
    ],
    // The OG manifest stores asset files as content-addressed md5s,
    // so the special stage sprites (empty Polo, backdropcute, mute
    // buttons) get hard-coded here. See the original notes in this
    // file's git history for how these were picked. Horror variants
    // sit in the same pack under `backdropevil` (also content-
    // addressed); the empty Polo horror look uses an alternate
    // mute-icon arrangement, no separate file.
    emptyFile:           "65c6f48ea19105ebd99a6b53e24842f3.svg",
    emptyHorrorFile:     "65c6f48ea19105ebd99a6b53e24842f3.svg",
    backdropFile:        "1c282eae03a608f17b842c01ceacf74e.svg",
    // backdropevil md5 from the OG project.json — the spooky
    // dark-sky variant the source game flips to in horror mode.
    backdropHorrorFile:  "7d8543e7fb8e7add27c5b7e4ea7daea8.svg",
    muteButtonFiles: {
      base:   "9803b5d3d73856f9961959093454b2b1.svg",
      mute:   "73903442b0f1ccf295e8d77861b01931.svg",
      solo:   "7a86c3b3e1fd3e3bef80bb5cd5cd1df2.svg",
      remove: "5d14b470589678ccbc9c5dd1e638aea9.svg",
    },
  },
};

const DEFAULT_SOURCE = "builtin";

// Per-source caches so a toggle between built-in and OG doesn't
// re-fetch the side already loaded.
const _states = {
  builtin: { manifest: null, manifestPromise: null, resolvedBase: null },
  og:      { manifest: null, manifestPromise: null, resolvedBase: null },
};

function _currentSource() {
  const s = sprunkiStore().assetSource;
  return SOURCES[s] ? s : DEFAULT_SOURCE;
}

function _cfg() { return SOURCES[_currentSource()]; }
function _st()  { return _states[_currentSource()]; }

/** Force the active source. Returns true if it changed. */
export function setAssetSource(source) {
  return sprunkiStore().setAssetSource(source);
}
export function getAssetSource() { return _currentSource(); }

export function loadSprunkiManifest() {
  const cfg = _cfg();
  const st = _st();
  if (st.manifestPromise) return st.manifestPromise;
  st.manifestPromise = fetch(cfg.manifestUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`manifest fetch HTTP ${r.status}`);
      return r.json();
    })
    .then((m) => { st.manifest = m; return m; })
    .catch((e) => {
      console.warn(`[sprunki-assets] failed to load manifest for "${_currentSource()}":`, e);
      st.manifestPromise = null;
      throw e;
    });
  return st.manifestPromise;
}

export function manifestSync() {
  return _st().manifest;
}

/** Character record for a given sprunki_id, or null when the
 *  manifest isn't loaded yet. */
export function ogCharacterById(sprunkiId) {
  const m = _st().manifest;
  if (!m || !sprunkiId) return null;
  return m.characters.find((c) => c.id === sprunkiId) || null;
}

/** Idle-gaze variants for a character — { blink, lookLeft, lookRight }
 *  URLs. Each entry is null if the manifest doesn't ship that variant
 *  (older OG manifest that predates the idle_variants bucket).
 *  Used by sprunki-stage to cycle a populated sprunki through
 *  randomized blink + look-around frames while it's not actively
 *  playing music. */
export function idleVariantsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return { blink: null, lookLeft: null, lookRight: null };
  const variants = og.costumes?.idle_variants || [];
  const lookup = (name) => {
    const entry = variants.find((v) => v.name === name);
    return entry?.file ? `${base}${entry.file}` : null;
  };
  return {
    blink:     lookup("blink"),
    lookLeft:  lookup("look-left"),
    lookRight: lookup("look-right"),
  };
}

/** Per-character animation profile from the manifest. Returns an
 *  object `{ kind, amplitude }` describing the subtle idle motion +
 *  on-hit reaction for this sprunki — drums bob, bass/melody sway,
 *  vocal/fx look-around. Defaults to a gentle bob when the manifest
 *  doesn't declare one (older OG manifest, or unknown character). */
export function animationProfileFor(sprunkiId) {
  const c = ogCharacterById(sprunkiId);
  const a = c?.animation;
  if (a && typeof a === "object") {
    return {
      kind: a.kind || "bob",
      amplitude: typeof a.amplitude === "number" ? a.amplitude : 3,
    };
  }
  return { kind: "bob", amplitude: 3 };
}

/** Idle-costume URL (first frame) for a sprunki id. */
export function idleCostumeUrlFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return null;
  const file = og.costumes?.idle?.[0]?.file;
  return file ? `${base}${file}` : null;
}

/** Safe (default-mode) idle frames for a character. */
export function allIdleCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return [];
  return (og.costumes?.idle || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${base}${f}`);
}

/** Scary-mode idle frames. Both source packs ship horror variants
 *  as of the late-2026-05-25 push (the asset agent added them to
 *  Foyer Originals + the OG pack already had `idle2` in its
 *  project.json). Surface these only when scary mode + parental
 *  unlock both say yes. */
export function alternateIdleCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return [];
  return (og.costumes?.idle_alternate || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${base}${f}`);
}

/** Play-costume URL (first play frame) for a sprunki id. */
export function playCostumeUrlFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return null;
  const file = og.costumes?.play?.[0]?.file;
  return file ? `${base}${file}` : null;
}

/** All play-cycle frames for a character — rotated by the stage
 *  when the slot's track makes sound. */
export function allPlayCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return [];
  return (og.costumes?.play || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${base}${f}`);
}

/** Scary-mode play frames (the `alternate` bucket in both manifests).
 *  Parallels `alternateIdleCostumeUrlsFor` — when scaryMode + parental
 *  unlock are both on, the stage's frame-advance reads from these
 *  instead of `play` so each beat hit shows the horror animation. */
export function allAlternatePlayCostumeUrlsFor(sprunkiId) {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return [];
  return (og.costumes?.alternate || [])
    .map((c) => c.file)
    .filter(Boolean)
    .map((f) => `${base}${f}`);
}

/** Sprunki id we conceptually treat as "empty slot" — kept for any
 *  consumers that still need a manifest id. The actual empty visual
 *  uses the dedicated empty.svg sprite via `emptySprunkiUrl()`. */
export const EMPTY_SLOT_SPRUNKI_ID = "raddy";

/** URL for the empty-slot placeholder sprite.
 *
 *  When `gaze` is one of `"blink"`, `"look-left"`, `"look-right"`,
 *  returns the matching idle-variant sprite (only available on the
 *  built-in pack — the OG pack has just the single empty Polo, so
 *  the variant falls back to the base sprite there). Used by the
 *  stage's per-slot idle scheduler to cycle empty slots through
 *  the same blink/look-around variants as costumed sprunkis. */
export function emptySprunkiUrl({ scary = false, gaze = null } = {}) {
  const cfg = _cfg();
  const base = _st().resolvedBase;
  if (!base) return null;
  if (!scary && gaze && cfg.emptyVariantFiles?.[gaze]) {
    return `${base}${cfg.emptyVariantFiles[gaze]}`;
  }
  const file = scary && cfg.emptyHorrorFile ? cfg.emptyHorrorFile : cfg.emptyFile;
  return `${base}${file}`;
}

export function backdropUrl({ scary = false } = {}) {
  const cfg = _cfg();
  const base = _st().resolvedBase;
  if (!base) return null;
  const file = scary && cfg.backdropHorrorFile ? cfg.backdropHorrorFile : cfg.backdropFile;
  return `${base}${file}`;
}

export function muteButtonUrl(kind) {
  const cfg = _cfg();
  const base = _st().resolvedBase;
  const file = cfg.muteButtonFiles[kind];
  return file && base ? `${base}${file}` : null;
}

/** Palette icon for a character. Variants: normal | pressed | dimmed.
 *  Returns null if the manifest isn't loaded yet. */
export function iconUrlFor(sprunkiId, variant = "normal") {
  const og = ogCharacterById(sprunkiId);
  const base = _st().resolvedBase;
  if (!og || !base) return null;
  const file = og.icon?.[variant];
  return file ? `${base}${file}` : null;
}

/** Find the first asset-base candidate that responds 200 OK to a
 *  HEAD for the manifest's first character idle frame. Cached for
 *  the lifetime of the active source. */
export async function probeAssetBase() {
  const st = _st();
  if (st.resolvedBase) return st.resolvedBase;
  if (!st.manifest) await loadSprunkiManifest();
  const cfg = _cfg();
  const probeFile = st.manifest?.characters?.[0]?.costumes?.idle?.[0]?.file;
  if (!probeFile) return null;
  for (const base of cfg.baseCandidates) {
    try {
      const r = await fetch(`${base}${probeFile}`, { method: "HEAD" });
      if (r.ok) {
        st.resolvedBase = base;
        console.info(`[sprunki-assets] "${_currentSource()}" base resolved: ${base}`);
        return base;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

/** Drop the cached base probe — call this after the OG pack finishes
 *  downloading (the disk path is now ready) or whenever the active
 *  source changes. The manifest cache is per-source so it survives. */
export function invalidateAssetBase() {
  const st = _st();
  st.resolvedBase = null;
}

/** Drop everything cached for one source — used when callers want a
 *  full re-init (e.g. user toggles back to OG after a wipe). */
export function invalidateSource(source = null) {
  const key = source || _currentSource();
  if (!_states[key]) return;
  _states[key] = { manifest: null, manifestPromise: null, resolvedBase: null };
}
