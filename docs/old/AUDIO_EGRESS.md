# Audio egress (DAW → browser) — M6a status

*Last updated 2026-04-20.*

## What's wired

1. **Schema** — `AudioCodec::{Opus, RawF32Le}` selects compressed or
   lossless streaming per client request. Opus is the default (~96
   kbps); `RawF32Le` is lossless for gigabit-LAN tracking sessions.
   ([crates/foyer-schema/src/audio.rs](../crates/foyer-schema/src/audio.rs))

2. **Sidecar audio hub** — [`crates/foyer-server/src/audio.rs`](../crates/foyer-server/src/audio.rs)
   holds live streams keyed by `stream_id`. Each stream owns:
   - a Tokio mpsc `PcmFrame` receiver (source of truth for PCM),
   - a 20 ms encode loop that either runs the Opus encoder or packs
     raw f32 LE bytes straight through,
   - a `broadcast` channel of encoded packets, wire-ready.

3. **Opus encoder wrapper** — [`audio_opus.rs`](../crates/foyer-server/src/audio_opus.rs)
   wraps `audiopus`. Fixed-frame-size API (20 ms chunks at 8/12/16/24/48
   kHz), validates input length, surfaces init errors cleanly.

4. **Binary WS route** — `GET /ws/audio/:stream_id`. Per-message wire
   format:

   ```
   u32  stream_id        (big-endian)
   u64  capture_us       (big-endian; microseconds since Unix epoch)
   [N]  opus payload    OR   interleaved f32 LE (codec-dependent)
   ```

   Subscriber pattern: the `broadcast::Sender` fanned out by the hub
   feeds every connected `/ws/audio/N` client. Lag is tolerated via
   `RecvError::Lagged`; the client is expected to resync on its own.

5. **Browser listener** — [`web/src/viz/audio-listener.js`](../web/src/viz/audio-listener.js):
   WebCodecs `AudioDecoder` → `AudioContext.destination` with a simple
   scheduled-buffer playback. The 12-byte header is parsed, decoded
   Opus frames are scheduled at a 150 ms cushion.

6. **Listen button** — mixer master strip has a speaker-icon toggle
   that opens an egress stream on the master bus and plays the audio
   in-browser. Works against the sidecar's **test-tone source** today;
   swap to real audio when the shim tap below lands.

7. **Dev probe** — `/dev/run-tests` includes an `audio_egress` probe
   that opens a stream, spawns the test tone, subscribes to the hub's
   broadcast, and asserts ≥ 1 Opus packet is emitted within 500 ms.
   Currently passing 9/9 against the stub.

## Command flow (current)

```
Browser                        Sidecar                            Audio hub
   │                              │                                   │
   │─ Command::AudioStreamOpen ──►│                                   │
   │  { stream_id=N, source=..,   │                                   │
   │    format=..,                │                                   │
   │    transport=WebSocket }     │                                   │
   │                              │── spawn_test_tone_source ────────►│
   │                              │── open_stream(N, ..) ────────────►│
   │                              │                                   │── encode loop spawns
   │◄─ Event::AudioEgressStarted─│                                   │
   │                              │                                   │
   │── (separate WS) GET /ws/audio/N                                  │
   │◄─────────────── subscriber attach ──────────────────────────────►│
   │                                                                   │
   │◄═══ binary packets (stream_id + ts_us + opus) ═══════════════════│
   │     every ~20 ms                                                  │
   │                                                                   │
   │─ Command::AudioStreamClose ─►│── close_stream(N) ────────────────►│── encode task abort
   │◄─ Event::AudioEgressStopped─│                                   │
```

## Hard blocker: the shim-side audio tap

The hub currently sources PCM from `AudioHub::spawn_test_tone_source`
(a 440 Hz sine wave). Real DAW audio requires the shim to:

1. Register a process callback. Ardour exposes this via
   `ARDOUR::Session::attach_Process (const Session::ProcessFunction&)`
   or by deriving an RT callback on a `Route::output()` port.

2. Inside the RT callback, read the master bus's (or selected route's)
   post-fader output buffer — `AudioPort::get_audio_buffer(nframes)` —
   for every frame, convert to interleaved f32 if needed, and push
   into a ring buffer (RT-safe: no allocation, no locking).

3. A dedicated non-RT reader thread drains the ring and writes IPC
   frames of kind `FrameKind::Audio` to the sidecar socket. (The
   existing `foyer-ipc` framing already supports Audio-kind frames;
   see [`crates/foyer-ipc/src/codec.rs`](../crates/foyer-ipc/src/codec.rs).)

4. On the sidecar side, `HostBackend::open_egress` already returns
   an `mpsc::Receiver<PcmFrame>`; feed its output directly into
   `AudioHub::open_stream` instead of the test-tone generator. The
   `ws.rs` handler needs that swap when a shim is live.

This is a focused C++ task but touches the RT thread, so it needs a
careful review. I haven't wired it tonight because getting RT-audio
wrong is the one category of bug I can't self-verify (I can't hear
the result, and dropouts / pops would be invisible to the probes).

## Deferred / future

- **Latency probe (M6b)** — schema has `Command::LatencyProbe`; shim
  needs to inject a sample-accurate marker into the output and
  measure the round-trip when it comes back as ingress. Client refuses
  to arm record until a fresh probe completes.
- **Ingress (M6c)** — browser mic → Opus → sidecar decode → resample
  → IPC → shim writes into a virtual input port. Mirror of egress.
  Blocked on Ardour registering a "remote input" port type.
- **AudioWorklet jitter buffer** — current playback schedules
  directly against `AudioContext.destination`; for real session
  monitoring we want a worklet-driven ring buffer so we can mask
  small jitter / xrun gaps without glitching the output.
- **WebRTC transport variant** — `AudioTransport::WebRtc` is in the
  schema but not wired on either side. Plain WebSocket gets us the
  same UX with simpler plumbing; WebRTC is an optimization for
  higher-packet-loss networks.
- **Underrun + clip indicators in-band** — `waveform-gl.js` already
  has a `u_underrun` sampler ready. Once the shim publishes xrun
  timestamps over IPC, the waveform component can mask them onto
  the region visually.
