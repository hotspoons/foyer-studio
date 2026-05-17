enabled: true

# Working with regions

Regions are the clips on the timeline — each one belongs to a track
and has a `kind` (`audio`, `midi`, or `sequencer`).

## Survey cheaply

```json
{"subcommand": "list"}                              // EVERY region
{"subcommand": "list", "track_id": "track.177"}     // one track
{"subcommand": "list", "track_ids": ["track.A", "track.B"]}  // subset
```

The no-arg `list` is one round-trip; firing per-track `list` calls
is what an inexperienced agent does. Don't be that agent.

## Create

```json
{"subcommand": "create",
 "track_id": "track.245",
 "at_samples": 96000,
 "length_samples": 480000,
 "kind": "midi",
 "name": "Verse 1"}
```

For audio regions referencing a file:
```json
{"subcommand": "create",
 "track_id": "track.245",
 "at_samples": 0,
 "kind": "audio",
 "source_path": "audio/voiceover.wav"}
```
`source_path` is **jail-relative** — never an absolute host path.

## Move / trim / split / duplicate

- `move` repositions a region's start (and optionally moves it to a
  different track via `target_track_id`).
- `trim` changes the region's length. Use `source_offset_samples` to
  trim from the head while keeping the tail.
- `split` cuts a region at a sample position into two.
- `duplicate` clones a region; pair with `at_samples` to place the
  copy, and optionally `length_samples` to truncate the clone.

## Fades

```json
{"subcommand": "set_fade",
 "region_id": "region.X",
 "which": "in",      // "in" | "out"
 "samples": 4800,
 "shape": "constant_power"}   // linear | constant_power | fast | slow | symmetric
```

For crossfades on overlapping regions, set the outgoing region's
`out` fade and the incoming region's `in` fade to roughly the same
length.

## Gain / reverse

- `set_gain { region_id, gain_linear }` — region-level gain
  multiplier, NOT dB. 1.0 = unity, 0.5 = -6 dB, 2.0 = +6 dB.
- `reverse { region_id }` — reverses the audio region. Wrapped in
  the host's undo group, so Ctrl-Z unwinds it. Still worth telling
  the user before doing this on their primary take.

## When to ask

Before deleting a region — even on an obviously empty take —
restate the action: "Removing region.X (Take 7 on Audio 1, 4.2 s).
OK?" Region deletes are recoverable via Ardour's undo stack but
the user shouldn't have to learn that mid-flow.

## Jail-relative paths

ALL region paths over the wire are relative to the filesystem jail
(typically the user's project root). Don't construct absolute
paths; the server will strip them but the user-facing error message
is uglier than it needs to be.
