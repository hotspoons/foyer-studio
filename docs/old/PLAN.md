# Foyer Studio — Implementation Plan

Foyer Studio is a web-native control surface, UI, and audio distribution layer for
professional DAWs. The DAW remains the audio engine (unmodified audio path); Foyer talks to
it over IPC and re-exposes session state to browsers over WebSocket, with an optional audio
stream forwarded via WebRTC. A stubbed backend lets the whole web experience run without a
DAW attached, for demos and frontend dev.

**Ardour is our first target** because it's open-source, fully pro-grade, and lets us modify
our own shim freely. The architecture is deliberately structured so a second target (Reaper
via ReaScript/C++ extension, Bitwig via Controller API, Pro Tools via EUCON, etc.) is a new
shim + new backend impl, nothing more.

## 1. Guiding principles

- **Rust primary.** C++ footprint is a thin shim that subscribes to DAW events, serializes
  them onto a DAW-agnostic IPC protocol, and dispatches commands back. Everything else —
  schema, protocol, client fan-out, audio encoding, collaboration, auth — lives in Rust.
- **DAW-agnostic above the shim.** Every artifact above the C++ shim layer (the IPC wire
  format, the Rust crates, the WebSocket protocol, the web app) speaks a neutral domain
  model. No DAW-specific types, IDs, or terminology leak past the shim boundary. The shim
  translates the host DAW's concepts into the Foyer domain model on the way out, and the
  other direction on the way in.
- **Out-of-tree first.** The Ardour shim builds as a Control Surface `.so`, installed to
  `$LIBDIR/surfaces`. No edits to Ardour's source tree unless a public-API gap forces it.
  Track any required patches in `docs/ardour-patches/` as candidate upstream contributions.
  Each future DAW gets its own shim directory with its own native extension mechanism.
- **Toolkit-agnostic schema.** Model the DAW domain (session, tracks, plugins, params), not
  any one DAW's internal data structures and not any one UI toolkit's widget tree. The
  browser UI is rebuilt from domain metadata using our own components.
- **No JS framework, no bundler.** Web UI is Lit web components + Tailwind CSS (standalone
  CLI, one-shot), with vendored ES-module dependencies under `web/vendor/` loaded via
  native `<script type="module">` and an import map. No `package.json`, no Vite/Webpack,
  no npm install step to run the app. We build what we can; we vendor what we can't.
- **One app, two modes.** The same Foyer UI ships in two shapes: served out of
  `foyer-cli` for browser access, and bundled into a self-contained native desktop app
  (Tauri-based, system WebView, no Electron/Chromium bundling). The desktop binary runs
  in either **host mode** (embeds `foyer-server` in-process, connects to the local DAW
  shim) or **client mode** (connects to a remote `foyer-cli` over WebSocket and acts as
  a dedicated full-screen UI). Same codebase, same UI, startup flag picks the mode. UI
  is designed for full-screen use with our own widgets, 100%.
- **Stub-first backend.** A `Backend` trait with multiple implementations: `StubBackend`
  (in-memory fake session) and one `*Backend` per supported DAW. Server is generic over the
  trait.
- **Bi-directional audio forwarding is a first-class concern.** The IPC contract includes
  audio channels in both directions from day one, even though we don't implement
  end-to-end WebRTC audio until later milestones. Every shim must be able to (a) produce
  a PCM stream from a configurable source (egress: DAW → browser for monitoring mixes)
  and (b) accept a PCM stream into a configurable sink (ingress: browser → DAW for remote
  tracking). Ingress is not the normal mode — it's for remote-tracking workflows where a
  performer records into a remotely-hosted DAW and monitors locally — but the architecture
  supports it.
- **Single-user correctness before multi-user collab.** Design IDs, subscriptions, seq
  numbers, and event-driven deltas from day one. Don't build the collab features until
  single-user is solid.

## 2. Repo layout (greenfield → target)

```
foyer-studio/
├── Cargo.toml                    # workspace root
├── crates/
│   ├── foyer-schema/             # serde types for session/controls/messages, versioned
│   ├── foyer-ipc/                # DAW-agnostic IPC wire protocol (shim ↔ sidecar)
│   ├── foyer-backend/            # Backend trait + shared types (consumed by server)
│   ├── foyer-backend-stub/       # in-memory demo backend
│   ├── foyer-backend-host/       # generic IPC-based backend — talks to ANY shim
│   ├── foyer-audio/              # audio pipeline: IPC PCM → Opus → WebRTC egress
│   ├── foyer-server/             # WebSocket server, client registry, fan-out, presence
│   │                             #   exposed as a library (embeddable) AND used by CLI
│   ├── foyer-cli/                # `foyer serve --backend=stub|host [--socket=PATH]`
│   └── foyer-desktop/            # native shell (Tauri / wry+tao) — host or client mode
├── shims/                        # one subdir per host DAW — all speak foyer-ipc
│   ├── ardour/                   # first target (C++, out-of-tree Ardour Control Surface)
│   │   ├── wscript
│   │   ├── src/
│   │   │   ├── surface.cc        # ControlProtocol + AbstractUI subclass
│   │   │   ├── signal_bridge.cc  # subscribes to Controllable::Changed, Session::*
│   │   │   ├── ipc.cc            # foyer-ipc server (UDS, length-prefixed MsgPack)
│   │   │   ├── audio_tap.cc      # PortAudio/JACK tap on a bus → IPC audio stream
│   │   │   └── dispatch.cc       # IPC command → Ardour API call
│   │   └── README.md
│   ├── reaper/                   # placeholder for future target
│   └── README.md                 # "what a shim must implement" — links to foyer-ipc spec
├── web/                          # Lit + Tailwind, no bundler (Milestone 4+)
│   ├── index.html                # entry; loads ES modules directly
│   ├── src/                      # hand-written JS modules (Lit components, WS client)
│   ├── styles/
│   │   ├── tw.css                # Tailwind input (@tailwind directives)
│   │   └── tw.build.css          # generated output (committed; Tailwind CLI is one-shot)
│   ├── vendor/                   # vendored ES modules — lit/, etc. committed to the repo
│   ├── tester.html               # M2 raw protocol dumper
│   └── README.md                 # "how to run tailwind CLI and start dev server"
├── docs/
│   ├── PLAN.md                   # this file
│   ├── schema.md                 # schema spec (drafted in Milestone 1)
│   ├── ipc-protocol.md           # shim ↔ sidecar wire protocol (the "host adapter contract")
│   ├── ws-protocol.md            # sidecar ↔ browser wire protocol
│   └── ardour-patches/           # tracked patches to Ardour, if any become necessary
└── Justfile                      # dev tasks
```

