// Keyboard bindings that snap the "focused" floating window to a slot.
//
// Modeled on Rectangle for macOS (the de-facto window-placement chord set)
// with the `Shift` modifier layered in so we don't collide with Foyer's
// `Ctrl+Alt+H/J/K/L` tile-focus family. See SLOT_SHORTCUTS in slots.js for
// the default map.
//
// "Focused" for placement purposes:
//   1. Top-of-z-stack floating window (most recently raised).
//   2. No floats open → the currently-focused tile in the tile tree gets
//      torn out into a floating window at the chosen slot. Matches how a
//      user reaches for Ctrl+Alt+Shift+Left while looking at a tiled
//      mixer — they expect "send this to the left half" to Just Work.

import { slotBounds, SLOT_SHORTCUTS } from "./slots.js";
import { isTypingTarget } from "../typing-guard.js";

let _installed = false;
let _handler = null;

function canonicalize(ev) {
  if (!ev.key) return "";
  const parts = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  const k = ev.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return "";
  let keyPart;
  if (k === " ") keyPart = "Space";
  else if (k.length === 1) keyPart = k.toUpperCase();
  else keyPart = k.charAt(0).toUpperCase() + k.slice(1);
  parts.push(keyPart);
  return parts.join("+");
}

function matchSlot(ev) {
  const combo = canonicalize(ev);
  if (!combo) return null;
  for (const [slotId, binding] of Object.entries(SLOT_SHORTCUTS)) {
    if (binding === combo) return slotId;
  }
  return null;
}

// Delegate to the shared typing guard so shadow-DOM text inputs (chat,
// agent, renames inside Lit components) are detected too — a plain
// `target instanceof` check stops at the shadow host.
const inTextInput = (ev) => isTypingTarget(ev);

/**
 * Move the topmost floating window to the named slot. If no floats are
 * open, tear the focused tile-tree leaf out into a floating window at
 * the slot.
 */
function applySlot(layout, slotId) {
  const rect = slotBounds(slotId);
  if (!rect) return;
  const floats = layout.floating ? layout.floating() : [];
  const shown = floats.filter((f) => !f.minimized);
  if (shown.length > 0) {
    shown.sort((a, b) => (b.z | 0) - (a.z | 0));
    const top = shown[0];
    layout.floatSet(top.id, { ...rect, slot: slotId });
    layout.raiseFloat(top.id);
    try {
      localStorage.setItem(`foyer.layout.sticky.${top.view}`, slotId);
    } catch {}
    return;
  }
  // No open floats → tear the focused tile into a new float at the slot.
  const focusId = layout.focusId;
  if (!focusId) return;
  // Resolve the leaf to grab its view + props before removing it.
  const tree = layout.tree;
  const find = (n) => {
    if (!n) return null;
    if (n.kind === "leaf") return n.id === focusId ? n : null;
    for (const c of n.children || []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  const leaf = find(tree);
  if (!leaf) return;
  layout.removeLeaf?.(focusId, { allowEmpty: true });
  layout.openFloating(leaf.view, leaf.props || {}, { slot: slotId });
}

/** Install the global keydown listener. Idempotent. */
export function installSlotKeybinds(layout) {
  if (_installed) return;
  _installed = true;
  _handler = (ev) => {
    if (inTextInput(ev)) return;
    const slotId = matchSlot(ev);
    if (!slotId) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    applySlot(layout, slotId);
  };
  // Capture phase so we win over local handlers (e.g. arrow keys in the
  // timeline). The no-text-input gate keeps form editing unaffected.
  window.addEventListener("keydown", _handler, true);
}

export function uninstallSlotKeybinds() {
  if (_handler) window.removeEventListener("keydown", _handler, true);
  _handler = null;
  _installed = false;
}
