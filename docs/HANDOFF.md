# Handoff to the next Claude

Foyer Studio is a **DAW-agnostic web UI** for pro audio workstations. The
architecture is:

```
 Ardour (or any DAW) ──(C++ shim .so)──► foyer-ipc (UDS, MsgPack + PCM) ◄── Rust sidecar
                                                                               │
                                                                               ▼
                                                                  WS / HTTP /files/ (browser)
```

The shim translates native concepts (Ardour routes, VST plugins, etc.) into
Foyer's schema; everything else reads that schema. Work currently targets the
**stub backend** (in-memory fake session) because the Ardour shim's full
introspection isn't ported yet. Memory at
`~/.claude/projects/-workspaces-foyer-studio/memory/` covers who Rich is, his
style preferences (Lit + Tailwind standalone, **no Node tooling**, vendored
ES modules only), and what's already been decided — don't re-ask.

## What exists — current state of play

### Rust workspace (stable)
- `foyer-schema` v0.2 — all wire types with stable IDs, schema-versioned
  envelopes, seq + origin for presence.
- `foyer-ipc` — length-prefixed frames; `Control = Command | Event` over
  MsgPack.
- `foyer-backend` — Backend trait; default impls return empty for
  introspection methods so partial shims still compile.
- `foyer-backend-stub` — populates 6 tracks with realistic plugin inserts
  (EQ/comp/dessser/reverb/limiter), synthesizes regions and deterministic
  waveform peaks.
- `foyer-backend-host` — generic IPC client for connecting to any shim.
- `foyer-server` — WS + static-file server; owns the `Jail` and
  `/files/<path>` endpoint. All 16 tests green.
- `foyer-cli`, `foyer-desktop` (wry/tao, builds clean).

### C++ shim (partial → expanded)
`shims/ardour/` (~1,600 LOC after tonight) — compiles against Ardour 9
cleanly (verified: `build/libs/surfaces/foyer_shim/libfoyer_shim.so` links
without warnings in this session). Emits transport + track gain/pan/mute/solo
**plus** every `PluginInsert`'s parameter set, inlined into each track's
`plugins[]` array in the snapshot. Includes a synthetic `.bypass` parameter
per plugin that toggles `PluginInsert::activate()`/`deactivate()`. The
`resolve()` + bypass fast-path in `dispatch.cc` handles inbound `ControlSet`
for `plugin.<pi-id>.param.<n>` and `plugin.<pi-id>.bypass`. **Signal
hookups for outbound `ControlUpdate`s on plugin param changes are still
TODO** — see queue item #2.

### Web (Lit 3.3 + Tailwind v4 standalone, zero bundler)
~7,500 LOC of JS + ~150 lines of CSS tokens. Import map in `web/index.html`
resolves bare specifiers from `web/vendor/`.

## What changed in the last session (2026-04-18 → 19)

Rich asked for the core schema-driven UI promise that was still stubbed.
Delivered:

- **Plugin parameter UI, end-to-end.** Realistic plugin params in the stub
  (EQ with lowcut + 3 bands, compressor with envelope + dynamics +
  detection-mode enum, de-esser, reverb with algorithm enum, limiter with
  mode enum). Bypass is modeled as a `plugin.<id>.bypass` Parameter inside
  `params[]` that syncs with the denormalized `bypassed: bool`; the stub's
  `set_control` detects `.bypass` suffixed IDs and keeps both in sync. The
  WS probe at [/tmp/ws_control.py](/tmp/ws_control.py) demonstrates that
  `ControlSet` on any plugin param echoes back correctly.

- **Generic widget stack** built on top of the schema:
  - [web/src/param-scale.js](../web/src/param-scale.js) — `toNorm`/`fromNorm`/`formatValue` covering linear, log, Hz, dB scales.
  - [web/src/components/knob.js](../web/src/components/knob.js) — SVG knob, scale-aware, shift-drag for fine control, wheel support.
  - [web/src/components/param-control.js](../web/src/components/param-control.js) — dispatches on `kind` (continuous/discrete/enum/trigger/meter/text) → knob / stepper / select / toggle / meter / text input.
  - [web/src/components/plugin-panel.js](../web/src/components/plugin-panel.js) — reads `PluginInstance.params`, groups by `group` hint, emits `ControlSet` on changes. Subscribes to the store so collaborator edits appear live.

- **Floating window system overhaul**:
  - 8-handle resize (corners + edges) in [floating-tiles.js](../web/src/layout/floating-tiles.js).
  - Z-order on click (via `layout.raiseFloat(id)`).
  - New `plugin_panel` view type that takes `{ plugin_id }` in props and locates it live.
  - [slots.js](../web/src/layout/slots.js) — 14 named placements (halves, thirds, quadrants, fullscreen, center).
  - [slot-picker.js](../web/src/layout/slot-picker.js) — popover with a 4×3 grid + hover-preview overlay.
  - Sticky slot per-view: `layout.openFloating(view, props)` without a placement returns to the last slot the user parked this view type in (`foyer.layout.sticky.<view>` in localStorage).
  - [drop-zones.js](../web/src/layout/drop-zones.js) — drop-target overlay that shows up during any floating-window drag. Release over a zone snaps; release outside leaves the window where you dropped it.
  - **Tear-out** from tile headers: pointer-down on a tile header + drag past 8px detaches the tile into a floating window and hands the drag off to the zone overlay. See [tile-leaf.js:_headerDown](../web/src/layout/tile-leaf.js).

