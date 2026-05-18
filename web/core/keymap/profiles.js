// DAW keymap + mouse-convention profiles.
//
// Each profile says, for each wheel zone, what plain/shift/ctrl/alt + wheel
// should do — and for each named action, which key combos fire it. The active
// profile is selected from Preferences. New zones / actions can be added
// later without breaking existing profiles: missing entries fall through to
// "foyer" (the native default).
//
// Operation IDs (wheel):
//   hzoom    — horizontal (temporal) zoom anchored at the pointer
//   vzoom    — vertical (lane-height) zoom for the lane under the pointer
//   hscroll  — horizontal pan (timeline scroll)
//   vscroll  — vertical scroll — yielded to the browser / scroll ancestor
//   none     — explicitly do nothing (eats the wheel event)
//
// We intentionally pick ONE modifier flavour per event (alt > ctrl > shift >
// plain). Compound modifiers (shift+ctrl etc) fall back to the most-specific
// single modifier the profile defines, which matches every DAW we model.
//
// Authoring honesty: these are best-effort defaults pulled from each DAW's
// shipped factory bindings as of late-2025 documentation. Power users
// customise these inside the DAW too; the goal is to give a Foyer user
// muscle memory parity with the most-common factory layout, not a 1:1
// recreation of every binding.

/** Op IDs valid in a wheel slot. */
export const WHEEL_OPS = ["hzoom", "vzoom", "hscroll", "vscroll", "none"];

/** Wheel zones the timeline + adjacent surfaces broadcast through. */
export const WHEEL_ZONES = [
  "timeline_main",      // body of the timeline (lanes + waveforms)
  "timeline_ruler",     // the time ruler strip at the top
  "timeline_overview",  // Ardour-style summary strip at the bottom
  "sequencer_grid",     // beat-sequencer grid body
];

/** Action IDs valid in a key slot. The set is open — call sites that don't
 *  recognise an action just ignore it. */
export const ACTIONS = [
  "transport.play_toggle",
  "transport.record_toggle",
  "transport.return_to_zero",
  "transport.go_to_end",
  "edit.undo",
  "edit.redo",
  "edit.split_at_playhead",
  "edit.duplicate",
  "editor.zoom_in",
  "editor.zoom_out",
  "editor.zoom_vertical_in",
  "editor.zoom_vertical_out",
  "editor.zoom_to_selection",
  "editor.zoom_previous",
  "region.mute_toggle",
];

/**
 * Build a key binding spec. `mod` is the platform Ctrl/Cmd. Any field left
 * undefined means "doesn't matter" (rather than "must be absent") — except
 * that callers only fire on an exact match by default, so unspecified shift
 * still implies shift=false.
 */
function key(opts) {
  return {
    key: opts.key,
    code: opts.code,
    mod: !!opts.mod,
    shift: !!opts.shift,
    alt: !!opts.alt,
    label: opts.label,
  };
}

/* ───────────────────────────── Profiles ───────────────────────────── */

