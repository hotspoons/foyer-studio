# Handoff — Foyer Studio (next Claude picks up here)

Context is tight. Read this top-to-bottom, then skim
[docs/DECISIONS.md](DECISIONS.md) and [docs/TODO.md](TODO.md).
Memory at `~/.claude/projects/-workspaces-foyer-studio/memory/`
covers Rich's preferences — read it and don't re-ask. Rules that
still apply:

- **No Node tooling.** No `node`/`npm`/bundlers/linters. Browser is the
  only JS runtime. Vendor ESM under `web/vendor/` if you must.
  Tailwind uses the standalone binary at `.bin/tailwindcss`.
- **Layer-scoped licensing.** `shims/ardour/` is GPLv2+ because it
  links `libardour` — standard Ardour-ecosystem practice. The Rust
  sidecar and web UI are licensed separately and sit above a
  documented IPC boundary, so they're not derivative of any one shim.
  Future shims (Reaper, JUCE hosts) each carry their own terms.
- **Ship-first, then log.** When a design tradeoff appears, pick the
  first sensible option and append an ADR entry in DECISIONS.md —
  don't stop to ask.
- **Speech-to-text artifacts:** "our door" = Ardour.

## 2026-04-21 afternoon (most recent)

Rich woke up thrilled with the morning push, then asked for three
specific pieces of work before going back to bed:

1. **Instrument the auto-play-on-open regression.** daw.log now
   carries a full config dump at subscribe time (`[DIAG]`) plus a
   `**STARTED**`-tagged log + C-stack backtrace on every
   `Stopped → Rolling` edge (`[DIAG-STARTED]`). The backtrace we
   caught shows the signal arrives via `AbstractUI::handle_ui_requests`
   → our `on_transport_state_changed`, which confirms the state
   change was emitted from *inside* Ardour (not from anything the
   shim did). Config values ruled out: `auto_play=0`,
   `auto_return=0`, `external_sync=0`, `synced_to_engine=0`,
   `master_is_external=0`. Root cause unknown — parked with a
   band-aid: after `subscribe_all` runs, a `call_slot` checks for
   `transport_state_rolling()` and calls `transport_stop()` if true.
   Disable via `FOYER_ALLOW_AUTO_ROLL=1` if it ever fires a false
   positive.

2. **Out-of-tree CMake build for the shim.** Rich explicitly wants
   to ship Foyer without redistributing a modified Ardour binary —
   honors Paul Davis's demo-timer commercial model and keeps the
   GPL blast radius to a single `.so`. New
   [shims/ardour/CMakeLists.txt](../shims/ardour/CMakeLists.txt)
   builds against a sibling Ardour source tree (configurable via
   `-DFOYER_ARDOUR_SOURCE=…` or `$FOYER_ARDOUR_BUILD_ROOT`) with no
   edits to any file in Ardour's tree. Output: plain
   `libfoyer_shim.so` that Ardour picks up from
   `ARDOUR_SURFACES_PATH` exactly like Mackie / OSC / GenericMIDI.
   New Justfile recipes: `shim-cmake-build`, `shim-install` (copies
   into `~/.config/ardour9/surfaces/`). Confirmed: the built `.so`
   exports `protocol_descriptor` and links successfully against
   Ardour 9.2's shared libraries. When Ardour ships
   `ardour-surface.pc` upstream (see
   [docs/PROPOSAL-surface-auto-discovery.md](PROPOSAL-surface-auto-discovery.md))
   this switches to `find_package(Ardour)` and drops the source-tree
   assumption entirely.

3. **M6a — shim RT master-bus audio tap.** Previously the "Listen"
   button played a sidecar test-tone since the shim exposed no real
   audio. Now:
   - [shims/ardour/src/master_tap.cc](../shims/ardour/src/master_tap.cc)
     implements `ARDOUR::Processor`-subclass `MasterTap`. The
     audio-thread `run()` copies master-bus samples into a
     `PBD::RingBuffer<float>` sized for ~200 ms — no allocations,
     no locks, no logging. A non-RT drain thread wakes on condvar
     every ~10 ms, reads whatever's in the ring, packs
     `[stream_id u32 LE][f32 LE PCM]` and sends it via `FrameKind::Audio`.
   - Shim dispatch decodes `audio_stream_open` /
     `audio_egress_start` (both spellings honored), calls
     `master->add_processor(tap, PostFader, …)` on the event loop,
     spins the drain thread, and emits `Event::AudioEgressStarted`
     so the HostBackend's oneshot resolves.
   - Sidecar `ws.rs` flipped: `AudioStreamOpen` now calls
     `backend().open_egress(...)` first — succeeds against the
     host backend (real audio), falls back to `spawn_test_tone_source`
     if the backend can't produce audio (stub or error). So the
     "Listen" button keeps working against stub AND plays real
     master-bus audio against Ardour.
   - Backend trait gains a default `close_egress` method; host
     backend overrides to send `AudioEgressStop`.
   - Only `source=master` is wired today; per-track taps land
     alongside the track preview feature.

