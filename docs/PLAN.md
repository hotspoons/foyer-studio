# New plan

Need to show output VU or bar visualization as things are playing, currently nothing hooked up

## Beat sequencer design (2026-04-21, pre-bed sketch)

**Ask**: Hydrogen-style pattern grid as an alternate view for a MIDI
region on any track. Drum-kit layout by default; swappable to a
pitched layout ("composable sequencer"). Steps quantized to a chosen
resolution. Velocity lane. Transport integrated with Ardour's main
transport. Zoomable to a foyer-window.

**Storage (the critical question)**: Ardour exposes `add_extra_xml()`
/ `extra_xml(name)` on every `Stateful` object (Region, Track,
Session inherit the pattern via `SessionObject → StatefulDestructible
→ Stateful` at `libs/pbd/pbd/stateful.h:67-69`). The base class
preserves unknown child nodes through save/load cycles by design
(`libs/pbd/stateful.cc:94-108`). So we stash a `<Foyer><Sequencer>`
sub-node on the region — JSON or sub-XML — and stock Ardour
open-save-close cycles preserve it intact. No sidecar file needed.

**Data model (per MIDI region)**:

```json
{
  "version": 1,
  "mode": "drum",                // or "pitched"
  "resolution": 16,              // 1/16 notes per beat cell
  "steps": 16,                   // pattern length (one bar at 16ths)
  "rows": [
    { "pitch": 36, "label": "Kick",  "channel": 9, "color": "#f59e0b" },
    { "pitch": 38, "label": "Snare", "channel": 9, "color": "#a78bfa" },
    { "pitch": 42, "label": "HH cl", "channel": 9, "color": "#22d3ee" }
  ],
  "cells": {
    "0:0":  { "on": true, "velocity": 110 },
    "0:4":  { "on": true, "velocity": 100 },
    "1:4":  { "on": true, "velocity": 120 }
  }
}
```

Cell keys are `"<rowIdx>:<stepIdx>"`. Pitched mode is the same
schema but rows use arbitrary pitches (bottom-to-top ascending).

**Rendering to MIDI**: each cell on → one MIDI note at
(rowPitch, stepTicks, lengthTicks = one step). The region's note list
is regenerated on every cell change (add for new, delete for removed
via the existing `AddNote` / `DeleteNote` commands we landed tonight).

**Conflict with the piano roll**: a region is either "sequencer-
owned" (has `<Foyer><Sequencer>` metadata → piano roll opens in
read-only "synced from sequencer" mode) or "free-form" (no metadata
→ piano roll is fully editable). This keeps the two editors from
fighting over the note list.

**Schema additions** (alongside `MidiNote`, `PatchChange`):

```rust
pub struct SequencerLayout { /* the JSON shape above, typed */ }
// On Region:
pub foyer_sequencer: Option<SequencerLayout>,
// Command:
SetSequencerLayout { region_id, layout: SequencerLayout },
ClearSequencerLayout { region_id },
```

**Shim wiring**:

1. `describe_region_desc`: look up `region->extra_xml("Foyer")`,
   parse `<Sequencer>` child into the typed struct, attach.
2. `SetSequencerLayout` handler: build `<Foyer><Sequencer>` XML,
   call `region->add_extra_xml()` (which *replaces* an existing node
   of the same name).
3. Fire a `RegionUpdated` echo so browsers reconcile.

**UI entry points**:

- MIDI lane-head context → "Open beat sequencer…" (new).
- Piano roll toolbar → "Switch to beat sequencer" button (when the
  region is beat-sequencer-owned OR empty).
- Track editor modal → "Default new regions to beat sequencer" pref
  (stretch, not phase 1).

**Component**: `<foyer-beat-sequencer>` — grid of rows × steps,
velocity lane under it, transport controls in the toolbar (bound
to the existing `transport.play` / `stop` controls so sequencer
starts/stops in sync with the rest of Ardour). Resolution + size
pickers. Drum-kit picker dropdown (GM drum map is the default; each
row can still be overridden pitch-by-pitch).

