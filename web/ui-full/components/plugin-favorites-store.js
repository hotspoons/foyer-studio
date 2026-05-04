// SPDX-License-Identifier: Apache-2.0
//
// Client-only plugin favorites (same module loaded as sibling to the
// picker — avoids a separate /core/ fetch that can go stale vs the
// component graph in some serve / cache setups).

const FAV_URIS_KEY = "foyer.plugins.favorites.v1";
const PICKER_FAV_ONLY_KEY = "foyer.plugins.picker.favorites_only.v1";

function readUris() {
  try {
    const raw = localStorage.getItem(FAV_URIS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeUris(set) {
  try {
    localStorage.setItem(FAV_URIS_KEY, JSON.stringify([...set].sort()));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent("foyer:plugin-favorites-changed"));
}

/** @param {string | undefined | null} uri */
export function isPluginFavorite(uri) {
  return !!(uri && readUris().has(uri));
}

/**
 * @param {string | undefined | null} uri
 * @returns {boolean} new favorite state (true = now a favorite)
 */
export function togglePluginFavorite(uri) {
  if (!uri) return false;
  const s = readUris();
  let on;
  if (s.has(uri)) {
    s.delete(uri);
    on = false;
  } else {
    s.add(uri);
    on = true;
  }
  writeUris(s);
  return on;
}

export function getPluginPickerFavoritesOnly() {
  try {
    return localStorage.getItem(PICKER_FAV_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {boolean} v */
export function setPluginPickerFavoritesOnly(v) {
  try {
    localStorage.setItem(PICKER_FAV_ONLY_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}
