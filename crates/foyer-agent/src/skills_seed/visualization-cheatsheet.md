enabled: true

# Visualization cheatsheet

The `visualize` tool renders a PNG you can show the user. Use it to:
- Confirm a change landed visually.
- Answer "show me X" without burning words describing what's visible.
- Ground "where do I click?" guidance.

## Subcommand → what it renders

| subcommand        | required args              | shows                          |
|-------------------|----------------------------|--------------------------------|
| `timeline`        | (none)                     | timeline with all tracks+regions |
| `mixer`           | (none)                     | mixer view (every track strip) |
| `waveform`        | `track_id`, `region_id`    | timeline, focused on that region |
| `midi_roll`       | `track_id`, `region_id`    | piano roll for that MIDI region |
| `beat_sequencer`  | `track_id`, `region_id`    | cell grid for a sequencer region |
| `automation_lane` | `track_id`, `control_id`   | a specific control's automation |
| `event_heatmap`   | `track_id`                 | timeline with event density overlay |
| `spectrogram`     | `track_id`, `duration_ms?` | live FFT waterfall (transport must be playing) |
| `screen`          | (none)                     | live capture of what the user sees |

## Common mistake: missing track_id

`waveform`, `midi_roll`, `beat_sequencer`, `automation_lane`, and
`event_heatmap` ALL require `track_id` even if you also pass
`region_id` / `control_id`. The error message is
`invalid args: missing field "track_id"` — pass it.

## spectrogram needs audio

The streaming spectrogram subscribes to live audio egress. If
transport isn't playing, the spectrum shows zeros. Either:
- Start playback before calling, OR
- Use `spectrum.snapshot` for an instant capture (planned: with
  `at_samples` + `duration_samples` for offline analysis).

## screen is FE-only

`screen` captures whatever the connected browser is showing. If
no FE is attached, the agent returns a clear error — use the more
specific subcommands (`timeline`, `mixer`, `midi_roll`, …) instead.

## Phone / minimal-UI clients

When the user is connected from a phone (the touch variant ships
without the full MIDI editor / piano roll / beat sequencer), the
agent still has to do session engineering for them. Treat viz as
the primary feedback channel:
- After every meaningful edit, render the relevant viz subcommand
  and link the PNG so the user can verify visually.
- For drum / MIDI work, `visualize.beat_sequencer` and
  `visualize.midi_roll` work even when the user's variant doesn't
  ship the editor — the headless renderer hydrates the live
  region content (notes + sequencer layout) and screenshots it.
- For mixer balance work, `visualize.mixer` shows fader / pan /
  mute / solo without needing the touch UI to ship its own mixer
  surface.

## Pair viz with the action

Don't `visualize.timeline` as a substitute for `regions.list`. The
list call is faster and cheaper. Use viz when the USER needs to
see something, not as a way to re-read state you just modified.
