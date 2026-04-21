# New plan

Need to show output VU or bar visualization as things are playing, currently nothing hooked up

## Beat sequencer design (2026-04-21, pre-bed sketch)

**Ask**: Hydrogen-style pattern grid as an alternate view for a MIDI
region on any track. Drum-kit layout by default; swappable to a
pitched layout ("composable sequencer"). Steps quantized to a chosen
resolution. Velocity lane. Transport integrated with Ardour's main
transport. Zoomable to a foyer-window.

**Storage (the critical question)**: Ardour exposes `add_extra_xml()`
/ `extra_xml(name)` on every `Stateful` object (Region, Track,
Session inherit the pattern via `SessionObject → StatefulDestructible
→ Stateful` at `libs/pbd/pbd/stateful.h:67-69`). The base class
preserves unknown child nodes through save/load cycles by design
(`libs/pbd/stateful.cc:94-108`). So we stash a `<Foyer><Sequencer>`
sub-node on the region — JSON or sub-XML — and stock Ardour
open-save-close cycles preserve it intact. No sidecar file needed.

**Data model (per MIDI region)**:

```json
{
  "version": 1,
  "mode": "drum",                // or "pitched"
  "resolution": 16,              // 1/16 notes per beat cell
  "steps": 16,                   // pattern length (one bar at 16ths)
  "rows": [
    { "pitch": 36, "label": "Kick",  "channel": 9, "color": "#f59e0b" },
    { "pitch": 38, "label": "Snare", "channel": 9, "color": "#a78bfa" },
    { "pitch": 42, "label": "HH cl", "channel": 9, "color": "#22d3ee" }
  ],
  "cells": {
    "0:0":  { "on": true, "velocity": 110 },
    "0:4":  { "on": true, "velocity": 100 },
    "1:4":  { "on": true, "velocity": 120 }
  }
}
```

Cell keys are `"<rowIdx>:<stepIdx>"`. Pitched mode is the same
schema but rows use arbitrary pitches (bottom-to-top ascending).

**Rendering to MIDI**: each cell on → one MIDI note at
(rowPitch, stepTicks, lengthTicks = one step). The region's note list
is regenerated on every cell change (add for new, delete for removed
via the existing `AddNote` / `DeleteNote` commands we landed tonight).

**Conflict with the piano roll**: a region is either "sequencer-
owned" (has `<Foyer><Sequencer>` metadata → piano roll opens in
read-only "synced from sequencer" mode) or "free-form" (no metadata
→ piano roll is fully editable). This keeps the two editors from
fighting over the note list.

**Schema additions** (alongside `MidiNote`, `PatchChange`):

```rust
pub struct SequencerLayout { /* the JSON shape above, typed */ }
// On Region:
pub foyer_sequencer: Option<SequencerLayout>,
// Command:
SetSequencerLayout { region_id, layout: SequencerLayout },
ClearSequencerLayout { region_id },
```

**Shim wiring**:

1. `describe_region_desc`: look up `region->extra_xml("Foyer")`,
   parse `<Sequencer>` child into the typed struct, attach.
2. `SetSequencerLayout` handler: build `<Foyer><Sequencer>` XML,
   call `region->add_extra_xml()` (which *replaces* an existing node
   of the same name).
3. Fire a `RegionUpdated` echo so browsers reconcile.

**UI entry points**:

- MIDI lane-head context → "Open beat sequencer…" (new).
- Piano roll toolbar → "Switch to beat sequencer" button (when the
  region is beat-sequencer-owned OR empty).
- Track editor modal → "Default new regions to beat sequencer" pref
  (stretch, not phase 1).

**Component**: `<foyer-beat-sequencer>` — grid of rows × steps,
velocity lane under it, transport controls in the toolbar (bound
to the existing `transport.play` / `stop` controls so sequencer
starts/stops in sync with the rest of Ardour). Resolution + size
pickers. Drum-kit picker dropdown (GM drum map is the default; each
row can still be overridden pitch-by-pitch).

**Tonight's scope** (~bed-time permitting): schema types + shim
round-trip + interactive web grid with local state that generates
notes via `AddNote` / `DeleteNote`. Hydrogen-style kit-mapping and
the pattern-song view land in a follow-up — the single-pattern
grid is the MVP and covers Rich's "zoom in a modal, solo, play in
ensemble" ask.

---

## Audio egress — proper jitter buffer (next)

## Audio egress — proper jitter buffer (next)

Current scheduling drives BufferSource start times straight from
the decode callback's `nextPlayhead`. Real-world WebSocket packet
delivery isn't smooth: browsers batch frames, background-tab
throttling creates 100-500 ms gaps, tokio's sleep timer is only
approximately periodic. With tolerances tuned for *typical* jitter
we still see "resetting playhead — 150 ms behind" warnings every
few seconds, and each reset is a ~300 ms gap audible as a pop.

Proper fix: pull scheduling OUT of the decode callback. Maintain
a `PriorityQueue<AudioBuffer>` keyed by decoder-order timestamp,
and have a dedicated `setInterval(schedulerTick, 10ms)` dequeue
and schedule buffers to keep `nextPlayhead ≥ currentTime + 150ms`.
Smooths bursts (which just pile into the queue and drain at
steady rate) and detects underflow cleanly (queue empty but
nextPlayhead < currentTime → log underrun + silently carry on).