**Tonight's scope** (~bed-time permitting): schema types + shim
round-trip + interactive web grid with local state that generates
notes via `AddNote` / `DeleteNote`. Hydrogen-style kit-mapping and
the pattern-song view land in a follow-up — the single-pattern
grid is the MVP and covers Rich's "zoom in a modal, solo, play in
ensemble" ask.

---

## Audio egress — proper jitter buffer (next)

## Audio egress — proper jitter buffer (next)

Current scheduling drives BufferSource start times straight from
the decode callback's `nextPlayhead`. Real-world WebSocket packet
delivery isn't smooth: browsers batch frames, background-tab
throttling creates 100-500 ms gaps, tokio's sleep timer is only
approximately periodic. With tolerances tuned for *typical* jitter
we still see "resetting playhead — 150 ms behind" warnings every
few seconds, and each reset is a ~300 ms gap audible as a pop.

Proper fix: pull scheduling OUT of the decode callback. Maintain
a `PriorityQueue<AudioBuffer>` keyed by decoder-order timestamp,
and have a dedicated `setInterval(schedulerTick, 10ms)` dequeue
and schedule buffers to keep `nextPlayhead ≥ currentTime + 150ms`.
Smooths bursts (which just pile into the queue and drain at
steady rate) and detects underflow cleanly (queue empty but
nextPlayhead < currentTime → log underrun + silently carry on).

Out of scope for the 2026-04-20 afternoon push; needed before
this audio path can stop feeling hacky.

## VU / peak-meter wiring (2026-04-20 afternoon — in progress)

**Shim side**: `shims/ardour/src/msgpack_out.cc::encode_track_meters`
walks `session.get_routes()`, reads each route's
`peak_meter()->meter_level(ch, MeterPeak)` (Ardour's canonical
dBFS peak-with-falloff), max-reduces across channels, and emits
one `meter_batch` event with `track.<stripable>.meter` →
dBFS-float entries. Called from the 30 Hz tick thread
unconditionally (moved above the idle-tick skip so meters pump
even with transport stopped — useful for input monitoring /
plugin noise / sanity check).

**Client side**: unchanged. Track-strip's `ControlController` is
already subscribed to `track.peak_meter` (schema id
`track.<id>.meter`) — the store dispatches
`control.update` events from the `meter_batch` envelope onto that
subscription, `<foyer-meter>` paints from whatever dBFS value
lands.

**Next**: verify meters visibly move when master audio taps are
active. If they don't, the drain-loop diagnostic counters
(run / silence / written / sent) will clarify whether the
processor chain is firing at all. Rich's session opens with
all-silent mastering and our auto-play workaround forces stop —
user has to hit Play (or arm a track with monitoring) to see
movement.


---

## Rich new notes

- Midi editor! We need a midi editor (basics in place)
  - We need to click + drag when first placing a note to set its duration, currently this is a two phase approach
  - We also need to be able to edit velocity more obviously (I like the transparency, but seeing a little number or something immediately when hovering would help, as would a velocity slider that appears enabled when a note is selected). Also I can't seem to put velocity back up, only down
  - Support non-grid placement of notes with like a modifier key or something when dragging or resizing
  - We also need multi-select (looks like it is in there), cut/copy/paste keyboard shortcuts for selection, undo/redo tracking
