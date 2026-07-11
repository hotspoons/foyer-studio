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

Three install shapes, ordered by "what should I use?" — the Linux
flatpak leads because it's one file, needs no container runtime,
and is the only path that gives you bundled Ardour *and* real
low-latency hardware audio. Full setup recipes live in
[docs/USAGE.md](docs/USAGE.md); server-style container deploys
(Docker, Cloud Run, Kubernetes) are covered
[at the end of that doc](docs/USAGE.md#path-3--docker) and
summarized at the end of this section.

### 1. Flatpak — the Linux install

Bundled Ardour 9.5 (source-built from upstream), the shim, and the
native desktop shell in one sandbox — with real hardware audio: the
flatpak runtime ships PipeWire's JACK layer, so the bundled Ardour
talks straight to your host PipeWire daemon at native latency, and
raw ALSA + hardware MIDI are exposed too. No privileged flags, no
shm bind-mounts, no jackd babysitting.

```bash
# One-time, if this machine has never used Flathub (runtime source):
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

curl -LO https://github.com/hotspoons/foyer-studio/releases/download/flatpak-latest/ai.patapsco.FoyerStudio.flatpak
flatpak install --user ai.patapsco.FoyerStudio.flatpak
flatpak run ai.patapsco.FoyerStudio
```

The window opens straight into native-Ardour mode — pick a session
and play. The `flatpak-latest` release is re-cut on every merge to
main. Full recipe (LAN/phone access, Flathub plugin extensions,
uninstall) in
[docs/USAGE.md#path-1--flatpak-linux-recommended](docs/USAGE.md#path-1--flatpak-linux-recommended).

### 2. Host install — drives your own Ardour 9.5

The macOS path (Apple Silicon and Intel — CoreAudio, your existing
plugin collection), and the Linux alternative when you'd rather
point Foyer at the Ardour you already have than use the bundled
one.

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
[docs/USAGE.md#path-2--host-install-against-your-own-ardour-95](docs/USAGE.md#path-2--host-install-against-your-own-ardour-95).

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

### Containers — Docker, Cloud Run, Kubernetes

For server deploys — a browser-reachable mixing surface on a home
server, Cloud Run, or a cluster — the multi-arch image bundles
Ardour 9.5, the shim, and ~200 LV2 plugins:

```bash
docker run --rm -it --name foyer-studio \
  -p 3838:3838 --shm-size=1g \
  --cap-add=SYS_NICE \
  --ulimit rtprio=95 --ulimit memlock=-1 \
  -v "$(pwd):/projects" \
  ghcr.io/hotspoons/foyer-studio:latest
```

Open <http://localhost:3838>. This is the **gui-dummy** mode — no
soundcard needed; audio leaves the container via Foyer's WebSocket
egress. Full recipes — the audio-flag rationale, host-JACK
passthrough, env knobs, [Cloud Run](docs/USAGE.md#deploying-to-google-cloud-run),
and the [helm chart](docs/USAGE.md#path-4--kubernetes-helm) — live in
[docs/USAGE.md#path-3--docker](docs/USAGE.md#path-3--docker).

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