Out of scope for the 2026-04-20 afternoon push; needed before
this audio path can stop feeling hacky.

## VU / peak-meter wiring (2026-04-20 afternoon — in progress)

**Shim side**: `shims/ardour/src/msgpack_out.cc::encode_track_meters`
walks `session.get_routes()`, reads each route's
`peak_meter()->meter_level(ch, MeterPeak)` (Ardour's canonical
dBFS peak-with-falloff), max-reduces across channels, and emits
one `meter_batch` event with `track.<stripable>.meter` →
dBFS-float entries. Called from the 30 Hz tick thread
unconditionally (moved above the idle-tick skip so meters pump
even with transport stopped — useful for input monitoring /
plugin noise / sanity check).

**Client side**: unchanged. Track-strip's `ControlController` is
already subscribed to `track.peak_meter` (schema id
`track.<id>.meter`) — the store dispatches
`control.update` events from the `meter_batch` envelope onto that
subscription, `<foyer-meter>` paints from whatever dBFS value
lands.

**Next**: verify meters visibly move when master audio taps are
active. If they don't, the drain-loop diagnostic counters
(run / silence / written / sent) will clarify whether the
processor chain is firing at all. Rich's session opens with
all-silent mastering and our auto-play workaround forces stop —
user has to hit Play (or arm a track with monitoring) to see
movement.


---

## Rich new notes

- Midi editor! We need a midi editor (basics in place)
  - We need to click + drag when first placing a note to set its duration, currently this is a two phase approach
  - We also need to be able to edit velocity more obviously (I like the transparency, but seeing a little number or something immediately when hovering would help, as would a velocity slider that appears enabled when a note is selected). Also I can't seem to put velocity back up, only down
  - Support non-grid placement of notes with like a modifier key or something when dragging or resizing
  - We also need multi-select (looks like it is in there), cut/copy/paste keyboard shortcuts for selection, undo/redo tracking
- Instrument swap/remove/add — reuse existing AddPlugin/RemovePlugin, just add a filtered instrument picker UI in the MIDI manager. ~1 focused pass.
- Per-region patch/bank events — new schema primitives + shim read (MidiModel::patch_changes()) + shim write (PatchChangeDiffCommand) + UI table. Same pattern I just did for notes.
- Plugin presets (lilv) — new backend trait methods + shim-side lilv preset enumeration + UI list. Biggest new surface, least user-facing value if the synth already exposes program changes via MIDI PC.
- Fix scroll-wheel zoom behavior, needs to essentially lock the zoom center on exactly where the pointer is and not move the waveform relatively when filling out horizontally from a low zoom to a high zoom. So regardless of what is happening to the timeline as a whole with framing, zoom targets must remain pixel exact on the pointer and reframe the timeline around this to prevent the timeline jumping that occurs zooming in and out and reframing the whole timeline. Currently it is perfect as long as the furthest left or right audio region extends past the frame of the timeline, but when dead space is available, that is when things go bad
- A beat sequencer would be *awesome* as an option for a MIDI channel. Think the primary UI for hydrogen with a sequencer and layout grid for loops could be used for drum tracks, awesome
- Modifier key when resizing a track or mixer channel to resize *all* of the tracks as we hold the handle of one
- Scroll to zoom h or v for midi roll (use same modifiers as other 2d zoomable panels)
- Delete/add one or more tracks from selection
- Make sure we can support higher-resolution (e.g. 96khz or 192khz) remote clients over audio tap
- Setup audio config for browser client (e.g. disable Opus compression and use raw waveforms, set client sampling freqency if possible)
- Audio source from browser to DAW session (lower priority). Approach
  settled 2026-04-21 (Decision 24): register soft input ports on the
  already-active AudioBackend via `PortManager::register_input_port()`
  and feed their buffers from our IPC drain, mirroring MasterTap in
  reverse. No custom backend, no JACK device on the sidecar — works
  on whichever backend the user already runs (JACK / ALSA / CoreAudio
  / WASAPI). Recordable by Ardour's normal track-input routing.
  Implementation lives behind the existing `AudioIngressOpen` command
  and `FrameKind::Audio` IPC plumbing; only the shim-side handler is
  missing. Latency calibration (`Backend::measure_latency()` trait
  method exists, implementation TBD) should land before we advertise
  this as anything beyond "monitoring / scratch-take grade."
- Upstream MCP proxy from foyer (so we can enable MCP tools in DAWs and integrate them with other tools we build independently like spectral analyzers)
- Push-to-talk audio broadcast for multi-user colabs (pipes audio to all clients of same session except ours)
- Simple relay chat for multiple users
- Floating dialogs like midi roll/editor, plugin editor, plugin config, ettc. should be a different class of window that can be, as a whole displayed and managed separately from core tiles, and have like a separate minimize/move/restore cycle from the main window manager. So you could lay out all of your overlay controls, then hide *all* of them to a dock, then restore the dock for all of them to have them 
- Channel grouping and bussing - works on back end but no way to edit on front end

---

- MCP tools in foyer Rust API for primary DAW functionality, plus novel things like spectral analyzers, histograms, audio snippets for models that support audio, beats sequencer / looping addon, MIDI editing, and other things that a clanker can use to aid with production
- Automation still missing per track!