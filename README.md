# Foyer Studio

A web-native, remote-collaborative control surface for professional
DAWs. Ardour is the first — and today, only — backend; the
architecture is deliberately generic above the shim boundary so
adding Reaper, Bitwig, or a custom engine is a contained task.

**Not a browser-based DAW.** Foyer doesn't run the audio graph — the
host DAW does, over its native low-latency path. Foyer replaces the
UI with something that treats modern browser capabilities as the
minimum target: tiling + floating windows, schema-driven plugin
panels, keyboard-first commands, and real-time collaboration over
WebSockets and Cloudflare tunnels.

## What's it for?

Use cases I had in mind when I built it (over the course of one
very caffeinated week, with heavy LLM assistance):

- **Sharing a mix-in-progress** with a performer and making live
  changes while they give feedback, without them being in the same
  room. Screen-share-with-audio exists; this is more fun.
- **A remote performer laying a track** into the host's session.
- **Real-time collaboration** on the mix, effects, timeline, or
  instruments — multiple browsers into one session, each with a
  scoped RBAC role.
- **Accessible, hackable UIs.** Reprojecting the DAW's state into
  a web UI opens up things you can't easily do in a pro-grade DAW
  shell: a MIDI-only Cakewalk-style surface, a phone transport
  remote, a kid-friendly touch interface, etc.
- **Feature compositions on top of the engine.** There's a simple
  beat + piano-roll sequencer shipped today that generates MIDI
  and saves the sequencer data in a region-data extension inside
  the `.ardour` file. My 8-year-old loves playing with Hydrogen
  and frankly so do I.

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

## Running it

Right now there's no packaged `foyer` binary or prebuilt Ardour
shim. The dev container is the supported way to run — it handles
the C++ toolchain, Ardour's deps, JACK, and the sidecar build.
Windows, Mac, and Linux hosts all work; only native Linux hosts
can currently pass real audio hardware through.

Prerequisites:

- Docker Desktop (Mac/Windows) or Docker Engine (Linux), running
- VS Code (or any IDE that reads `.devcontainer/devcontainer.json`)
- The **Dev Containers** VS Code extension

Steps:

```bash
git clone https://github.com/hotspoons/foyer-studio.git
cd foyer-studio
code .
```

In VS Code: when the notification appears, click **Reopen in
Container** (or run **Dev Containers: Rebuild and Reopen in
Container** from the command palette, `Ctrl+Shift+P` /
`Cmd+Shift+P`).

The first build takes ~5–10 minutes. Subsequent opens are
instant.

Then open a terminal inside the container (**Terminal → New
Terminal**) and:

```bash
just run                  # default
# or
just run-tls              # HTTPS; required if you'll reach it from another device on the LAN
```

The first `just run` clones and builds Ardour (~20 minutes on an
Apple Silicon MBP, longer on slower hosts), compiles the shim and
sidecar, then starts serving on port `3838`. It also launches a
`jackd` daemon with a dummy backend for the headless Ardour
session to connect to.

Open <http://127.0.0.1:3838> (or <https://127.0.0.1:3838> if you
used `run-tls`). To share the session off-host, use **Session →
Remote Access...** to open a Cloudflare tunnel, then invite
collaborators via the role picker.

### Linux hosts — passing real hardware

Native Linux hosts can expose ALSA devices to the container so the
container-owned `jackd` drives real hardware. Uncomment the
`--device=/dev/snd` and `--group-add=audio` lines in
[.devcontainer/devcontainer.json](.devcontainer/devcontainer.json)
(around line 75) and rebuild the container. Mac/Windows Docker VMs
don't expose audio devices, so on those hosts you're limited to
the browser's `getUserMedia` / `AudioContext` paths — fine for
remote collaboration but not for driving studio gear directly
from the container.

## Reading further

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
