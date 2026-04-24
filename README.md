# Foyer Studio

A web-native, DAW-agnostic control surface and modern UI for
professional audio workstations. Ardour is the first supported
engine; the architecture is deliberately generic above the `.so`
boundary so adding Reaper, Bitwig (where possible), or a custom DAW
backend is a contained task.

**Not a browser-based DAW.** Foyer doesn't run the audio graph — the
host DAW does, with its native low-latency path. Foyer replaces the
*UI* with something that treats 2026 browser capabilities as the
minimum target: tiling + floating window management, per-channel
resizing, schema-driven plugin panels, CRDT-ready collaboration
primitives, and a keyboard-first command model.

## Architecture

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

**The shim is a thin event translator.** It subscribes to libardour
signals and forwards them as the DAW-agnostic `foyer-schema`
vocabulary over a Unix socket — no UX logic, no policy, just
translation. Keeping the shim narrow is what lets adding a second
backend (Reaper, Bitwig, a custom engine) come down to "write
another shim" rather than "rewrite Foyer." Each shim naturally
inherits whatever license its host DAW requires for linking; the
Rust sidecar and web UI sit above that boundary and can be licensed
separately from any one shim. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 15.

**The web UI is a three-tier split.** `foyer-core` (renderless —
ws, store, RBAC, registries) → `foyer-ui-core` (shared primitives —
tiling, widgets, fallback shell) → one or more `ui-*` variants (the
opinionated UIs; `ui-full` is what ships). Third parties can
replace any tier below theirs — React / Svelte / native — without
owning the wire protocol, state, or audio path. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 40.

## Capabilities

Full table lives in [docs/STATUS.md](docs/STATUS.md). Highlights:

- Stub backend + live Ardour backend with hot-swap
- Tile + floating-window WM, keyboard-first chords, user layouts
- Schema-driven mixer, timeline, plugin panels; embedded track
  editor; multi-track selection + batch ops
- Transport — play / stop / record / loop / return-on-stop modes;
  tempo + loop-range writes persist through the shim
- Real audio egress from the master tap (Opus or raw f32 over WS)
- Cloudflare tunnel auto-provision + per-invite RBAC for remote
  guests (see [DECISIONS 35–38](docs/DECISIONS.md))
- Hot-serve UI assets from `$XDG_DATA_HOME/foyer/web/` with
  runtime overlay dirs for third-party UIs (see
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md))

## Quick start

Dev container is Debian trixie with Rust + audio deps preinstalled.
From the repo root:

```bash
just run                         # serves web/, default backend from config.yaml
just run --backend stub          # stub-only, no shim or JACK needed
```

Then open <http://127.0.0.1:3838>. A fresh install boots in
"launcher" mode with an empty stub; pick a project folder in the
Session view and Foyer spawns Ardour via the shim, then atomically
swaps the backend without dropping your browser connection.

**Full Ardour path** (may build Ardour + shim once on first run):

```bash
just ardour ensure
just shim check
```

**Dev-only integration probes:**

```bash
FOYER_DEV=1 just run &
curl -s http://127.0.0.1:3838/dev/run-tests | jq
```

Returns pass/fail for each probe (snapshot shape, control echo,
region list, waveform decode, track rename, transport round-trip).
Same probes surface in the **Diagnostics** view.

**Playwright smoke + agent probe:**

```bash
just test-ui            # Playwright suite against the running server
just ui-probe dump      # JSON snapshot of store/rbac/peers
just ui-probe screenshot /tmp/foyer.png
just ci                 # fmt + clippy + cargo test + UI smoke (matches PR gate)
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full dev
workflow (building your own UI, overlays, ship-your-own-binary,
testing).

## Project layout

```
crates/                    Rust workspace
  foyer-schema             wire types (Session/Track/Parameter/Event/…)
  foyer-ipc                length-prefixed MsgPack frames (shim ↔ sidecar)
  foyer-backend            Backend trait — DAW-agnostic
  foyer-backend-stub       in-memory fake session for demo mode
  foyer-backend-host       generic IPC client for any shim
  foyer-server             axum WS + HTTP + jail + tunnel + RBAC
  foyer-config             YAML config + XDG + roles + tunnel manifest
  foyer-cli                `foyer` binary; bundles web/ via include_dir!
  foyer-desktop            wry + tao native wrapper (no Electron)

