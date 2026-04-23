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
 │ C++ shim               │  ───────────────────────────────┐
 │  (libfoyer_shim.so)    │                                 │
 │  · event translation   │                                 ▼
 │    only — no UX logic  │                    ┌──────────────────────┐
 └────────────────────────┘                    │ Rust sidecar         │
                                               │  · foyer-server      │
 ┌────────────────────────┐                    │  · foyer-backend-*   │
 │ Web UI (Lit + Tailwind)│ ◄── WS / HTTP ────►│  · foyer-schema      │
 │  · zero build step     │                    │  · foyer-ipc         │
 │  · vendored ES modules │                    └──────────────────────┘
 └────────────────────────┘                                 │
                                                            ▼
                                               ┌──────────────────────┐
                                               │ Optional:            │
                                               │  foyer-desktop (wry) │
                                               └──────────────────────┘
```

**The shim is a thin event translator.** It subscribes to libardour
signals and forwards them as the DAW-agnostic `foyer-schema` vocabulary
over a Unix socket — no UX logic, no policy, just translation. Keeping
the shim narrow is what lets adding a second backend (Reaper, Bitwig,
a custom engine) come down to "write another shim" rather than "rewrite
Foyer." Each shim naturally inherits whatever license its host DAW
requires for linking; the Rust sidecar and web UI sit above that
boundary and can be licensed separately from any one shim. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 15.

## Status at a glance

| Capability | State |
|---|---|
| Stub backend (in-memory demo session) | Shipping — 6 tracks with realistic plugin params |
| Ardour shim — transport (play/stop/rec/loop), control updates, 30 Hz playhead tick | Shipping |
| Ardour shim — real regions + source paths (playlist walk + Playlist signals) | Shipping |
| Ardour shim — per-track plugin enumeration + parameter emission | Shipping |
| Ardour shim — track rename/color (UpdateTrack → set_name / PresentationInfo::set_color) | Shipping |
| Ardour shim — action dispatch (edit.undo/redo, session.save, session.save_as, plugin.rescan, track.add_audio/bus) | Shipping |
| Ardour shim — session dirty + signal bridge | Shipping |
| Ardour shim — plugin parameter live updates (ParameterChangedExternally + ActiveChanged) | Shipping |
| Ardour shim — MIDI note emission (MidiModel walk, inline on region list) | Shipping |
| Symphonia-backed waveform peak decoder (WAV / FLAC / AIFF / OGG / Vorbis) | Shipping |
| Vector waveform renderer — port of Ardour's WaveView connected-line algorithm, viewport-cropped Canvas2D | Shipping |
| Schema-driven plugin panels | Shipping — `<foyer-plugin-panel>` renders any `PluginInstance.params` |
| Plugin picker modal + Add/Remove round-tripped through shim | Shipping |
| Errored-plugin row in the track strip with localStorage-persisted dismiss | Shipping |
| Track editor modal (right-click track label → rename/color/comment + embedded mixer strip) | Shipping |
| Tile tree + floating windows + slot picker + paired-edge resize | Shipping |
| Tear-out (tile header, plugin strip, menu items) + right-dock | Shipping |
| Layouts + Agents FABs as right-dock slide-out panels | Shipping |
| Layout presets + user-assigned chords | Shipping |
| Keyboard-first WM + AHK-flavored automation | Shipping |
| Transport bar with pulsing record, 3-mode return-on-stop, undo/redo/save cluster | Shipping |
| Multi-track selection + zoom-to-selection w/ back-stack | Shipping |
| Selection ops — delete / mute toggle across selection | Shipping |
| Return-on-stop mode (stay / zero / play-start) with front-end position lock + mid-play seek tracking | Shipping |
| MIDI piano roll component (modal via region right-click; reads shim-emitted notes) | Shipping |
| Client-side settings modal (preferences, waveform style/palette, transport mode) | Shipping |
| Session share modal with QR + URL copy | Shipping |
| Dev integration test harness (`/dev/run-tests` + diagnostics panel) | Shipping — 9 probes, all green against stub |
| Session save + save-as (shim-side `session.save_state(path)`) | Shipping |
| Audio I/O schema (IoPort + WebRTC/WebSocket transport negotiation) | Shipping — wire types land; runtime stubs pending |
| Audio egress test-tone path (sidecar synth → Opus / raw f32 → binary WS fan-out) | Shipping — listen button works against synth |
| Audio egress real master tap (shim RT `Processor` + ring buffer + drain thread) | Shipping — real master-bus audio flows via host backend |
| Out-of-tree shim build (CMake, no Ardour source edits, `ARDOUR_SURFACES_PATH`-installable) | Shipping — `just shim build && just shim install` |
| WebRTC audio forwarding (M6b ingress, M6c latency probe) | Schema ready; runtime pending |
| Busses / groups / sends (schema fields + mixer UI) | Not yet |
| Region fade-in / fade-out / trim-to-selection ops | Not yet |
| Standalone `.so` shim (drop-in for upstream Ardour) | Not yet |
| MCP agent round-trip | Panel + settings stub; no tool runtime yet |
| Voice chat between connected clients | Planned |
| Multi-window pop-out via `?window=N` | Planned |

## Quick start

Dev container is Debian trixie with Rust + audio deps already
installed. From the repo root:

```bash
just tw-build                    # one-shot Tailwind build
just run                         # run on 0.0.0.0 with soft preflight checks
```

Then open <http://127.0.0.1:3838>. On a fresh box the sidecar boots in
"launcher" mode with an empty stub; pick a project folder in the
Session view and Foyer spawns Ardour with the shim loaded, then
atomically swaps the backend in place without dropping your browser
connection.

To boot straight into the standalone demo session (no Ardour), run:

```bash
just run -- --backend stub
```

Six tracks, realistic plugin params, synthesized regions and
waveforms — useful for frontend work without the audio engine
running.

**Full Ardour path** (first run may build Ardour/shim once):

```bash
just ardour ensure
just shim check
```

After that, `just run` spawns Ardour via the shim as you pick projects.

**Out-of-tree shim build** (no edits to Ardour's source):

```bash
just shim build                          # build libfoyer_shim.so
just shim install                        # → ~/.config/ardour9/surfaces/
```

Ardour picks it up from `ARDOUR_SURFACES_PATH` at startup — same
mechanism Mackie / OSC / Generic MIDI use. Requires a built Ardour
sibling tree for headers + libs today; flips to `find_package(Ardour)`
once [docs/PROPOSAL-surface-auto-discovery.md](docs/PROPOSAL-surface-auto-discovery.md)
lands upstream. Keeps the GPL blast radius to the shim alone — the
rest of Foyer sits above a documented IPC boundary and ships under
non-GPL terms.

**Integration probes** (dev only):

```bash
FOYER_DEV=1 just run &
curl -s http://127.0.0.1:3838/dev/run-tests | jq
```

Returns pass/fail for each probe (snapshot shape, control echo, region
list, waveform decode, track rename, transport round-trip, ...). The
same probes are browsable in-UI via the **Diagnostics** view.

### Keyboard quick reference

Global tiling bindings (modifier is `Ctrl+Alt`; Mac users can swap to
`Cmd+Alt` by setting `foyer.keymap.mod = "meta-alt"` in localStorage):

| Keys | Action |
|---|---|
| `Ctrl+Alt` + `H` / `J` / `K` / `L` | Focus tile left / down / up / right (arrow keys also work) |
| `Ctrl+Alt` + `\|` or `\` | Split focused tile to the right (duplicates current view) |
| `Ctrl+Alt` + `-` or `_` | Split focused tile below (duplicates current view) |
| `Ctrl+Alt` + `W` | Close focused tile |
| `Ctrl+Alt` + `[` / `]` | Shrink / grow focused pane by 5% |
| `Ctrl+Alt` + `A` | Toggle automation panel |
| `Ctrl/Cmd` + `K` | Command palette |
| *(your chords)* | Per-layout, assigned via right-click → "Assign keybind…" in the layouts FAB |

Keyboard splits duplicate the focused view; mouse-clicking the split
icons in the tile header pops a view picker so you can choose what
goes in the new pane. Two UIs, one data model.

Inside the automation panel:

| Keys | Action |
|---|---|
| `Ctrl/Cmd` + `S` | Save and apply the current script |
| `Escape` | Close panel (unsaved buffer is kept) |

Mouse / gesture:

- Wheel over the timeline scrolls temporal zoom (anchored at the pointer).
- `Alt` or `Ctrl` + wheel over a timeline lane changes that lane's height.
- Drag a tile header past 8 px to tear it into a floating window.
- Drag a floating window's header over the right rail to dock it as an icon.
- Right-click anything in the layouts FAB for assign-keybind / hide / delete.

## Project layout

```
crates/
  foyer-schema            wire types (Session/Track/Region/Parameter, etc.)
  foyer-ipc               length-prefixed MsgPack frames (shim ↔ sidecar)
  foyer-backend           Backend trait — DAW-agnostic
  foyer-backend-stub      in-memory fake session for demo mode
  foyer-backend-host      generic IPC client for any shim
  foyer-server            WS + HTTP static server + jail
  foyer-config            YAML config + XDG data dir ($HOME/.local/share/foyer)
  foyer-cli               `foyer serve [--backend ID] [--project PATH] ...`
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
- **Per-layer licensing discipline.** Each shim naturally inherits the
  license terms of the host DAW it links against — `shims/ardour/`
  statically links `libardour` and is GPLv2+ accordingly. The Rust
  sidecar and web UI sit above the IPC boundary and are licensed
  separately (exact license TBD); keep the per-layer headers consistent
  so future shims (Reaper SDK, JUCE-based engines, whatever) can
  ship under whatever terms their SDK requires without touching the
  layers above.
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
just test                        # Rust workspace tests
just clippy                      # lint all targets with -D warnings
cargo fmt --all                  # formatter stays a direct cargo command
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

Layer-scoped:

- **`shims/ardour/`** — GPLv2+, because it statically links `libardour`.
  Standard practice for anything that touches the Ardour internals.
- **Rust sidecar + web UI** — TBD; sits above a documented IPC boundary
  and isn't derivative of any single shim, so it's licensed separately
  from whichever shim the user is running.

Future shims for other engines (Reaper, JUCE-based hosts, commercial
SDKs) will each carry their own license terms appropriate to how they
link against their respective host. See
[docs/DECISIONS.md](docs/DECISIONS.md) entry 15 for the long version.

Foyer is an attempt to build a modern editing surface around Ardour's
mature audio engine — not a replacement for it. Without Ardour's decades
of work on real-time audio, a recording/mixing surface like this one
wouldn't exist; the separation below is an engineering boundary, not a
political one.