### Follow-ups this push created

- M6b ingress (browser → DAW) still uses the trait default. That's
  next once someone has a use case to exercise it.
- Per-track audio taps — same Processor pattern, just needs the
  dispatch handler to find the target track from
  `source = Track(id)` and `add_processor` there.
- `FOYER_ALLOW_AUTO_ROLL=1` is an escape hatch; would be nice to
  pin the actual cause of the spurious `Stopped → Rolling`
  transition. Candidates: `merge_event(TransportMasterStart)` from
  some transport-master-init path, or session-state restore doing
  `request_transport_speed(1.0)` on load.

## 2026-04-21 overnight push (most recent)

Second autonomous push — user's feedback after the previous one was
*"It is finally starting to feel like a $2000 DAW console."* Scope
was polish-plus-MIDI. Uncommitted changes on disk; review before
merging.

### UX polish that accumulated

- **Vector waveform renderer** replaces the texture-sampled shader.
  Three iterations landed in one session: (1) WebGL2 quad + RG32F
  texture with LINEAR fallback to NEAREST + OES_texture_float_linear
  probe, (2) WebGL2 triangle-strip vertex geometry, (3) Canvas2D
  port of Ardour's `WaveView::draw_image` connected-line algorithm
  (cite at [waveform-gl.js](../web/src/viz/waveform-gl.js) file
  header). Final form: every pixel column is a 1-pixel line drawn
  either as a vertical `top→bot` bar (overlapping ranges) or a
  diagonal connector to the next column (smoothly rising/falling
  signal). Sharp at any zoom, continuous, no raster stretch.
- **Viewport cropping** for extreme zoom. At 4000 px/s a 30 s
  region is 120k CSS px wide — past every browser's canvas cap.
  The viz component now listens to its scroll parent and resizes
  its own canvas to the visible slice, positioned via absolute CSS
  `left` + `width`. Backing store stays under 8 k pixels.
- **Click-to-raise** on plugin-layer windows (was only wired on
  floating-tiles). Document-capture pointerdown mirrors what
  floating-tiles does so clicks deep inside a plugin UI still raise
  the window.
- **Paired-edge resize.** Two floating tiles whose opposite edges
  touch (within 8 px) become a draggable splitter — resizing one
  shrinks the other in lockstep. Alt bypasses.
- **Modal scrim theming** — every modal scrim is now `rgba(0, 0, 0,
  0.55)` so opening a modal darkens the dark theme instead of
  tinting it toward navy.
- **Region name ellipsis** — long take names no longer spill past
  the region's right edge and can't visually poke into adjacent
  track header strips.
