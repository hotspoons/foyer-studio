enabled: true

# Drum-pattern authoring

Use the `sequencer` tool for any repetitive cell-grid pattern (drums,
arpeggios, basslines). It's higher-leverage than writing notes by
hand — the shim regenerates the region's MIDI notes from the layout
every time you set cells.

## Pre-flight (DO THIS FIRST)

You CANNOT just dump cells onto any MIDI region. Verify the
instrument can actually play drums:

1. `tracks.describe { track_id }` — read `instrument_summary`. For
   MIDI tracks Foyer surfaces the instrument plugin URI + name and
   the active GM program right there.
2. If the URI is `http://gareus.org/oss/lv2/gmsynth` (General MIDI
   Synth):
   - Drums are on **MIDI channel 9** (zero-indexed; some UIs label
     it "channel 10").
   - Foyer auto-forces `playback_channel_mode: "force",
     playback_channel_mask: 1 << 9` when you call
     `sequencer.set_layout` with `mode: "drum"` — so the user
     hears drums even if cells were authored on channel 0. You
     don't have to call `tracks.set_midi_channel_mode` by hand
     for this anymore.
3. If the URI is melodic (DX10, synthv1, padthv1) and the user
   asked for drums, prefer a dedicated drum plugin:
   - `plugins.catalog { query: "drum" }` and offer the user the
     options the host has installed (drumkv1, drumgizmo, etc.).
   - Or `plugins.duplicate` from another drum track if one exists.
   - Don't silently smear drum cells over a melodic synth — the
     user will hear pitched kicks and assume you broke something.

## Layout shape

```json
{"subcommand": "set_layout",
 "region_id": "region.14089",
 "layout": {
   "version": 2,
   "mode": "drum",
   "active": true,
   "resolution": 4,           // 4 = 16th notes
   "pattern_steps": 16,       // 16 steps = one bar of 4/4
   "rows": [
     {"pitch": 36, "label": "Kick",      "channel": 9},
     {"pitch": 38, "label": "Snare",     "channel": 9},
     {"pitch": 42, "label": "HH closed", "channel": 9},
     {"pitch": 46, "label": "HH open",   "channel": 9},
     {"pitch": 49, "label": "Crash",     "channel": 9},
     {"pitch": 51, "label": "Ride",      "channel": 9}
   ],
   "patterns": [
     {"id": "p.basic", "name": "Basic", "cells": [
       {"row": 0, "step": 0, "velocity": 110},
       {"row": 0, "step": 8, "velocity": 110},
       {"row": 1, "step": 4, "velocity": 105},
       {"row": 1, "step": 12, "velocity": 110}
     ]}
   ],
   "arrangement": [
     {"pattern_id": "p.basic", "bar": 0, "arrangement_row": 0}
   ]
 }}
```

## GM drum pitch reference (channel 9)

- 35 / 36 — Acoustic / Bass Kick
- 38 / 40 — Acoustic / Electric Snare
- 41 / 43 / 45 / 47 — Low / Mid-low / Mid / High Tom
- 42 — Closed Hi-Hat
- 44 — Pedal Hi-Hat
- 46 — Open Hi-Hat
- 49 / 57 — Crash 1 / Crash 2
- 51 / 59 — Ride 1 / Ride 2
- 56 — Cowbell
- 70 — Maracas

## Length math

- `resolution: 4` + `pattern_steps: 16` = one bar at 4/4 with
  16th-note steps. Want 8th notes? Set `resolution: 2`.
- `arrangement` lists `{pattern_id, bar, arrangement_row}` — each
  entry plays one pattern at one bar position. Re-use pattern ids
  to repeat a pattern; vary the bar index for fills.
- A 4-bar loop is `[{bar:0,p1},{bar:1,p1},{bar:2,p1},{bar:3,p2}]`
  where `p2` is a fill bar.

## After you set the layout

- `sequencer.show { region_id }` — re-read to confirm `note_count`
  is non-zero and the patterns + arrangement look right.
- `visualize.beat_sequencer { region_id, track_id }` — render a
  PNG for the user to spot-check.
- `transport.play` for two bars, then `transport.stop` — and
  ASK the user how it sounds before iterating. If they wanted
  drums and got piano, the instrument is the problem (see above).
