enabled: true

# Spectrum analysis

The `spectrum` tool returns FFT data; `visualize.spectrogram`
renders the same data as a waterfall PNG. Used for "what's the
output composition of this track / bus / master at time T?"

## Always probe capabilities first

```json
{"subcommand": "capabilities"}
```

The backend may not support spectrum natively (most stub backends
return `available: false`). Foyer's server falls back to a built-in
FFT pipeline that taps live audio egress — works during playback,
returns zeros when transport is stopped.

## Snapshot (single FFT frame)

```json
{"subcommand": "snapshot",
 "target": {"kind": "master"},
 "fft_size": 2048,
 "max_bins": 512,
 "per_channel": true}
```

Targets:
- `{"kind": "master"}` — the master bus
- `{"kind": "monitor"}` — monitor bus
- `{"kind": "track", "id": "track.245"}` — a specific track

Returns per-channel dBFS bins. `max_bins` truncates the bottom of
the Nyquist range to keep the response small for the agent.

## Capture at a specific position (offline)

When the user asks "what does the master sound like at bar 17?"
and transport isn't there, use `capture_at`:

```json
{"subcommand": "capture_at",
 "at_samples": 768000,
 "target": {"kind": "master"},
 "fft_size": 2048,
 "max_bins": 512,
 "per_channel": true,
 "mute_master": true}
```

The director:
1. Saves current transport position + playing state + master mute.
2. (If `mute_master`) mutes the master so the user doesn't hear
   the scrub.
3. Locates to `at_samples`, briefly plays.
4. Captures one FFT window.
5. Restores everything.

**Multi-client warning**: this mutates SHARED transport state for
the duration of the capture (~200 ms). Other connected clients
will see playback move momentarily. Mention this to the user if
they're collaborating.

## Capture across a window (time-slice with decay)

For "what does this whole section sound like on average?":

```json
{"subcommand": "capture_window",
 "start_samples": 480000,
 "end_samples": 960000,
 "target": {"kind": "track", "id": "track.245"},
 "decay": 0.85,
 "mute_master": true}
```

The director sweeps from start → end, computing FFT hops along the
way, and returns an exponential-moving-average of the bins.
`decay` is 0..1:
- `0.0` — last hop wins (no smoothing; same as `capture_at` at
  the end position).
- `~0.5` — moderate smoothing across the window.
- `~0.85` (default) — strong smoothing; good for "spectral
  fingerprint of this section".
- `>0.95` — first hop dominates; usually not what you want.

Same multi-client transport-mutation caveat.

## Spectrogram (temporal waterfall PNG)

```json
{"subcommand": "spectrogram",
 "track_id": "track.78",
 "duration_ms": 2000}
```

This is the visualize tool, not the spectrum tool — it opens the
streaming spectrum viz and captures ~2 s of live frames. Requires
transport to be playing for non-empty content. Prefer
`capture_window` when you want aggregated bins as data, not a PNG.

## When to use which

- "What's loudest at the current position right now?" → `snapshot`
  (works only when transport is playing).
- "What's the spectrum at bar 17?" → `capture_at`.
- "What does the bridge section average to?" → `capture_window`.
- "Show the user a moving waterfall" → `visualize.spectrogram`.
- "Compare master vs drum bus at this same moment" → two
  `capture_at` calls at the same `at_samples` with different
  `target` and diff the bins.

## Reading the output

The result includes `sample_rate`, `bins`, and `channels[*].bins`
(per-channel dBFS values). Bin N corresponds to frequency
`N * sample_rate / fft_size / 2`. With fft_size 2048 at 48 kHz,
bin 0 = 0 Hz, bin 100 ≈ 1.17 kHz, bin 1024 = Nyquist (24 kHz).