- **Shim stability** — `ctrl->set_value()` now runs on the event
  loop, not the IPC reader thread. Was crashing the shim after a
  few rapid mute/solo clicks (PBD's per-thread pool FATAL).

### Feature work

- **Plugin picker modal** — real flow now. + slot on the plugin
  strip opens a searchable filter-by-format/role catalog that
  fires `add_plugin` with the track id and URI.
- **Errored plugin row** — `add_plugin_failed` / `remove_plugin_failed`
  events show as a dismissible row at the top of the plugin strip;
  dismissals persist in `localStorage`.
- **Plugin parameter live updates** — shim now subscribes to every
  PluginInsert's automation controls + `ActiveChanged` so tweaks
  in Ardour's native GUI round-trip back to the browser.
- **Track editor modal** — right-click a lane head (timeline) or
  strip name (mixer) → full-depth editor with name / color /
  comment / embedded mixer strip.
- **MIDI piano roll** — `<foyer-midi-editor>` component with piano
  keyboard + notes-as-rectangles, velocity as alpha. Opens via
  region context menu on MIDI regions.
- **Shim MIDI note emission** — `encode_regions_list` iterates
  `MidiModel::notes()` for any `MidiRegion` and inlines them on
  the regions_list envelope. Ticks come from
  `Temporal::Beats::to_ticks()`.
- **Transport edit cluster** — undo/redo/save buttons on the
  transport bar, save button lights up when `session.dirty` is
  true. Keyboard chords were already bound; buttons round it out.
- **Session save-as** — new action `session.save_as` intercepted
  client-side to prompt for a path, sends `Command::SaveSession
  { as_path }` that the shim now decodes → `save_state(path)`.
  HostBackend's `save_session` forwards the command.
- **`plugin.rescan`** wired to `PluginManager::refresh()`.
- **Preferences modal** (`settings.preferences`) — transport mode,
  waveform style, palette. Previously was a dead menu entry.
- **Layouts + Agents FABs** — when docked to the right rail they
  render their content inline in the slide-out dock panel, same
  pattern as Actions / Session / Windows.

### Deferred / noted blockers

- **Shim RT audio tap (M6a)** — Ardour's session header has no
  `attach_Process` signal. Legit options are (a) subclass
  `Processor` and insert on the master route, (b) poll `meter()`
  (not actually audio though), (c) JACK port-connection tap
  (Linux only). Each is ~1 day of real work + testing. The
  sidecar test-tone path still serves the "Listen" button so the
  gap is invisible until a user hovers it.
- **Session-opens-rolling regression** — no `ControlSet recv`
  arrives in daw.log before transport transitions, so it's not a
  UI-initiated play. Needs runtime tracing the next time the user
  reproduces it.
- **Viewport-cropped waveform** still resamples its visible slice
  on every scroll event; cheap in JS but not free. If the
  timeline ever shows 100+ visible regions, rAF-debounce the
  scroll handler.

## 2026-04-20 overnight push

Big session of autonomous work. Uncommitted changes on disk — review
before merging. Summary of what's new since the last handoff:

- **Transport finally works.** Play / Stop / Record / Loop / Locate
  go through BasicUI helpers on the shim's event loop thread
  (`transport_play` / `transport_stop` / `rec_enable_toggle` /
  `loop_toggle`). Root cause of the earlier outage was an empty
  `FoyerShim::do_request` override that silently swallowed every
  `call_slot` post — fixed in [surface.h](../shims/ardour/src/surface.h).
  Playhead animates at 30 Hz via a new ticker thread in
  [signal_bridge.cc](../shims/ardour/src/signal_bridge.cc).
- **Playing-predicate fix.** Was using `transport_rolling()` which
  returns `true` on a freshly-loaded session; switched to
  `transport_state_rolling()` (authoritative FSM state). Record
  button uses `get_record_enabled()` (armed) not `actively_recording()`
  (armed + rolling).
- **3-mode return-on-stop** (Stay / → 0 / ↩ Start) with a front-end
  position lock in [transport-return.js](../web/src/transport-return.js).
  Swallows backend position updates for 600 ms after a user-triggered
  return so the shim's 30 Hz tick doesn't race our locate. Released
  early on explicit user seeks.
- **Track rename + color** end-to-end. Right-click (or double-click)
  a track name in the mixer / timeline; shim calls `Route::set_name` +
  `PresentationInfo::set_color` on the event loop. PresentationInfo /
  Route `PropertyChanged` signals push back so external renames made
  inside Ardour propagate to Foyer.
- **Session dirty chip** ("Unsaved") in the status bar, wired to
  `Session::DirtyChanged`.
- **Action dispatch in shim** — `edit.undo/redo`, `session.save`,
  `track.add_audio/bus`, `transport.goto_start/end` all land on
  `Session::*` methods via `Command::InvokeAction` in
  [dispatch.cc](../shims/ardour/src/dispatch.cc). Cut/copy/paste
  explicitly surfaced as "editor action manager only (headless
  unsupported)" so the toast explains the gap.
- **Multi-track selection** lifted into the Store — click a track
  head / strip to select, Shift-click to extend, Ctrl/Cmd-click to
  toggle. Both mixer strips and timeline lanes render a selected
  state and subscribe to the same `selection` event.
- **Time-range × track-selection ops.** `Edit → Delete Selection`
  and `Edit → Mute / Unmute Selection` (also bound to the Delete
  key) walk all regions overlapping the current time-range on
  selected tracks (or every audio/midi track when none are
  explicitly selected) and fan out per-region commands.
- **Zoom-to-selection** + zoom back-stack. `Ctrl+Shift+E` to zoom
  the current time-range into the viewport; `Ctrl+Shift+Backspace`
  to pop. Menu entries under View.
- **R button in the timeline + mixer track heads** — shim now emits
  `record_arm` for any track with a `rec_enable_control`
  ([msgpack_out.cc](../shims/ardour/src/msgpack_out.cc)).
- **Integration test harness**. `FOYER_DEV=1 just run` mounts
  `GET /dev/run-tests` + `GET /dev/list-tests`. 8 probes exercise
  snapshot / list_actions / set_control / event broadcast /
  list_regions / load_waveform / update_track / transport play+stop.
  All passing against the stub. Matching web view:
  [diagnostics.js](../web/src/components/diagnostics.js); launch via
  the "+ New" menu → Diagnostics or via `curl`.
- **Transport bar redesign** — proper DAW transport row
  (⏮ ⏪ ⏹ ▶/⏸ ⏺ ↻ ⏩ ⏭), solid-filled Heroicons glyphs, color-coded
  per action (record pulses red when armed), 3-mode return-on-stop
  cycler at the end of the row.
- **Master mix strip separation** — master + monitor routes render
  in a pinned right column with a divider + gutter so the main bus
  stays visible even as input strips scroll horizontally.
