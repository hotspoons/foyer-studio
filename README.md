# Foyer Studio

A web-native, remote-collaborative control surface for professional
DAWs. Ardour is the first — and today, only — backend; the
architecture is deliberately generic above the shim boundary so
adding Reaper, Bitwig, or a custom engine is a contained task.

**Not a browser-based DAW.** Foyer doesn't run the audio graph — the
host DAW does, over its native low-latency path. Foyer is a
browser-native control surface that runs alongside the DAW's own UI,
focused on the cases the native UI wasn't designed for: remote
collaboration over WebSockets and Cloudflare tunnels, tiling +
floating windows in the browser, schema-driven plugin panels, and
keyboard-first commands. The DAW's own editor keeps doing what it's
always done; Foyer adds a parallel surface for when you're not
sitting at the workstation.

## Running it

Three deployment shapes, ordered by "how fast can I see it work?" —
Docker is first because it's a single command and needs nothing
installed beyond Docker itself. Full setup recipes for each live in
[docs/USAGE.md](docs/USAGE.md).

### 1. Docker — Foyer + Ardour + plugins, all in one image

The fastest path: nothing on your machine but Docker. The image
bundles Ardour 9.2, the shim, the autovocoder LV2, and ~200 LV2
plugins.

```bash
docker run --rm -it --name foyer-studio \
  -p 3838:3838 --shm-size=1g \
  -v "$(pwd):/projects" \
  ghcr.io/hotspoons/foyer-studio:latest
```

Open <http://localhost:3838>. This runs the **gui-dummy** mode —
GUI Ardour painting onto an in-container Xvfb against libardour's
"None (Dummy)" backend. No JACK, no realtime scheduling, no
privileged flags. Works identically on Cloud Run, Docker Desktop,
Colima, plain Linux. Audio leaves the container only via Foyer's
WebSocket egress.

For real audio hardware via a host-running jackd (Linux only),
flip into `jack-headless` mode with the privileged flags + JACK
shm passthrough — full recipe in
[docs/USAGE.md#path-1--docker](docs/USAGE.md#path-1--docker).

### 2. Host install — drives your own Ardour 9.2

Best for laptops / studio machines: lowest latency, real audio
hardware, your existing plugin collection. Linux + macOS (Apple
Silicon and Intel).

```bash
# Pulls the most recent passing CI build (no GitHub auth needed).
curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh \
  | bash -s -- --latest-ci

foyer serve --backend ardour
```

Open <http://127.0.0.1:3838>. The installer also drops the C++
shim into Ardour's surfaces directory; tick **Preferences →
Control Surfaces → Foyer Studio Shim** in Ardour once and the
sidecar attaches automatically on every Ardour launch from there
on.

Full walkthrough (LAN access, TLS, uninstall) in
[docs/USAGE.md#path-2--host-install-against-your-own-ardour-92](docs/USAGE.md#path-2--host-install-against-your-own-ardour-92).

### 3. From source — the dev container

For hacking on Foyer itself: the C++ toolchain, Ardour's deps,
JACK, Bun + Playwright, and every script the Justfile relies on
land in a VS Code dev container.

```bash
git clone https://github.com/hotspoons/foyer-studio.git
cd foyer-studio
code .   # VS Code → "Reopen in Container"
# then, in the container terminal:
just run
```

First boot clones and builds Ardour (~20 min on Apple Silicon).
Subsequent runs are instant. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full workflow —
UI overlays, the CI gate, the Justfile catalog.

## Architecture (the one-paragraph version)

Three layers, each with a strict job:

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

- The **C++ shim** is a thin Ardour control surface plugin. It
  translates between Ardour's internal vocabulary and Foyer's
  DAW-agnostic wire schema. No UX logic, no state, no policy.
- The **Rust sidecar** (`foyer` binary, axum-based) owns the state
  store, RBAC enforcement, Cloudflare tunneling, audio routing, and
  the HTTP/WS surface the browser talks to.
- The **web UI** is plain ES modules + Lit + Tailwind, no build
  step at ship time. Three-tier split so a third party can replace
  any tier (including the whole UI) without owning the wire
  protocol, the audio path, or the state store.

Deeper walkthrough in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What works today

- Stub backend + live Ardour backend with hot-swap between the two
- Tiling + floating window manager, keyboard-first chords,
  per-user saved layouts
- Schema-driven mixer, timeline, and plugin panels; embedded track
  editor; multi-track selection + batch ops
- Transport — play / stop / record / loop / return-on-stop modes;
  tempo and loop-range writes persist through the shim
- Real-time audio egress from the master tap (Opus by default, raw
  f32 over WS for fidelity-critical sessions)
- Real-time audio ingress — a remote performer's mic lands on an
  Ardour soft port, armable and recordable
- Cloudflare tunnel auto-provision with per-invite RBAC; relay
  chat + push-to-talk audio between collaborators
- A simple beat + piano-roll sequencer that writes MIDI into
  `.ardour` regions via a data extension

## Licensing

Layer-scoped:

- **`shims/ardour/`** — GPLv2+ because it statically links
  `libardour`. Standard practice for anything linking Ardour
  internals.
- **Rust sidecar + web UI** — Apache-2.0. They sit above the IPC
  boundary and are not derivative of any single shim. Replacing
  Ardour with a different backend doesn't touch the Apache parts.

Future shims for other engines (Reaper SDK, JUCE-based hosts,
commercial SDKs) will each carry their own license terms. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 15 for the long
version.

## Reading further

- [**docs/USAGE.md**](docs/USAGE.md) — full host-install and
  Docker recipes; JACK passthrough modes; Cloud Run deployment.
- [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) — three-layer
  walkthrough, wire contract, conventions baked into the codebase.
- [**docs/DEVELOPMENT.md**](docs/DEVELOPMENT.md) — running the
  container, overlaying your own UI variants, testing, CI gate.
- [**docs/SECURITY.md**](docs/SECURITY.md) — tunnel and RBAC
  threat model; who the owner is, what each role can do.
- [**docs/DECISIONS.md**](docs/DECISIONS.md) — every architectural
  tradeoff logged as a numbered ADR, with rejected alternatives.
- [**docs/KEYBOARD.md**](docs/KEYBOARD.md) — keyboard and gesture
  reference for the shipping UI.
- [**web/HACKING.md**](web/HACKING.md) — writing a new UI variant
  without forking the main tree.
- [**AGENTS.md**](AGENTS.md) — cold-start brief for coding agents
  (Claude Code, Cursor, Aider) working in this repo.

## Credit where it's due

Foyer would not exist without the last 20+ years of work Paul
Davis, Robin Gareus, and the rest of the Ardour community have
poured into JACK and Ardour. If you get value out of this, **please
[go support Ardour](https://community.ardour.org/donate)**. Foyer
is a modern editing surface around Ardour's mature audio engine —
not a replacement for it.

Contributions, issues, and feedback welcome at
<https://github.com/hotspoons/foyer-studio>.
