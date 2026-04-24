# Foyer Studio — architecture

Foyer is a web-native remote control surface for professional DAWs.
The browser is not running audio. The host DAW is, over its native
low-latency path. Foyer replaces the DAW's local UI with one designed
around modern browser capabilities — tiling + floating windows,
schema-driven plugin panels, keyboard-first command model, and
real-time collaboration over WebSockets and Cloudflare tunnels.

Ardour is the first — and, today, only — supported backend. The
architecture is deliberately generic above the shim boundary so
adding Reaper, Bitwig (where their APIs allow), or a bespoke engine
is a contained task: write one more shim.

```
 Ardour (or any DAW)
    │
    ▼
 ┌────────────────────────┐   Unix socket, MessagePack framing
 │ C++ shim               │  ───────────────────────────────┐
 │  (libfoyer_shim.so)    │                                 │
 │  · event translation   │                                 ▼
 │    only — no UX logic  │                    ┌──────────────────────┐
 └────────────────────────┘                    │ Rust sidecar         │
                                               │  · foyer-server      │
 ┌────────────────────────┐                    │  · foyer-backend-*   │
 │ Web UI (Lit + Tailwind)│ ◄── WS / HTTP ────►│  · foyer-schema      │
 │  · three-tier split    │                    │  · foyer-ipc         │
 │  · no shipping bundler │                    └──────────────────────┘
 └────────────────────────┘                                 │
                                                            ▼
                                               ┌──────────────────────┐
                                               │ Optional:            │
                                               │  foyer-desktop (wry) │
                                               └──────────────────────┘
```

## The three layers

### Shim (C++ in `shims/ardour/`)

A thin Ardour control-surface plugin built against `libardour`.
The shim has one job: translate between Ardour's native vocabulary
(routes, processors, plugin parameters, transport state, MIDI/audio
ports) and Foyer's DAW-agnostic wire schema. It holds no UI state,
no policy, no session management, no auth — all of that lives a
layer up. Keeping the shim narrow is what makes "support a second
DAW" tractable: the work is one focused C++ module, not rebuilding
the system.

Runs in Ardour's process as a loaded surface `.so`. Registers
itself as `foyer_shim`, subscribes to the libardour signals it
cares about, and streams events over a Unix socket to the sidecar.
Receives commands in the other direction.

Audio flows through the same socket, as a different frame kind:
- **Egress** (DAW → browser): a `MasterTap` `Processor` subclass
  sits on the master bus, copies samples on the RT audio thread
  into a lock-free ring, and a non-RT drain thread packs them
  into IPC audio frames.
- **Ingress** (browser → DAW): a `ShimInputPort` registers a soft
  audio port with whatever audio backend is active (JACK, ALSA,
  CoreAudio). A jitter buffer primes ~80 ms of audio before the RT
  thread starts draining per-cycle chunks into the port buffer.
  See [`shim_input_port.h`](../shims/ardour/src/shim_input_port.h)
  for the RT synchronization detail — writing port buffers from
  a non-RT thread races Ardour's `cycle_start()` memset and
  produces audible pops; the drain is ticked from `MasterTap::run()`
  in the RT window to avoid that race.

The shim is GPLv2+ because it statically links `libardour`. See
[Decision 15](DECISIONS.md).

### Sidecar (Rust workspace in `crates/`)

```
foyer-schema           wire types (Session/Track/Parameter/Event/Command/...)
foyer-ipc              length-prefixed MsgPack framing over the Unix socket
foyer-backend          DAW-agnostic Backend trait
foyer-backend-stub     in-memory fake session for demo mode / UI dev
foyer-backend-host     generic IPC client that talks to any shim
foyer-server           axum HTTP + WS; RBAC, tunnels, audio routing
foyer-config           YAML config + XDG + roles + tunnel manifest
foyer-cli              the `foyer` binary; bundles `web/` via include_dir!
foyer-desktop          wry + tao native wrapper (no Electron)
```

The same types `foyer-schema` defines over the IPC socket are
re-encoded as JSON text frames over the WebSocket to the browser
(plus raw binary frames for audio). That's one wire vocabulary
across the whole stack — if you change a variant of the `Event`
enum, every layer updates automatically, or you get a
deserialization error pointing you at the drift.

**Audio routing.** Opus-compressed by default, with an uncompressed
f32 path for when you care about fidelity more than bandwidth.
Egress and ingress each have their own WS path
(`/ws/audio/:stream_id`, `/ws/ingress/:stream_id`) so a session
engineer can listen to a remote performer on one stream while
routing their push-to-talk on another.

**RBAC.** Single-use tokens scoped to a role (Viewer, Performer,
SessionController, Admin). The server is the enforcement point; the
browser-side `foyer-core/rbac.js` only mirrors the server's
decision for UI sugar (disabled controls, hidden surfaces). A
compromised client can't bypass anything — it's revalidated server
side on every command. See [Decision 38](DECISIONS.md).