- **Right-dock = unified dock area** ([right-dock.js](../web/src/components/right-dock.js)):
  - Subscribes to store `change` (fixed the long-standing session panel update bug).
  - Subscribes to layout `change` and renders minimized floats as dock icons in the rail.
  - Drop a dragging floating window over the rail → it minimizes into a dock icon.
  - Right-click a dock icon to close the window entirely.

- **Plugin strip** ([plugin-strip.js](../web/src/components/plugin-strip.js)):
  - Click any plugin row opens the generated plugin panel. Sticky-slots to the last position that view type lived in.
  - Right-click opens the panel **and** immediately invokes the slot picker.
  - Bypass button emits `ControlSet` on the `.bypass` param instead of mutating local state.

- **Shared QuadrantFab base class** ([quadrant-fab.js](../web/src/components/quadrant-fab.js)). Both the layout FAB ([layout-fab.js](../web/src/components/layout-fab.js)) and future floating surfaces share drag, resize, and quadrant-anchoring math. The agent panel still uses its own (more complex) copy; migrating it is low-risk follow-up work.

- **Icons** ([icons.js](../web/src/icons.js)) swapped to proper Heroicons 24×24 outline paths lifted from `/tmp/patapsco-ai-platform/modules/platform-ui/static/js/components/base/app-icon.js`. Old names aliased (`close` → `x-mark`, `music-note` → `musical-note`) so no component had to be touched. Added ~45 new names so new features have a consistent vocabulary.

