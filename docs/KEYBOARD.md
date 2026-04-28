# Keyboard + gesture reference

Global tiling bindings use `Ctrl+Alt` by default. Mac users can swap
to `Cmd+Alt` by setting `foyer.keymap.mod = "meta-alt"` in
localStorage.

## Tile focus + layout

| Keys | Action |
|---|---|
| `Ctrl+Alt` + `H` / `J` / `K` / `L` | Focus tile left / down / up / right (arrow keys also work) |
| `Ctrl+Alt` + `\|` or `\` | Split focused tile to the right (duplicates current view) |
| `Ctrl+Alt` + `-` or `_` | Split focused tile below (duplicates current view) |
| `Ctrl+Alt` + `W` | Close focused tile |
| `Ctrl+Alt` + `[` / `]` | Shrink / grow focused pane by 5% |
| `Ctrl+Alt` + `A` | Toggle automation panel |
| `Ctrl/Cmd` + `K` | Command palette |
| *(your chords)* | Per-layout, assigned via right-click → "Assign keybind…" in the layouts FAB |

Keyboard splits duplicate the focused view; mouse-clicking the
split icons in the tile header pops a view picker so you can
choose what goes in the new pane. Two UIs, one data model.

## Automation panel

| Keys | Action |
|---|---|
| `Ctrl/Cmd` + `S` | Save and apply the current script |
| `Escape` | Close panel (unsaved buffer is kept) |

## Mouse + gesture

- Wheel over the timeline scrolls temporal zoom (anchored at the
  pointer).
- `Alt` or `Ctrl` + wheel over a timeline lane changes that lane's
  height.
- Drag a tile header past 8 px to tear it into a floating window.
- Drag a floating window's header over the right rail to dock it as
  an icon.
- Right-click anything in the layouts FAB for assign-keybind / hide
  / delete.
