# Foyer Studio

A web-native, DAW-agnostic control surface and modern UI for
professional audio workstations. Ardour is the first supported engine;
the architecture is deliberately generic above the `.so` boundary so
adding Reaper, Bitwig (where possible), or a custom DAW backend is a
contained task.

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
 │ C++ shim (libfoyer_    │  ───────────────────────────────┐
 │ shim.so, ~1.6k LOC)    │                                 │
 │  · GPL-contained       │                                 ▼
 │  · event translation   │                    ┌──────────────────────┐
 │    only — no UX logic  │                    │ Rust sidecar         │
 └────────────────────────┘                    │  · foyer-server      │
                                               │  · foyer-backend-*   │
 ┌────────────────────────┐                    │  · foyer-schema      │
 │ Web UI (Lit + Tailwind)│ ◄── WS / HTTP ────►│  · foyer-ipc         │
 │  · zero build step     │                    │  · non-GPL           │
 │  · vendored ES modules │                    └──────────────────────┘
 │  · non-GPL             │                                 │
 └────────────────────────┘                                 ▼
                                               ┌──────────────────────┐
                                               │ Optional:            │
                                               │  foyer-desktop (wry) │
                                               └──────────────────────┘
```

**Three boundaries, three licenses.** The C++ shim links `libardour`
and is therefore GPL. Everything above the Unix-socket boundary is
non-viral and Foyer's own license (TBD). See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 6 for the rationale.

## Status at a glance

| Capability | State |
|---|---|
| Stub backend (in-memory demo session) | Shipping — 6 tracks with realistic plugin params |
| Schema-driven plugin panels | Shipping — `<foyer-plugin-panel>` renders any `PluginInstance.params` |
| Ardour shim — transport + track controls | Shipping |
| Ardour shim — plugin parameter emission | Shipping (`libfoyer_shim.so` builds clean; untested against live plugins) |
| Tile tree + floating windows + slot picker | Shipping |
| Tear-out (tile header, plugin strip, menu items) | Shipping |
| Right-dock as unified dock area | Shipping |
| Layout presets with user-assigned chords | Shipping |
| Keyboard-first WM (Hyprland-style keybinds) | Shipping |
| AHK-flavored automation | Shipping |
| Generic context menu, non-native scrollbars, text-selection policy | Shipping |
| Multi-monitor detection (`getScreenDetails`) | Wired; slot picker doesn't target yet |
| MessagePack hot path (WS binary frames) | Not yet — deferred from the M3 plan |
| Canvas-first timeline + mixer rendering | Not yet |
| WebRTC audio forwarding (M6) | Schema types exist; no runtime |
| MCP agent (M8) | Panel + settings exist; no real round-trip |

## Quick start

Dev container is Debian trixie with Rust + audio deps already
installed. From the repo root:

```bash
just tw-build                    # one-shot Tailwind build
just run-stub --listen=127.0.0.1:3838 \
               --web-root=./web \
               --jail=/tmp/foyer-jail
```

Then open <http://127.0.0.1:3838>. You get the full UI backed by the
in-memory stub — six tracks, realistic plugin params, synthesized
regions and waveforms. Nothing needs Ardour to boot.

**Full Ardour path** (requires building Ardour 9; ~15 min cold):

```bash
just ardour-configure && just ardour-build
just shim-build
just shim-e2e                    # headless hardour + shim + foyer-cli
```

### Keyboard quick reference

| Keys | Action |
|---|---|
| `Ctrl+Alt H/J/K/L` | Focus tile left / down / up / right |
| `Ctrl+Alt |` · `Ctrl+Alt -` | Split focused tile right / below (pops view picker) |
| `Ctrl+Alt W` | Close focused tile |
| `Ctrl+Alt [` · `Ctrl+Alt ]` | Shrink / grow focused tile |
| `Ctrl+Alt A` | Toggle automation panel |
| `Ctrl/Cmd K` | Command palette |
| *(your chords)* | Assigned via right-click → "Assign keybind" in the layout FAB |

Wheel over the timeline scrolls temporal zoom; Alt- or Ctrl-wheel
changes the lane height of the track under the pointer.

## Project layout

```
crates/
  foyer-schema            wire types (Session/Track/Region/Parameter, etc.)
  foyer-ipc               length-prefixed MsgPack frames (shim ↔ sidecar)
  foyer-backend           Backend trait — DAW-agnostic
  foyer-backend-stub      in-memory fake session for demo mode
  foyer-backend-host      generic IPC client for any shim
  foyer-server            WS + HTTP static server + jail
  foyer-cli               `foyer serve --backend=stub|host ...`
  foyer-desktop           wry + tao native wrapper (no Electron)

