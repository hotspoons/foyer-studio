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
.github/workflows/docker.yml Builds + pushes the container image to GHCR
                             (snapshot-<sha>/snapshot-latest on branch
                             pushes; main-<sha>/latest on main merges)
.github/workflows/ghcr-cleanup.yml  Daily cron pruning old snapshot tags
                             from GHCR (>14 days). Untagged orphans go at >7 days.
.github/workflows/cloudrun-deploy.yml CD into Cloud Run on main-pipeline
                             success (gated on `vars.GCP_PROJECT` — off by
                             default in fresh forks).
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
  Don't re-litigate in six months. Current entry count ≥ 47.
- **`just` over one-off scripts.** If it's worth doing twice, it's
  a recipe in the [Justfile](Justfile).
- **Server is the RBAC enforcement point.** Client-side gating
  (`foyer-core/rbac.js`) mirrors the server decision for UI sugar;
  it is never the security boundary. See DECISION 38.
- **Backend is the ONLY source of truth for shared session state.**
  *Read this before adding any user-facing toggle.* If the setting
  affects what every connected client sees — return-on-stop mode,
  loop range, time signature, monitor mode, source-user assignment,
  etc. — the value MUST live on the backend (typed schema field +
  ControlSet wire-route + ControlUpdate echo). The UI toggle reads
  from `store.state.controls`, writes via `ws.controlSet`. A
  localStorage cache is fine as a cold-boot fallback / optimistic
  layer, but it CANNOT be the canonical store.
  - **Why this is in caps:** every Claude (and Cursor and Copilot)
    instance that has touched this repo has, at some point, stuffed
    a shared session setting into localStorage because that's the
    pattern the training corpus is saturated with — solo-dev demos,
    Stack Overflow answers about "how do I remember this checkbox,"
    Medium tutorials about React state. The path of least resistance
    completes the diff without expanding into the schema/backend
    layers, which feels like restraint but in a multi-client domain
    is just shrinking the scope of the request to fit the wrong
    shape. Real bug from 2026-05-03: a return-on-stop button shipped
    as localStorage-only; phone toggle → desktop never sees it →
    user confused.
  - **The check, before you write a line of UI code:** if I changed
    this setting on the desktop and walked over to a phone, would
    the phone show the new value? If "no" or "I don't know," wire
    it through the backend FIRST. Schema field, stub fixture,
    ControlSet handler, then the UI button — in that order.
  - **Per-client preferences are a different category.** Theme,
    fader-detail viz, mic-codec choice, panel layout — these are
    correctly localStorage. The discriminator is *"does another
    client at the same session need to see this?"* If yes:
    backend. If no: localStorage.
- **Jail-relative paths only on the wire.** Anything outside the
  backend — WS envelopes, recents.json, log lines that the UI sees,
  error messages broadcast to clients — uses paths *relative to the
  filesystem jail root*, never absolute. The jail is the user's
  Cloud Run / devcontainer / studio mount point and its absolute
  form (`/workspaces/foyer-studio`, `/projects/<tenant>`, …) is a
  host-deployment detail the UI has no business knowing. Sibling
  contracts already enforced today:
  - `SessionInfo.path` → `SessionRegistry::jail_display_path` strip
    on every emit (snapshot list + per-session events).
  - `BackendSwapped.project_path` → same strip in `swap_backend`.
  - `RecentEntry.path` → `recents::normalize_path(path, jail_root)`
    canonicalize-then-strip before `touch` / `forget`.
  - `OrphanInfo.path` → `orphans_for_wire` strip at every WS emit
    site (initial attach + ListSessions + reattach + dismiss).
  - When you add a new event with a path field, mirror these. When
    you add a new event with an embedded user-facing message that
    interpolates a path, run it through the same strip — the
    `reattach_failed` error message had a leaked socket path
    (`/tmp/foyer/ardour-NNN.sock`) that ended up in the UI even
    though the orphan path itself was clean. The check: *would I
    learn anything about my host filesystem layout from this string
    that I shouldn't?* If yes, strip; if you can't tell, log the
    full version server-side and ship a sanitized one over the
    wire.
  - **Why this is also in a sticker:** the same training-corpus
    gravity that pulls toward localStorage pulls toward
    `path.display()` / raw `format!("{:?}", project_path)` because
    that's how every Rust tutorial demonstrates Display impls.
    Real bug from 2026-05-03: orphan banner displayed
    `/workspaces/foyer-studio/sessions/asdf` while the recents row
    next to it correctly read `foyer-studio/sessions/asdf` — same
    project, two labels, immediate "where does this Foyer instance
    actually live?" leak.
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

### Authoring Playwright specs (gotchas earned in anger)

The probe loop above is fast for one-offs; for anything you want to
keep, write a spec under [tests-ui/specs/](tests-ui/specs/).

**Wait on capabilities, not visibility.** The smoke test waits for
`foyer-app` to be visible, but `__foyer.layout` is attached during
the variant's `connectedCallback`, which lags visibility by a few
hundred ms in a cold headless boot. The right wait is the one you
actually need:

