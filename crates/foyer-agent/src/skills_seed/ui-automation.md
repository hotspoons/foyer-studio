enabled: true

# Driving the user's UI

The `ui` tool lets you open / close / focus floating windows and
swap the tile tree. Use it sparingly — the user owns their layout
— but reach for it when:
- A window the user needs ISN'T open and they're asking about its
  contents ("what plugins are on this track?" → open plugin panel).
- The user asks "show me X" and X is a view.
- You need a specific viz on screen for context before doing
  destructive ops.

## Always query first

```json
{"subcommand": "query"}
```

Returns:
- `windows[*]` — already-open floating windows + their storage keys.
- `available_kinds[*]` — string ids registered in THIS variant.
- `kinds[*]` — same list enriched with `{id, label, description,
  viz_fallback}`. Prefer this for picking what to open.
- `canonical_kinds[*]` — every kind Foyer recognizes globally.
- `missing_kinds[*]` — canonical kinds NOT in this variant. When
  the user asks for one of these (e.g. piano roll on a phone),
  reach for the per-entry `viz_fallback` (`visualize.midi_roll`,
  `visualize.beat_sequencer`, …) INSTEAD of telling them "I
  can't help here." Phone-class variants typically lack the
  heavy editors and rely on rendered viz for the same context.
- `tile_tree` — current tile tree shape.

Without `query`, you'll guess kind names and they may not exist
in this UI variant.

## Open

```json
{"subcommand": "open", "kind": "midi-editor",
 "props": {"trackId": "track.16682", "regionId": "region.17085"}}
```

`props` is per-kind. Common shapes:
- midi-editor: `{trackId, regionId}`
- plugin-panel: `{pluginId}`
- beat-sequencer: `{trackId, regionId}`
- track-editor: `{trackId}`

If you don't know the prop names, open the window first with
empty props and the user can navigate from there.

## Focus / close

```json
{"subcommand": "focus", "storage_key": "midi-editor.track.16682"}
{"subcommand": "close", "storage_key": "midi-editor.track.16682"}
```
Use the `storage_key` returned by `query` — it's the stable
identity for an already-open window.

## set_tile_tree

For swapping the main tile layout to a preset:
```json
{"subcommand": "set_tile_tree",
 "tree": {"kind": "leaf", "id": "t1", "view": "mixer", "props": {}}}
```

Splits:
```json
{"kind": "split", "direction": "vertical",
 "a": {"kind": "leaf", "view": "timeline", ...},
 "b": {"kind": "leaf", "view": "mixer", ...}}
```

This is BIG — it replaces the user's main work area. Confirm first
or restrict to obvious "show me the timeline" requests.

## Pair with visualize.screen

After driving the UI, `visualize.screen` captures the new state so
the user can verify. It's also the easiest way to ground "where
should I click?" guidance: take a screen, point at the button.
