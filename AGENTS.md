# Agent working notes — Foyer Studio

Context for automated coding agents (Claude Code, Cursor, Aider, etc.)
working in this repo. Human-readable intro lives in the
[README](README.md); architectural history in
[docs/DECISIONS.md](docs/DECISIONS.md); developer workflow in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); UI-author recipes in
[web/HACKING.md](web/HACKING.md).

## What the project is

A web-native control surface for professional DAWs. Ardour is the
first engine. The browser isn't running audio — the DAW does. Foyer
replaces the *UI* with one opinionated about modern-browser
capabilities (tiling + floating windows, schema-driven plugin
panels, keyboard-first commands, remote-over-WS collaboration).

```
┌──────────────────────────┐
│ C++ shim (GPL-contained) │  ← translates DAW events to the wire schema
└──────────▲───────────────┘
           │ MsgPack over Unix socket
┌──────────▼───────────────┐
│ Rust sidecar             │  ← state, broadcast, HTTP/WS surface, RBAC,
│  (foyer-server + crates) │     audio egress/ingress, tunnel auth
└──────────▲───────────────┘
           │ WebSocket (+ /ws/audio/*, /ws/ingress/*)
┌──────────▼───────────────┐
│ Web UI (Lit + Tailwind)  │  ← three-tier split below, see "Web tree"
└──────────────────────────┘
```

## Repo layout

```
crates/                     Rust workspace
  foyer-schema              wire types (Event/Command/Envelope/…)
  foyer-ipc                 length-prefixed MsgPack framing
  foyer-backend             Backend trait — DAW-agnostic
  foyer-backend-stub        in-memory fake session (demo + tests)
  foyer-backend-host        generic IPC client for any shim
  foyer-server              axum WS + HTTP static + jail + tunnel + RBAC
  foyer-config              YAML config + XDG + roles + tunnel manifest
  foyer-cli                 `foyer` binary; bundles web/ via include_dir!
  foyer-desktop             wry + tao native wrapper

shims/
  ardour                    C++ control surface plugin (.so); GPL-contained

web/                        Three-tier web tree — see below
tests-ui/                   Playwright harness (outside web/ so not bundled)
scripts/dev/                Helper scripts invoked by the Justfile
docs/                       PLAN, STATUS, DECISIONS, DEVELOPMENT, KEYBOARD, TODO
.github/workflows/ci.yml    Calls `just` recipes — same as local gate
```

## Web tree (three-tier split)

```
web/
├── boot.js                  fetches /variants.json, dynamic-imports each
├── index.html               import map for lit + foyer-core + foyer-ui-core
├── core/                    foyer-core — renderless
│   ├── bootstrap.js, store.js, ws.js, rbac.js, …
│   ├── audio/, automation/
│   └── registry/{features,ui-variants,widgets,views}.js
├── ui-core/                 foyer-ui-core — primitives
│   ├── fallback-ui.js       the "If you lived here…" boot shell
│   ├── layout/              tile tree, docks, plugin float layer
│   └── widgets/             knob, fader, meter, modals, windows
├── ui-full/                 shipping UI (a ui-* variant)
│   ├── package.js           registers itself on import
│   ├── app.js               foyer-app shell
│   └── components/          mixer, timeline, transport, session, …
└── vendor/                  vendored Lit (no npm)
```

Dependency arrow is one-way: `core → ui-core → ui-*`. Never add an
import that points the other way. If ui-core needs something from a
concrete UI, push it up through a registry
([web/core/registry/](web/core/registry/)) instead.

Variants are *auto-discovered*. The server's `/variants.json`
endpoint scans `web_root` (+ any `--web-overlay`s) for any `ui-*`
folder containing a `package.js` and returns them; boot.js dynamic
-imports each and lets [`pickUiVariant()`](web/core/registry/ui-variants.js)
decide which mounts. Adding a variant means dropping a folder; do
NOT edit `index.html` or `boot.js`.

## Conventions that matter

- **No Node at ship time.** `web/` is plain ES modules + import map,
  vendored deps only. Bun + Playwright are dev-time tooling (in
  `tests-ui/`); they never enter the shipping binary.
- **Registries instead of hard-coded element tags.** When writing a
  widget-like thing, register it so alternate UIs can override:
  [`registerWidget`](web/core/registry/widgets.js),
  [`registerView`](web/core/registry/views.js),
  [`registerUiVariant`](web/core/registry/ui-variants.js).
- **Decisions get logged.** Real architectural tradeoffs go in
  [docs/DECISIONS.md](docs/DECISIONS.md) as a new numbered entry.
  Don't re-litigate in six months. Current entry count ≥ 41.
- **`just` over one-off scripts.** If it's worth doing twice, it's
  a recipe in the [Justfile](Justfile).