```js
await page.goto("/");
await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
await page.waitForFunction(
  () => typeof window.__foyer?.layout?.setTree === "function",
);
```

**Default timeouts are not enough.** Variant boot can take >5 s on a
cold headless start. Set `page.setDefaultTimeout(20_000)` at the top
of each test that needs to interact with mounted views; otherwise
`waitForFunction` quietly hits the 5 s default and gives you a
`Timeout 5000ms` you'll waste 30 minutes chasing.

**Walk shadow roots — `document.querySelector` lies.** Most live
views are nested ≥2 shadow roots deep
(`foyer-app → foyer-tile-container → foyer-tile-leaf → foyer-…`).
Playwright locators pierce closed roots automatically; raw DOM
inside `page.evaluate` doesn't. The pattern that works in any spec:

```js
const DEEP_FIND = `
  function deepFind(tag) {
    const stack = [document.querySelector("foyer-app").shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector(tag);
      if (hit) return hit;
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return null;
  }
`;
// then inside an evaluate:
await page.evaluate(`(() => {
  ${DEEP_FIND}
  const tv = deepFind("foyer-timeline-view");
  // …
})()`);
```

**Mount what you need with `setTree`.** A fresh stub session opens
into the `mixer` leaf by default. To exercise timeline / piano roll /
beat sequencer ops, swap the tree first:

```js
await page.evaluate(() => {
  window.__foyer.layout.setTree({
    kind: "leaf", id: "test_t", view: "timeline", props: {},
  });
});
await page.waitForFunction(`(() => {
  ${DEEP_FIND}
  return !!deepFind("foyer-timeline-view");
})()`);
```

Lit re-renders are batched on a microtask + animation frame; if
you skip the deep-find wait you'll race the tile-leaf swap.

**Drive features by calling methods, not by simulating drags.**
Synthesizing pointer events that have to traverse shadow boundaries
is brittle. For state-mutating ops, prefer:

```js
await page.evaluate(`(() => {
  ${DEEP_FIND}
  deepFind("foyer-timeline-view").duplicateRegionSelection();
})()`);
```

…and then `await page.waitForFunction(...)` on the resulting state.
Reserve real pointer simulation for tests where the gesture itself
is what's under test (e.g. drag-to-resize, marquee-select).

**Wait on state transitions, not arbitrary timeouts.** WS round-trips
are typically 100–400 ms but vary; `setTimeout(400)` will be flaky
across runs. Poll the predicate that the op actually changes:

```js
await page.waitForFunction(
  `() => deepFind("foyer-timeline-view")
    ._regionsByTrack[${JSON.stringify(trackId)}].length === ${target}`,
);
```

**Stub state persists between tests in a single playwright run.**
With `workers: 1` (default), each test gets a fresh page but they all
hit the same stub-backend process, which retains region edits, control
values, etc. Don't write `expect(count).toBe(2)` — capture `before`,
then `expect(after).toBe(before + N)`.

**Stash debugging probes in `/tmp` not `tests-ui/specs`.** When
something is genuinely racy, drop a `bun /tmp/probe-foo.js` script
that runs the same boot sequence as your spec and dumps state. It's
faster than rerunning `bunx playwright test` and lets you log freely
without the spec runner eating stdout.

### Running a tight inner loop

```bash
just run --backend stub                                  # background
bunx playwright test specs/your-spec.spec.js --reporter=line   # iterate
just verify                                              # gate before commit
```

`just run` already passes `--web-root web`, so a saved file is live
on the next probe — no rebuild needed for client-side fixes. Server
or schema changes require `cargo run` + restart.

## Gotchas

- **Lit `css` tagged templates are normal JavaScript template literals.**
  `${...}` interpolates. A **raw backtick** anywhere in the CSS body
  ends the `css` template literal early; the tail is parsed as ordinary
  code (2026-05-03: `TypeError: css(...).region is not a function` after
  a comment used Markdown-style quoted class names with backticks).
  **Do not** put backticks inside `css` blocks — rephrase comments.
  Avoid angle-bracket custom element names in `css` text too (e.g.
  `<foyer-waveform-gl>`): Lit can treat the token after `<` as an
  identifier and throw `ReferenceError` at class init. See
  [waveform-gl.js](web/ui-core/viz/waveform-gl.js) for the corrected
  comments.
- **`./web` is NOT served by default.** `foyer serve` with no flag
  serves `$XDG_DATA_HOME/foyer/web/` (extracted from the binary on
  first run). `just run` explicitly passes `--web-root web` so edits
  to the repo tree are live. Don't be surprised if `cargo run
  --bin foyer` with no flags paints a stale UI. **When a UI fix
  "does nothing", verify the browser is actually loading scripts from
  the workspace** (e.g. DevTools Network → response path or source age).
  An agent can ship the right patch and still think it failed because
  the running server kept serving the old bundled tree.
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
