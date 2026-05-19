// SPDX-License-Identifier: Apache-2.0
// Touch-variant panel catalog + per-user pinning.
//
// Every screen the user can land on is a "panel". Four are always
// in the bottom-nav (Mixer / Timeline / Tracks / More); the rest
// live inside More until the user pins them. Pinning surfaces them
// as bottom-nav slots (max 1 extra) AND as a chip row at the top
// of More for quick access.
//
// Storage is localStorage — this is a per-client preference, not
// shared session state (per CLAUDE.md's "Backend = source of truth"
// rule, which carves out per-client UI prefs as the exception).

const STORAGE_KEY = "foyer.ui.touch.pins";

/// Built-in panels. Each has a stable id (used in pins + URL hash),
/// a human label, an icon (foyer-ui-core/icons.js key), a category
/// for grouping in More, and a `mount` thunk that returns the
/// element tag the active-panel container will render.
///
/// `kind`:
///   - "tab"   — one of the four hard-coded bottom-nav slots; not pinnable.
///   - "panel" — a regular screen; pinnable.
///   - "modal" — opens a dialog rather than swapping the active panel.
const CATALOG = [
  { id: "mixer",        label: "Mixer",      icon: "adjustments-horizontal", kind: "tab",   category: "core" },
  { id: "timeline",     label: "Timeline",   icon: "squares-2x2",            kind: "tab",   category: "core" },
  { id: "tracks",       label: "Tracks",     icon: "queue-list",             kind: "tab",   category: "core" },
  { id: "more",         label: "More",       icon: "bars-3",                 kind: "tab",   category: "core" },

  { id: "piano-roll",   label: "Piano roll",   icon: "musical-note",        kind: "panel",  category: "edit" },
  { id: "beat-seq",     label: "Beat sequencer", icon: "squares-2x2",       kind: "panel",  category: "edit" },
  { id: "plugins",      label: "Plugins",      icon: "puzzle-piece",        kind: "panel",  category: "edit" },
  { id: "automation",   label: "Automation",   icon: "adjustments-vertical",kind: "panel",  category: "edit" },
  { id: "sections",     label: "Sections",     icon: "bars-3-bottom-left",  kind: "panel",  category: "edit" },

  { id: "spectrum",     label: "Spectrum",     icon: "chart-bar",           kind: "panel",  category: "visualize" },

  { id: "sessions",     label: "Sessions",     icon: "folder-open",         kind: "panel",  category: "session" },
  { id: "snapshot",     label: "Snapshot",     icon: "document-duplicate",  kind: "modal",  category: "session" },

  { id: "agent",        label: "Agent",        icon: "chat-bubble-left-right", kind: "panel",  category: "agent" },
  { id: "scripts",      label: "Scripts",      icon: "command-line",        kind: "panel",  category: "agent" },

  { id: "midi-devices", label: "MIDI devices", icon: "musical-note",        kind: "panel",  category: "midi" },
  { id: "soft-keyboard",label: "Keyboard",     icon: "musical-note",        kind: "panel",  category: "midi" },

  { id: "console",      label: "Console",      icon: "command-line",        kind: "panel",  category: "developer" },
  { id: "diagnostics",  label: "Diagnostics",  icon: "check-circle",        kind: "panel",  category: "developer" },

  { id: "settings",     label: "Settings",     icon: "cog-6-tooth",         kind: "modal",  category: "settings" },
  { id: "language",     label: "Language",     icon: "globe-alt",           kind: "modal",  category: "settings" },
];

const ID_INDEX = new Map(CATALOG.map((p) => [p.id, p]));

export function listPanels() {
  return CATALOG.slice();
}

export function panelById(id) {
  return ID_INDEX.get(id) || null;
}

/// Panel groups for the More screen. Order here is the rendering
/// order. "core" is excluded — those are the bottom-nav tabs.
export const CATEGORIES = [
  { id: "edit",      label: "Edit" },
  { id: "visualize", label: "Visualize" },
  { id: "midi",      label: "MIDI" },
  { id: "session",   label: "Session" },
  { id: "agent",     label: "Agent" },
  { id: "developer", label: "Developer" },
  { id: "settings",  label: "Settings" },
];

// ─── Pinning ────────────────────────────────────────────────────

function readPins() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((id) => typeof id === "string" && ID_INDEX.has(id) && ID_INDEX.get(id).kind !== "tab");
  } catch {
    return [];
  }
}

function writePins(list) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* private mode / quota — fine, lose preference */ }
  // Broadcast so any component watching can refresh without a
  // full page reload.
  globalThis.dispatchEvent?.(new CustomEvent("foyer-touch:pins-changed", { detail: { pins: list } }));
}

export function getPins() {
  return readPins();
}

export function isPinned(id) {
  return readPins().includes(id);
}

export function togglePin(id) {
  const panel = ID_INDEX.get(id);
  if (!panel || panel.kind === "tab") return;
  const list = readPins();
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(id);
  writePins(list);
}

export function onPinsChange(handler) {
  const wrap = (ev) => handler(ev.detail?.pins || []);
  globalThis.addEventListener?.("foyer-touch:pins-changed", wrap);
  return () => globalThis.removeEventListener?.("foyer-touch:pins-changed", wrap);
}

// ─── Active panel ───────────────────────────────────────────────
//
// The URL hash drives the active panel so deep-links and back-button
// behaviour both work without us hand-rolling a router.

const HASH_PREFIX = "panel/";
export const DEFAULT_PANEL = "mixer";

export function activePanelFromHash() {
  try {
    const hash = (globalThis.location?.hash || "").replace(/^#/, "");
    if (hash.startsWith(HASH_PREFIX)) {
      const id = hash.slice(HASH_PREFIX.length);
      const panel = ID_INDEX.get(id);
      if (panel && panel.kind !== "modal") return id;
    }
  } catch { /* no window */ }
  return DEFAULT_PANEL;
}

export function setActivePanel(id) {
  const panel = ID_INDEX.get(id);
  if (!panel || panel.kind === "modal") return;
  try {
    const next = `#${HASH_PREFIX}${id}`;
    if (globalThis.location?.hash !== next) {
      globalThis.location.hash = next;
    }
  } catch { /* no window */ }
}