- **`<foyer-viz>` library** — new `web/src/viz/` directory housing:
  - [`waveform-gl.js`](../web/src/viz/waveform-gl.js) — WebGL2
    fragment-shader waveform renderer with linear-filtered peaks
    (no more stair-step blockiness at high zoom), AA envelope
    edges, per-half clip markers, underrun overlay (wire ready),
    and an "energy glow" effect.
  - [`waveform-shader.js`](../web/src/viz/waveform-shader.js) — the
    shader. Three styles: `mirrored` / `bar` / `ghost`. Clean-room
    Heroicons-derived palette set (aurora / cyan / magma / sunset /
    chlorophyll / graphite).
  - [`viz-settings.js`](../web/src/viz/viz-settings.js) +
    [`viz-picker.js`](../web/src/viz/viz-picker.js) — localStorage
    prefs + a small toolbar popover for style / palette / glow /
    clip-threshold.
  - Canvas 2D fallback path lives in the same component for browsers
    without WebGL2.
- **Sample-detail zoom fix** — tier ladder now includes `[8, 16, 32]`
  and the symphonia decoder's bucket cap is raised to 262 144 so
  short regions decode to ~4 samples/peak.

## 2026-04-20 late-session additions

Beyond what's above, the overnight push also landed:

- **`<foyer-viz>` component library** — [`web/src/viz/`](../web/src/viz/):
  WebGL2 waveform renderer with anti-aliased envelope, per-half clip
  markers, underrun overlay (data source pending), three styles
  (`mirrored` / `bar` / `ghost`), six palettes, runtime settings via
  a small picker chip on the timeline toolbar. Canvas 2D fallback
  path lives in the same component. Replaces the old stair-step
  Canvas peak rendering.
- **M6a audio egress skeleton** — [`crates/foyer-server/src/audio.rs`](../crates/foyer-server/src/audio.rs)
  + [`audio_opus.rs`](../crates/foyer-server/src/audio_opus.rs)
  + [`audio_ws.rs`](../crates/foyer-server/src/audio_ws.rs).
  Audio hub with per-stream Opus encoder, `/ws/audio/:stream_id`
  binary route, `AudioCodec::{Opus, RawF32Le}` switch (lossless
  for gigabit LAN), test-tone source for wire verification, a
  "Listen" button on the mixer's master strip that opens an
  egress and plays through WebCodecs → `AudioContext`. The only
  missing piece is the shim's RT-thread audio tap — see
  [docs/AUDIO_EGRESS.md](AUDIO_EGRESS.md).
- **Plugin lifecycle — AddPlugin / RemovePlugin** — `Route::add_processor`
  / `remove_processor` wired in [dispatch.cc](../shims/ardour/src/dispatch.cc)
  with LV2 → LADSPA → VST3 → Lua fallback on `PluginManager::find_plugin`.
  Host-side trait method added; fire-and-forget from the WS handler,
  shim emits `TrackUpdated` on success.
- **Master strip separation in the mixer** — master + monitor routes
  pinned in a gradient-tinted right rail with gutter + divider so
  they stay visible under horizontal input-strip scroll.
- **Docs pass**: README tone review, new licensing ADR (`DECISIONS.md`
  entry 15) with rationale for why the shim is GPLv2+ and the rest
  sits above the IPC boundary. Stale status table rewritten.

## Still to do

1. **Shim RT audio tap** — hard blocker for real DAW audio through
   the egress path. Needs a process callback attached to
   `Session::attach_Process` or a `Route::output()` port buffer read.
   Must be RT-safe (no allocation, no locking); writes to a ring
   buffer that a non-RT reader drains into the IPC socket as
   `FrameKind::Audio`. Full spec in [docs/AUDIO_EGRESS.md](AUDIO_EGRESS.md)
   "Hard blocker" section. Until this lands, the `Listen` button
   plays the synth test tone; all wire paths above it are verified.
2. **MovePlugin / plugin presets / OpenPluginGui** — schema + ws
   route need completion. `OpenPluginGui` will probably be a no-op
   on headless hardour and shim-visible only with the GUI binary.
3. **Region fade-in / fade-out / trim-to-selection** — new
   `RegionPatch` fields (`fade_in_samples`, `fade_out_samples`,
   `fade_in_shape`) + shim wiring to `AudioRegion::set_fade_in_length`.
4. **Standalone `.so` shim** — CMake port so upstream Ardour can
   load `libfoyer_shim.so` without linking it into the fork tree.
5. **AudioWorklet jitter buffer** for the browser side. Current
   listener schedules directly against `AudioContext` — fine for
   the continuous test tone, likely glitchy on real session audio
   that has natural gaps.
6. **Group / send routing** — schema done, shim side not populated.
7. **MIDI region notes + piano roll** — schema done; wire piano
   roll component + shim region-notes emission.
8. **WebRTC transport variant** — schema reserves it; plain WS is
   enough for M6a.

Everything above compiles clean + the dev test harness (`FOYER_DEV=1
just run` → `curl /dev/run-tests`) reports **9/9 green** against the
stub backend as of this handoff. Browser-side untouched where it
didn't need to change (Lit components, layout, keybinds, store);
everything in [web/src/viz/](../web/src/viz/) is new.

