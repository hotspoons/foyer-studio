enabled: true

# MIDI track + instrument setup

A MIDI track is silent until it has an instrument plugin. Setting one
up wrong is the most common source of "I did what you said but I
can't hear it" feedback.

## The rule

1. New MIDI track → either `tracks.create { kind: "midi",
   instrument_uri: <uri> }` (atomic, one undo) OR `tracks.create`
   followed by `plugins.insert`.
2. Always PROMPT the user for the synth choice unless they
   explicitly said "synth" generically — only then default to
   gmsynth (it ships with Ardour and produces sound predictably).
3. Common URIs you can offer:
   - `http://gareus.org/oss/lv2/gmsynth` — General MIDI Synth
     (128 melodic + drum kit on channel 9)
   - `http://drobilla.net/plugins/mda/DX10` — bell / FM bass
   - `http://synthv1.sourceforge.net/lv2` — subtractive synth
   - `http://drumkv1.sourceforge.net/lv2` — drum sampler (designed
     for drum patterns — first choice for drums)
   - `http://padthv1.sourceforge.net/lv2` — pad synth
4. `plugins.catalog { query: "drum" }` / `query: "synth"` /
   `query: "piano"` returns the live catalog so you can surface
   options the user has installed.
5. Tell the user which instrument you picked. The same MIDI pattern
   sounds completely different through DX10 vs gmsynth vs drumkv1.

## Drum vs melodic content — the channel/program trap

This bites EVERY time on gmsynth and any GM-compatible host:

- gmsynth uses the GM program map. `program: 0` = Acoustic Grand
  Piano. `program: 30` = Distortion Guitar. `channel: 9` = the
  drum kit (kick on pitch 36, snare on 38, hihat on 42, etc.).
- A MIDI region routes notes on ONE channel by default (usually
  channel 0). Setting per-cell `channel: 9` in a sequencer layout
  is NOT enough on its own — Ardour's MIDI region has a routing
  channel that may override per-note channels depending on the
  shim and the patch-change events present.
- If the user asks for drums and you don't:
  - move the region's routing channel to 9, OR
  - swap the instrument to a dedicated drum plugin (drumkv1), OR
  - set the gmsynth's `program` to a drum kit on channel 0
  …they will hear their kick + snare as middle-C piano hits.

## Checking before you commit

Always read the track's current state before assuming:

```json
{"subcommand": "describe", "track_id": "track.1673"}
```

Look at:
- `plugins[*].uri` and `plugins[*].name` — what instrument is loaded
- `midi_patches[*]` — per-channel `{bank, program}` — what GM patch
  is active on each channel
- `playback_channel_mask` — which channels the track routes to

For a drum track on gmsynth, the user wants either:
- `midi_patches[9]` set to bank 0 / a drum-kit program (often 0
  works on GM drum channel) AND notes on channel 9, OR
- a non-GM drum plugin (drumkv1, drumgizmo) where any channel works.

## When you're not sure, ASK or SHOW

Don't silently pick an instrument. Either:
- Tell the user "I'll insert gmsynth on this MIDI track; that gives
  you a GM piano by default. Want a different sound?"
- Or `plugins.catalog { query: "synth" }` and offer 2-3 named
  options.

A single sentence of context beats five turns of "actually, can it
be a bass?".