**Tunnels.** Cloudflare tunnels are first-class — `foyer serve` can
auto-provision a quick tunnel, wire the RBAC token into the
invite URL, and emit a shareable link in three clicks. ngrok is
scaffolded but untested. See
[`foyer-server/src/cloudflare_provider.rs`](../crates/foyer-server/src/cloudflare_provider.rs).

### Web UI (`web/`)

Three-tier split enforced by import direction. The arrow is
strictly one-way; if a lower tier needs something from an upper
tier, it goes through a registry, not a direct import:

```
core  → ui-core  → ui-*
```

- **`web/core/`** — `foyer-core`. Renderless. Owns the WebSocket
  connection, state store, RBAC helper, audio decoder pipeline,
  command registry, variant registry. No DOM opinions.
- **`web/ui-core/`** — `foyer-ui-core`. Framework-agnostic-ish
  primitives: tile tree, docks, widgets (knobs, faders, meters,
  window list), plus a fallback shell that renders if no variant
  matches.
- **`web/ui-full/`** — the shipping opinionated UI. One of many
  possible `ui-*/` variants. A third party can drop `ui-mine/`
  next to it, register via `package.js`, and the server's
  `/variants.json` endpoint auto-discovers it on next boot.

**No Node at ship time.** `web/` is plain ES modules + an import
map in `index.html`, vendored dependencies only. Lit is the
primary framework (standard web components, shadow DOM). Tailwind
is compiled via the standalone CLI (a single static binary — no
npm, no postcss plugin chain). Bun + Playwright are dev-time
tooling; they never enter the shipping binary.

**First-run extraction.** The `foyer` binary embeds `web/` via
Rust's `include_dir!` macro. On first launch it extracts to
`$XDG_DATA_HOME/foyer/web/` (typically
`~/.local/share/foyer/web/`) and serves from there. That lets an
end user patch the UI without rebuilding the binary — edit the
file on disk and refresh.

See [web/HACKING.md](../web/HACKING.md) for the UI author's entry
point, [Decision 40](DECISIONS.md) for the tile-leaf / static-html
constraint, and [DEVELOPMENT.md](DEVELOPMENT.md) for overlaying
your own UI variants without editing the main tree.

## Wire contract

[`crates/foyer-schema/src/message.rs`](../crates/foyer-schema/src/message.rs)
is the single source of truth. Everything — the C++ shim
(manually mirroring the shape), the Rust sidecar, the JS
frontend — reads from or encodes into these types. Change a
variant, rebuild, expect loud failures anywhere that drifted.

Over the Unix socket (shim ↔ sidecar): MsgPack via `rmp_serde`,
length-prefixed frames tagged with a kind byte.
- `0x01` = MsgPack `Envelope<Control>` (commands in, events out)
- `0x02` = raw audio PCM, stream-id-prefixed

Over the WebSocket (sidecar ↔ browser):
- Text frames = JSON encoding of the same `Envelope<Control>`
- Binary frames on `/ws/audio/:id` = Opus packets (default) or
  raw f32 PCM (opt-in)
- Binary frames on `/ws/ingress/:id` = raw f32 LE interleaved PCM

## Conventions baked into the codebase

Each of these is enforced in review and logged in
[DECISIONS.md](DECISIONS.md) with rationale:

- **No Node at ship time.** Already covered.
- **Per-layer licensing.** `shims/ardour/` is GPLv2+; everything
  above the IPC boundary is Apache-2.0. Future shims inherit
  whatever license their host DAW's SDK requires. [Decision 15](DECISIONS.md).
- **Rust primary, C++ minimized.** The shim translates; the
  sidecar owns state, protocol, auth, collaboration.
- **Server is the RBAC enforcement point.** [Decision 38](DECISIONS.md).
- **DAW-agnostic schema.** `foyer-schema` types describe domain
  entities (Session, Track, Parameter) — never Ardour specifics.
- **`just` over ad-hoc scripts.** Every recurring workflow lives
  in the [Justfile](../Justfile). A green `just ci` maps directly
  to a green PR check.
- **Decisions get written down.** Architectural tradeoffs append
  to [DECISIONS.md](DECISIONS.md) as a numbered ADR.

## Where to read next

- [DECISIONS.md](DECISIONS.md) — every architectural call logged
  with rationale and rejected alternatives.
- [DEVELOPMENT.md](DEVELOPMENT.md) — running the dev container,
  overlaying your own UI, testing, CI gate.
- [SECURITY.md](SECURITY.md) — tunnel + RBAC threat model.
- [web/HACKING.md](../web/HACKING.md) — UI-author recipes.
- [KEYBOARD.md](KEYBOARD.md) — keyboard and gesture reference.