const foyer = {
  id: "foyer",
  label: "Foyer (native)",
  description:
    "Wheel zooms at cursor on the timeline body; Shift/Ctrl pans; Alt zooms lanes. " +
    "=/- zoom horizontally; Shift =/- zooms lanes.",
  wheel: {
    timeline_main:     { plain: "hzoom",   shift: "hscroll", ctrl: "hscroll", alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "hscroll", alt: "hscroll" },
    timeline_overview: { plain: "hzoom",   shift: "hscroll", ctrl: "hscroll", alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: " ", mod: true, label: "Ctrl/Cmd+Space" })],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo": [
      key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" }),
      key({ key: "y", mod: true,              label: "Ctrl/Cmd+Y" }),
    ],
    "edit.split_at_playhead":     [key({ key: "s", label: "S" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "=", label: "=" })],
    "editor.zoom_out":            [key({ key: "-", label: "-" })],
    "editor.zoom_vertical_in":    [key({ key: "=", shift: true, label: "Shift+=" })],
    "editor.zoom_vertical_out":   [key({ key: "-", shift: true, label: "Shift+-" })],
    "editor.zoom_to_selection":   [key({ key: "e", mod: true, shift: true, label: "Ctrl/Cmd+Shift+E" })],
    "editor.zoom_previous":       [key({ key: "Backspace", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Backspace" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

// Pro Tools — Cmd+] / Cmd+[ are zoom in / out horizontally. Cmd+R / Cmd+\
// vertical. Plain wheel scrolls horizontally; Cmd-wheel zooms; Option/Alt
// adjusts amplitude (we map to vzoom-lane). Spacebar play/stop, F12 record.
const protools = {
  id: "protools",
  label: "Pro Tools",
  description:
    "Plain wheel scrolls the timeline; Cmd/Ctrl-wheel zooms at cursor; " +
    "Alt-wheel adjusts lane size. Cmd+] / Cmd+[ zoom horizontally.",
  wheel: {
    timeline_main:     { plain: "hscroll", shift: "vscroll", ctrl: "hzoom",   alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    timeline_overview: { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle": [
      key({ key: "F12", label: "F12" }),
      key({ key: "3", mod: true, label: "Cmd/Ctrl+3" }),
    ],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Cmd/Ctrl+Z" })],
    "edit.redo":                  [key({ key: "z", mod: true, shift: true, label: "Cmd/Ctrl+Shift+Z" })],
    "edit.split_at_playhead":     [key({ key: "e", mod: true, label: "Cmd/Ctrl+E" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Cmd/Ctrl+D" })],
    "editor.zoom_in":             [key({ key: "]", mod: true, label: "Cmd/Ctrl+]" })],
    "editor.zoom_out":            [key({ key: "[", mod: true, label: "Cmd/Ctrl+[" })],
    "editor.zoom_vertical_in":    [key({ key: "r", mod: true,             label: "Cmd/Ctrl+R" })],
    "editor.zoom_vertical_out":   [key({ key: "r", mod: true, shift: true, label: "Cmd/Ctrl+Shift+R" })],
    "editor.zoom_to_selection":   [key({ key: "f", mod: true, alt: true, label: "Cmd/Ctrl+Alt+F" })],
    "editor.zoom_previous":       [key({ key: "z", mod: true, alt: true, label: "Cmd/Ctrl+Alt+Z" })],
    "region.mute_toggle":         [key({ key: "m", mod: true, label: "Cmd/Ctrl+M" })],
  },
};

// Cubase / Nuendo — G/H zoom horizontally; Shift+G/H zoom vertically. Plain
// wheel scrolls vertically; Ctrl-wheel zooms horizontally at cursor; Shift-
// wheel scrolls horizontally; Alt-wheel vertical zoom.
const cubase = {
  id: "cubase",
  label: "Cubase / Nuendo",
  description:
    "Plain wheel scrolls vertically; Ctrl-wheel zooms; Shift-wheel pans " +
    "horizontally. G/H horizontal zoom; Shift+G/H vertical zoom.",
  wheel: {
    timeline_main:     { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    timeline_overview: { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: "*", label: "*" })],
    "transport.return_to_zero":   [key({ key: ",", label: "," })],
    "transport.go_to_end":        [key({ key: ".", label: "." })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo": [
      key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" }),
      key({ key: "y", mod: true, label: "Ctrl/Cmd+Y" }),
    ],
    "edit.split_at_playhead":     [key({ key: "x", alt: true, label: "Alt+X" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "h", label: "H" })],
    "editor.zoom_out":            [key({ key: "g", label: "G" })],
    "editor.zoom_vertical_in":    [key({ key: "h", shift: true, label: "Shift+H" })],
    "editor.zoom_vertical_out":   [key({ key: "g", shift: true, label: "Shift+G" })],
    "editor.zoom_to_selection":   [key({ key: "f", alt: true, label: "Alt+F" })],
    "editor.zoom_previous":       [key({ key: "u", alt: true, label: "Alt+U" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

// Reaper — Plain wheel scrolls horizontally; Ctrl-wheel zooms; Shift-wheel
// scrolls vertically; Alt-wheel zooms lanes. +/- horizontal zoom, PgUp/PgDn
// vertical zoom.
const reaper = {
  id: "reaper",
  label: "Reaper",
  description:
    "Plain wheel scrolls horizontally; Ctrl-wheel zooms; Shift-wheel " +
    "scrolls vertically. +/- horizontal zoom, PgUp/PgDn vertical zoom.",
  wheel: {
    timeline_main:     { plain: "hscroll", shift: "vscroll", ctrl: "hzoom",   alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "vscroll", ctrl: "hzoom",   alt: "hscroll" },
    timeline_overview: { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: "r", mod: true, label: "Ctrl/Cmd+R" })],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo": [
      key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" }),
      key({ key: "y", mod: true, label: "Ctrl/Cmd+Y" }),
    ],
    "edit.split_at_playhead":     [key({ key: "s", label: "S" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "=", label: "=" }), key({ key: "+", label: "+" })],
    "editor.zoom_out":            [key({ key: "-", label: "-" })],
    "editor.zoom_vertical_in":    [key({ key: "PageUp",   label: "PgUp" })],
    "editor.zoom_vertical_out":   [key({ key: "PageDown", label: "PgDn" })],
    "editor.zoom_to_selection":   [key({ key: "e", label: "E" })],
    "editor.zoom_previous":       [key({ key: "w", label: "W" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

// Ardour — Editor's wheel-zoom-at-cursor is the same shape as Foyer's
// native (no surprise: Foyer's default UI is the Ardour-faithful one).
// =/- is zoom in / out; Shift-wheel pans; Ctrl-wheel pans vertically;
// alt-wheel vertical zoom. S splits at edit point; M mutes selected.
const ardour = {
  id: "ardour",
  label: "Ardour",
  description:
    "Wheel zooms at cursor; Shift-wheel pans horizontally; Alt-wheel " +
    "zooms lanes. =/- horizontal zoom; Ctrl+E zooms to range.",
  wheel: {
    timeline_main:     { plain: "hzoom",   shift: "hscroll", ctrl: "vscroll", alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "vscroll", alt: "hscroll" },
    timeline_overview: { plain: "hzoom",   shift: "hscroll", ctrl: "hscroll", alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: " ", mod: true, label: "Ctrl/Cmd+Space" })],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo": [
      key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" }),
      key({ key: "r", mod: true, label: "Ctrl/Cmd+R" }),
    ],
    "edit.split_at_playhead":     [key({ key: "s", label: "S" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "=", label: "=" })],
    "editor.zoom_out":            [key({ key: "-", label: "-" })],
    "editor.zoom_vertical_in":    [key({ key: "ArrowUp",   mod: true, label: "Ctrl/Cmd+↑" })],
    "editor.zoom_vertical_out":   [key({ key: "ArrowDown", mod: true, label: "Ctrl/Cmd+↓" })],
    "editor.zoom_to_selection":   [key({ key: "e", mod: true, shift: true, label: "Ctrl/Cmd+Shift+E" })],
    "editor.zoom_previous":       [key({ key: "Backspace", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Backspace" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

// Bitwig — Plain wheel scrolls vertically; Ctrl-wheel zooms; Shift-wheel
// horizontal scroll. +/- horizontal zoom, Shift+/- vertical zoom.
const bitwig = {
  id: "bitwig",
  label: "Bitwig Studio",
  description:
    "Plain wheel scrolls vertically; Ctrl-wheel zooms; Shift-wheel pans. " +
    "+/- horizontal zoom; Shift+/- vertical zoom.",
  wheel: {
    timeline_main:     { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    timeline_overview: { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: " ", mod: true, label: "Ctrl/Cmd+Space" })],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo":                  [key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" })],
    "edit.split_at_playhead":     [key({ key: "s", label: "S" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "+", label: "+" }), key({ key: "=", label: "=" })],
    "editor.zoom_out":            [key({ key: "-", label: "-" })],
    "editor.zoom_vertical_in":    [key({ key: "+", shift: true, label: "Shift++" }), key({ key: "=", shift: true, label: "Shift+=" })],
    "editor.zoom_vertical_out":   [key({ key: "-", shift: true, label: "Shift+-" })],
    "editor.zoom_to_selection":   [key({ key: "z", label: "Z" })],
    "editor.zoom_previous":       [key({ key: "Backspace", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Backspace" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

// Reason — Plain wheel scrolls vertically; Ctrl-wheel zooms; Shift-wheel
// horizontal scroll. +/- horizontal zoom, Shift+/- vertical zoom.
// (Reason 11+ added DAW-like wheel handling to the Sequencer.)
const reason = {
  id: "reason",
  label: "Reason",
  description:
    "Plain wheel scrolls; Ctrl-wheel zooms; Shift-wheel pans. " +
    "+/- horizontal zoom; H zooms horizontally.",
  wheel: {
    timeline_main:     { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
    timeline_ruler:    { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    timeline_overview: { plain: "hscroll", shift: "hscroll", ctrl: "hzoom",   alt: "hscroll" },
    sequencer_grid:    { plain: "vscroll", shift: "hscroll", ctrl: "hzoom",   alt: "vzoom"   },
  },
  keys: {
    "transport.play_toggle":      [key({ key: " ", label: "Space" })],
    "transport.record_toggle":    [key({ key: " ", mod: true, label: "Ctrl/Cmd+Space" })],
    "transport.return_to_zero":   [key({ key: "Home", label: "Home" })],
    "transport.go_to_end":        [key({ key: "End",  label: "End" })],
    "edit.undo":                  [key({ key: "z", mod: true, label: "Ctrl/Cmd+Z" })],
    "edit.redo":                  [key({ key: "z", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Z" })],
    "edit.split_at_playhead":     [key({ key: "e", mod: true, label: "Ctrl/Cmd+E" })],
    "edit.duplicate":             [key({ key: "d", mod: true, label: "Ctrl/Cmd+D" })],
    "editor.zoom_in":             [key({ key: "+", label: "+" }), key({ key: "=", label: "=" }), key({ key: "h", label: "H" })],
    "editor.zoom_out":            [key({ key: "-", label: "-" })],
    "editor.zoom_vertical_in":    [key({ key: "+", shift: true, label: "Shift++" })],
    "editor.zoom_vertical_out":   [key({ key: "-", shift: true, label: "Shift+-" })],
    "editor.zoom_to_selection":   [key({ key: "e", label: "E" })],
    "editor.zoom_previous":       [key({ key: "Backspace", mod: true, shift: true, label: "Ctrl/Cmd+Shift+Backspace" })],
    "region.mute_toggle":         [key({ key: "m", label: "M" })],
  },
};

export const PROFILES = Object.freeze({
  foyer, protools, cubase, reaper, ardour, bitwig, reason,
});

export const PROFILE_ORDER = Object.freeze([
  "foyer", "ardour", "protools", "cubase", "reaper", "bitwig", "reason",
]);

export const DEFAULT_PROFILE_ID = "foyer";