shims/
  ardour                  C++ control surface plugin (.so); GPL-contained

web/
  index.html              import map + app mount
  src/
    app.js                root shell + boot-time integration
    layout/               tile tree, layout store, slots, keybinds, bindings
    components/           mixer, timeline, plugin panel, FABs, right dock, ...
    automation/           AHK-flavored parser + runtime + toast
    param-scale.js        normalize ↔ native for dB/Hz/log/linear
    screens.js            multi-monitor probe
    icons.js              Heroicons 24x24 outline set
    theme.js              dim/dark/light/auto [data-theme] scopes
  vendor/                 vendored ES modules (Lit, fonts)
  styles/tw.css           Tailwind v4 (standalone CLI, no bundler)

docs/
  PLAN.md                 canonical product plan + milestones
  HANDOFF.md              state-of-the-world for a fresh Claude
  DECISIONS.md            append-only ADR-style engineering decisions
  PROPOSAL-surface-auto-discovery.md
                          upstream proposal for auto-discoverable Ardour
                          surfaces + commercial DAW SDK survey
```

## Conventions

These are durable rules, not stylistic preferences. Each is enforced
in code review and logged in [docs/DECISIONS.md](docs/DECISIONS.md)
and/or `~/.claude/.../memory/`.

- **No Node tooling on the web side.** No `node`, `npm`, `pnpm`,
  `yarn`, bundlers, linters, formatters, test runners. The browser is
  the only JS runtime. New JS dependencies are vendored as raw ES
  modules under [`web/vendor/`](web/vendor/) and committed. Tailwind
  uses the standalone CLI binary in [`./.bin/`](.bin/).
- **No viral copyleft in Foyer's own code.** GPL is contained to the
  C++ shim; everything else is permissively licensed (exact license
  TBD). Don't include a GPL header anywhere outside `shims/ardour/`.
- **Rust primary, C++ minimized.** The shim's only job is translating
  Ardour events to Foyer's neutral schema. Anything above that — state
  management, protocol fan-out, auth, collaboration — is Rust.
- **DAW-agnostic schema.** Types in [`foyer-schema`](crates/foyer-schema/)
  describe domain entities (Session, Track, Parameter), not Ardour
  specifics. When extending, check that the shape makes sense for a
  Reaper or Bitwig backend you might add later.
- **Decisions get written down.** See
  [docs/DECISIONS.md](docs/DECISIONS.md). When you pick between real
  alternatives, append an entry. Don't re-litigate six months later.
- **`just` over ad-hoc scripts.** Every recurring workflow lives in
  the [Justfile](Justfile). Add recipes; don't bake one-off commands.

## Building + testing

```bash
cargo test --workspace           # 16 passing as of 2026-04-19
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
just tw-build                    # compile Tailwind (needed after CSS edits)
```

There is intentionally **no JS test runner**. Web-side verification is
either: run the stub, poke the UI in a browser; or use the Python
stdlib WS probes under [`scripts/`](scripts/) for protocol-level
smoke testing. Our rationale lives in the "no Node" memory.

## Where to read next

1. [docs/PLAN.md](docs/PLAN.md) — canonical product plan.
2. [docs/HANDOFF.md](docs/HANDOFF.md) — current state + open work queue.
3. [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they are.
4. [docs/PROPOSAL-surface-auto-discovery.md](docs/PROPOSAL-surface-auto-discovery.md)
   — upstream ask + commercial DAW SDK limitations survey.
5. [crates/foyer-schema/src/message.rs](crates/foyer-schema/src/message.rs)
   — the wire contract; every other layer is downstream of this file.

## License

TBD — permissive (not GPL). The C++ shim at
[`shims/ardour/`](shims/ardour/) is GPLv2+ by necessity (links
`libardour`); everything outside that directory is separately
licensed. See [docs/DECISIONS.md](docs/DECISIONS.md) entry 6.
