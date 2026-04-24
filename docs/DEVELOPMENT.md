# Foyer Studio — developer workflow

Running the sidecar, extending the web UI without editing the main
tree, and running the same test gate CI runs.

UI-author recipes live in [../web/HACKING.md](../web/HACKING.md);
this doc is the plumbing around them.

## The dev container is the only supported way to run

The dev container is the only supported path today. It installs the
C++ toolchain, Rust, Ardour's build deps, JACK, Bun + Playwright
(dev-only), and every script the Justfile relies on. Trying to run
outside it is possible but unsupported and will leak host-specific
issues every time.

Prerequisites:

- Docker Desktop (Mac/Windows) or Docker Engine (Linux) running
- VS Code with the Dev Containers extension, OR any IDE that
  consumes `.devcontainer/devcontainer.json`

From a fresh clone:

1. Open the repo in VS Code.
2. Command palette → **Dev Containers: Reopen in Container**.
3. Wait ~5–10 minutes for the initial image build.
4. In the container terminal: `just run`.

The first `just run` clones and builds Ardour (~20 minutes on an
Apple Silicon Mac, longer on slower hosts) and compiles the shim +
sidecar. Subsequent runs reuse the build artifacts and are fast.

On native Linux hosts you can uncomment the `--device=/dev/snd`
block in [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)
to expose ALSA devices to the container; JACK inside the container
can then drive real hardware. On Mac/Windows the Docker VM doesn't
expose audio devices, so ingress/egress rides the browser's
`getUserMedia` and `AudioContext` paths — sufficient for remote
collaboration but not for driving studio gear.

## Running

```bash
just run                         # default backend from config.yaml, serves web/
just run --backend stub          # force the stub backend (fast dev loop)
just run-tls                     # HTTPS — required for getUserMedia / AudioWorklet on LAN IPs
```

`just run` passes `--web-root web`, so the sidecar serves the
working-copy UI tree — file edits show up on browser refresh.
Without that flag the binary serves `$XDG_DATA_HOME/foyer/web/` (the
user-install path, extracted from the binary on first boot).

`just prep` (auto-called by `just run`) clears the install dir so
stale extractions from a prior build can't silently serve old UI
under a newer sidecar.

Then open <http://127.0.0.1:3838>. A fresh boot lands in the
launcher; pick a project folder in the Session view and Foyer
spawns Ardour via the shim, swapping the backend without dropping
the browser connection.

## Building a UI outside the main tree

You don't have to fork `web/` to add your own UI. Drop your package
dir alongside the repo, point `FOYER_WEB_OVERLAY` at it, and
`just run` layers your assets on top of the shipped ones:

```
my-workspace/
├── foyer-studio/              # this repo, untouched
│   ├── web/                   # shipped UI + core
│   └── …
└── my-foyer-ui/               # your UI-only package
    ├── ui-mine/               # new variant (auto-discovered)
    │   ├── package.js
    │   └── app.js
    └── ui-mine-touch/         # another variant, same overlay
        └── package.js
```

```bash
cd foyer-studio
FOYER_WEB_OVERLAY=../my-foyer-ui just run
```

What happens:

1. `just run` passes `--web-overlay ../my-foyer-ui` to the sidecar.
2. The server composes a static-asset chain: **overlay first**,
   then `--web-root web` as the fallback. A hit in your overlay
   wins; a miss cascades down. You can shadow any file from the
   base tree (drop `index.html` in your overlay and it wins over
   the shipped one — use sparingly).
3. `/variants.json` scans **every root** for `ui-*/package.js`.
   Your `ui-mine/` and `ui-mine-touch/` show up in `boot.js`'s
   dynamic-import list automatically.
4. `pickUiVariant()` on the browser side runs your variants'
   `match(env)` alongside shipped ones; highest score wins. Force
   a specific one with `?ui=mine` on the URL.

Stack multiple overlays by colon-separating:

```bash
FOYER_WEB_OVERLAY=../my-foyer-ui:../my-foyer-ui-experiments just run
```