- **Server is the RBAC enforcement point.** Client-side gating
  (`foyer-core/rbac.js`) mirrors the server decision for UI sugar;
  it is never the security boundary. See DECISION 38.
- **Per-layer licensing.** `shims/ardour/` inherits GPLv2+ (links
  libardour). The Rust sidecar + web UI sit above the IPC boundary
  and stay non-copyleft. See DECISION 15.

## How to run + probe

```bash
just run                      # stub or Ardour backend, serves web/
just run --backend stub       # fast dev loop, no shim/JACK needed
just test-ui-ci               # Playwright smoke with auto-spawned stub
just verify                   # fmt-check + clippy + test + UI smoke (read-only PR gate)
just ci                       # autofixers (cargo fmt, …) — run before `just verify`
just ui-probe dump            # JSON snapshot of store/rbac/peers
just ui-probe screenshot /tmp/f.png
just ui-probe eval 'window.__foyer.store.state.status'
just ui-probe click 'foyer-transport-bar button[title*="Play"]'
```

### Talking to the running UI (agent-oriented)

The browser exposes a single global for external control:

```js
window.__foyer = {
  store,            // EventTarget — state.{session, controls, rbac, peers, …}
  ws,               // FoyerWs — .send({type: "..."}) to dispatch commands
  layout,           // LayoutStore — tile tree, floating windows, slots
  mountVariant({ id }),   // hot-swap UI variants at runtime
  unmountVariant(),
}
```

Typical probes from an agent:

```js
// Read state
window.__foyer.store.state.status               // "idle" | "open" | "closed" | "error"
window.__foyer.store.state.session              // current snapshot
Array.from(window.__foyer.store.state.peers.values())
window.__foyer.store.state.greeting?.features   // backend capability map

// Drive it
window.__foyer.ws.send({type: "request_snapshot"})
window.__foyer.ws.controlSet("transport.playing", true)
window.__foyer.ws.controlSet("transport.position", 0)

// Swap UI variants (if multiple registered)
window.__foyer.mountVariant({id: "touch"})
```

`just ui-probe eval '<expr>'` evaluates an expression in a fresh
headless Chromium pointed at `http://127.0.0.1:3838`. For longer
scripts, write a Playwright spec under `tests-ui/specs/*.spec.js`.

### When things are weird

```bash
just ui-probe dump                  # store/rbac/peers snapshot
curl -s http://127.0.0.1:3838/variants.json
curl -s http://127.0.0.1:3838/       # index.html — smoke test static serving
RUST_LOG=foyer_server=debug just run
```

## Gotchas

- **`./web` is NOT served by default.** `foyer serve` with no flag
  serves `$XDG_DATA_HOME/foyer/web/` (extracted from the binary on
  first run). `just run` explicitly passes `--web-root web` so edits
  to the repo tree are live. Don't be surprised if `cargo run
  --bin foyer` with no flags paints a stale UI.
- **tile-leaf must use static-html for dynamic tags.** Rendering
  view bodies via `document.createElement(tag)` breaks Lit's element
  reuse — the mixer, timeline, etc. remount on every store event.
  See DECISION 40 + the `lit/static-html.js` pattern in
  [web/ui-core/layout/tile-leaf.js](web/ui-core/layout/tile-leaf.js).
- **Pump existing element tags into `ui-full/app.js`.** ui-core
  doesn't import concrete UI elements (no backward dep). Anything
  ui-core templates (`<foyer-plugin-panel>`, etc.) must be
  side-effect-imported from the active UI variant's entry.
- **Rebuild when the schema changes.** `crates/foyer-schema/src/message.rs`
  is shared by shim + sidecar + browser. If you change the wire
  format, update all three or expect silent decode failures.
- **Feature flags in `ClientGreeting.features` default to
  *optimistic*.** A missing entry is rendered as "supported." Only
  explicit `false` hides the surface. See
  [web/core/registry/features.js](web/core/registry/features.js).

## Writing a new UI variant

Full recipe in [web/HACKING.md](web/HACKING.md). Short version:

1. Create `<web_root>/ui-mine/package.js` exporting a manifest +
   `registerUiVariant({id, match, boot, label})`.
2. Restart the server. `curl /variants.json` to confirm.
3. Reload the browser; `?ui=mine` forces your variant.

For developing one outside the repo (so you don't fork `web/`),
set `FOYER_WEB_OVERLAY=/path/to/your-dir` — see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Where to read next

- [README.md](README.md) — the human-facing intro.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — run + test workflow.
- [web/HACKING.md](web/HACKING.md) — UI authoring recipes.
- [docs/DECISIONS.md](docs/DECISIONS.md) — every architectural
  tradeoff logged as an ADR.
- [docs/PLAN.md](docs/PLAN.md) — product + feature backlog.
- [docs/STATUS.md](docs/STATUS.md) — capability snapshot (what's
  shipping vs planned).