## 2026-04-19 update — real regions + peaks landed

## 2026-04-19 update — real regions + peaks landed

The three deferred items from the original handoff (regions in the
shim, `update_region` / `delete_region` dispatch, symphonia peak
decoder) are all done:

- Shim now emits real regions (per-track playlist walk) in response
  to `Command::ListRegions`, along with `RegionAdded` / `RegionRemoved`
  signals subscribed per playlist → `Event::RegionsList` /
  `Event::RegionRemoved`. See
  [shims/ardour/src/schema_map.cc](../shims/ardour/src/schema_map.cc)
  (`enumerate_regions` + `find_region`),
  [shims/ardour/src/msgpack_out.cc](../shims/ardour/src/msgpack_out.cc)
  (`encode_regions_list` / `encode_region_updated` / `encode_region_removed`),
  [shims/ardour/src/dispatch.cc](../shims/ardour/src/dispatch.cc)
  (new `Kind::{ListRegions, UpdateRegion, DeleteRegion}`),
  [shims/ardour/src/signal_bridge.cc](../shims/ardour/src/signal_bridge.cc)
  (`subscribe_playlist_for_route`).
- Host backend proxies `list_regions` / `update_region` /
  `delete_region` to the shim (no more stopgap demo regions) and
  caches regions client-side so `load_waveform` can look up
  `source_path` + `source_offset_samples`. See
  [foyer-backend-host/src/client.rs](../crates/foyer-backend-host/src/client.rs)
  (`pending_regions` / `pending_update_region` / `pending_delete_region`
  + `regions_cache`) and
  [foyer-backend-host/src/lib.rs](../crates/foyer-backend-host/src/lib.rs).
- Symphonia-backed peak decoder in
  [foyer-backend-host/src/waveform.rs](../crates/foyer-backend-host/src/waveform.rs)
  — mono downmix, min/max per bucket, capped at 8192 buckets, EOF-safe.
  Falls back to `synth_waveform` when no `source_path` is known or
  the decode fails.

What's still open from this group: the region cache is per-connection
(lives in `HostClient`), so if the shim swaps backends we lose peaks
until the client re-calls `list_regions`. That's fine — the frontend
does exactly that on `backend_swapped`.

## Current state — what works end-to-end (2026-04-19)

1. `just run` starts the sidecar with the config-default backend
   (currently `ardour`; stub is a fallback). On a fresh box the config
   is auto-seeded at `$XDG_DATA_HOME/foyer/config.yaml` with sensible
   defaults including an auto-detected Ardour binary path (falls back
   to `/workspaces/ardour/build/` dev tree; picks the headless
   `hardour` binary when `$DISPLAY` is empty — full detection in
   [foyer-config/src/lib.rs](../crates/foyer-config/src/lib.rs)).
2. Browser connects, picker shows `LOCAL` / `REMOTE` chip + a Share
   button (QR code over LAN, [share-modal.js](../web/src/components/share-modal.js)).
3. Project picker at the top-left — `Session → Open Session` —
   launches a modal ([project-picker-modal.js](../web/src/components/project-picker-modal.js))
   with an "Open" / "New" mode. Clicking a session folder fires
   `launch_project`. Sidecar spawns `hardour` with the ardev env
   sourced, patches the `.ardour` XML to activate the Foyer Studio
   Shim (inserts `<Protocol name="Foyer Studio Shim" active="1"/>`
   before `</ControlProtocols>`), bootstraps a new session via
   `ardour<N>-new_empty_session` if the file doesn't exist yet.
4. Shim advertises at `/tmp/foyer/ardour-<pid>.{sock,json}` in ~0.7s;
   `HostBackend::connect` attaches; `Server::swap_backend` atomically
   replaces the in-process backend. WS stays open — all clients
   re-snapshot automatically.
5. Menu bar populates (Session / Edit / Transport / Track / Plugin /
   View / Settings) from the canonical catalog in
   [foyer-backend/src/actions.rs](../crates/foyer-backend/src/actions.rs).
   Transport verbs (play/stop/record/loop/goto_start) work headless
   because the trait default translates them to `set_control` calls.
6. Startup-errors modal ([startup-errors.js](../web/src/components/startup-errors.js))
   surfaces any errors (missing plugins, shim complaints) in a single
   dismissable banner — no more log-scraping to find them.
7. Console view ([console-view.js](../web/src/components/console-view.js))
   tails `$XDG_STATE_HOME/foyer/daw.log` (where the spawner redirects
   DAW stdout/stderr) via a new `GET /console?since=<offset>` endpoint.
   Auto-scrolls, classes `[ERROR]` / `[WARNING]` lines.

## Rich's new notes — focus areas for the next turn

Pulled from [docs/TODO.md lines 274–329](TODO.md):

### Immediate UI gaps (📋 queued)

- **MIDI track view + piano roll editor** — modal + optionally
  dockable. Big feature, needs backend event support for MIDI notes
  (not in schema yet).