- Instrument swap/remove/add — reuse existing AddPlugin/RemovePlugin, just add a filtered instrument picker UI in the MIDI manager. ~1 focused pass.
- Per-region patch/bank events — new schema primitives + shim read (MidiModel::patch_changes()) + shim write (PatchChangeDiffCommand) + UI table. Same pattern I just did for notes.
- Plugin presets (lilv) — new backend trait methods + shim-side lilv preset enumeration + UI list. Biggest new surface, least user-facing value if the synth already exposes program changes via MIDI PC.
- Fix scroll-wheel zoom behavior, needs to essentially lock the zoom center on exactly where the pointer is and not move the waveform relatively when filling out horizontally from a low zoom to a high zoom. So regardless of what is happening to the timeline as a whole with framing, zoom targets must remain pixel exact on the pointer and reframe the timeline around this to prevent the timeline jumping that occurs zooming in and out and reframing the whole timeline. Currently it is perfect as long as the furthest left or right audio region extends past the frame of the timeline, but when dead space is available, that is when things go bad
- A beat sequencer would be *awesome* as an option for a MIDI channel. Think the primary UI for hydrogen with a sequencer and layout grid for loops could be used for drum tracks, awesome
- Modifier key when resizing a track or mixer channel to resize *all* of the tracks as we hold the handle of one
- Scroll to zoom h or v for midi roll (use same modifiers as other 2d zoomable panels)
- Delete/add one or more tracks from selection
- Make sure we can support higher-resolution (e.g. 96khz or 192khz) remote clients over audio tap
- Setup audio config for browser client (e.g. disable Opus compression and use raw waveforms, set client sampling freqency if possible)
- Audio source from browser to DAW session (lower priority). Approach
  settled 2026-04-21 (Decision 24): register soft input ports on the
  already-active AudioBackend via `PortManager::register_input_port()`
  and feed their buffers from our IPC drain, mirroring MasterTap in
  reverse. No custom backend, no JACK device on the sidecar — works
  on whichever backend the user already runs (JACK / ALSA / CoreAudio
  / WASAPI). Recordable by Ardour's normal track-input routing.
  Implementation lives behind the existing `AudioIngressOpen` command
  and `FrameKind::Audio` IPC plumbing; only the shim-side handler is
  missing. Latency calibration (`Backend::measure_latency()` trait
  method exists, implementation TBD) should land before we advertise
  this as anything beyond "monitoring / scratch-take grade."
- Upstream MCP proxy from foyer (so we can enable MCP tools in DAWs and integrate them with other tools we build independently like spectral analyzers)
- Push-to-talk audio broadcast for multi-user colabs (pipes audio to all clients of same session except ours)
- Simple relay chat for multiple users
- Floating dialogs like midi roll/editor, plugin editor, plugin config, ettc. should be a different class of window that can be, as a whole displayed and managed separately from core tiles, and have like a separate minimize/move/restore cycle from the main window manager. So you could lay out all of your overlay controls, then hide *all* of them to a dock, then restore the dock for all of them to have them 
- Channel grouping and bussing - works on back end but no way to edit on front end
---

- @Foyer Studio/sessions/at the casino/at the casino.ardour#1465-1531  - looks like it is saving now! The format is a little weird - we should be saving sequences, then arranging the sequences on a grid like hydrogen, then using that to generate notes for the region as a regular midi region.

This is creating new regions for each beat - this ain't the thing to do, all of the sequences and arrangements needs to be metadata that drove the generation of the region. Any time we update the sequences and arrangements for the sequences, we should *regenerate* the midi notes for the whole region. You should be able to convert a sequencer track to a regular midi track and hand-edit things on the piano roll, but not the other way around - a sequencer track should auto-generate the midi data.

The piano roll idea - you kind of missed that - basically instead of a fixed grid of drums, if you are using a regular instrument but still want to create an arrangement using the sequencer paradigm, allow a 16 beat or what ever piano roll instead of drum grid, with the option for ad-hoc placement and length of notes instead of to the grid via an alt drag or something like that

It would be awesome if we could have the midi generation happen in the foyer back end, triggered by sending state from the sequencer on the front end. This is where we will truly go on our own for design, but it should be a back end item so events emit on multiple connected clients
- Plugiin editor needs some work too, I don't see any plugins listed for selection even though it found the one for the black pearl drumkit multi we used for a virtual instrument on one track, so I can't change the instrument. The add instrument dialog appears under the midi setup  panel - this should probably be just inline in the midi form, not a separate panel
- Mousewheel over track labels in timeline should do vertical scrolling, not timeline zoom. Also need a modifer to be able to mousewheel and scroll down in the larger list
- Can't add midi tracks, only busses and audio
- Busses seem to be hooked up, we need a UI for them now
- MCP tools in foyer Rust API for primary DAW functionality, plus novel things like spectral analyzers, histograms, audio snippets for models that support audio, beats sequencer / looping addon, MIDI editing, and other things that a clanker can use to aid with production
- Automation still missing on tracks!



