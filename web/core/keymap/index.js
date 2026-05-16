// Active-keymap accessor. Reads localStorage, falls back to the "foyer"
// profile, and provides two resolvers call sites use:
//
//   resolveWheel(zone, ev) → "hzoom" | "vzoom" | "hscroll" | "vscroll" | "none"
//   matchKey(actionId, ev) → bool
//
// `setActiveProfile(id)` dispatches `foyer:keymap-changed` so live handlers
// can refresh any cached predicates. Most call sites don't bother caching —
// resolveWheel is cheap enough to call inline on every wheel event.

import { PROFILES, PROFILE_ORDER, DEFAULT_PROFILE_ID } from "./profiles.js";

const STORAGE_KEY = "foyer.keymap.profile";

export function listProfiles() {
  return PROFILE_ORDER.map((id) => PROFILES[id]);
}

export function getActiveProfileId() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && PROFILES[v]) return v;
  } catch { /* ignore */ }
  return DEFAULT_PROFILE_ID;
}

export function getActiveProfile() {
  return PROFILES[getActiveProfileId()] || PROFILES[DEFAULT_PROFILE_ID];
}

export function setActiveProfile(id) {
  if (!PROFILES[id]) return false;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent("foyer:keymap-changed", {
      detail: { profileId: id },
    }));
  } catch { /* ignore */ }
  return true;
}

/**
 * Resolve a wheel event for a named zone into an op id.
 *
 * Modifier priority: alt > ctrl/meta > shift > plain. Compound modifiers
 * (e.g. Shift+Ctrl) collapse to the most specific single key the profile
 * defines, which matches what each DAW we model actually does today.
 *
 * Unknown zone → falls back to the "foyer" profile so a new call site
 * doesn't dead-end before its profile entry lands.
 */
export function resolveWheel(zone, ev) {
  const profile = getActiveProfile();
  const map = profile?.wheel?.[zone] || PROFILES[DEFAULT_PROFILE_ID].wheel[zone];
  if (!map) return "none";
  if (ev.altKey) return map.alt || "none";
  if (ev.ctrlKey || ev.metaKey) return map.ctrl || "none";
  if (ev.shiftKey) return map.shift || "none";
  return map.plain || "none";
}

/**
 * Exact-match the keyboard event against any of the bindings for an action.
 * `mod` means platform Ctrl/Cmd: matches `ctrlKey || metaKey`.
 */
export function matchKey(actionId, ev) {
  const profile = getActiveProfile();
  const list = profile?.keys?.[actionId];
  if (!list || list.length === 0) return false;
  for (const b of list) {
    if (matchOne(b, ev)) return true;
  }
  return false;
}

function matchOne(b, ev) {
  if (b.code != null && ev.code !== b.code) return false;
  if (b.key != null) {
    const evKey = ev.key;
    if (b.key.length === 1 && evKey?.length === 1) {
      if (evKey.toLowerCase() !== b.key.toLowerCase()) return false;
    } else {
      if (evKey !== b.key) return false;
    }
  }
  const mod = ev.ctrlKey || ev.metaKey;
  if (!!b.mod !== !!mod) return false;
  if (!!b.shift !== !!ev.shiftKey) return false;
  if (!!b.alt !== !!ev.altKey) return false;
  return true;
}

/**
 * Pretty label for an action — first binding's `label` field, or null if
 * the action isn't bound in the active profile. Useful for menu hints.
 */
export function keyLabel(actionId) {
  const profile = getActiveProfile();
  const list = profile?.keys?.[actionId];
  return list?.[0]?.label || null;
}

/**
 * Apply a temporal-zoom wheel anchored at the pointer. Shared between
 * timeline body / overview so the math + clamps stay in one place.
 * Returns the new zoom level; caller is responsible for redrawing.
 *
 * `getZoom` / `setZoom` are functions so we don't have to standardise
 * on an instance shape; callers wire them to their own state.
 */
export function zoomFactorFromWheel(deltaY) {
  if (deltaY === 0) return 1;
  return deltaY < 0 ? 1.18 : 1 / 1.18;
}