- **Agent / Layouts as right-panel slideouts when docked** — today
  those FABs open floating panels regardless of dock state; should
  switch rendering when the FAB is docked into the right rail.
- **Track editor on right-click** — name / color / bus / group, plus
  a compact mixer strip reachable from the timeline. Modal or overlay,
  not a full window. Needs new `Command::UpdateTrack { id, patch }`
  in the schema + shim wiring for rename / color / enable.
- **Busses + groups** — mixer already shows a `Reverb` bus from
  fixtures; real bus routing + group edits are missing. Schema already
  has `Bus` / `Send` in [foyer-schema/src/session.rs](../crates/foyer-schema/src/session.rs);
  shim side needs to populate + respond to mutation commands.
- **Unsaved-session-changes indicator** — blocked on shim
  `Session::DirtyChanged` emit. Stub can fake it meanwhile by
  flipping a bool on `control_set`. UI dot goes in
  [status-bar.js](../web/src/components/status-bar.js) next to the
  conn chip.
- **Undo / redo buttons** — keyboard chords work (Ctrl/Cmd+Z / Shift+Z
  / Y fire `edit.undo` / `edit.redo`); dedicated buttons in the
  transport-bar are still open.

### Rich's just-added notes

- **Package the shim as a stand-alone .so** — can Ardour be extended
  via its official plugin / extension path so we don't need a fork at
  all? Worth investigating: Ardour's `ControlProtocolManager` already
  scans `ARDOUR_SURFACES_PATH` for `.so` files and dlopens any that
  export `protocol_descriptor()` (that's how our shim loads *today*).
  What's not yet tested: whether a built shim from an out-of-tree
  CMake or waf script (linking against Ardour's installed headers
  via a public SDK) works on a stock upstream Ardour without our
  patched source tree. Current setup has the shim living inside
  Ardour's `libs/surfaces/foyer_shim/` (via a symlink in
  `just shim-link`). Goal: move to a genuinely standalone build that
  compiles outside the Ardour tree + loads into an unmodified
  upstream binary. If Ardour's public C++ API isn't stable enough for
  that, document the blocker and the commits that would need to be
  upstreamed.

- **Audio forwarding both directions, with resampling** — the
  headline next milestone. Schema already has the audio primitives
  (`AudioFormat`, `AudioSource`, `LatencyReport` in
  [foyer-schema/src/audio.rs](../crates/foyer-schema/src/audio.rs),
  commands `audio_egress_start/stop`, `audio_ingress_open/close`,
  `latency_probe`). The `rubato` crate is already in the workspace
  deps for sample-rate conversion. What's missing:
  - **Egress (Ardour → browser):** shim needs to capture a designated
    route's output (bus or master) into a ring buffer, push frames
    out the UDS as `FrameKind::Audio` packets. Sidecar decodes,
    resamples to the browser's requested rate, re-encodes as Opus
    via the existing `opus` dep, streams via `MediaSource` extensions
    or WebRTC. WebRTC gives better latency; `MediaSource` is simpler.
  - **Ingress (browser → Ardour):** `getUserMedia()` → Opus →
    sidecar decode → resample → UDS → shim writes into an Ardour
    input port. Blocked on Ardour exposing a "remote input" port
    type; our shim will need to register one at surface-init.
  - **Resampling:** `rubato` handles arbitrary ratios. Client tells
    server its sample rate in the `audio_egress_start` command
    (`AudioFormat { sample_rate, channels, encoding }`); the sidecar
    picks a resampler for the DAW-rate → client-rate path.
  - **Latency calibration:** `latency_probe` already in the schema.
    Backend trait has `measure_latency(stream_id)` — host backend
    proxies to shim; shim runs a round-trip. Needs wiring.

## Known broken / half-done

Everything not marked ✅ in [TODO.md "Rich notes"](TODO.md) is open.
Specific blockers:

- **Action dispatch for non-transport verbs.** Shim decoder only
  recognizes `subscribe / request_snapshot / control_set / audio_* /
  latency_probe`. The sidecar now surfaces unknown actions as
  `Event::Error { code: "action_unimplemented" }` so users see the
  gap instead of silent log-warn spam. Fix in shim:
  [shims/ardour/src/dispatch.cc](../shims/ardour/src/dispatch.cc)
  — add `Kind::InvokeAction` to `DecodedCmd` + the `decode()` match;
  add a dispatch switch that maps:
  - `edit.undo` → `session.undo(1)`
  - `edit.redo` → `session.redo(1)`
  - `session.save` → `session.save_state("")`
  - `session.export` → template save (Session has `export_state`)
  - `track.add_audio` → `session.new_audio_track(1, 2, ...)`
  - `track.add_bus` → `session.new_audio_route(...)`

  Cut/copy/paste live in the GUI-only `Editor` action manager — can't
  be dispatched from headless `hardour`. Document that as a known
  limit; surface it in the error toast when `hardour` is running.

