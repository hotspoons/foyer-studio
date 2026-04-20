# Overnight Push — 2026-04-20 / 04-21

**Prime directive:** move forward without stopping. Blockers get noted
in a "Deferred" section of this doc and we skip to the next task — we
do NOT burn the run waiting on a single problem.

## Regressions surfaced right before the run

- **Session opens with transport rolling.** Was fixed earlier in this
  project and has regressed. When the user opens a project from the
  session picker, Ardour comes up and playback starts immediately —
  should come up stopped at 0. Suspect the front-end `transport.playing`
  pin is getting re-asserted by a stale store value after
  `backend_swapped`, or the shim is reporting `transport_state_rolling()`
  true on a fresh load. Fix in Phase 1.

## Phase 1 — Bug bash (do first, fast wins)

1. **Session-opens-rolling regression** (above).
2. **Track rename / color not updating mixer.** Both updates hit the
   store, timeline repaints, mixer does not. Mixer's `session` property
   is set once at tile mount and never re-pushed. Either: subscribe to
   store `change` in the mixer element, or in [tile-leaf.js](../web/src/layout/tile-leaf.js)
   re-push the session prop to the mixer when the store changes, same
   as the timeline.
3. **"Set color" no-op.** Likely piggy-backs on bug 2 — the update
   fires, the shim applies it, but the mixer doesn't re-render. Verify
   after bug 2 fix; if still dead, chase the code path.
4. **Add plugin button dead.** [plugin-strip.js](../web/src/components/plugin-strip.js)
   `_addSlot()` currently does `location.hash = "plugins"` and opens
   nothing. Build a proper picker modal (`<foyer-plugin-picker>`) that
   lists `foyer://plugins`, filters by text, returns the URI into an
   `AddPlugin` command for the selected track.
5. **Dead main-menu items** (`settings.preferences`, `plugin.rescan`,
   others). For each: either wire to shim, wire to a local modal, or
   remove from the catalog. `settings.preferences` → open a settings
   modal (we already have settings scattered; consolidate). `plugin.rescan`
   → wire to shim (`PluginManager::rescan_all`).
6. **Track label context menu — ID: row.** It's informational only,
   shown at the bottom of the menu. Leave it but tone it down
   visually (smaller, dimmer). Lean into the Phase 4 track editor
   modal instead.