Notice that there is no `foyer-backend-ardour` crate. The Rust side only knows about a
generic `HostBackend` that speaks `foyer-ipc`. Whether the process on the other end of the
socket is the Ardour shim, the Reaper shim, or a mock is invisible to everything above.

## 3. The architectural split

```
                ┌─────────────────────────────────────────────────┐
                │  Host DAW process  (Ardour / Reaper / …)        │
                │  ┌────────────────────┐    ┌────────────────┐   │
                │  │ audio engine + GUI │◄──►│  foyer-shim    │   │
                │  │ (unmodified)       │    │  (native ext)  │   │
                │  └────────────────────┘    └───────┬────────┘   │
                │        audio bus tap     ──────────┤            │
                │        virtual input sink◄─────────┤            │
                └────────────────────────────────────┼────────────┘
                                                     │ foyer-ipc
                                                     │ (UDS, MsgPack + PCM frames, both ways)
                ┌────────────────────────────────────▼────────────┐
                │  foyer-cli (Rust process) — DAW-agnostic        │
                │  ┌──────────────────┐   ┌─────────────────┐     │
                │  │ HostBackend      │──►│ foyer-server    │◄──┼─── WS control (browsers)
                │  │ (or StubBackend) │   │                 │     │
                │  └──────────────────┘   └─────────────────┘     │
                │  ┌──────────────────────────────────────────┐   │
                │  │ foyer-audio                              │   │
                │  │  egress : PCM  → resample → Opus → WebRTC│───┼── WebRTC audio out (browsers)
                │  │  ingress: Opus → resample → PCM  → IPC   │◄──┼── WebRTC audio in (browsers)
                │  │  latency: round-trip probe + lock offset │   │
                │  └──────────────────────────────────────────┘   │
                └─────────────────────────────────────────────────┘
```

**Why this split:**

- The C++ shim is ~500–1500 lines whose only dependencies are the host DAW's public APIs.
  It's easy to keep in lockstep with that DAW's releases. Swap the shim — everything above
  it is unchanged.
- Rust owns all the interesting logic (schema, state, fan-out, audio encoding, collab) and
  evolves independently of any host DAW.
- The `foyer-ipc` contract is the **only** bidirectional coupling. A new host target is a
  new shim that speaks `foyer-ipc`; the `HostBackend` crate connects to it without
  modification.
- If/when Ardour upstream accepts a generic "session-introspection IPC" surface, the shim
  is what we'd propose — and it's already structured as a clean submission, with a
  protocol spec that isn't Ardour-specific.

## 4. Schema and protocol sketch

Full specs are drafted in M1; this is the shape. There are **two wire protocols**, both
DAW-agnostic:

- **`foyer-ipc`** — between a shim and the Rust sidecar (local, UDS, binary).
- **`foyer-ws`** — between the Rust sidecar and browsers (WebSocket, JSON + MsgPack).

Both share the same underlying domain schema types, defined once in `foyer-schema`.

**Domain entities:** `Session`, `Transport`, `Track`, `Bus`, `Send`, `PluginInstance`,
`Parameter`, `Meter`, `AudioStream`. No DAW-specific concepts (no `Stripable`, no
`Route`, no `MediaItem`) — these are neutral terms every DAW maps onto its own primitives.

