enabled: true

# Melodic / harmonic MIDI authoring

For one-off melodies, chords, basslines, and any pitched content that
ISN'T a repeating cell grid, use the `midi` tool — not the sequencer
(which is for repetitive patterns).

## Atomic replace beats note-by-note

ALWAYS prefer:
```json
{"subcommand": "region_replace_notes",
 "region_id": "region.17085",
 "notes": [...40 notes here...]}
```

over forty `note_add` calls. Reasons:
- One WS round-trip vs forty.
- ONE undo step the user can hit Ctrl-Z on, instead of forty.
- Atomic — partial failures don't leave the region half-edited.

## Tick math

Regions are tick-relative. Read `ppqn` from `session.summary` (Foyer
default is 1920). Then:

- 1 quarter note = `ppqn` ticks (1920)
- 1 eighth note  = 960
- 1 sixteenth     = 480
- 1 bar at 4/4   = 4 × ppqn = 7680

Each note: `{pitch, velocity, start_ticks, length_ticks, channel}`.
Velocities 0–127, pitches 0–127 (MIDI standard). C4 = 60, A4 = 69.

## Region length

Foyer auto-extends the region to fit your longest note: pass
notes whose `start_ticks + length_ticks` exceeds the current
region length, and the backend grows the region's
`length_samples` to match before the note insert. That means you
can sketch a long melody on a short region in one call without
trim-then-replace gymnastics.

If you'd rather size the region explicitly first:
```json
{"subcommand": "trim",
 "region_id": "region.17085",
 "length_samples": 768000}
```
At 48 kHz, 768000 samples = 16 s = 8 bars at 120 bpm. The math:
`(60 / bpm) * beats_per_bar * bars * sample_rate`.

## Channel selection matters

The region's routing channel (usually 0) determines what instrument
patch the notes hit. If the track's instrument is gmsynth and you
write notes on channel 9, you'll get drums; on channel 0, GM
program 0 (piano by default). See `midi-track-setup` skill for the
gory details.

## After writing notes

- `midi.show_value { region_id }` — confirm note count + spot-check
  first/last note position.
- `midi.show_viz { track_id, region_id }` — render the piano roll
  as PNG so the user can see the contour.

## When the user asks for "a melody"

Don't overthink. A passable C-major melody:
1. Stay diatonic: only C D E F G A B (60, 62, 64, 65, 67, 69, 71).
2. Land on chord tones at strong beats (C, E, G on beats 1 and 3).
3. Use eighth/quarter mixture for rhythm — not all eighths.
4. End on the tonic (C, pitch 60 or 72) with a long note.

If the user gave a key, scale, or mood: respect it. If not, ask
once — "C major / 8 bars / mellow OK?" — then write.

## Per-note editing

For surgical tweaks (transpose one note, lengthen one beat):
```json
{"subcommand": "note_update",
 "region_id": "region.X",
 "note_id": "note.X.Y",
 "pitch": 67,
 "length_ticks": 1920}
```
`region_replace_notes` is overkill for a single change.