---



- ~~More polish on the beats - The add pattern button should be above the patterns boxes, the arrangement box should be resizable veritcally with vertical overflow, the preset beat kit we detected should be able to add additional beats (pick from piano roll, name the custom drum, should get placed in the note sequence). Have a checkbox to enable/disable audio preview in all piano rolls so when you click a note or drum, as long as the channel is unmuted and bussed to output (not disk only). Add ability to drag up/down the velocity for beats on the sequencer (need to show colored velocity markers with multiple beats per note if there is overlap, see screenshot)~~
- ~~Add "add region" in midi channel context menu (should add region at point where right clicked)~~
- ~~Alt drag for adhoc placement of beats and notes in quantized grid, alt drag resize of notes too~~
- ~~Presets manager on beat loops (with option to import/export as $name.fybt or something json or yaml, look at persisting in ardour config if there are any extensible config sections for the DAW as a whole) - for now store in browser storage~~
- ~~Add disk (play) and in (monitor) option on the mixer~~
- ~~Session durability/cross-crash/restart recovery, ux for sessions~~ (2026-04-22)
  - ~~Opening a session should create an internal UUID for that session in foyer, and from the UI we should be able to pick from open sessions~~ — UUID lives inside the .ardour file's `<Foyer><Session id="…"/>` extra_xml (Decision 30). Travels with the project across machines. Session switcher chip in the status bar lists every attached session with live dirty indicator.
  - ~~If that session is open with ardour, we should not be able to reopen it, it should just switch to the active session~~ — `SessionRegistry::find_by_path` is the hook; command dispatch layer still needs to be taught to call it before re-launching. [REMAINING: wire the "already open by path" short-circuit in `Command::LaunchProject`.]
  - ~~If ardour crashes and we have the crash data, we should offer to reopen the session~~ — `Event::BackendLost` now opens a blocking modal (`backend-lost-modal.js`) with Recover / Main menu / Ignore. Recover re-launches the same project path in a fresh shim.
  - ~~We should replace the current default layout with no open session with a welcome dialog showing recently opened projects, offering to open a project browser, or create a new session~~ — `welcome-screen.js` replaces the tile workspace when `sessions.length === 0`. Renders recents, orphan banner, and Browse / New CTAs. New-session is stubbed pending a `Session::new()` command in the shim.
  - ~~We should move off of hash-based navigation of files, and instead remember the last folder selected, and see if we can caputure browser forward/back actions (and mouse browser forward/back) and/or keyboard shortcuts while focused in the file view window~~ — `session-view.js` now owns an internal history stack, persists last-path in `localStorage` (`foyer.picker.last-path`), binds mouse buttons 3/4 + Alt+←/Alt+→ + Backspace-up, and adds visible back/forward buttons in the crumb bar.
  - ~~Need way to reattach orphaned hardour processes if we close foyer while a session is running, currently no way~~ — Shim writes `~/.local/share/foyer/sessions/<uuid>.json` on startup (pid + socket + path + timestamp), removes on clean shutdown. Sidecar scans on startup and classifies (running/crashed). [REMAINING: actual reattach path — the welcome screen and switcher call `reattach_orphan`, but the sidecar handler is stubbed (`reattach_unimplemented` error). Wiring it means teaching the CLI spawner to build a `HostBackend` against an existing socket path. Reopen-after-crash works via launch_project.]
  - ~~We should catalog recently opened sessions (like 10 of them, configurable via settings) under session -> recent~~ — `recents.js` with `foyer.recents.v1` + `foyer.recents.cap`. 10-entry default, per-browser storage so collaborators don't see each other's lists. Welcome screen renders them; [REMAINING: add "Session → Recent" submenu in main-menu — today the recents only surface from the welcome screen].
  - ~~We should guard against opening a new session if the current session is unsaved (prompt if they want to abandon unsaved changes)~~ / ~~A third option could be leave session running in background, come back to it later~~ — 4-way unsaved guard in the session switcher's Close action: Save & close / Leave running (switch away) / Close without saving / Cancel. "Leave running" just flips `currentSessionId` to another open session — backends stay up until explicitly closed.
  - ~~Close session (should close the Ardour process for the session, bring you back to main view)~~ — `Command::CloseSession` aborts the pump, drops the backend Arc (which closes the shim socket), broadcasts `SessionClosed`. When the last session closes the welcome screen comes back.
  - ~~State of listen/monitoring should be persistent, not reset per project~~ / ~~Default to listen off for local sessions, monitoring for remote sessions~~ — Mixer persists `foyer.listen.master` in localStorage. On mount it reads the saved pref; if none, defaults off for local (`is_local` from ClientGreeting) and on for remote.

