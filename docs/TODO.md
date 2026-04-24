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

## Browser-triggered DAW launch + live backend swap

- **Status:** core path landed; UX polish pending
- **Owner:** unassigned

End-to-end flow now works: boot `foyer serve` (stub-first), open the
session picker, click a project, sidecar spawns the configured DAW,
waits for shim advertisement, and atomically swaps its backend. The
WebSocket never drops — clients re-snapshot from the new backend.

- [foyer-server](../crates/foyer-server/src/lib.rs) holds
  `RwLock<Arc<dyn Backend>>` + `Mutex<Option<JoinHandle>>` for the
  event pump. `AppState::swap_backend` aborts the old pump, spawns a
  new one, drops the cached snapshot, and broadcasts
  `Event::BackendSwapped`.
- `BackendSpawner` trait exposed from foyer-server; CLI's
  `CliSpawner` implements it (stub ↦ fresh `StubBackend`, ardour ↦
  spawn exec + wait for advertisement + `HostBackend::connect`).
- Schema additions: `Command::{ListBackends, LaunchProject}` +
  `Event::{BackendsListed, BackendSwapped}`.
- Browser [session-view](../web/src/components/session-view.js)
  issues `launch_project` on click, prefers `kind: ardour` backends
  for `.ardour` paths, surfaces `launch_failed` errors inline, and
  re-requests a snapshot on `backend_swapped`.
- `StubBackend` now tracks its meter-tick task handle and aborts
  it in `Drop` so repeated swaps don't leak timers.

Still to do (nice-to-haves, not blockers):

- **Backend picker UI**: `BackendsListed` is already cached in the
  session view; wire up an explicit "Open with: [Ardour ▾] / [Dummy]"
  dropdown instead of the path-based inference.
- **Recent projects**: `foyer-config.launcher.recent` is defined but
  unused. Surface it above the file browser, and have
  `CliSpawner::launch` `Config::record_recent + save` on success.
- **Launcher-only start**: a fresh install boots into stub-with-picker,
  which works but requires the user to notice that the session view
  is the launcher. A dedicated "pick a DAW" splash before any tile
  content renders would be more obvious.
- **More DAWs**: `BackendKind` currently has `Stub | Ardour`. Adding
  Reaper / Bitwig / Pro Tools etc. is trivial at the config layer but
  gated on a shim for each one.

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



---

## Rich notes:

Progress key: ✅ landed · 🚧 scaffolded · 📋 queued.

- ✅ MIDI track view + piano roll — `<foyer-midi-editor>` component
  ([midi-editor.js](../web/src/components/midi-editor.js)); opens
  from the region context menu on any MIDI region; shim emits
  notes inline on the regions_list envelope via `MidiModel::notes()`
  ([schema_map.cc](../shims/ardour/src/schema_map.cc) `describe_region`).
  Dockable tile variant still TODO; note edits (drag, velocity scrub)
  TODO.

- ✅ Agent + Layouts FABs appear in the right-panel slide-out when
  docked — wired via `dockPanelContent()` on QuadrantFab /
  AgentPanel; right-dock calls into it from `_renderPanel`.

- ✅ Track editor UI (rename, color, comment, embedded mixer strip) —
  right-click track label in mixer or timeline-lane head opens
  [track-editor-modal.js](../web/src/components/track-editor-modal.js).
  Bus / group / send controls TODO (separate bullet below).

- 📋 busses and groups — schema doesn't carry them yet. Needs:
  `Session.groups: Vec<Group>`, `Track.group_id: Option<EntityId>`,
  `Track.sends: Vec<Send>`, shim population from `RouteGroup` +
  `Send`, mixer UI (collapsible group rows + send strips under
  the fader). Track editor modal will surface the binding once
  the schema lands.

- ✅ Unsaved-session chip in status bar — shim wires
  `Session::DirtyChanged`, emits `SessionDirtyChanged { dirty }`,
  [status-bar.js](../web/src/components/status-bar.js)
  (_renderSessionDirty) shows a dot + "Unsaved" label.

- ✅ add undo and redo (ctrl/cmd z/ ctrl/cmd + shift z) capability with buttons — keyboard chords wired in [keybinds.js](../web/src/layout/keybinds.js); they fire `edit.undo` / `edit.redo` which the host's action catalog handles. Dedicated Undo / Redo / Save buttons on the transport bar as of 2026-04-21 ([transport-bar.js](../web/src/components/transport-bar.js)); Save button lights up when `session.dirty`.

- ✅ add cut/copy/paste actions — Ctrl/Cmd+X/C/V bound in keybinds.js, fire `edit.cut/copy/paste`. Native editing in input fields is preserved (handler bails when focus is on an input/textarea).

