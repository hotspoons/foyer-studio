enabled: true

# Drawing automation curves

Automation lanes hold time-varying control values (gain ramps,
filter sweeps, pan moves). Each lane belongs to a control_id and
has a playback `mode` plus a list of `{time_samples, value}`
breakpoints.

## Atomic replace for curves

```json
{"subcommand": "draw",
 "control_id": "track.245.gain",
 "mode": "play",
 "points": [
   {"time_samples": 0,      "value": 0},
   {"time_samples": 240000, "value": -6},
   {"time_samples": 480000, "value": 0}
 ]}
```

This replaces the WHOLE lane atomically — no need to delete + add
points. Set `mode` to `play` so playback honors the curve (the
default `off` lane plays the static manual value instead).

## Modes

- `off` — automation ignored; lane plays its manual value.
- `manual` — engine ignores automation but the lane data persists.
- `play` — automation drives the control during playback.
- `write` — playback overwrites the lane with whatever the user
  is moving live (rec armed).
- `touch` — like write, but reverts to existing automation when
  the user releases the control.
- `latch` — like touch, but holds the new value until next stop.

Pick `play` for AI-drawn curves; `write`/`touch`/`latch` only when
the user explicitly asked for live-record automation.

## Surveying

```json
{"subcommand": "list", "track_id": "track.245"}
```
returns every automatable lane on the track plus its current mode
+ point count.

## Per-point edits

For surgical adjustments (move ONE point):
```json
{"subcommand": "point_update",
 "control_id": "track.245.gain",
 "original_time_samples": 240000,
 "new_time_samples": 280000,
 "value": -8}
```

`point_add` and `point_delete` round out the per-point surface.
For curves of more than 3 points, `draw` is always cheaper.

## time_samples is at the session's sample rate

Read `sample_rate` from `session.summary`. At 48 kHz, one second
is 48 000 samples. A 4-bar ramp at 120 bpm is `4 * 4 * 48000 / 2`
= 384 000 samples.

## Show the user

`automation.show_viz { track_id, control_id }` renders the lane as
a PNG so they can spot-check before playback.