- ~~DAW disconnected UX~~ (2026-04-22) — Replaced the corner-banner for `backend_lost` with a proper blocking modal offering Recover / Main menu / Ignore. Auto-dismisses on `backend_swapped` or `session_opened`.

- ~~Multi-session remote access for collaborators / mobile~~ (2026-04-22) — Added native rustls TLS to foyer-cli (musl-clean; no openssl/native-tls in the dep graph). New `just run-lan-tls` recipe generates a self-signed cert under `~/.local/share/foyer/tls/` with SANs covering every non-bridge LAN IP + localhost, then serves HTTPS/WSS on 0.0.0.0. Unblocks `AudioContext.audioWorklet` on mobile browsers which require a secure context for Worklet. `reachable_urls` picks `https://` when TLS is on so the share QR hands out working links. Also audio-listener surfaces a clear "AudioWorklet not available; reach over HTTPS" error instead of the raw undefined-property crash.

- ~~Justfile `kill-daws` foot-gun~~ (2026-04-22) — Recipe used to `pgrep -x foyer` which matched the CLI binary itself, taking out the sidecar. Split into `kill-daws` (Ardour only, sweeps dead-pid registry entries) and `kill-all` (full reset including the `foyer` process). `kill-daws` also scrubs sessions-dir JSONs whose pids are dead so the welcome screen doesn't render ghost "crashed" entries after a hard kill.




Please follow-up on these:

Multi-track add/delete: schema has no CreateTrack / DeleteTrack — that's its own vertical slice (schema + backend trait + host client + shim Session::new_audio_track / Session::remove_route wiring).
96/192 kHz shim-side: shim delivers at Ardour's session rate with no resampling. For true end-to-end high rates, either set Ardour's session rate to match or land a resampler in the shim (speex-resampler would be the obvious choice).
Browser→DAW ingress: the shim command now rejects cleanly instead of hanging. Needs a SidecarInputPort class parallel to MasterTap (Decision 24 has the sketch). ~200–400 lines of RT-disciplined Ardour C++.

Double clicking on tracks should open the track editor. For midi tracks we should have the rest of the context menu available above the fold so can can three-click access midi editors or midi functions
Also if it is a sequencer-driven track, it would be cool to see it marked like that in the strips instead of just midi (like midi(seq) or something)
Let's plan to start automation, this is a big one we'll need

And review context and find any incomplete items and write up a new plan document with everything left to do based on instructions so far. Look at these too: 

## Remaining from the session lifecycle slice

- Wire the "already-open-by-path" short-circuit: `Command::LaunchProject` should check `SessionRegistry::find_by_path(canonical_path)` and `SelectSession` to it when a match exists instead of spawning a second shim.
- Orphan *reattach* (Ardour process still running, we just lost the sidecar): implement by letting `HostBackend::connect(socket_path)` be driven from the reattach handler, bypassing the CLI spawner's launch-and-wait step.
- Session → Recent menu entry: today recents only surface in the welcome screen. Add the submenu to `main-menu.js` so opening a recent doesn't require closing the active session first.
- New-session creation: the welcome screen's "New session…" is stubbed pending a shim command. Needs `CreateEmptySession { path, template? }` in the schema + a `session.new_session()` call on the Ardour side.
- Per-connection session selection: `Command::SelectSession` currently sets a sidecar-wide focus. For multi-browser-window scenarios (pop-out into a second monitor), each WS connection should track its own `current_session_id`. Threading that through `dispatch_command` is mechanical but touches every handler.
