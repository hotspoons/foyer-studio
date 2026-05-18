enabled: true

# Mixer balancing (gain / pan / mute / solo)

The mixer tool reads or writes per-track fader state. Almost every
mix tweak involves multiple tracks — use the batched `apply`
subcommand.

## Batched: one tool call for the whole mix

```json
{"subcommand": "apply",
 "changes": [
   {"track_id": "track.177",  "gain_db": -3, "pan": -0.2},
   {"track_id": "track.1988", "gain_db": -6},
   {"track_id": "track.245",  "muted": true},
   {"track_id": "track.16880","soloed": true}
 ]}
```

Capped at 256 changes per call. Each change object MUST include
`track_id` and at least one of `gain_db | muted | soloed | pan`.

Don't loop `set_gain_db`/`set_mute`/`set_solo` across N tracks —
that's N round-trips for what should be one.

## Reading state

```json
{"subcommand": "get", "track_id": "track.177"}
```
returns `{ gain_db, muted, soloed, pan }`. For multi-track survey
use `tracks.describe_many` instead.

## Solo state hygiene

Solo is global: when ANY track is soloed, all non-soloed tracks
mute. The user can be confused if you add a new track and they
hear nothing — but a track elsewhere is silently soloed.

**Before adding a new track or unmuting one, check:**
```json
{"subcommand": "list"}                  // tracks.list
```
and look for `solo: true`. If at least one track is soloed:
- Solo the new track too (so the user hears it), OR
- Warn the user: "track.X is soloed — your new track will be
  muted until you clear solo".

The default behavior (mute everything that isn't soloed) is
Ardour-correct but surprising in cold conversations.

## dB ranges

- `gain_db: 0` = unity. Most pop mixes sit between -12 and 0 dB.
- Don't slam tracks above 0 dB without reason — the user can
  always boost on the master if needed.
- `pan: -1` = hard left, `pan: 1` = hard right, `pan: 0` = center.

## Pan law

`pan: -1` = hard left, `pan: 0` = center, `pan: 1` = hard right.
The shim applies the host's configured pan law (Ardour defaults
to -3 dB equal-power) — that's how the audible mix actually
behaves regardless of the schema's linear value.