shims/
  ardour                   C++ control surface plugin (.so); GPL-contained

web/                       Three-tier UI tree (see HACKING + DEVELOPMENT)
  boot.js                  fetches /variants.json, dynamic-imports variants
  index.html               import map for lit + foyer-core + foyer-ui-core
  core/                    foyer-core — renderless: ws, store, RBAC, audio, registries
  ui-core/                 foyer-ui-core — primitives: tiling, widgets, fallback
  ui-full/                 shipping UI variant (one of many possible ui-*/)
  vendor/                  vendored ES modules (Lit — no npm)
  styles/                  Tailwind v4 standalone CLI output

tests-ui/                  Playwright harness (outside web/ so not bundled)
scripts/dev/               helper scripts invoked by the Justfile
docs/                      DECISIONS, DEVELOPMENT, PLAN, STATUS, TODO, KEYBOARD
```

## Conventions

Durable rules, not stylistic preferences. Each is enforced in code
review and logged in [docs/DECISIONS.md](docs/DECISIONS.md).

- **No Node at ship time.** `web/` is plain ES modules + import map,
  vendored deps only. Bun + Playwright are dev-time tooling in
  [tests-ui/](tests-ui); they never enter the shipping binary.
  Tailwind uses the standalone CLI in [.bin/](.bin/).
- **Per-layer licensing.** `shims/ardour/` inherits GPLv2+ because
  it statically links `libardour`. The Rust sidecar + web UI sit
  above the IPC boundary and ship under non-copyleft terms. Future
  shims (Reaper SDK, JUCE-based engines) carry their own license.
- **Rust primary, C++ minimized.** The shim's only job is
  translation. Anything above that (state, protocol, auth,
  collaboration) is Rust.
- **DAW-agnostic schema.** Types in
  [foyer-schema](crates/foyer-schema) describe domain entities
  (Session, Track, Parameter) — never Ardour specifics.
- **One-way web dependency arrow.** `core → ui-core → ui-*`. Never
  import the other way; push up through a registry instead. See
  [docs/DECISIONS.md](docs/DECISIONS.md) entry 40.
- **Decisions get written down.** Real architectural tradeoffs
  append to [DECISIONS.md](docs/DECISIONS.md) as a numbered entry.
- **`just` over ad-hoc scripts.** Every recurring workflow lives in
  the [Justfile](Justfile). A green `just ci` == a green PR check.

## Where to read next

- **Agent context:** [AGENTS.md](AGENTS.md) — cold-start brief for
  coding agents, with `window.__foyer` probe recipes.
- **Develop + test:** [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) —
  run, overlay your own UI, ship a derived binary, CI gate.
- **Write a UI variant:** [web/HACKING.md](web/HACKING.md) —
  renderer recipes, widget overrides, feature gates.
- **Current state:** [docs/STATUS.md](docs/STATUS.md) +
  [docs/PLAN.md](docs/PLAN.md) — capability table + backlog.
- **Why things are the way they are:**
  [docs/DECISIONS.md](docs/DECISIONS.md) — every architectural
  call logged as an ADR.
- **Keyboard + gestures:** [docs/KEYBOARD.md](docs/KEYBOARD.md).
- **Wire contract:**
  [crates/foyer-schema/src/message.rs](crates/foyer-schema/src/message.rs) —
  every other layer is downstream of this file.

## License

Layer-scoped:

- **`shims/ardour/`** — GPLv2+, because it statically links
  `libardour`. Standard practice for anything that touches the
  Ardour internals.
- **Rust sidecar + web UI** — TBD; sits above a documented IPC
  boundary and isn't derivative of any single shim, so it's
  licensed separately from whichever shim the user is running.

Future shims for other engines (Reaper, JUCE-based hosts,
commercial SDKs) will each carry their own license terms
appropriate to how they link against their respective host. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 15 for the long
version.

Foyer is an attempt to build a modern editing surface around
Ardour's mature audio engine — not a replacement for it. Without
Ardour's decades of work on real-time audio, a recording / mixing
surface like this one wouldn't exist; the separation below is an
engineering boundary, not a tribute vacuum.
