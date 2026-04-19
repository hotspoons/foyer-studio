# Handoff — Foyer Studio (next Claude picks up here)

Context is tight. Read this top-to-bottom, then skim
[docs/DECISIONS.md](DECISIONS.md) — the "why" behind the current design.
[docs/PLAN.md](PLAN.md) is the canonical product plan; [docs/TODO.md](TODO.md)
the loose backlog. Memory at
`~/.claude/projects/-workspaces-foyer-studio/memory/` covers Rich's
preferences — read it and don't re-ask. Key rules in particular:

- **No Node tooling.** No `node`/`npm`/bundlers/linters/test runners.
  Browser is the only JS runtime. Vendor ESM under `web/vendor/` if you
  must. Tailwind uses the standalone binary at `.bin/tailwindcss`.
- **Non-viral license everywhere except `shims/ardour/`.** The C++ shim
  is GPL by construction; everything else is permissive.
- **Ship-first, then log.** When a design tradeoff appears, pick the
  first sensible option and append an ADR entry in DECISIONS.md —
  don't stop to ask.
- **Speech-to-text artifacts:** "our door" = Ardour.

## 30-second orientation

Foyer is a **web-native, DAW-agnostic control surface** with a modern
UI built as a full-screen desktop environment (not a browser page).
Three layers:

```
 Ardour (or any DAW) ──(libfoyer_shim.so, GPL, ~1.6k LOC C++)
                          │  Unix socket, MessagePack frames + raw PCM
                          ▼
                    foyer-server (Rust, non-GPL)
                    WS + HTTP + Jail + plugin-param introspection
                          │  WebSocket JSON (MsgPack hot path deferred)
                          ▼
                    Lit 3.3 web UI (no bundler, no npm)
```

The web UI is a full desktop environment with custom tile tree, floating
windows with slot pinning, dedicated plugin-float layer, draggable FABs,
context menus, keyboard chord system, automation panel (AHK-flavored),
and a rails-style presets manager. See [DECISIONS.md](DECISIONS.md) for
every engineering call we've made.

## What just shipped (last session)

This session added a *lot*. Highlights of what's now working:

- **Plugin parameter UI end-to-end.** Realistic fixtures in the stub,
  `<foyer-plugin-panel>` renders any `PluginInstance.params` schema-
  driven. Ardour shim emits plugin params too (compiles cleanly; only
  lacks signal-hookup for external-change notifications).
- **Tile tree + tile-leaf tear-out.** Pointerdown on a tile header past
  an 8px threshold detaches into a floating window.
- **Floating windows with first-class slot system** (halves / thirds /
  quadrants / fullscreen / center). Every float has a `slot: <id> | null`
  field. Non-null = relative (reflows on workspace resize); null =
  absolute. Small drags within tolerance re-adopt the slot; big drags
  go absolute. Alt modifier bypasses snap.