- ✅ add 'console' window that can show the stderr/out of ardour plus any internal console it exposes — new `<foyer-console-view>` tile ([console-view.js](../web/src/components/console-view.js)) polls a new `GET /console?since=<offset>` endpoint on the sidecar, auto-scrolls, error/warn colorization. Reachable via the Launch menu → Console or the `console` view id in any preset/split.

- ✅ add detection to see if the client is connecting from the local machine or a remote machine via IP address probably — server now uses `ConnectInfo<SocketAddr>`, emits `Event::ClientGreeting { remote_addr, is_local, server_host }` on connect. Status bar renders a "LOCAL" / "REMOTE" chip. Loopback / link-local / private IPs count as local.

- 🚧 add "share session connection" or something button that will generate a QR code with the local machine's IP address — half-done: we now know whether the client is local + the server's hostname. A FAB or status-bar button to generate a QR needs a vendored encoder (~2–5 KB of JS). Pair with `ClientGreeting.server_host` + `listen` port to build `http://<host>:<port>/?window=N`. Gateway-mode session tokens deferred to the auth-gateway TODO entry above.
---

## Diagnosis: shim-not-found bug (resolved 2026-04-19)

Symptom: "timed out waiting for shim advertisement" after every launch,
even though `libfoyer_shim.so` was built and `<Protocol name="Foyer
Studio Shim" active="1"/>` was patched into the session file.

Root cause: `shell_escape()` wraps paths in single quotes (so they're
safe as standalone args: `VAR='...'`). When the result got interpolated
inside a DOUBLE-quoted bash assignment, the single quotes became
literal characters — `ARDOUR_SURFACES_PATH="'/workspaces/…/foyer_shim':…"`.
Ardour looked for a directory named `'/workspaces/…/foyer_shim'`
(literal quotes in the pathname), didn't find it, and skipped
registration. Session-file loader then couldn't resolve the protocol.

Fix in [foyer-cli/src/main.rs](../crates/foyer-cli/src/main.rs): assign
shell-escaped paths to intermediate bash variables first, then expand
the variable (which IS safe inside double quotes).

Invariant for future edits: values coming out of `shell_escape()` are
only safe as STANDALONE arguments. If you need to stick one inside a
compound double-quoted string, land it in a var first.

## Rich new notes/TODOs:

 - Is it possible to package the shim as a totally stand-alone .so? Like is there a core plugin architecture in Ardour that will scan for core extensions? If possible I'd love to see if we can make this work with no core changes, but it may just not be possible.

 - Forwarding audio to/from Ardour via Foyer with resampling as necessary (client will have to tell what st)
---

## Session-two landings (2026-04-19 autonomous run)

- ✅ **Action menu empty after backend swap** — root cause: `Backend::list_actions` trait default returned `Vec::new()`. Moved the canonical DAW catalog into [foyer-backend/src/actions.rs](../crates/foyer-backend/src/actions.rs) as `default_daw_actions()` and made it the new default. Host backend now serves the full menu (Session / Edit / Transport / Track / Plugin / View / Settings) without needing shim changes. Shims can override to add DAW-specific verbs.

- ✅ **Waveform no-op default** — `Backend::load_waveform` default was `Err("not supported")`. Changed to return `WaveformPeaks { peaks: [], bucket_count: 0, … }`. Clients render regions as flat blocks instead of erroring. Stub still generates fixture peaks; host returns empty until shim support lands.

- ✅ **Errors-on-startup dismissable modal** — [startup-errors.js](../web/src/components/startup-errors.js). Subscribes to WS envelopes, collects `error` events during a capture window around connect and each `backend_swapped` event, shows a single dismissable banner with all of them. Re-arms on next swap.

## Waveform peaks for real Ardour sessions (open)

Schema + sidecar tier cache + client cache are already in place. The missing
link is having the shim produce real peak data for Ardour sessions. Two
viable paths:

1. **Read Ardour's `.peak` files** from `<session>/peaks/<region>-peak`.
   Known binary format (32-bit min + 32-bit max per bucket), present once
   the session's been saved. Zero-copy cheap — just open, seek, decimate.
2. **Decode the source audio** via `symphonia` (pure-Rust, multi-format).
   Works even for freshly-imported clips that haven't been peak'd yet.
   Pay a one-time scan cost per region; cache to disk.

Either way the sidecar's existing tier logic
([backend-stub/src/waveform.rs](../crates/foyer-backend-stub/src/waveform.rs))
handles the mipmap math — it picks the nearest `samples_per_peak` ∈
{16, 64, 256, 1024, 4096, 16384, 65536} so one cache line serves every
zoom level. The client already requests at specific tiers and the
sidecar rounds; no additional protocol work required.


## Rich new notes 

 - ✅ Zoom-to-selection w/ backstack, fade/delete/mute across
   time-range × tracks, multi-track selection — all landed. See
   [timeline-view.js](../web/src/components/timeline-view.js)
   `zoomToSelection` / `zoomPrevious` / `deleteSelection` /
   `muteSelection`.

