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

Two paths: install a prebuilt binary on a host that already has
Ardour, or run the whole stack inside the dev container. There's
no tagged release yet, so today the prebuilt path pulls the most
recent passing CI build from `main`.

### Install via the script (CI builds)

Targets Linux + Apple Silicon macOS hosts that already have Ardour
9 installed. The installer drops the `foyer` sidecar in
`$XDG_DATA_HOME/foyer/bin` (or `$HOME/.foyer/bin` if XDG isn't set)
and copies the `libfoyer_shim.so` / `.dylib` into Ardour's
control-surface directory so the next time you launch Ardour the
"Foyer Studio" surface shows up under **Preferences → Control
Surfaces**.

```bash
# Latest passing CI build, no GitHub auth required (proxied
# through nightly.link).
curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh \
  | bash -s -- --latest-ci
```

If the install adds a new directory to your `PATH`, the script
prints the line you'd source — restart your shell or `source` the
rc file it edited, then:

```bash
foyer serve --backend ardour
```

…and open <http://127.0.0.1:3838>. With Ardour already running and
the Foyer surface enabled, the sidecar attaches over the shim's
Unix socket; otherwise pick a project from the launcher and
`foyer` will spawn a headless Ardour for you.

Other useful flags:

- `--version vX.Y.Z` — install a specific tagged release (none yet)
- `--from-bundle DIR` — install from a local directory of artifacts
- `uninstall [--purge]` — remove the installed binary + shim;
  `--purge` also wipes the install root

Intel Mac hosts aren't supported by the prebuilt release (GitHub
retired the Intel runners) — build from source via the dev
container instead.

### From source — the dev container

The dev container handles the C++ toolchain, Ardour's deps, JACK,
and the sidecar build, so you don't have to install any of that on
the host. Windows, Mac, and Linux hosts all work; only native
Linux hosts can currently pass real audio hardware through.

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

For the full development workflow — overlaying your own UI
variants, running the test suite, the CI gate, the Justfile recipe
catalog — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

#### Linux hosts — passing real hardware

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