7. **WebGL waveform still renders nothing.** After the
   ResizeObserver + rAF + deferred-upload fix in the last session, the
   user reports waveforms are still not drawing in the timeline. Most
   likely suspects: (a) 0×0 canvas at the moment of draw because the
   timeline lane is still laying out when `firstUpdated` fires; (b)
   `RG32F` float texture + `OES_texture_float_linear` unsupported on
   the test GPU and we're silently falling back to nothing; (c)
   `.peaks` never actually reaching the element because the tier-cache
   fetch is returning empty arrays (server now returns an empty
   `WaveformPeaks` for unsupported backends — we need to check the
   stub path is still synthesizing, and the host path is hitting
   symphonia for the user's `sessions/asdf` project). Instrument the
   component to log exactly what it sees (canvas size at draw, gl
   version, peaks length, extension availability) and fix whichever
   branch is broken. Fall back to a Canvas2D renderer if WebGL isn't
   available so we degrade gracefully.

## Deferred — shim RT audio tap (M6a, legitimately blocked)

Looked into `Session::attach_Process` but that's not a thing in
Ardour 9's header. The mechanism we actually need to use is one of:

- Install an Insert processor on the master route and harvest its
  per-block `BufferSet` — stable but intrusive (shows up as a
  `PortInsert` in Ardour's GUI).
- Register as a normal `MeterPoint` listener and copy samples out —
  runs on the process thread, no extra route objects, but we have
  to care about thread registration (the per-thread pool crash we
  just fixed extends to any thread that allocates in libardour).
- Use JACK port-connection tapping — only works when the backend is
  JACK, not ALSA/Core/Wasapi.

Picking one of these and writing the ring-buffer + drain-thread
bridge is a day of work + testing. Parking behind the rest of the
bug-bash since the sidecar already has a working test-tone source
path; flipping from the test-tone to the real master is a one-line
swap in [ws.rs](../crates/foyer-server/src/ws.rs) once the shim is
emitting real `FrameKind::Audio` frames.

## Phase 2 — Shim RT audio tap (M6a hard part)

Unblock real master-bus monitoring.

- Shim: `ARDOUR::Session::attach_Process([this](pframes_t n){ … })`
  registered in the surface's session-set handler.
- Lock-free RT → non-RT handoff via `PBD::RingBuffer<float>` sized for
  ~200 ms @ 48 kHz (~80 kB per channel, stereo).
- Dedicated non-RT drain thread in the shim wakes on a condvar every
  5–10 ms, pulls available samples, serializes as `FrameKind::Audio`
  on the foyer-ipc socket.
- `HostBackend::open_egress` already exists; wire the Audio frames
  through to an mpsc the sidecar subscribes to. `AudioHub` then
  encodes (Opus or raw f32) and fans out over
  `/ws/audio/:stream_id` — same path already proven with the test
  tone.
- Mixer "Listen" button's `sourceKind: "master"` currently gets the
  sidecar's test tone; that flips to real master audio automatically
  once the host backend has a non-stub source for `AudioSource::Master`.
- Watch thread discipline: **no allocation, no locking, no logging**
  inside `attach_Process`. Anything bigger than a memcpy defers to the
  drain thread. Document this invariant in code comments so future
  edits don't regress it.

Blocker if RT-safe FFI turns out to be awkward (e.g., `attach_Process`
signature wants a specific callback shape the shim can't match without
Ardour-side changes): note in Deferred, switch to polling `master_out()`
from the shim's event loop at ~5 ms cadence as a stopgap. Audio
quality will still be fine for monitoring.

## Phase 3 — Right-panel FABs for layouts + agents

[TODO.md:284](TODO.md#L284). Match existing windows/session/actions
pattern. When the FAB is docked to the right rail, clicking it opens
the slide-out dock panel with that view's content; when floating, it
opens a floating window. Minimal risk; this is just adding two
entries to the dock-target registry.

## Phase 4 — Track editor modal

[TODO.md:286](TODO.md#L286). Right-click track label anywhere (mixer
or timeline) opens a modal overlay containing: name, color, comment,
bus assignment, group membership, and — crucially — the full mixer
strip embedded at the bottom so users can fully tune the track
without opening the mixer tile. The simple rename/color menu stays;
modal is for deeper work.

## Phase 5 — MIDI piano roll

[TODO.md:282](TODO.md#L282). `<foyer-midi-editor>` with a piano
keyboard down the left edge and note lanes extending right. Dockable
OR modal. Render mode: WebGL using the same viz library we've been
building; notes are rectangles, velocity is color saturation,
selection is outline. Schema already has `MidiNote` (added earlier
this session in [midi.rs](../crates/foyer-schema/src/midi.rs)).
Ardour shim region-notes emission is a second task.

## Phase 6 — Plugin parameter live updates

[TODO.md:230](TODO.md#L230). Subscribe to
`Plugin::ParameterChangedExternally` and `PluginInsert::ActiveChanged`
in [signal_bridge.cc](../shims/ardour/src/signal_bridge.cc) so
outbound `ControlUpdate` events fire when Ardour's native GUI moves a
plugin param. Without this the web UI only shows values it set
itself.

## Phase 7 — Session dirty indicator

[TODO.md:290](TODO.md#L290). `Session::DirtyChanged` hook on the
shim, `Event::SessionDirty { dirty: bool }` on the wire, dot next to
the conn chip in [status-bar.js](../web/src/components/status-bar.js).
Stub emits a stand-in so demo mode has the dot too.

## Phase 8 — Audio conferencing push-to-talk

[TODO.md:375](TODO.md#L375). Simple walkie-talkie between connected
Foyer clients. One audio stream per client via the existing
`/ws/audio/:stream_id` path, mixed into a "voice chat" channel the
others subscribe to. Push-to-talk key + sticky-on checkbox. Routes
entirely through the sidecar; no DAW involvement.

## Phase 9 — Multi-window pop-out

[TODO.md:64](TODO.md#L64), [TODO.md:374](TODO.md#L374).

1. `?window=N` URL param handling in app shell (pop-outs suppress
   global chrome like the transport bar and the FAB rail).
2. `BroadcastChannel("foyer")` fan-out for layout/store changes so
   `localStorage` isn't the transport.
3. Window-menu entry + `Ctrl+Alt+N` chord to open a new window at
   the next free slot, placed on the current screen by default.
4. `window.getScreenDetails()` gives multi-monitor geometry for a
   "send to monitor N" chord (optional, nice to have).

## Phase 9.5 — Draggable dividers on adjacent tiles

When two floating tiles share an edge (clean left/right half split,
top/bottom half split, any mid-screen boundary that's shared between
two neighbors) the shared edge becomes a drag handle. Dragging
resizes both tiles symmetrically around the edge. The act of dragging
"de-fixes" the layout — what was a named preset
(`layout.split-halves`) becomes a user-authored free form. The user
can still hit a preset chord to snap back to the canonical grid. This
is a big ergonomics win for the floating-tiles layout and doesn't
require changing the underlying tile model.

Implementation sketch:

- [floating-tiles.js](../web/src/layout/floating-tiles.js) computes a
  per-edge adjacency graph (which tiles share which edges within a
  tolerance).
- Render an invisible but hit-target-wide `<div>` along each shared
  edge, cursor `col-resize` / `row-resize`.
- Pointer-drag updates the two neighbors in lockstep — expand one,
  shrink the other, subject to min-size constraints.
- First drag flips the layout from preset-bound to free form; clear
  the preset indicator.

## Phase 1.8 — Errored-plugins UX

When the shim encounters a plugin reference it can't resolve (missing
URI, failed to instantiate, incompatible channel count) it logs the
error and skips the insert. The user sees nothing in the UI today.

Add a dedicated "errors" row at the top of the plugin strip that
surfaces the missing plugin URI + short reason, plus a "dismiss"
button that records the dismissal in `localStorage`
(`foyer.plugin.errors.dismissed`, keyed by URI+trackId). On
subsequent sessions the dismissed entries stay hidden unless the
same plugin fails on a different track.

Also covers Rich's ask: "we should also show errored plugins in the
strip with a dismiss — client-side only (backend removes them), use
browser storage to track dismissal".

## Phase 1.10 — Viewport-cropped waveform rendering

At extreme zoom (4000 px/s over a 30s region → 120k-pixel-wide
region div), the waveform canvas's backing store can't match the
region's rendered width — browsers cap canvas dimensions around
16k pixels. Temporarily clamped the backing store to 8192 px (CSS
stretches the canvas horizontally to fill, costing pixel density).

Proper fix: the waveform component should render only the slice of
the region that's on-screen, into a canvas sized to the viewport
intersection, positioned absolutely inside the region div at the
correct offset. Requires:

- Timeline pushes `{ viewportLeftPx, viewportWidthPx, regionLeftPx,
  regionWidthPx }` into each `<foyer-waveform-gl>` on scroll + zoom.
- `waveform-gl` sizes its canvas to `viewportWidthPx` clamped to the
  region's clipped extent, places it via `left:` offset, resamples
  the peaks array to just the visible sample range.
- Backing store stays under the 8k cap even at 10k px/s zoom.

Mid-effort, isolated to the viz + timeline components.

## Phase 1.9 — Floating window z-order regression

Clicking a floating or backgrounded window does not raise it; it stays
behind whatever tile was on top. Root cause likely in
[floating-tiles.js](../web/src/layout/floating-tiles.js) — either the
pointerdown/focus handler doesn't reassign the z-index counter, or
the layout store's `focusId` is updating but the render path doesn't
map focus back to a CSS z-index bump. Fix: on pointerdown anywhere in
a floating tile, push that tile's id to the top of the z-stack. One
monotonically-increasing counter stored in the layout-store, applied
as `z-index` on each tile.

## Phase 9.6 — Modal scrim theme polish

The share-modal (and any other modal with a scrim) had a semi-opaque
navy background that lightened the dark theme when overlaid — a
greyish-blue cast appeared behind the modal instead of the surface
staying dark. All modal scrims now use pure `rgba(0, 0, 0, 0.55)` so
overlaying only darkens the underlying theme, never tints it.
Low-effort sweep: grep for `rgba(2, 6, 23` and similar and normalize.

## Phase 10 — Polish sweep

- Diagnostics panel: add a "reset waveform cache" button that
  invokes `clear_waveform_cache`.
- `scan_plugins` progress UX: event stream so the button shows "45 /
  312 plugins scanned" instead of blocking silently.
- FAB layer: keyboard chord to toggle "docked mode for everything"
  in one shot.

## Deferred / blockers parking lot

Append-only. Anything I can't finish in one sitting lands here with a
one-paragraph note explaining where it got stuck and what would
unblock it. Do not hold the run up for these.

---

## Execution order

Phases run in the order above. Within a phase, tasks are serialized
— each phase ends before the next one begins. Partial completion of a
phase is fine; note the split-point in the phase's section and move
on.

Progress against this plan is logged live in
[HANDOFF.md](HANDOFF.md)'s "2026-04-20 overnight push" section.