- ✅ Master mix strip pinned to the right of the mixer with
   its own gutter — [mixer.js](../web/src/components/mixer.js)
   splits inputs into a horizontally-scrolling column and master-
   like strips (master + monitor) into a fixed right column.

- ✅ Waveforms — fully vector now. Canvas2D port of Ardour's
   `WaveView::draw_image` connected-line algorithm
   ([waveform-gl.js](../web/src/viz/waveform-gl.js), cites source
   inline), viewport-cropped canvas (only paints the visible
   slice), 1-pixel lines with column-by-column decision logic.
   Sharp at any zoom.

## New 2026-04-21 surface (things that fell out this session)

 - Dockable MIDI tile — today the piano roll only opens as a modal
   from the region context menu. Registering `midi` as a first-class
   view in the tile tree so it can live in a permanent dock slot is
   ~50 LOC (tile-leaf, layout-store, tile-tree view registry).

 - MIDI note edits — add `Command::UpdateMidiNote { id, patch }`
   (`MidiNotePatch` already exists in schema). Shim side: acquire
   the MidiModel write lock, apply the patch, emit `region_updated`
   so other clients reconcile. UI side: drag-to-move, drag-edges to
   resize, velocity-drag, delete.

 - "Clear peak cache" button on the timeline ribbon is wired;
   consider also adding a "rescan region source" shortcut to force
   symphonia to re-decode the file if the user edits it externally.

 - Export toast says "use Ardour's native dialog for now"; wire
   `session.export` to a real exporter when ready. Ardour's
   `Session::export_to_file` is the target API but needs a format
   + range selector modal.

 - Waveform renderer resamples peaks on every scroll event. At
   100+ visible regions this gets non-trivial. rAF-debounce the
   scroll handler inside waveform-gl.js.

 - Errored plugin row detection is string-match ("does this error
   message mention our track id"). That's brittle. The sidecar
   should broadcast `Event::PluginError { track_id, plugin_uri,
   reason }` instead.

 - `session.save_as` prompts for a filename but there's no file
   browser — advanced users can type a full path, everyone else
   types just a filename and it lands next to the current session.
   Proper folder picker integrated with the existing session-view
   jail browser would be nicer.

 - Bus / group plumbing (big — see "busses and groups" bullet
   above).

 - Session-opens-rolling regression — log shows no `ControlSet
   recv` before transport transitions, so it's not UI-initiated.
   Needs live trace.


--- 

## High level longer-term goals
- Pluggable UIs - so we can have a phone UI that gives phone-optimized controls for transport, track arming, etc. - the kind of shit you'd need if you were engineering yourself as a musician, having your phone as a remote control for the high-level DAW functions is so slick (without the full DAW UI, you maybe need a mixer and play/record/seek/etc. functionality, but not timeline view or plugin management) - and for tablets and touch PCs, full functionality with touch-first interfaces. Also having a kids version that makes a lot of flexibility sacrifices for ease of use would be great! And intermediate version that makes Ardour more like Audacity for example (but don't copy, that UI is awful, it is simpler tho). Would also love to have an easy to use system for end users to develop and plug in their own UIs for specific purposes. So if we ensure the core UI library is truly framework agnostic outside of lit and we handle all of the hard stuff like mapping websocket messages to events both ways, then offer a sane API that can be plugged in from react or any framework, I think it would make this a killer UX.
- Multi-window setup with window position memory. We did this at USPTO, and I think the windows communicated through browser storage but there were some race conditions. This time we'd have everything hooked to websockets remotely so I think it would actually be easier, we just need to expand the window management to cover multimonitor setups and send stuff to remote windows
- Audio conferencing between all connected users - since we'll have WebRTC already wired in for the audio projection, let's put in a simple push-to-talk walkie-talkie-style (with keep-on checkbox for regular conferencing) conferencing function that will output audio to all connected parties. Imagine a band with geographically dispersed members and they want to talk to each other while collaborating on a project for a record - how cool would it be if they could just fucking talk into their computers like they were all at the same console?
- Setup-in-a-bottle - look at packaging the DAW's full setup in an OverlayFS (e.g. container) with snapshotting (e.g. docker commit) so a full session's computing environment can be saved off and committed. Create a meta-wrapper around this that associates the audio session with the computing snapshot via Ardour field extensions, and make a simple program that automates creating computing snapshots; creating audio session + home folder snapshots; and loading and saving these as separate entities using an OCI registry probably. Having the computing environment available and bound to a session's metadata will make it fully reproducable, and by decoupling the project from the compute environment the compute environment can be easily shared. Add an option to package all-in-one for full portability. Licensed plugins are a real issue, anything requiring a runtime license will need to be externalized