- **Track editor, rename, color** — no schema support for track
  mutation yet. Need `Command::UpdateTrack { id, patch }` (similar
  shape to `UpdateRegion`). Shim-side: `Route::set_name()`,
  `PresentationInfo::set_color()`.

- **Session dirty flag** — no event yet. Shim needs to subscribe
  `Session::DirtyChanged` and emit `Event::SessionDirty { dirty }`.
  Schema doesn't have that variant yet; add it.

## Architecture reference

```
 Ardour (libardour) ──(libfoyer_shim.so, GPL, ~1.7k LOC C++)
                         │  Unix socket, MessagePack frames + raw PCM
                         ▼
                   foyer-server (Rust, non-GPL)
                   WS + HTTP + jail + /console + /qr + backend swap
                         │  WebSocket JSON  ·  MsgPack hot path deferred
                         ▼
                   Lit 3.3 web UI (no bundler, vendored ESM)
```

Key crates:

- **[foyer-schema](../crates/foyer-schema/)** — wire types. `Command` /
  `Event` enums + `Session` / `Track` / `Region` / `Parameter`.
  Changes here ripple to both shim (C++ decoder) and browser.
- **[foyer-ipc](../crates/foyer-ipc/)** — length-prefixed MessagePack
  framing between sidecar and shim.
- **[foyer-backend](../crates/foyer-backend/)** — `Backend` trait +
  `default_daw_actions()` + `synth_waveform()`. Trait defaults
  handle transport verbs, synthesized peaks. Overriding method
  wins but should usually extend rather than replace.
- **[foyer-backend-stub](../crates/foyer-backend-stub/)** — in-memory
  demo backend with realistic plugin fixtures, timeline regions,
  meter tick. Used for `--backend stub` + launcher mode.
- **[foyer-backend-host](../crates/foyer-backend-host/)** — proxies
  `Backend` calls to an IPC-connected shim. Currently only wires:
  `snapshot`, `subscribe`, `set_control`, audio commands,
  `measure_latency`. Everything else goes to the trait default.
  That's where most "still doesn't work" complaints start.
- **[foyer-server](../crates/foyer-server/)** — axum + WS + HTTP.
  Holds `RwLock<Arc<dyn Backend>>` for live backend swap
  (`AppState::swap_backend`). Routes: `/ws`, `/files/*`, `/console`,
  `/qr?data=`. `ConnectInfo<SocketAddr>` → `ClientGreeting` with
  local/remote detection + reachable URLs for the Share flow.
- **[foyer-config](../crates/foyer-config/)** — YAML config at
  `$XDG_DATA_HOME/foyer/config.yaml`. Seeds on first run with `stub`
  + `ardour` entries. `detect_ardour_executable()` handles
  `$PATH` + macOS bundles + `/workspaces/ardour/build/...` dev trees
  + headless preference when `$DISPLAY` is empty.