**Stable IDs:** `track.<uuid>.gain`, `plugin.<uuid>.param.<index>`, `transport.tempo`.
UUIDs are assigned by the shim. The shim is responsible for maintaining a stable mapping
between Foyer UUIDs and its host DAW's internal identifiers across sessions and reloads
(typically by persisting the mapping into the DAW's session file or a side-car store).
Foyer doesn't care where they come from — it just requires they be stable.

**Control types:** `continuous`, `discrete`, `enum`, `trigger`, `meter`, `text`,
`custom_gui` (phase-2 pixel-forwarding escape hatch).

**Control message envelope:**
```json
{ "type": "control.update", "id": "track.abc.gain", "value": 0.72,
  "origin": "user:alice", "seq": 4871 }
```

**Message types (both protocols):**
- `session.snapshot` — full tree (snapshot for join/recovery)
- `session.patch` — structural change (track added/removed, plugin loaded)
- `control.update` — value change outgoing from the authoritative side
- `control.set` — value change request from a subscriber
- `meter.batch` — bundled meter readings at ~30Hz
- `audio.egress.offer` — shim announces a PCM stream is available with given format
- `audio.egress.start` / `audio.egress.stop` — sidecar requests the shim to produce/halt
- `audio.egress.frame` — binary-framed PCM frame flowing shim → sidecar
- `audio.ingress.offer` — sidecar announces a PCM stream is available (a remote performer
  is connected) with given format, proposed sink (track/input), and measured network-side
  latency
- `audio.ingress.open` / `audio.ingress.close` — shim accepts/declines and binds the
  stream to a host input or refuses
- `audio.ingress.frame` — binary-framed PCM frame flowing sidecar → shim
- `audio.latency.probe` / `audio.latency.report` — round-trip measurement exchange used
  to lock the ingress timing offset (see §5.1)
- `presence.*` — user joined/left/cursor moved (WebSocket only, sidecar-synthesized)

**Transports:**
- `foyer-ws`: WebSocket for control; MessagePack on the hot path, JSON elsewhere.
- `foyer-ipc`: UDS with length-prefixed MessagePack for control/events; audio frames are
  interleaved with a small binary header (stream id + sample count + format ref) over the
  same connection for simplicity, with the option to promote to a shared-memory ring
  buffer later if profiling demands.
- WebRTC peer connection between sidecar and browser for audio egress. Opus encode lives
  in `foyer-audio`, not in any shim.

**Seq numbers + short ring buffer** on the sidecar so disconnected browsers can request
deltas since their last seq on reconnect.

## 5. The Host Adapter Contract (a.k.a. `foyer-ipc`)

This is the interface document a shim must implement. A correct shim is a program that:

1. **Enumerates the current session** on request and emits a `session.snapshot` populated
   with Foyer's neutral entity types. Ardour-specific concepts (e.g., `Stripable`) must be
   mapped — buses and tracks both become `Track` records with a `kind` field, for example.
2. **Emits `control.update` events** whenever a mapped control's value changes inside the
   host DAW, tagged with the Foyer stable ID.
3. **Emits `session.patch` events** for structural changes (track add/remove, plugin
   load/unload, route change).
4. **Applies incoming `control.set` commands** by resolving the Foyer ID and calling the
   host's native API on the appropriate thread.
5. **Produces a configurable audio tap (egress).** On receiving
   `audio.egress.start {source, format}` the shim begins emitting `audio.egress.frame`
   records for that source (e.g., master bus, a specific track, the monitor bus) until
   `audio.egress.stop` or disconnect. Sample rate, channel count, and frame size are
   reported in `audio.egress.offer` and confirmed in `audio.egress.start`; the shim may
   refuse formats it can't produce.
6. **Accepts an audio sink (ingress).** On receiving `audio.ingress.open {sink, format,
   latency_hint}` the shim binds the incoming stream to a host-side input (typically a
   virtual JACK port for Ardour or equivalent for other hosts) so it appears as a normal
   input the user can arm on a track. The shim must:
   - **Not monitor the stream through the DAW's outputs by default** — it's expected to
     be used with local monitoring on the performer's end, and looping audio back creates
     feedback and confusion. The sink should default to "input only" with monitoring
     disabled.
   - **Apply the locked latency offset** from the most recent
     `audio.latency.report` so recorded material lines up on the DAW timeline. The offset
     covers the full round trip: browser capture + WebRTC + sidecar decode + IPC + host
     input buffer. If no offset has been locked, the shim should refuse to arm the stream
     for recording (it can still pass audio through non-destructively).
7. **Participates in latency measurement.** On `audio.latency.probe` the shim injects a
   detectable pulse into the ingress path and watches for it on the egress path (or
   vice-versa, or both), reporting measured round-trip in samples. Exact mechanism is
   shim-internal; the protocol just needs the measurement outcome.
8. **Negotiates a schema version** during the handshake so the sidecar can gracefully
   refuse incompatible shims.

Per-host shim responsibilities NOT in the contract (they're private implementation):

- UUID ↔ native-ID mapping (Ardour route ID, Reaper track GUID, whatever).
- Threading marshaling to the host's main/audio/UI thread as that host requires.
- Native plugin metadata extraction.
- Audio tap implementation (JACK port tap for Ardour; a render callback for Reaper; etc.).

This contract document lives at [docs/ipc-protocol.md](ipc-protocol.md) once drafted in M1.

### 5.1 Latency discipline for ingress (remote tracking)

Remote tracking only works if we're honest about the three things that can be true and
the one thing that can't:

1. **The remote performer hears themselves locally** (their own headphones, zero-latency
   monitoring on their audio interface, or software monitoring on their machine). This
   has to be their problem, not ours, because any round-trip monitoring over WebRTC is
   going to be too laggy to play to.
2. **The DAW does NOT mix the incoming stream into its outputs** — not to the master bus,
   not to the monitor bus, not anywhere that would get tapped and forwarded back as
   egress. The ingress sink defaults to "record-armed input only, monitor off." The shim
   enforces this; the sidecar trusts it.
3. **The recorded audio lands in the right place on the timeline.** This requires knowing
   the total round-trip latency of the path (browser capture → network → sidecar decode
   → resample → IPC → host input buffering → DAW record head) and shifting the recording
   backward by that amount. DAWs already do this for hardware with reported ADC/DAC
   latency — we're just adding one more contribution to the latency budget.
4. **What CANNOT be true:** live-playing to a click or to previously recorded material
   that originates in the DAW and is forwarded back over egress. The round-trip is ~100+
   ms, which is unplayable. The remote performer plays against a click they generate
   locally, or against a pre-shared backing track they load locally, never against a
   live-forwarded DAW mix.

**Latency measurement and lock:**

- On setup, the sidecar and shim run a calibration exchange: sidecar injects a known
  marker into the ingress stream, shim captures when it arrives at the host input, shim
  also emits a marker on egress, sidecar captures its arrival. Combined with WebRTC's
  own jitter-buffer reporting, we derive a round-trip number.
- That number gets locked into the shim's input delay compensation for the duration of
  the session. We do not chase it dynamically (WebRTC jitter would cause timeline drift).
- If the network path changes characteristics dramatically (e.g., the performer moves
  from wifi to cellular) the lock invalidates and must be re-measured before the next
  take. The UI surfaces this to both sides.

**Resampling:** browser-captured audio typically arrives at 48 kHz (WebRTC standard); the
host DAW may be running at any rate. Resampling happens in `foyer-audio` on the sidecar,
before frames hit the IPC, so the shim always receives audio in the host's native rate.
Same direction in reverse for egress (sidecar receives PCM at host rate, resamples to
48 kHz for Opus/WebRTC). Use a high-quality resampler (`rubato` crate is the obvious
choice) configured for low latency — remote tracking has a tight budget.

## 6. Deployment shapes

The same Foyer UI and server code ships in several ways. Choose one per install;
everything below M4 is shape-agnostic.

**Shape A — browser + `foyer-cli`.** The default for development and headless servers.
User runs `foyer-cli serve`, points any browser at the URL. Works everywhere; no native
dependencies beyond the Rust toolchain.

**Shape B — native desktop, host mode.** A single self-contained binary (`foyer-desktop`)
that:
1. Starts `foyer-server` in-process on a localhost port.
2. Connects to a local DAW shim via `foyer-ipc`.
3. Opens a system WebView window pointed at the embedded UI.
4. Optionally also listens on LAN so other machines/browsers/desktop-clients can connect.

This is what someone running the DAW on their own machine installs. Full-screen on a
secondary display is the intended primary use.

**Shape C — native desktop, client mode.** Same `foyer-desktop` binary, started with a
remote-URL argument. Does NOT start `foyer-server` or touch any DAW. Opens a WebView
connected to a remote `foyer-cli` over WebSocket (and WebRTC for audio). Acts as a
dedicated, chromeless, full-screen UI for controlling a studio machine elsewhere.

**Packaging approach:** prefer Tauri 2 because it uses the system WebView (smaller
binary, ~3–10 MB instead of Electron's ~150 MB), is Rust-native, and integrates cleanly
with the existing workspace. The UI is served from a custom protocol handler pointing at
web assets bundled via `include_dir!` at compile time, or from the in-process
`foyer-server` when in host mode. If Tauri's asset pipeline gets in the way of our
"no-bundler" stance, drop to raw `wry + tao` — they're the primitives Tauri is built on
and give us full control over what's shipped. Electron is explicitly **not** a target;
the Node toolchain conflicts with our frontend principles.

Per-OS distributables: `.dmg` (macOS), `.msi` or plain `.exe` (Windows), `.AppImage` +
`.deb` (Linux). Tauri handles all of these.

## 7. Milestones

Each milestone ends with a concrete, runnable deliverable.

### M0 — Bootstrap (1–2 days)
- Cargo workspace with empty crates.
- Justfile recipes: `just build`, `just test`, `just fmt`, `just run-stub`.
- CI skeleton (fmt + clippy + test).
- Build Ardour from source in the dev container; verify `libardour_websockets.so` loads
  (reference, not used).
- Wire `scripts/bootstrap-workspace.sh` into `post-create.sh` if not already.

**Deliverable:** `cargo test` passes empty tree; Ardour launches with default surfaces.

### M1 — Schema + IPC contract + StubBackend (5–7 days)
- Write `foyer-schema` crate: serde types for all domain entities and message envelope.
  Version the schema (`#[serde(tag = "v")]` or similar).
- Write `foyer-ipc` crate: the DAW-agnostic wire protocol. Codec, framing, handshake, and
  the full message set including bi-directional audio (egress + ingress + latency probe).
- Write `foyer-backend` trait: `subscribe() -> Stream<Event>`, `apply(Command) -> Result`,
  `snapshot() -> Session`, `open_egress(source, format) -> Stream<PcmFrame>`,
  `open_ingress(sink, format) -> Sink<PcmFrame>`, `measure_latency() -> LatencyReport`.
- Write `foyer-backend-stub`: in-memory `Session` with fake tracks/plugins; background
  task that emits fake meters and parameter updates; can produce a synthetic egress
  stream (sine wave or pink noise) and consume an ingress stream (writes frames to a
  ring buffer so tests can assert what arrived) so both audio directions can be exercised
  without a real DAW.
- Write `docs/schema.md`, `docs/ipc-protocol.md`, `docs/ws-protocol.md`.

**Deliverable:** unit tests exercise the stub backend including both audio directions and
the latency-probe handshake; can serialize/deserialize a realistic session snapshot and
PCM frames (both directions) round-trip.

### M2 — foyer-server + WebSocket fan-out (3–4 days)
- `foyer-server` accepts WebSocket connections, maintains client registry, tracks last-seen
  seq per client, maintains short delta ring buffer for resync.
- Subscribes to backend events, fans out to all clients; handles `control.set` by calling
  `backend.apply(...)` and broadcasting the resulting event.
- `foyer-cli serve --backend=stub --listen=127.0.0.1:3838`.
- Minimal HTML tester in `web/tester.html`: connects, dumps stream, has a few inputs to
  round-trip control changes.

**Deliverable:** open `tester.html`, see the stub session, change a fader, see it echo back
with proper seq; open a second tab, verify fan-out.

### M3 — Ardour shim + generic HostBackend (1.5–2 weeks)
- Out-of-tree `shims/ardour/` builds against installed Ardour. Minimal ControlProtocol
  subclass following the pattern at
  [libs/surfaces/websockets/ardour_websockets.cc](../../ardour/libs/surfaces/websockets/ardour_websockets.cc).
- Implements the `foyer-ipc` handshake and emits `session.snapshot` by translating
  `Session::get_stripables`
  ([libs/ardour/ardour/session.h:354](../../ardour/libs/ardour/ardour/session.h#L354))
  output into Foyer's neutral entity model.
- Subscribes to `Controllable::Changed`, `Session::RouteAdded`, transport signals
  ([libs/ardour/ardour/session.h:466](../../ardour/libs/ardour/ardour/session.h#L466)) and
  emits neutral `control.update` / `session.patch` events.
- UDS server with length-prefixed MessagePack framing.
- Command dispatch: resolves Foyer stable IDs back to `AutomationControl` pointers via a
  registry kept inside the shim.
- Plugin metadata via `Plugin::get_parameter_descriptor`
  ([libs/ardour/ardour/plugin.h:108](../../ardour/libs/ardour/ardour/plugin.h#L108)).
- Rust side: write `foyer-backend-host` (the generic IPC backend — has no knowledge of
  Ardour).

**Deliverable:** start Ardour with the Foyer shim loaded, start `foyer-cli serve
--backend=host`, connect via tester.html, see real session, move a fader in browser → see
it move in Ardour's native GUI → see the echo back.

### M4 — Lit UI, first real surface (1–2 weeks)
- Set up `web/` with a single `index.html` that loads ES modules from `web/src/` with an
  import map aliasing vendored Lit from `web/vendor/lit-<version>/`.
- Vendor Lit: download the `lit` and `lit-html` ESM builds, commit under
  `web/vendor/lit-<version>/`. Add Tailwind standalone CLI invocation to the Justfile
  (`just tw-watch`, `just tw-build`).
- Component library — one `<foyer-*>` custom element per control type (Fader, Knob, Enum,
  Meter, Trigger). Each subscribes to its schema ID via a lightweight shared store
  implemented as a Lit reactive controller over a single `EventTarget`.
- WebSocket client (hand-rolled, in `web/src/ws.js`): connection management, reconnection,
  delta-replay using the seq mechanism, dispatches `control.update` into the store.
- First surface: transport bar + mixer strip. Meter rendering in a `<canvas>` element
  inside a Lit component (not DOM nodes per meter).
- Serve statically during dev (`python3 -m http.server` or a trivial Rust static-file
  server baked into `foyer-cli`). No Node involved at any stage.

**Deliverable:** recognizably a mixer, bound to any compliant backend (stub or Ardour),
30fps meters, no perceptible lag on faders. The entire web tree builds with one shell
command (Tailwind CLI) and runs with a static file server; no `npm install` exists.

### M4.5 — Desktop shell (3–5 days, orthogonal)

Can start any time after M4; doesn't block M5+. Produces Shape B and Shape C (see §6).

- New crate `foyer-desktop` built on Tauri 2 (or `wry + tao` if Tauri's asset pipeline
  proves awkward for a zero-bundler frontend). One binary, startup flag picks mode.
- Refactor `foyer-server` to expose a clean embeddable API: `Server::new(config).run()`
  returning a `JoinHandle`. `foyer-cli` and `foyer-desktop` both call into it; `cli` is
  now just the CLI + config glue around the library.
- **Host mode:** `foyer-desktop --backend=host --socket=/tmp/foyer.sock` starts
  `foyer-server` on a random localhost port, opens a WebView pointed at it. Optionally
  also listens externally if `--listen=0.0.0.0:3838` is passed so other browsers and
  remote client-mode desktops can join.
- **Client mode:** `foyer-desktop --connect=wss://studio.example.com:3838` opens a
  WebView with a baked-in HTML entrypoint that connects straight to the remote WS. No
  backend started. WebRTC audio flows peer-to-peer to the desktop's WebView.
- Web assets bundled via `include_dir!` at compile time in host-mode (or served by the
  embedded server); same assets the browser shape uses.
- Full-screen-first behavior: cmd/ctrl-F toggles, frameless window option, no menubar
  distractions by default.

**Deliverable:** on your dev machine, `cargo run -p foyer-desktop -- --backend=host`
opens a native window showing the mixer, with the same UX as the browser shape. On a
second machine, `foyer-desktop --connect=ws://<first-machine>:3838` opens a native
window showing and controlling the first machine's session.

### M5 — Plugin parameter UIs (1 week)
- Plugin inserts flow through the same schema. Add `PluginPanel` component that renders a
  generic parameter form from plugin param descriptors.
- Honor LV2 port groups and VST3 parameter categories as layout hints.

**Deliverable:** load a plugin in the host DAW, its parameter panel appears in Foyer,
tweaking either side keeps them in sync.

### M6a — Audio egress: DAW → Opus → WebRTC (1.5–2 weeks)
- `shims/ardour/src/audio_tap.cc`: tap a configurable bus (default: master) via a JACK
  client or Ardour's port-insert mechanism; frame into `foyer-ipc` `audio.egress.frame`
  messages. Watch thread discipline — the audio thread must not block on IPC; use a
  lock-free ring buffer into a service thread that writes to UDS.
- `foyer-audio` crate (egress half): receive PCM frames over IPC, resample to 48 kHz with
  `rubato`, Opus-encode, stream to browsers via WebRTC. Use `webrtc-rs`. One
  `RTCPeerConnection` per subscriber; signaling piggy-backs on the existing WebSocket.
- Browser side: `<audio>` element sourced from the WebRTC stream; mute/solo/volume UI.
- Exercise against the stub backend's synthetic egress stream so this works without a
  DAW for demos.

**Deliverable:** click "listen" in the browser UI, hear the master bus with ~30–50 ms
latency; works against both stub and Ardour backends.

### M6b — Audio ingress + latency lock: browser → DAW (2–3 weeks)
- `foyer-audio` crate (ingress half): accept WebRTC audio from a browser, resample to
  host native rate, feed frames over IPC via `audio.ingress.frame`.
- `shims/ardour/src/audio_sink.cc`: create a virtual JACK input port (or equivalent
  mechanism in future hosts) that receives ingress frames and presents them to Ardour as
  a normal input. Expose in the schema as an input source the user can route to a
  record-armed track.
- Latency calibration: implement the probe exchange (§5.1). UI surfaces a "calibrate"
  button on each connected remote performer; result is displayed and lockable. Shim
  refuses to arm a remote input for recording until calibration is locked.
- Monitor-off enforcement: shim sets up the virtual input with monitoring disabled and
  exposes no UI path to re-enable it. This prevents the accidental feedback loop.
- Browser side: microphone capture via `getUserMedia`, apply the constraints for music
  fidelity (no AGC/NS/echo cancellation), let the user pick a channel count / sample rate
  where the hardware supports multi-channel.
- Exercise end-to-end against the stub backend's ingress sink.

**Deliverable:** remote performer opens Foyer in a browser, grants mic access, sees their
input appear in the host DAW as an assignable source, gets a locked latency number, arms
a track, records a take that lines up correctly on the timeline. Local operator monitors
the performance via their existing headphones (not through Foyer's audio path).

### M7 — Collaboration, minimal (1 week)
- Presence: client identity, broadcast `presence.joined/left/cursor`. Simple visual
  indicators in UI.
- Last-write-wins for controls; server-assigned seq makes ordering deterministic.
- Multi-client smoke test: two browsers, same host DAW, edits converge.
- Reject structural commands that reference stale entities (e.g., deleted track) with a
  clean error + resync.

**Deliverable:** open two browsers pointing at the same foyer-cli, move a fader in one,
watch it move in the other with presence indicator showing who moved it.

### M8 — MCP tools + in-app agent (1.5–2 weeks)

Expose Foyer's session as an MCP ([Model Context Protocol]) server so any
MCP-compatible LLM — Claude via Anthropic API, a local Ollama/LM Studio model,
whatever — can drive the DAW as a power-assist. Ship a first-party chat panel
in the web UI that talks through the same MCP surface so there's always a
known-working client.

**Pragmatic design principles:**

- **MCP server is just another WS client.** No new backend, no new protocol —
  the MCP server in `foyer-mcp` connects to `foyer-cli` over WebSocket exactly
  like a browser, and translates MCP tool calls into `Envelope<Command>`. This
  keeps the agent off the audio-realtime path and ensures anything the agent
  can do a human can do through the UI (and vice versa).
- **Resources vs tools, cleanly split.** MCP resources are read-only views:
  `foyer://session`, `foyer://track/{id}`, `foyer://plugin/{id}/params`,
  `foyer://meter/{id}`. MCP tools are the side-effecting subset:
  `set_control`, `toggle_record`, `load_plugin`, `add_send`, `bounce_region`.
  Tight, narrow, composable — don't ship a "mix_the_song" tool.
- **Destructive or expensive ops are proposals, not direct calls.** The MCP
  tool returns "proposed change N" and the web UI surfaces it with an Accept
  / Reject button. Confirmed once per session or per-op via user preference.
  Non-destructive reads and small parameter tweaks go through directly.
- **Attribution and undo.** Agent actions carry `origin="agent:<name>"` in the
  envelope; presence indicators and (eventual) per-user undo stacks inherit
  this for free from the M7 collaboration infrastructure.
- **Audio context via existing egress.** When the agent needs to "listen" to a
  mix, it opens an egress stream like any other client and decodes the Opus
  it receives. For offline work the agent uses a `render_bounce` tool that
  produces a file path the agent can then read.
- **Context windowing.** Don't dump the whole session tree into every agent
  request. The server-side MCP resource handlers return slim representations
  of the requested slice; the agent asks for more detail when needed. Track
  full names, parameter descriptors, and recent events compose into a few-KB
  envelope that's cheap to ship every turn.
- **Model-agnostic chat UI.** The in-app panel speaks to any MCP-capable host.
  Default config in `foyer-desktop` points at the Anthropic API with a
  user-supplied key; a toggle swaps to a local model via an OpenAI-compatible
  endpoint (covers Ollama, LM Studio, llama.cpp server). The user picks.

**Deliverables:**

- `crates/foyer-mcp` — MCP server crate. Uses the [rmcp] Rust SDK for the
  transport and tool/resource machinery. Connects to `foyer-cli` over WS.
  Ships tools for the M3/M4 surface area plus `open_audio_stream` hooks for
  M6 once those land.
- `foyer mcp` CLI subcommand that starts the MCP server (stdio transport for
  desktop agent hosts, or listens on a local port for a remote agent).
- Web UI chat panel (Lit component under `web/src/agent/`) with a settings
  pane for model endpoint + API key storage (credentials in OPFS, never sent
  to the foyer server).
- Session recipe: a documented example of running Claude Desktop or Goose
  against a local Foyer instance.

**Risks worth naming:**

- Prompt injection from session metadata (plugin names, track names,
  imported file names). Treat all session-resident strings as untrusted when
  rendering agent prompts — don't interpolate them into system prompts.
- Latency. Agent round-trips are multi-second; the agent should operate on
  stopped or looped transport by default, not live-driving a take.
- Scope creep. This milestone is about plumbing, not about shipping the
  world's best DAW copilot. The real product work is refining which tools
  the agent actually gets — and that's tuning across many user sessions, not
  a one-shot design.

[Model Context Protocol]: https://modelcontextprotocol.io
[rmcp]: https://github.com/modelcontextprotocol/rust-sdk

### M9+ — beyond the first release
- Internet-reachable deployment (TURN/STUN, auth tokens) — deferred until LAN works great.
- **Collaboration hub (parking lot).** A standalone service — call it `foyer-hub` — that
  acts as a WebSocket proxy/router and optional signaling server for WebRTC. Users
  running `foyer-cli` behind NAT register with the hub and get a stable discovery
  identity; remote clients (browsers or `foyer-desktop --connect`) find and connect to
  sessions through the hub rather than directly. Likely also hosts auth, presence
  aggregation across sessions, and per-session access control. Keep this in mind as a
  design constraint — the WebSocket protocol should survive being proxied and shouldn't
  bake in host-local assumptions — but don't build until the single-host collaboration
  story (M7) is solid and real users are asking for it.
- Second host target (Reaper is the most tractable candidate — stable C++ extension API,
  no licensing drama). Validates the abstraction.
- Phase 2 pixel forwarding via Xpra for plugins whose GUI is the point.
- Structural CRDT if/when last-write-wins isn't enough.

## 8. Keeping changes tight (fork vs upstream)

The out-of-tree shim means **zero edits to Ardour by default**. That's the whole strategy.

We'll hit three categories of potential Ardour gaps:

1. **Missing introspection.** E.g., a plugin descriptor field we want that isn't exposed.
   Fix: add a public accessor in Ardour, propose upstream. Small, contained, likely to land.
2. **Signal granularity.** E.g., no signal for some state transition we care about. Fix:
   add a signal upstream; similarly contained.
3. **Control-surface API limits.** E.g., can't observe something from a ControlProtocol
   subclass. Fix: promote the API in Ardour's public headers; also small.

Keep every such patch as a standalone file in `docs/ardour-patches/NNN-*.patch` with a
description of what it does and why we need it. That makes the upstream PRs trivial to
assemble later and keeps the fork (if any) minimal and legible.

## 9. Licensing note

Ardour is GPLv2. The `shims/ardour/` `.so` statically links `libardour`, so it's GPLv2+
accordingly — standard practice for anything touching Ardour's internals, and in keeping
with the ecosystem conventions Ardour's own developers have established. Patches we upstream
to Ardour are likewise GPLv2 and we should expect to send more as the integration matures.

The Rust sidecar runs in a separate process and talks to the shim over a documented IPC
protocol, so it isn't a derivative work of `libardour` under the standard network-boundary
argument (same position used by every DAW with an OSC or MCP controller). Future shims for
other engines (Reaper's SDK, JUCE hosts, commercial DAWs) each carry their own license
terms; keeping shim-per-DAW means those licenses stay localized and the sidecar / web
layers remain portable.

This layering is an engineering accommodation — we want a modern editing surface without
being locked into any single engine's release cadence or toolkit — not a political stance.
Ardour's decades of audio-engine work are what make the project viable; the boundary exists
to keep the per-host translation thin, not to insulate Foyer from its upstream.

## 10. Open questions (resolve before M3)

- **Shim UDS role:** does the shim listen for connections (sidecar connects in) or dial out
  (sidecar listens, shim connects)? Leaning listen-in-shim since the DAW is the long-lived
  process. Revisit if container networking makes it awkward.
- **Audio frame transport:** interleaved with control frames over the same UDS is simplest
  and works up to a point. Switch to a dedicated shared-memory ring buffer only if
  profiling says so, or if we need sample-accurate timestamps that a general UDS can't
  deliver.
- **Schema versioning policy:** semver in the message envelope; how we handle client/server
  skew. Pin down in Milestone 1.
- **ID stability on session reload:** verify Ardour's route IDs survive save/load and that
  the Foyer UUID mapping is durable across crashes. If not, we need a mapping persisted
  alongside the session file.
- **Audio format negotiation:** what does the shim promise? Probably float32 interleaved at
  the host's sample rate, with channel count matching the tapped bus. The sidecar
  resamples to 48 kHz before Opus (and the reverse for ingress).
- **Ingress sink mechanism in Ardour:** virtual JACK port vs synthetic input connection.
  JACK is the obvious path on Linux; macOS CoreAudio equivalent is BlackHole / Loopback
  style virtual device which is more intrusive. Pin down per-platform approach before
  M6b. Reaper's extension API gives us easier access to a synthetic input, which may
  validate the abstraction sooner.
- **Latency probe signal choice:** inaudible marker (high-frequency tone above the
  program material, or a brief null-sample window) vs out-of-band channel. Needs to be
  reliably detectable after Opus encode/decode and resampling. Likely a brief pulse on a
  known channel during a dedicated calibration mode rather than mid-performance.
- **Multi-performer ingress:** M6b supports one remote performer. Multi-performer is a
  scope decision for M8+ — each performer gets their own virtual input, independently
  calibrated, no attempt to align them with each other.

## 12. Active push — 2026-04-20 overnight

The running plan for this session's autonomous push is
[PLAN-overnight-2026-04-20.md](PLAN-overnight-2026-04-20.md) — bug-bash
first (including a transport-starts-rolling regression on session open
and WebGL waveforms not rendering), then shim RT audio tap (Phase 2),
then right-panel FABs (Phase 3), then track-editor modal, MIDI piano
roll, plugin live-update signals, dirty indicator, voice chat,
multi-window pop-out, and polish. Phase progression is linear but
blockers get parked in a "Deferred" section rather than halting the
push.

## 11. First coding-agent handoff

First package to delegate: **M0 + M1**. Self-contained, no Ardour hookup required, unblocks
everything. Success criterion: `just run-stub` starts `foyer-cli`, tester.html connects, a
realistic fake session renders, control round-trips work, and both audio directions can be
exercised end-to-end through the stub backend — egress produces PCM frames the audio
pipeline can consume, ingress accepts PCM frames and the stub records them into a ring
buffer that tests can assert against. The latency probe exchange should complete
against the stub (returning a synthetic fixed number).
7dd5ec3ebfff8c



---

### Plan from 4/21/2026:

---

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

- @Foyer Studio/sessions/at the casino/at the casino.ardour#1465-1531  - looks like it is saving now! The format is a little weird - we should be saving sequences, then arranging the sequences on a grid like hydrogen, then using that to generate notes for the region as a regular midi region.

This is creating new regions for each beat - this ain't the thing to do, all of the sequences and arrangements needs to be metadata that drove the generation of the region. Any time we update the sequences and arrangements for the sequences, we should *regenerate* the midi notes for the whole region. You should be able to convert a sequencer track to a regular midi track and hand-edit things on the piano roll, but not the other way around - a sequencer track should auto-generate the midi data.

The piano roll idea - you kind of missed that - basically instead of a fixed grid of drums, if you are using a regular instrument but still want to create an arrangement using the sequencer paradigm, allow a 16 beat or what ever piano roll instead of drum grid, with the option for ad-hoc placement and length of notes instead of to the grid via an alt drag or something like that

It would be awesome if we could have the midi generation happen in the foyer back end, triggered by sending state from the sequencer on the front end. This is where we will truly go on our own for design, but it should be a back end item so events emit on multiple connected clients
- Plugiin editor needs some work too, I don't see any plugins listed for selection even though it found the one for the black pearl drumkit multi we used for a virtual instrument on one track, so I can't change the instrument. The add instrument dialog appears under the midi setup  panel - this should probably be just inline in the midi form, not a separate panel
- Mousewheel over track labels in timeline should do vertical scrolling, not timeline zoom. Also need a modifer to be able to mousewheel and scroll down in the larger list
- Can't add midi tracks, only busses and audio
- Busses seem to be hooked up, we need a UI for them now
- MCP tools in foyer Rust API for primary DAW functionality, plus novel things like spectral analyzers, histograms, audio snippets for models that support audio, beats sequencer / looping addon, MIDI editing, and other things that a clanker can use to aid with production
- Automation still missing on tracks!



---



- ~~More polish on the beats - The add pattern button should be above the patterns boxes, the arrangement box should be resizable veritcally with vertical overflow, the preset beat kit we detected should be able to add additional beats (pick from piano roll, name the custom drum, should get placed in the note sequence). Have a checkbox to enable/disable audio preview in all piano rolls so when you click a note or drum, as long as the channel is unmuted and bussed to output (not disk only). Add ability to drag up/down the velocity for beats on the sequencer (need to show colored velocity markers with multiple beats per note if there is overlap, see screenshot)~~
- ~~Add "add region" in midi channel context menu (should add region at point where right clicked)~~
- ~~Alt drag for adhoc placement of beats and notes in quantized grid, alt drag resize of notes too~~
- ~~Presets manager on beat loops (with option to import/export as $name.fybt or something json or yaml, look at persisting in ardour config if there are any extensible config sections for the DAW as a whole) - for now store in browser storage~~
- ~~Add disk (play) and in (monitor) option on the mixer~~
- ~~Session durability/cross-crash/restart recovery, ux for sessions~~ (2026-04-22)
  - ~~Opening a session should create an internal UUID for that session in foyer, and from the UI we should be able to pick from open sessions~~ — UUID lives inside the .ardour file's `<Foyer><Session id="…"/>` extra_xml (Decision 30). Travels with the project across machines. Session switcher chip in the status bar lists every attached session with live dirty indicator.
  - ~~If that session is open with ardour, we should not be able to reopen it, it should just switch to the active session~~ — `SessionRegistry::find_by_path` is the hook; command dispatch layer still needs to be taught to call it before re-launching. [REMAINING: wire the "already open by path" short-circuit in `Command::LaunchProject`.]
  - ~~If ardour crashes and we have the crash data, we should offer to reopen the session~~ — `Event::BackendLost` now opens a blocking modal (`backend-lost-modal.js`) with Recover / Main menu / Ignore. Recover re-launches the same project path in a fresh shim.
  - ~~We should replace the current default layout with no open session with a welcome dialog showing recently opened projects, offering to open a project browser, or create a new session~~ — `welcome-screen.js` replaces the tile workspace when `sessions.length === 0`. Renders recents, orphan banner, and Browse / New CTAs. New-session is stubbed pending a `Session::new()` command in the shim.
  - ~~We should move off of hash-based navigation of files, and instead remember the last folder selected, and see if we can caputure browser forward/back actions (and mouse browser forward/back) and/or keyboard shortcuts while focused in the file view window~~ — `session-view.js` now owns an internal history stack, persists last-path in `localStorage` (`foyer.picker.last-path`), binds mouse buttons 3/4 + Alt+←/Alt+→ + Backspace-up, and adds visible back/forward buttons in the crumb bar.
  - ~~Need way to reattach orphaned hardour processes if we close foyer while a session is running, currently no way~~ — Shim writes `~/.local/share/foyer/sessions/<uuid>.json` on startup (pid + socket + path + timestamp), removes on clean shutdown. Sidecar scans on startup and classifies (running/crashed). [REMAINING: actual reattach path — the welcome screen and switcher call `reattach_orphan`, but the sidecar handler is stubbed (`reattach_unimplemented` error). Wiring it means teaching the CLI spawner to build a `HostBackend` against an existing socket path. Reopen-after-crash works via launch_project.]
  - ~~We should catalog recently opened sessions (like 10 of them, configurable via settings) under session -> recent~~ — `recents.js` with `foyer.recents.v1` + `foyer.recents.cap`. 10-entry default, per-browser storage so collaborators don't see each other's lists. Welcome screen renders them; [REMAINING: add "Session → Recent" submenu in main-menu — today the recents only surface from the welcome screen].
  - ~~We should guard against opening a new session if the current session is unsaved (prompt if they want to abandon unsaved changes)~~ / ~~A third option could be leave session running in background, come back to it later~~ — 4-way unsaved guard in the session switcher's Close action: Save & close / Leave running (switch away) / Close without saving / Cancel. "Leave running" just flips `currentSessionId` to another open session — backends stay up until explicitly closed.
  - ~~Close session (should close the Ardour process for the session, bring you back to main view)~~ — `Command::CloseSession` aborts the pump, drops the backend Arc (which closes the shim socket), broadcasts `SessionClosed`. When the last session closes the welcome screen comes back.
  - ~~State of listen/monitoring should be persistent, not reset per project~~ / ~~Default to listen off for local sessions, monitoring for remote sessions~~ — Mixer persists `foyer.listen.master` in localStorage. On mount it reads the saved pref; if none, defaults off for local (`is_local` from ClientGreeting) and on for remote.

- ~~DAW disconnected UX~~ (2026-04-22) — Replaced the corner-banner for `backend_lost` with a proper blocking modal offering Recover / Main menu / Ignore. Auto-dismisses on `backend_swapped` or `session_opened`.

- ~~Multi-session remote access for collaborators / mobile~~ (2026-04-22) — Added native rustls TLS to foyer-cli (musl-clean; no openssl/native-tls in the dep graph). New `just run-lan-tls` recipe generates a self-signed cert under `~/.local/share/foyer/tls/` with SANs covering every non-bridge LAN IP + localhost, then serves HTTPS/WSS on 0.0.0.0. Unblocks `AudioContext.audioWorklet` on mobile browsers which require a secure context for Worklet. `reachable_urls` picks `https://` when TLS is on so the share QR hands out working links. Also audio-listener surfaces a clear "AudioWorklet not available; reach over HTTPS" error instead of the raw undefined-property crash.

- ~~Justfile `kill-daws` foot-gun~~ (2026-04-22) — Recipe used to `pgrep -x foyer` which matched the CLI binary itself, taking out the sidecar. Split into `kill-daws` (Ardour only, sweeps dead-pid registry entries) and `kill-all` (full reset including the `foyer` process). `kill-daws` also scrubs sessions-dir JSONs whose pids are dead so the welcome screen doesn't render ghost "crashed" entries after a hard kill.




Please follow-up on these:

Multi-track add/delete: schema has no CreateTrack / DeleteTrack — that's its own vertical slice (schema + backend trait + host client + shim Session::new_audio_track / Session::remove_route wiring).
96/192 kHz shim-side: shim delivers at Ardour's session rate with no resampling. For true end-to-end high rates, either set Ardour's session rate to match or land a resampler in the shim (speex-resampler would be the obvious choice).
Browser→DAW ingress: the shim command now rejects cleanly instead of hanging. Needs a SidecarInputPort class parallel to MasterTap (Decision 24 has the sketch). ~200–400 lines of RT-disciplined Ardour C++.

Double clicking on tracks should open the track editor. For midi tracks we should have the rest of the context menu available above the fold so can can three-click access midi editors or midi functions
Also if it is a sequencer-driven track, it would be cool to see it marked like that in the strips instead of just midi (like midi(seq) or something)
Let's plan to start automation, this is a big one we'll need

And review context and find any incomplete items and write up a new plan document with everything left to do based on instructions so far. Look at these too: 

## Remaining from the session lifecycle slice

- Wire the "already-open-by-path" short-circuit: `Command::LaunchProject` should check `SessionRegistry::find_by_path(canonical_path)` and `SelectSession` to it when a match exists instead of spawning a second shim.
- Orphan *reattach* (Ardour process still running, we just lost the sidecar): implement by letting `HostBackend::connect(socket_path)` be driven from the reattach handler, bypassing the CLI spawner's launch-and-wait step.
- Session → Recent menu entry: today recents only surface in the welcome screen. Add the submenu to `main-menu.js` so opening a recent doesn't require closing the active session first.
- New-session creation: the welcome screen's "New session…" is stubbed pending a shim command. Needs `CreateEmptySession { path, template? }` in the schema + a `session.new_session()` call on the Ardour side.
- Per-connection session selection: `Command::SelectSession` currently sets a sidecar-wide focus. For multi-browser-window scenarios (pop-out into a second monitor), each WS connection should track its own `current_session_id`. Threading that through `dispatch_command` is mechanical but touches every handler.