- **Multi-monitor** ([screens.js](../web/src/screens.js)) — probes
  `window.getScreenDetails()` (Chromium's Window Management API) with
  permission-aware fallbacks. `probeScreens()` returns `{ source, screens,
  current }`; `watchScreens(cb)` subscribes to topology changes. Not surfaced
  in UI yet — available for the slot picker to target a specific monitor.

- **Context menus** ([context-menu.js](../web/src/components/context-menu.js))
  — `showContextMenu(event, items[])` API. Single singleton mounted at
  `document.body`. Items support `label`, `icon`, `shortcut`, `tone`,
  `action`, `disabled`, `separator`, `heading`. Viewport-edge flipping.
  Wire-up is per-component.

- **Timeline per-lane vertical resize** in
  [timeline-view.js](../web/src/components/timeline-view.js). Drag-handle
  below each lane; heights persist in localStorage
  (`foyer.timeline.lane-heights.v1`). Waveform canvas heights follow.

- **Presence badge** in status bar — surfaces active peers (seen via
  envelope `origin` within the last 10s). Tooltips show the origin tag list.
  The store grew `peers: Map<origin, timestamp>` + `activePeers()` +
  `peers` event.

- **Non-native scrollbars** — single global `@layer base` rule in
  [tw.css](../web/styles/tw.css) uses `color-mix(in oklab, ...)` so hover
  tints with the palette accent. Firefox + Chromium both covered.

- **Workspace shrink fixes**: tile-tree split ratio floor dropped from 10% →
  3% (so a sibling tile can collapse to a slim rail on ultrawide);
  `.main`/`.workspace` got `min-width: 0`; mixer + timeline toolbars
  `flex-wrap: wrap`. Should address the "leftmost pane stops resizing at
  1200px" report.

- **No-Node memory** saved. See
  [memory/feedback_no_node.md](/home/vscode/.claude/projects/-workspaces-foyer-studio/memory/feedback_no_node.md).
  **Do not** install Node, npm, any bundler, or a test runner.

## Running the stack

```bash
# From repo root:
just tw-build                    # rebuild Tailwind CSS
target/debug/foyer serve \
  --backend=stub \
  --listen=127.0.0.1:3838 \
  --web-root=$PWD/web \
  --jail=/tmp/foyer-jail

# End-to-end Ardour path (slow; initial Ardour build ~15 min):
just ardour-configure && just ardour-build && just shim-build
just shim-e2e
```

WS probes for smoke testing (stdlib only, no `pip`):
- [/tmp/ws_probe.py](/tmp/ws_probe.py) — connect, dump plugin counts per track.
- [/tmp/ws_control.py](/tmp/ws_control.py) — connect, set a plugin param, watch the echo.

**Background task lifecycle:** `pkill -f 'foyer serve'` can kill processes
started via `run_in_background: true`. Always `pgrep -af 'foyer serve'`
before launching.

## Open work queue (in priority order)

1. **Multi-monitor-aware slot picker.** `screens.js` is wired; the slot
   picker still computes against `window.innerWidth/Height`. If the user
   is on an ultrawide + secondary screen, we should let them pick which
   screen a slot targets, then use `window.open()` with coordinates on that
   screen for a true multi-window setup. USPTO's pubwebapp was cited as
   reference — implement: (a) screen chooser strip at top of slot picker,
   (b) `window.open(url, '_blank', 'width=W,height=H,left=X,top=Y')` with
   `#floatId` fragment, (c) cross-window sync via BroadcastChannel so
   `control.update`s propagate.

2. **Ardour shim plugin parameter emission.**
   [msgpack_out.cc::encode_session_snapshot](../shims/ardour/src/msgpack_out.cc)
   currently emits tracks with gain/pan/mute/solo only. Need to:
   - Walk each `Route::nth_plugin(i)` until null.
   - For each `ARDOUR::PluginInsert`, iterate parameters via
     `plugin->parameter_descriptor(i, desc)`.
   - Emit `PluginInstance { id, name, uri, bypassed, params[] }` with every
     descriptor mapped to the neutral `Parameter` shape.
   - Hook `PluginInsert::ParameterChanged` + `PluginInsert::BypassChanged`
     signals to emit `ControlUpdate`s.
   - Extend [dispatch.cc](../shims/ardour/src/dispatch.cc)'s `resolve()` so
     `plugin.<insert-id>.param.<name>` + `.bypass` IDs route to
     `PluginInsert::set_parameter()` / `PluginInsert::set_active()`.
   - Test end-to-end with a real LV2 plugin loaded on a track.
   This is the **single biggest gap** — without it, "plug a real DAW in and
   the UI works" is still promise-not-delivered.

3. **Canvas-based timeline + mixer rendering** (still in the queue from
   before). One `<canvas>` per tile with a hit-test layer. Biggest pain
   today is resize drift on the per-region waveform canvases.

4. **MessagePack hot path for WS.** Server already uses rmp for IPC; WS is
   JSON only. Vendor a minimal MsgPack decoder (~150 LOC handwritten —
   don't reach for an npm package; see the no-Node memory), flip
   `ControlUpdate` + `MeterBatch` to binary frames, keep JSON for
   snapshots/errors. Saves about 40% bandwidth at scale.

5. **Migrate agent-panel to QuadrantFab.** It predates the base class. Risk
   is medium — agent panel has the chat transcript, settings modal, etc.
   worth doing carefully.

6. **Custom slot-set editor.** Rich wants per-client configurable grids
   (different slot presets for a 49" ultrawide vs. a laptop). Add a
   `foyer.layout.custom-slots.v1` store + an editor accessible from the
   slot picker ("Edit slots…" chip). Hard bounds: each slot still needs a
   `bounds(vw, vh, pad)` — easiest to encode as fractional rects.

7. **Tabbed floating windows.** Drag one floating window's title onto
   another's title → they become a tabbed group. Hyprland-like.

8. **Text-preview.js import path nit**: already fixed in current session
   state; the note is in the changelog.

## File map — what to read first

1. [docs/PLAN.md](PLAN.md) — canonical product spec.
2. [crates/foyer-schema/src/message.rs](../crates/foyer-schema/src/message.rs)
   + [value.rs](../crates/foyer-schema/src/value.rs)
   + [session.rs](../crates/foyer-schema/src/session.rs) — the wire contract.
3. [web/src/layout/tile-tree.js](../web/src/layout/tile-tree.js) — pure
   layout data model.
4. [web/src/layout/layout-store.js](../web/src/layout/layout-store.js) —
   the authoritative floating-window state.
5. [web/src/layout/floating-tiles.js](../web/src/layout/floating-tiles.js)
   — the drag/resize/drop-zone behavior.
6. [web/src/components/plugin-panel.js](../web/src/components/plugin-panel.js)
   — the canonical schema-driven widget host.
7. [crates/foyer-backend-stub/src/fixtures.rs](../crates/foyer-backend-stub/src/fixtures.rs)
   — where fake plugin params live. Edit here if the UI needs different
   shapes to exercise.

## Conventions and traps

- **No Node.** See [memory/feedback_no_node.md](/home/vscode/.claude/projects/-workspaces-foyer-studio/memory/feedback_no_node.md). If a change "needs" Node, do it in Rust or write a tiny browser-only fallback instead.
- **No new dependencies in `web/`.** Vendor if truly needed.
- **`just` over shell scripts.**
- **Rust is primary; C++ minimized.** Shim's only job is translation.
- **Auto mode is on.** Press forward on low-risk work. Ask before
  destructive operations or new npm fetches (there shouldn't be any).
- **Speech-to-text artifacts.** "Our door" = Ardour.

## Schema extension checklist (for any new command/event)

1. Add types to `foyer-schema` (`message.rs` + wherever the entity lives).
2. Bump `SCHEMA_VERSION` minor if additive, major if breaking.
3. Add a default-erroring method to the `Backend` trait.
4. Implement in `foyer-backend-stub` so the UI can exercise it.
5. Route it through `foyer-server`'s `ws::dispatch_command`.
6. Add to the shim's `dispatch.cc::decode()` + encoder in `msgpack_out`.
7. Test with `just run-stub` first, then the real shim.

Good luck.
