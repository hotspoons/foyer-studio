// Minimal AHK-flavored script parser.
//
// Grammar (reduced from real AutoHotkey):
//
//   script   := line*
//   line     := comment | blank | hotkey-single | hotkey-block | command | "Return"
//   comment  := ";" any... EOL
//   hotkey-single  := modifiers key "::" command
//   hotkey-block   := modifiers key "::" EOL (command | blank | comment)* "Return"
//   modifiers      := ( "^" | "!" | "+" | "#" )*
//   key            := alpha | digit | F1..F24 | named-key
//   command        := verb ( arg ( "," arg )* )?
//   verb           := identifier
//   arg            := (non-comma, non-newline)*
//
// The result is an AST:
//   { hotkeys: [{ combo: { ctrl, alt, shift, meta, key }, body: [{ verb, args[] }] }],
//     errors: [{ line, message }] }
//
// Case-insensitive on verbs and modifiers. Keys are normalized to lowercase.
// Pure, no side effects — the runtime decides what the commands mean.

const NAMED_KEYS = new Set([
  "enter", "return", "space", "tab", "escape", "esc",
  "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "insert", "delete", "backspace",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
]);

/** Parse an AHK-ish script into an AST. */
export function parseScript(source) {
  const out = { hotkeys: [], errors: [] };
  if (typeof source !== "string") return out;

  const rawLines = source.split(/\r?\n/);
  let i = 0;
  let pendingHotkey = null; // hotkey combo whose block body we're collecting

  const pushError = (lineNum, message) => out.errors.push({ line: lineNum, message });

  while (i < rawLines.length) {
    const lineNum = i + 1;
    const line = rawLines[i].replace(/;.*$/, "").trim();
    i++;
    if (line === "") continue;

    // Collecting a block body?
    if (pendingHotkey) {
      if (/^return$/i.test(line)) {
        out.hotkeys.push(pendingHotkey);
        pendingHotkey = null;
        continue;
      }
      const cmd = parseCommand(line, lineNum, pushError);
      if (cmd) pendingHotkey.body.push(cmd);
      continue;
    }

    // Hotkey line?  "<modifiers><key>::" then maybe an inline command.
    const hk = /^([\^!+#]*)([A-Za-z0-9_]+|[`~\-=\[\]\\;',./]|\\)::(.*)$/.exec(line);
    if (hk) {
      const combo = parseCombo(hk[1], hk[2]);
      if (!combo) {
        pushError(lineNum, `unrecognized key "${hk[2]}"`);
        continue;
      }
      const tail = hk[3].trim();
      if (tail === "") {
        pendingHotkey = { combo, body: [] };
        continue;
      }
      // Inline single-line hotkey.
      const cmd = parseCommand(tail, lineNum, pushError);
      if (cmd) out.hotkeys.push({ combo, body: [cmd] });
      continue;
    }

    // Bare command outside a hotkey body is an error (for now).
    pushError(lineNum, `stray command outside hotkey body: "${line}"`);
  }

  // If we hit EOF with an open block, close it gracefully.
  if (pendingHotkey) {
    if (pendingHotkey.body.length > 0) out.hotkeys.push(pendingHotkey);
    else pushError(rawLines.length, "hotkey declared without a body");
  }

  return out;
}

function parseCombo(modifiers, rawKey) {
  const lower = rawKey.toLowerCase();
  let key = lower;
  if (!NAMED_KEYS.has(key) && key.length !== 1) return null;
  const combo = {
    ctrl: modifiers.includes("^"),
    alt: modifiers.includes("!"),
    shift: modifiers.includes("+"),
    meta: modifiers.includes("#"),
    key,
  };
  return combo;
}

function parseCommand(text, lineNum, pushError) {
  // Verb is the first whitespace-delimited token. Args follow, split on comma.
  const m = /^([A-Za-z_]\w*)\s*(.*)$/.exec(text);
  if (!m) {
    pushError(lineNum, `cannot parse command "${text}"`);
    return null;
  }
  const verb = m[1];
  const rest = m[2];
  const args = rest === "" ? [] : rest.split(",").map((s) => s.trim());
  return { verb, args, line: lineNum };
}

/** Canonical string form of a combo (useful for UI + as a dedupe key). */
export function comboToString(c) {
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Meta");
  parts.push(c.key.length === 1 ? c.key.toUpperCase() : cap(c.key));
  return parts.join("+");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Match a keyboard event against a parsed combo. */
export function matchEvent(event, combo) {
  if (!!event.ctrlKey !== !!combo.ctrl) return false;
  if (!!event.altKey !== !!combo.alt) return false;
  if (!!event.shiftKey !== !!combo.shift) return false;
  if (!!event.metaKey !== !!combo.meta) return false;
  const ek = (event.key || "").toLowerCase();
  // Match either `key` directly (e.g. "a", "f1") or via common aliases.
  if (ek === combo.key) return true;
  if (combo.key === "space" && ek === " ") return true;
  if (combo.key === "escape" && ek === "esc") return true;
  if (combo.key === "esc" && ek === "escape") return true;
  if (combo.key === "return" && ek === "enter") return true;
  if (combo.key === "enter" && ek === "return") return true;
  return false;
}
