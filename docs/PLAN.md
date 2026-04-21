# New plan

Need to show output VU or bar visualization as things are playing, currently nothing hooked up

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

- Midi editor! We need a midi editor
- A beat sequencer would be *awesome* as an option for a MIDI channel. Think the primary UI for oxygen with a sequencer and layout def could be used for drum tracks, awesome
- Push-to-talk audio broadcast for multi-user colabs (pipes audio to all clients of same session except ours)