Earlier entries win. Up to four stacked overlays compose via plain
`ServeDir` chaining; past that the server logs a warning and stops
at four — put the extras in subdirs of a single overlay.

### Directly, without the Justfile

```bash
cargo run --bin foyer -- serve \
    --listen 127.0.0.1:3838 \
    --backend stub \
    --web-root web \
    --web-overlay ../my-foyer-ui \
    --web-overlay ../my-foyer-ui-experiments
```

`--web-overlay` is repeatable. Paths are validated at startup — a
typo aborts immediately rather than surfacing as a mystery 404.

### Shipping your UI as a redistributable binary

The runtime `--web-overlay` flag covers the live dev loop. To bake
your UI into a redistributable `foyer` binary (so end users get
your UI without configuring an overlay), set `FOYER_BUNDLED_WEB` at
build time:

```bash
FOYER_BUNDLED_WEB=/path/to/my-staged-web cargo build --release --bin foyer
```

[`../crates/foyer-cli/build.rs`](../crates/foyer-cli/build.rs) reads
that env var and threads it through to `include_dir!`, so the
baked-in assets come from your dir instead of the repo's `web/`.
Absolute or relative paths both work; the resolved directory is
registered as `rerun-if-changed` so edits inside it trigger a
rebuild on the next `cargo build`.

Rebuilds with the env unset fall back to the repo's `web/`.

## Web build

Tailwind compiles via the standalone CLI (no Node at ship time):

```bash
just tw-build        # one-shot build of web/styles/tw.build.css
just tw watch        # rebuild on change
```

`just run`'s prep runs `just tw check` which rebuilds only when
stale.

## Tests

Tests are `just` recipes so they double as CI steps:

```bash
just fmt-check       # cargo fmt --all -- --check
just clippy          # cargo clippy --workspace --all-targets -- -D warnings
just test            # cargo test --workspace --all-targets
just test-ui         # Playwright smoke against a running server
just test-ui-ci      # Playwright smoke with an auto-spawned stub server
just ci              # fmt-check + clippy + test + test-ui-ci (full gate)
```

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the
same recipes via `setup-just` + `setup-bun`, so a green `just ci`
locally maps to a green PR check.

The UI harness lives in [../tests-ui/](../tests-ui) (outside `web/`
so it isn't bundled into the binary). Bun + Playwright persist via
the dev container's post-install step.

### Probing the live UI from the CLI

```bash
just ui-probe screenshot /tmp/foyer.png
just ui-probe eval 'window.__foyer.store.state.status'
just ui-probe click 'foyer-main-menu button'
just ui-probe dump
```

`just ui-probe` wraps [../tests-ui/probe.js](../tests-ui/probe.js).
Useful for scripting reproducers or driving the UI from an
automated agent that can't open a browser.

## Where things live

- [../web/core/](../web/core) — renderless: ws, store, RBAC, audio,
  automation, registries
- [../web/ui-core/](../web/ui-core) — shared primitives: tiling,
  widgets, fallback shell
- [../web/ui-full/](../web/ui-full) — the shipping UI variant
- [../web/boot.js](../web/boot.js) — fetches `/variants.json`,
  dynamic-imports each variant, boots core
- [../crates/foyer-cli/](../crates/foyer-cli) — `foyer` binary;
  bundles `web/` via `include_dir!` and extracts on first run
- [../crates/foyer-server/](../crates/foyer-server) — axum HTTP + WS;
  composes `ServeDir` overlay chain and serves `/variants.json`
- [../tests-ui/](../tests-ui) — Playwright harness
- [../scripts/dev/](../scripts/dev) — helper scripts invoked by
  the Justfile

See [ARCHITECTURE.md](ARCHITECTURE.md) for the three-layer walkthrough,
[../web/HACKING.md](../web/HACKING.md) for the UI-author's entry
point, and [DECISIONS.md](DECISIONS.md) for every architectural call
logged as an ADR.