- **Dedicated plugin-float layer** — [DECISIONS.md #12](DECISIONS.md).
  Plugin windows live in their own z-850 `<foyer-plugin-layer>`,
  auto-packed via shelf packing in [plugin-packer.js](../web/src/layout/plugin-packer.js).
  Global `Ctrl+Shift+P` shows/hides them all. Plugin panels measure
  their own natural size post-mount and resize the window to fit.
- **Right-dock is "hallowed ground"** for workspace reservation. Its
  full width (rail + any expanded panel) is excluded from the workspace
  rect, so slot-pinned windows reflow when the dock opens/closes.
  Event: `foyer:dock-resized`. Right-dock now has rail buttons for
  Actions, Session, Windows (new!), plus any docked FAB.
- **Docked FABs** — agent-panel + layout-fab register themselves via
  `layout.registerFab(id, meta, instance)`. Click rail icon = open
  quadrant panel near rail; drag rail icon off = tear out and keep
  following cursor until release. "Undock" button inside the pop-out
  panel too.
- **Status bar absorbed the main-menu row** — one less chrome row.
  Hosts FOYER brand, status dot, peers badge, layout save chip,
  `<foyer-main-menu>` (New launcher + DAW dropdowns), Full/Restore
  toggle, Theme.
- **Rectangle-inspired slot chords** in [slots.js](../web/src/layout/slots.js)
  `SLOT_SHORTCUTS` — `Ctrl+Alt+Shift+<arrows / UIJK / 1–5 / F / C>`.
  Runtime in [slot-keybinds.js](../web/src/layout/slot-keybinds.js)
  snaps the topmost float (or tears the focused tile) to the slot.
- **Sane sticky defaults per view** — mixer → right-half, timeline →
  left-half, plugins → left-third, session → right-third.
- **Global window list** — [window-list.js](../web/src/components/window-list.js)
  groups Tiled / Floating / Minimized / Plugins / Docked FABs. Click
  row to focus/raise/restore; × to close. Reachable via rail icon.
- **Styled prompt modal** replaces `window.prompt()` for save-layout.
  No more native dialogs anywhere.
- **`<foyer-number>` scrub-drag widget** for tempo — drag horizontally
  with Shift/Ctrl modifiers for fine/coarse steps, double-click to
  type, wheel + arrow keys. Wired into transport tempo.
- **Transport ticker** — stub advances `transport.position` at sample-
  rate × 33ms while `transport.playing = true`, emits `control.update`
  so the timeline playhead visibly moves.
- **Return-to-start-on-stop** — client pref in [transport-settings.js](../web/src/transport-settings.js),
  exposed as a checkbox-style item in the Transport menu. Both the
  Space keybind and the transport-bar Play toggle honor it.
- **Context menu fix.** The `_onDoc` dismissal in [context-menu.js](../web/src/components/context-menu.js)
  used `host.contains(ev.target)`, which fails across shadow-DOM
  retargeting. Now uses `composedPath()`. Same pattern applied in
  main-menu. Menu items finally fire their actions.
- **Click-to-raise** via document-level capture pointerdown that walks
  `composedPath` looking for a `.window` in our shadow root. Beats
  child handlers that would otherwise swallow the pointerdown.
- **Keyed `repeat()` on floating windows** — fixed the "click window A
  grabs window B" bug caused by Lit reusing DOM nodes across re-renders
  with stale `@pointerdown` handlers.

## You're in the middle of something

I was ~halfway through **paired adjacent-window resize** in
[floating-tiles.js](../web/src/layout/floating-tiles.js) when context
forced this handoff. What's there:

- `_startResize` gathers `partners = this._collectResizePartners(entry, dir, 8)`
  at the start of a resize. **This method is not yet written.**
- The `move` closure doesn't yet apply paired deltas to the partner
  windows. You need to finish both.

What to build:

1. `_collectResizePartners(entry, dir, tol)` — walk `this.store.floating()`,
   filter to visible windows, find any whose opposite edge lines up
   with `entry`'s `dir` edge within `tol` pixels AND whose perpendicular
   extent overlaps our entry's. For a right-edge drag on entry A:
   partners are windows B where `|B.x - (A.x + A.w)| < tol` AND the
   y-ranges overlap. Record `{ id, origX, origY, origW, origH, edge }`
   per partner.

2. In the `move` closure, after computing `nx/ny/nw/nh` for the entry,
   iterate partners: each partner's matching edge should move by the
   same `dx`/`dy` so the shared border stays glued. A right-edge drag
   of entry A that moves A's `w` by `+dx` should push each paired B's
   `x` by `+dx` and shrink `B.w` by `-dx`. Apply `minW/minH` clamps.

3. Alt-bypass: if `e.altKey`, skip partner updates (user opted out of
   paired resize).

4. Slot semantics during paired drag: commit both windows as absolute
   (`slot: null`) during the drag. On release, run each through
   `slotForRect` — if a pair still matches canonical slots together
   (e.g. left-half + right-half within tolerance), re-adopt both.

The drop-zones hover / snap logic during resize isn't yet run either.
Leave it off for paired drags — the slot system handles single-window
snap; paired is opt-in "splitter" behavior.

## What else is pending (queue)

From TODO.md and the in-flight lists, roughly by priority:

1. **Finish paired adjacent-window resize** (above).
2. **Plugin float persistence in named layouts.** Saving a layout
   should serialize the set of open plugin IDs so loading the layout
   reopens the same plugins. `layout.saveNamed()` currently only
   serializes the tile tree. Extend the serialized format.
3. **Layout undo/redo** with `Ctrl/Cmd+Z` / `Shift+Z` / `Ctrl+Y`. The
   store has a clear natural history boundary — every `_emit()` after
   a tree/floating/dockedFabs mutation could push a snapshot onto a
   ring buffer. Keep depth ~50, skip while dragging (use a `_drafting`
   flag the drag handlers set).
4. **MessagePack hot path on WebSocket.** `ControlUpdate` +
   `MeterBatch` as binary frames with an opt-in `?binary=1` query
   param. Server has `rmp-serde`; browser decoder is ~150 lines by
   hand (per the no-Node rule).
5. **Ardour shim: outbound plugin signal hookups.** The shim accepts
   plugin-param `ControlSet` and emits plugin descriptions in the
   snapshot, but doesn't yet subscribe to `Plugin::ParameterChanged`
   / `PluginInsert::ActiveChanged` so Ardour-side tweaks don't echo
   out. See `shims/ardour/src/signal_bridge.{h,cc}`.
6. **Multi-monitor-aware slot picker.** `screens.js` probe is wired
   but the picker doesn't offer "target this slot on monitor 2."
7. **Canvas-based timeline + mixer rendering.** Queued for perf.
8. **Auth gateway** — design in
   [docs/PROPOSAL-auth-gateway.md](PROPOSAL-auth-gateway.md).

## Running the stack

```bash
# Stub backend (demo mode):
pkill -9 -f 'foyer serve' 2>/dev/null; sleep 1
/workspaces/foyer-studio/target/debug/foyer serve \
  --backend=stub \
  --listen=127.0.0.1:3838 \
  --web-root=/workspaces/foyer-studio/web \
  --jail=/tmp/foyer-jail &

just tw-build                          # rebuild Tailwind CSS
cargo test --workspace                 # 16 tests; everything should pass

# Full Ardour path (/workspaces/ardour is the fork at
# hotspoons/zzz-forks-ardour.git on branch foyer-studio-integration):
just ardour-configure && just ardour-build
just shim-build
just shim-e2e
```

Smoke probes:
- `python3 /tmp/ws_probe.py` — connects, dumps plugin counts per track
- `python3 /tmp/ws_control.py` — sets a plugin param and watches the echo

## Background task lifecycle gotchas

- `pkill -9 -f 'foyer serve'` kills everything matching. Always pgrep
  to verify.
- Background commands started via `run_in_background: true` get
  SIGTERM'd when the Bash tool "completes," which can nuke the server
  process. Start the server with `&` inside a shell, then return — the
  parent shell exiting is fine, the child stays up.

## Conventions (durable)

- `just` over ad-hoc shell scripts.
- Rust primary; C++ minimized to the shim.
- DAW-agnostic schema — every type in `foyer-schema` should plausibly
  describe a Reaper or Bitwig backend too.
- Decisions go in [DECISIONS.md](DECISIONS.md). Log when you make one;
  don't re-litigate six months later.
- `docs/TODO.md` for scope work; `docs/HANDOFF.md` (this file) for
  state-of-play.
- For UI changes, rebuild Tailwind (`just tw-build`) if you touched
  `.css` classes — otherwise your changes won't apply.

## File map — read first

1. [docs/PLAN.md](PLAN.md) — canonical product plan.
2. [docs/DECISIONS.md](DECISIONS.md) — every tradeoff, why we picked
   what we did (14 entries as of this handoff).
3. [docs/TODO.md](TODO.md) — loose backlog.
4. [crates/foyer-schema/src/message.rs](../crates/foyer-schema/src/message.rs)
   — wire contract (Command + Event enums).
5. [web/src/layout/layout-store.js](../web/src/layout/layout-store.js)
   — authoritative floating-window + tile-tree state.
6. [web/src/layout/floating-tiles.js](../web/src/layout/floating-tiles.js)
   — window drag/resize/raise/tear-out/slot-matching. Biggest + most
   behavior-dense file.
7. [web/src/layout/slots.js](../web/src/layout/slots.js) — slot
   definitions, bounds functions, `SLOT_SHORTCUTS`, `slotForRect`
   tolerance match.
8. [crates/foyer-backend-stub/src/state.rs](../crates/foyer-backend-stub/src/state.rs)
   — where fake data comes from, including the new transport ticker.

## Git state

Current branch on `/workspaces/foyer-studio`: `main`.

Fork repo for Ardour: `https://github.com/hotspoons/zzz-forks-ardour.git`
— branches `foyer-studio-integration` (two patches) and
`upstream-master` (mirror of upstream).

## Known-good state

- Rust workspace compiles + all 16 tests pass.
- Every web asset serves 200 from `foyer serve` stub mode.
- Python WS probe confirms plugin params flow and `ControlSet`
  round-trips.

## One-line rule

If you're about to do something that takes more than one tool call,
write a TodoWrite list first. Fifty-plus web files and eight Rust
crates — scope drift is the biggest risk.

Good luck.
