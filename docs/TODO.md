# Foyer Studio — TODO

The product plan lives in [PLAN.md](PLAN.md) and the state-of-play lives
in [HANDOFF.md](HANDOFF.md). This file is for loosely-scoped work items
that either aren't sized yet or are explicitly deferred — things we
want in our heads but not in next week's sprint. Items are append-only
in spirit; finished work gets moved to HANDOFF's "done" column or a
DECISIONS.md entry explaining the call we made.

Entries follow a loose shape:

```
## Short title
- **Status:** pending / sketched / deferred / blocked
- **Owner:** (claude / rich / unassigned)
- One paragraph of intent + constraints
- Optional sub-bullets: concrete next actions
```

---

## Multi-monitor / multi-window support

- **Status:** pending (foundation landed)
- **Owner:** unassigned

Today a Foyer instance lives in one browser window. On multi-monitor
setups that's a real limitation — engineers routinely want timeline +
transport on one screen and mixer + plugins on another, and the
in-window floating-tile layer isn't a substitute for a native OS
window the user can fling to a specific monitor.

What's already in place:

- WebSocket origin carries a zero-indexed window slot: `web-0`,
  `web-1`, … The default window is always `-0`; future pop-outs will
  pass `?window=N` in the URL and claim their own slot. See
  `_resolveWindowIndex()` in
  [web/src/app.js](../web/src/app.js). Exposed on
  `window.__foyer.windowIndex` so any future UI that wants to show the
  current window number can read it.
