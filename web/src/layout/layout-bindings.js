// User-assigned keyboard chords that fire layout presets or saved layouts.
//
// Storage shape (localStorage `foyer.layout.bindings.v1`):
//   {
//     [comboString]: { kind: "preset" | "named", name: "<preset-or-layout-name>" }
//   }
//
// `comboString` matches parser.js's `comboToString` canonical form:
// modifier tokens in `Ctrl+Alt+Shift+Meta+Key` order, key uppercase.
//
// At boot we subscribe to keydown in capture phase; a matching chord loads
// the target preset or named layout and `preventDefault`s the event.

const KEY = "foyer.layout.bindings.v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function save(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

let _installed = false;
let _map = load();
let _handler = null;

export function listBindings() {
  return _map;
}

/** Find the combo assigned to a given (kind, name) pair, or `null`. */
export function bindingFor(kind, name) {
  for (const [combo, entry] of Object.entries(_map)) {
    if (entry.kind === kind && entry.name === name) return combo;
  }
  return null;
}

export function setBinding(combo, kind, name) {
  if (!combo || !name) return;
  // Only one binding per target at a time — clear any old one.
  for (const [c, e] of Object.entries(_map)) {
    if (e.kind === kind && e.name === name) delete _map[c];
  }
  _map[combo] = { kind, name };
  save(_map);
  window.dispatchEvent(new CustomEvent("foyer:layout-bindings-changed"));
}

export function clearBinding(combo) {
  delete _map[combo];
  save(_map);
  window.dispatchEvent(new CustomEvent("foyer:layout-bindings-changed"));
}

/** Install the global keydown handler. Idempotent. */
export function installBindingsRuntime(layoutStore) {
  if (_installed) return;
  _installed = true;
  _handler = (ev) => {
    // Don't hijack typing.
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t && t.isContentEditable)) return;
    const combo = eventToCombo(ev);
    if (!combo) return;
    const entry = _map[combo];
    if (!entry) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (entry.kind === "preset") layoutStore.loadPreset(entry.name);
    else if (entry.kind === "named") layoutStore.loadNamed(entry.name);
  };
  window.addEventListener("keydown", _handler, true);
}

/** Build a canonical combo string from a KeyboardEvent. Returns null for bare modifiers. */
export function eventToCombo(ev) {
  const parts = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  const k = (ev.key || "").toLowerCase();
  if (!k || k === "control" || k === "alt" || k === "shift" || k === "meta") return null;
  let keyPart;
  if (k === " ") keyPart = "Space";
  else if (k.length === 1) keyPart = k.toUpperCase();
  else keyPart = k.charAt(0).toUpperCase() + k.slice(1);
  parts.push(keyPart);
  return parts.join("+");
}