- **[foyer-cli](../crates/foyer-cli/)** — `foyer serve` / `backends`
  / `config-path` / `configure`. `CliSpawner` implements
  `BackendSpawner`: spawns Ardour with env sourced via a bash
  wrapper script (sources `ardev_common_waf.sh`, sets
  `ARDOUR_BACKEND="None (Dummy)"` for devcontainers without JACK,
  prepends `foyer_shim` to `ARDOUR_SURFACES_PATH`, patches the
  session file to activate the protocol, bootstraps a new session
  via `ardour<N>-new_empty_session` if needed, splits the project
  path into `DIR SNAPSHOT_NAME` for Ardour's two-arg form).

Watch out: `shell_escape()` in the CLI wraps paths in single quotes
for STANDALONE argv use. **Do not interpolate its output inside
double-quoted bash strings** — single quotes become literal and
paths break silently. The fix pattern is assigning to a bash
variable first, then expanding the variable. See
[TODO.md — Diagnosis: shim-not-found bug](TODO.md) for the scar story.

### Web UI entrypoints

- `<foyer-app>` — [app.js](../web/src/app.js) — shell. Holds
  `this.ws` + `this.store` + `this.layout`. Exposes
  `window.__foyer.{ws, store, layout, workspaceRect, windowIndex}`.
- `<foyer-status-bar>` — [status-bar.js](../web/src/components/status-bar.js)
  — top row. Renders `LOCAL`/`REMOTE` chip, `Share` button,
  layout-dirty chip, theme + fullscreen buttons. Hosts the main
  menu (Session / Edit / Transport / …).
- `<foyer-tile-container>` / `<foyer-tile-leaf>` — the tile tree.
  Leaves render view components by string id (`mixer`, `timeline`,
  `plugins`, `session`, `console`). Saved layouts store `view`
  strings; if you rename a view id you break layouts.
- `<foyer-floating-tiles>` — absolute windows with slot pinning,
  8-handle resize, adjacent-window paired resize.
- `<foyer-plugin-layer>` — z-850 dedicated layer for plugin UIs.
- View components live in [web/src/components/](../web/src/components/).
  Thirty-odd tiles all about the same shape: Lit element that reads
  `window.__foyer.store` state + optionally subscribes to WS
  envelopes for live updates.

## Build / test

```
cargo build --workspace        # should be clean
cargo test --workspace         # 18 suites should all pass
just run                       # boots stub → picker → swap to ardour on project-click
just run-ardour <project>      # direct-spawn path
just shim-build                # compiles libfoyer_shim.so into Ardour's tree
just shim-e2e                  # full E2E headless smoke
just configure                 # auto-detect Ardour exec + jail
```

## The audio-forwarding plan, in order

This is the big next mission. Suggested phasing:

1. **M6a — egress to browser** (1–2 sessions of work)
   - Shim: register an egress ring per route on `audio_egress_start`;
     tap `AudioPort::get_audio_buffer()` from a process-thread-side
     callback (already possible via `Session::attach_Process()` hook).
     Push frames as `FrameKind::Audio` over UDS.
   - Sidecar: resample with `rubato` to the browser-requested rate,
     encode Opus (crate already in workspace deps), fan out to the
     subscribing WS client as binary frames.
   - Browser: `MediaSource` or `AudioWorklet`-based decoder. Start
     with `MediaSource` — less plumbing.

2. **M6b — latency probe** (half a session)
   - Shim: insert a marker, wait for it to come back, measure
     frames. Emit `latency.report`.
   - Browser: ask before arming record, refuse to arm until probe
     clears.

3. **M6c — ingress from browser** (1 session)
   - Register an Ardour port type per ingress stream. Browser
     streams mic via Opus; sidecar decodes + resamples to DAW rate;
     shim writes into the port's audio buffer in process-thread.

4. **M6d — transport sync + word-clock** (polish)

Each stage has a natural demo: "play a session in Ardour, hear it in
your browser"; "record vocals from your browser, see the waveform
land in Ardour."

## The standalone-shim investigation

Track this as its own experiment, separate from the audio work. The
question is: **can `libfoyer_shim.so` ship as a binary that loads into
an unmodified upstream Ardour?** Today the shim lives at
`shims/ardour/src/` and is symlinked into `ardour/libs/surfaces/foyer_shim/`
where waf picks it up. The entry point it exposes
(`extern "C" protocol_descriptor()`) is exactly what Ardour's
`ControlProtocolManager::control_protocol_discover()` looks for when
scanning `ARDOUR_SURFACES_PATH`. So in principle the shim IS already a
loadable plugin — but the build is tied to Ardour's tree via waf.

Plan:

1. Port the shim's build to CMake. It depends on `libardour` +
   `libpbd` + the Control Protocol headers. If Ardour ships
   pkg-config files (it doesn't by default on Linux distros), use
   those; otherwise document an `ARDOUR_SRC` pointer the user sets
   to their Ardour checkout.
2. Test loading the built `.so` on a vanilla Ardour install (e.g.
   Debian's packaged Ardour 7 or a nightly). Set
   `ARDOUR_SURFACES_PATH=<shim-build-dir>` and check that Ardour's
   Preferences → Control Surfaces lists "Foyer Studio Shim".
3. If it works: ship the shim as a separately-downloadable binary
   keyed to Ardour major versions. Drop the fork dependency
   entirely.
4. If it doesn't: identify what ABI-breaking calls we rely on,
   minimize them, upstream a tiny stable-SDK patch series to Ardour.
   Forks live on `hotspoons/zzz-forks-ardour` branch
   `foyer-studio-integration`.

## Known-good state as of this handoff

- Rust workspace compiles clean.
- All 18 test suites pass (`cargo test --workspace`).
- `just run` → session picker → click `asdf` → `hardour` spawns →
  shim advertises in ~0.7s → Foyer UI reconnects to the real
  backend. Mixer shows real tracks. Timeline shows placeholder
  regions (stopgap from host backend). Transport Play/Stop/Rec
  work (via set_control translation). Other menu clicks show a
  user-visible "action unimplemented" toast instead of silent
  log warnings.
- QR share: Share button appears when client is local + server has
  at least one non-loopback reachable URL. Click → modal with QR
  SVG (rendered server-side, no browser-side QR lib) + copyable
  URL.
- Console view tails `~/.local/state/foyer/daw.log`.

## One-line rule

If you're about to do something that takes more than one tool
call, write a TodoWrite list first. Fifty-plus web files and nine
Rust crates — scope drift is the biggest risk.

Start here:

1. Read [docs/TODO.md](TODO.md) lines 274–329 for Rich's latest asks.
2. Pick one of three: (a) wire regions in the shim, (b) wire
   `invoke_action` in the shim, (c) start the M6a egress milestone.
3. If you pick audio: the browser-side AudioWorklet skeleton is the
   right first commit — pure frontend, no shim changes needed to
   start.

Good luck.
