// AHK-flavored automation runtime.
//
// Loads a parsed script (see parser.js), registers keydown listeners for
// every hotkey, and executes command bodies against Foyer's runtime surfaces
// (ws, layout, theme, toast). Designed for continuous edits — calling
// `install(script)` replaces any previously-installed script cleanly.
//
// Commands implemented (case-insensitive verb):
//
//   Action <id>
//       invoke_action <id> — runs a named action from the catalog.
//   ControlSet <id>, <value>
//       set a control to a numeric, boolean, or string value.
//       `true`, `false`, `on`, `off` coerce to boolean.
//   Layout <preset-name>
//       load a tile-tree preset by name (from tile-tree.js PRESETS).
//   NamedLayout <saved-name>
//       load one of the user's named layouts.
//   Float <view> [, slot]
//       open a floating window with the given view, optionally at a slot.
//   Sleep <ms>
//       pause execution of this body.
//   Msg <text>
//       toast notification.
//   Theme <name>
//       dim | dark | light | auto
//   Focus <direction>
//       left | right | up | down — move keyboard focus among tiles.
//   Close
//       close the focused tile.
//   Split row|column|h|v <view>
//       split the focused tile in the given direction with `view`.

import { matchEvent, comboToString } from "./parser.js";

/** State for the currently-installed script. */
let _state = {
  handler: null,
  hotkeys: [], // [{combo, comboString, body}]
};

/**
 * Install the given parsed AST (from parseScript). Safe to call repeatedly —
 * each call replaces prior registrations. Pass `null` to tear down.
 * Returns a summary of what got installed: { installed: n, conflicts: [...] }
 */
export function install(ast) {
  teardown();
  if (!ast || !ast.hotkeys || ast.hotkeys.length === 0) {
    return { installed: 0, conflicts: [] };
  }

  const hotkeys = ast.hotkeys.map((hk) => ({
    combo: hk.combo,
    comboString: comboToString(hk.combo),
    body: hk.body,
  }));

  const handler = (event) => {
    // Avoid hijacking while the user is typing in a form field — otherwise
    // Sleep + ControlSet scripts would fight the text input.
    const t = event.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || (t && t.isContentEditable)) {
      return;
    }
    for (const hk of hotkeys) {
      if (matchEvent(event, hk.combo)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        runBody(hk.body).catch((err) => {
          console.error(`automation hotkey ${hk.comboString} failed`, err);
        });
        return;
      }
    }
  };

  // Use capture so we fire before Keybinds and before any focused component.
  window.addEventListener("keydown", handler, true);

  _state = { handler, hotkeys };
  return { installed: hotkeys.length, conflicts: [] };
}

export function teardown() {
  if (_state.handler) {
    window.removeEventListener("keydown", _state.handler, true);
  }
  _state = { handler: null, hotkeys: [] };
}

/** List of currently-active hotkey summaries (for the automation panel). */
export function activeHotkeys() {
  return _state.hotkeys.map((hk) => ({
    combo: hk.comboString,
    summary: summarizeBody(hk.body),
  }));
}

function summarizeBody(body) {
  return body.map((c) => {
    if (c.args.length === 0) return c.verb;
    return `${c.verb} ${c.args.join(", ")}`;
  }).join(" → ");
}

// ── command execution ────────────────────────────────────────────────────

async function runBody(body) {
  for (const cmd of body) {
    await runCommand(cmd);
  }
}

async function runCommand({ verb, args }) {
  const v = verb.toLowerCase();
  switch (v) {
    case "action":
      return call_action(arg(args, 0));
    case "controlset":
      return call_controlset(arg(args, 0), arg(args, 1));
    case "layout":
      return call_layout(arg(args, 0));
    case "namedlayout":
      return call_named_layout(arg(args, 0));
    case "float":
      return call_float(arg(args, 0), arg(args, 1));
    case "sleep":
      return new Promise((r) => setTimeout(r, parseIntSafe(arg(args, 0), 0)));
    case "msg":
      return call_msg(args.join(", "));
    case "theme":
      return call_theme(arg(args, 0));
    case "focus":
      return call_focus(arg(args, 0));
    case "close":
      return call_close();
    case "split":
      return call_split(arg(args, 0), arg(args, 1));
    default:
      console.warn(`automation: unknown verb "${verb}"`);
  }
}

function arg(list, n) { return list.length > n ? list[n] : ""; }

function parseIntSafe(s, fallback) {
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) ? n : fallback;
}

function coerceValue(s) {
  const t = String(s).trim();
  if (/^(true|on)$/i.test(t)) return true;
  if (/^(false|off)$/i.test(t)) return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  // Strip surrounding quotes if present.
  if ((t.startsWith('"') && t.endsWith('"'))
   || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function call_action(id) {
  if (!id) return;
  window.__foyer?.ws?.send({ type: "invoke_action", id });
}
function call_controlset(id, rawValue) {
  if (!id) return;
  window.__foyer?.ws?.controlSet(id, coerceValue(rawValue));
}
function call_layout(name) {
  if (!name) return;
  window.__foyer?.layout?.loadPreset(name);
}
function call_named_layout(name) {
  if (!name) return;
  window.__foyer?.layout?.loadNamed(name);
}
function call_float(view, slot) {
  if (!view) return;
  const placement = slot ? { slot } : undefined;
  window.__foyer?.layout?.openFloating(view, {}, placement);
}
async function call_msg(text) {
  const mod = await import("./toast.js");
  mod.toast(text);
}
async function call_theme(name) {
  const { setTheme } = await import("foyer-ui-core/theme.js");
  setTheme(name);
}
function call_focus(direction) {
  const layout = window.__foyer?.layout;
  if (!layout) return;
  const rects = new Map();
  for (const el of document.querySelectorAll("foyer-tile-leaf")) {
    if (el.leaf?.id) rects.set(el.leaf.id, el.getBoundingClientRect());
  }
  layout.moveFocus(direction, rects);
}
function call_close() {
  window.__foyer?.layout?.closeFocused();
}
function call_split(dir, view) {
  const d = (dir || "").toLowerCase();
  const direction = (d === "column" || d === "v" || d === "vertical") ? "column" : "row";
  window.__foyer?.layout?.split(direction, view || "mixer");
}