- The sidecar is already shim-aware (per-pid advertisement files, see
  [DECISIONS.md #13](DECISIONS.md)) so attaching multiple browser
  windows to the same sidecar is already supported on the backend.
  Each window gets its own WebSocket connection; the sidecar doesn't
  need any code change to fan control updates out to all connected
  clients.

What's missing:

- **Pop-out affordance**: a window-manager menu entry or `Ctrl+Alt+N`
  chord that opens a new browser window at `?window=N` (next free
  slot). The current Foyer shell (`foyer-app`) needs to notice the
  `?window=` param at load time and render WITHOUT duplicating global
  chrome — e.g. a pop-out window probably shouldn't render its own
  transport bar if `window.opener` is a primary Foyer window.
- **UI-state fan-out across windows**: tile layout, docked FABs, and
  window-list are persisted in `localStorage` today. Multi-window
  needs either (a) a `BroadcastChannel("foyer")` fan-out so
  `localStorage` writes replicate live, or (b) a small SharedWorker
  that owns the layout store and both windows subscribe. Option (a)
  is less code; option (b) is cleaner if we also want to avoid
  duplicated WS traffic (each window currently opens its own
  connection).
- **Window discovery on the sidecar side**: knowing which
  `web-<N>` origins are currently connected lets the backend route
  per-window preferences (e.g. "window 1 wants MeterBatch updates,
  window 0 does not because it's not rendering the mixer"). Not
  required for MVP, but unblocks bandwidth wins later.
- **Screen-aware window placement**: `navigator.windowControlsOverlay`
  + `window.getScreenDetails()` (see existing probe in
  [web/src/screens.js](../web/src/screens.js)) let the pop-out code
  pick which monitor a new window opens on. The slot picker will want
  to respect screen geometry — a "send to monitor 2" chord is probably
  the main user ask.
- **Focus / z-index coordination**: when one window raises a floating
  tile, the other window shouldn't. The `BroadcastChannel` approach
  above gives us the substrate for "I am focused" / "you take over"
  handoffs.

Design decision still open: whether the native wrapper
(`foyer-desktop`, wry/tao) opens pop-outs as native OS windows (with
chrome) or chromeless frames that imitate the in-app window shell.
Probably chromeless for parity, but that adds window-drag
re-implementation on the native side.

## Multi-session management

- **Status:** pending
- **Owner:** unassigned

Make it trivial to run multiple DAW sessions side-by-side without
manual socket-path juggling. The shim side is already partway there
(see [DECISIONS.md #13](DECISIONS.md) — per-pid default socket paths +
`$XDG_RUNTIME_DIR/foyer/ardour-<pid>.json` advertisement files). The
sidecar-side CLI learns `--list-shims` and auto-picks when unambiguous.

What's still missing:

- **Sidecar UI / right-dock panel that lists live shims** with session
  name, pid, started-at timestamp. Click one to swap the active
  session in-place (re-subscribe, fresh snapshot) without restarting
  the sidecar.
- **Session switcher command palette entry** so `Ctrl+K → "switch
  session"` works.
- **Shim registry event stream** — when a new shim comes up, running
  sidecars should be able to notice without polling the directory. An
  `inotify`/`FSEventStream`/`ReadDirectoryChangesW` watcher on the
  advertisement dir is one option; cleaner would be a small
  `foyer-registry` daemon that shims and sidecars both report to.
- **Cross-session commands** for a power user running two sessions:
  "copy this track's plugin chain from session A to session B",
  "A/B the same mix under two different sessions side-by-side" are
  the obvious ones.

## Auth gateway for remote DAW collaboration

- **Status:** sketched — see [PROPOSAL-auth-gateway.md](PROPOSAL-auth-gateway.md)
- **Owner:** unassigned

A central gateway that authenticates clients and routes them to one of
several DAW hosts. Studio-engineer use case: producer at home connects
to the studio DAW over the public internet without the engineer
needing to port-forward or hand out credentials directly. The gateway
URL is configurable (env var / CLI flag / config file) and defaults to
`foyer.local` in dev.

## MessagePack hot path on WebSocket

- **Status:** deferred
- **Owner:** unassigned

Server emits binary frames (MsgPack-encoded) for `ControlUpdate` and
`MeterBatch`. JSON stays on the wire for snapshots, errors, and slow-
path control. `rmp-serde` is already a dep on the server; the
browser-side decoder is a ~150-line handwritten module per the
no-Node rule. Biggest bandwidth win is `MeterBatch` at 30 Hz — the
JSON encoding blows up to ~3× the raw payload size.

## User-configurable drop zones (Rectangle-inspired)

- **Status:** deferred
- **Owner:** unassigned

The current drop-zone overlay ships with hard-coded slots (thirds,
halves, quadrants, fullscreen). Rich wants the user to be able to
edit the available zones — "maybe 75% of the free Rectangle." The
data model (`SLOT_PRESETS` in [web/src/layout/slots.js](../web/src/layout/slots.js))
is already a list of `{ id, label, bounds(vw,vh,pad) }` so user-
authored entries slot in without engine changes. What's missing is
the editor UI, storage, and per-slot keybind capture (layout-bindings
already supports arbitrary `{kind, name}` routing).

## Preset drag-to-reorder in the layout FAB

- **Status:** deferred
- **Owner:** unassigned

Currently presets have a canonical order (see PRESET_ORDER in
[layout-fab.js](../web/src/components/layout-fab.js)) and the user
can only hide/show them via right-click. Dragging a row up or down
to reorder would be nice to have. Same for saved layouts.

## Agent panel: rail-expand polish

- **Status:** deferred
- **Owner:** unassigned

When the agent is docked to the right rail, the sidebar should
expand to fit the agent's preferred width (~380px) instead of the
agent's floating panel anchoring OVER whatever else is in the
right-dock. Patapsco's implementation stashes the pre-dock sidebar
width and restores on undock — we should mirror that.

## Canvas-first timeline + mixer rendering

- **Status:** deferred (queued in HANDOFF.md)
- **Owner:** unassigned

One `<canvas>` per tile, paint lanes + regions + waveforms + playhead
in a single RAF pass. DOM hit-test layer on top. Biggest immediate
win is eliminating waveform canvas resize drift.

## Ardour shim: plugin parameter signal hookups

- **Status:** partially done
- **Owner:** unassigned

The shim emits plugin params in the session snapshot and routes
inbound `ControlSet` for `plugin.<pi-id>.param.<n>` and `.bypass`
(see [DECISIONS.md #??] and [HANDOFF.md](HANDOFF.md)). The remaining
piece is subscribing to `Plugin::ParameterChangedExternally` and the
`PluginInsert::ActiveChanged` signal so outbound `ControlUpdate`
events fire when Ardour's own GUI moves a plugin param.

## Upstream Ardour contributions

- **Status:** drafted
- **Owner:** rich

The `foyer-studio-integration` branch on
`hotspoons/zzz-forks-ardour` holds two patches (wscript
auto-discovery + `ARDOUR_BACKEND` env var). The full upstream
rationale lives in [PROPOSAL-surface-auto-discovery.md](PROPOSAL-surface-auto-discovery.md).
Submitting these upstream is a low-priority ask — Foyer is fine on
the fork indefinitely.

## WebRTC audio forwarding (M6 in PLAN.md)

- **Status:** not started
- **Owner:** unassigned

Schema types exist (`AudioFormat`, `AudioSource`, `LatencyReport`,
`AudioEgressOffer`, etc.). Runtime doesn't. First milestone: stub
backend can emit a sine wave as an Opus-encoded WebRTC track to a
connected browser. Second: ingress from the browser's
`getUserMedia()` back to the shim. Third: latency calibration +
lock.

## MCP agent wiring (M8 in PLAN.md)

- **Status:** panel exists; no round-trip
- **Owner:** unassigned

The agent panel + settings modal exist and persist user config. What
doesn't exist is the actual MCP round-trip: tool registration, model
calls, tool-use loop, streaming response rendering. Rich's WebLLM +
external-OpenAI-compatible config is pre-wired; once the runtime
lands, switching between them should be a config toggle.
