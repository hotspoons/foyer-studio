Observed issues:

- [x] ✅ Make audio streaming console prints with chunk data for FE and BE debug only. Keep connections, disconnections, subscriptions, etc. silence the constant noise
  - Already in good shape in tree (`VERBOSE` in `audio-listener.js`, encode path uses `tracing::debug!` in `audio.rs`); no extra changes needed.
- [x] ✅ Loader/throbber after selecting a project, before it loads
  - `foyer-app` full-viewport overlay on `launch_project` (WS `project_launch_start`); clears on `backend_swapped` or `launch_failed`. Covers welcome/recents/modal paths. Removed duplicate overlay from `session-view` (it only fired inside the picker).
- [/] Show audio placeholder as we are recording, figure out live waveforms later
  - Timeline: pulsing span record-start→playhead; per **record-armed** lane via `.recording-lane-fill`, full-stack fallback when recording but nothing armed. Live waveforms still future work.
    - Looks good but the start-position doesn't stay put and grow, it sweeps with the record head. We want it to fill the position that it would after we render the waveforms
- [ ] Seek head (time marker) is jumping around on some projects, going back and forward like 3 seconds
  - Timeline now ignores out-of-order `transport.position` packets by monotonic envelope-seq guard (`_lastTransportSeq`) before updating playhead; this removes visible jump-back from stale WS packets.
- [ ] Can't adjust tempo, changing it just immediately resets it
  - Blocked in shim: `dispatch.cc` logs `transport.tempo set_control deferred (use TempoMap API)` so UI writes bounce; needs Ardour TempoMap write path in shim.
- [/] Zoom to selection in timeline
  - Already implemented in `foyer-timeline-view` (`zoomToSelection` / `zoomPrevious`) and wired in menu + keybinds (`Ctrl+Shift+E`, `Ctrl+Shift+Backspace`).
    - We need a button that appears on the timeline view next to zoom when there is a selection for 'zoom to selection', right next to zoom
- [ ] Loop selection don't work
  - Blocked: no loop-range control contract in schema/UI (`transport.loop_start` / `transport.loop_end` equivalents are absent); only loop toggle exists today.
- [ ] Routing and groups are incomplete, no UI for them, just static RO track info
  - Partially improved previously (track routing, bus assign, sends UI in track editor) but group management remains read-only and full routing workflow is still incomplete.
- [/] Bypass button on plugin doesn't light up in track editor view (but does in plugin view)
  - Plugin strip now listens to store control updates and re-renders bypass state live in embedded track-editor strip.
    - Needs the 'by' text to be more obvious and the whole text a little dimmer, not intuitive
- [x] Plugin's can't be deleted from channel configs!!
  - Added remove flow in channel plugin strip context menu (`remove_plugin` command).
- [x] Double clicking a sequence or midi region should open the respective editor
  - Region double-click now opens the appropriate editor on MIDI tracks (beat sequencer for active sequencer layouts, piano roll otherwise).
- [/] Double clicking effects strip or empty part of strip in mixer should open track editor
  - Mixer track strip dblclick already opened track editor; plugin-strip area/empty slot now also routes dblclick to track editor.
    - Yes but...it always tries to open in a sequencer view even if it is a MIDI track so we get a prompt to convert region to sequencer. Should auto-detect which view to open to and not do this
- [/] When clicking on a region, delete key should delete the region 
  - Added explicit region click-selection and keyboard delete path for selected regions.
    - Does not work, delete key does nothing with a region highlighted
- [x] Multi-select regions!
  - Added modifier multi-select/toggle for regions (Shift/Ctrl/Cmd on region click) plus selected styling and batch delete support.
- [x] Switching tile layouts should delete any existing floating tile-classed windows
  - `layout-store` now clears generic floating tile windows on preset/named layout load (`loadPreset`, `loadNamed`).
- [ ] For midi channels, combine the "Track editor" dialog and midi settings dialog into a single dialog switchable with tabs, remember last tab
  - Blocked for this pass: requires larger modal architecture merge (track editor + midi manager window models) and tab-state persistence.
- [/] Auto/in/disk needs vertical layout grouping like M/S/rec with a divider between
  - Track strip now renders M/S/rec and monitoring mode in a vertical stack with a divider (`monitor-stack` + `divider`).
    - Divider is there but auto/in/disk don't reflow vertically like M/S/Rec do so they get cut off on narrow mixer views
- [ ] Panning editor is missing, need stereo and surround pans
  - Blocked: no dedicated pan-editor component/UX yet; current surface exposes basic pan control paths but not stereo/surround pan editor UI.
- [ ] Plugin windows can't be moved! They need to auto-layout and auto-move
  - Current plugin layer is intentionally auto-packed/non-draggable by design; auto-layout exists, but manual move remains intentionally disabled pending UX decision.
- [ ] Can't delete tracks from the timeline view (should also work with multiple tracks)
  - Blocked: no `delete_track` command path in current schema/shim dispatch.
- [ ] Can't rearrange tracks from the timeline view
  - Blocked: no track reorder command contract implemented in schema/shim.
- [ ] Right click on track should have delete option (as well as multi select -> delete track) with confirmation
  - Blocked by missing backend command support for deleting tracks.
- [/] Clear automation should be a styled dialog, not an old school confirm dialog
  - Automation lane clear now uses styled `confirm-modal` (`confirmAction`) instead of `window.confirm`.
   - Clearing automation CRASHES THE DAW! Also the point setting is super unreliable, setting a point almost always snaps back when doing it in the UI. Needs a lot of investigation
- [x] Automation painting is clunky, it is hard to put an automation point at the start of a track, not sure what's going on
  - Added left-edge add behavior: clicks near lane start now snap to `time_samples=0` and prefer add-point over grabbing nearby first point.
- [x] Close session needs to be one to two clicks, not three - Save & Close, Close (abandon changes), cancel. No More.... button. Close abandon changes should prompt are you sure, that is it
  - Session switcher unsaved-close flow reduced to 1-2 clicks: Save & Close, or Close without saving (with one danger confirm), or Cancel.

Short term features: 
- [ ] CloudFlare tunnels support - connect foyer studio API to tunnel, create DNS or pick existing DNS (optionally), when connected strongly encourage using auto-generated connection tokens that can be part of URL or pop up in a form on first load required to establish session
  - Make extensible API to support other tunnel providers later

Mid term:

- [ ] UX for floating windows versus tiles (tiles being core UI):
  - The track editor, plugin windows, beat editor, midi roll, and maybe a couple of other windows should be a different class of windows than the primary interfaces that has it's own separate dock lower on the right strip with small window indicators, and quick controls to tile all open windows, untile (capture last position before tiling, restore to this), minimize all, unminimize all. They should be styled differently to show they are a different layer of the application and should always float above core windows. Maybe add a hint of transparency and/or blur to background too.
  - Optionally have a tiled panel that can be scrolled h and v that contains a different view of all open float-class windows

### Resampler:
- [ ] Add a foyer-audio crate (or module in foyer-backend) wrapping rubato::SincFixedIn with a small Resampler { in_rate, out_rate, channels } helper that pushes/pops f32 chunks.
- [ ] Ingress: in shim_input_port.cc drain_loop, check _sample_rate vs AudioEngine::instance()->sample_rate(); when mismatched, hold a rubato instance per port and run captured chunks through it before buf.read_from. Keep the 20 ms frame-size invariant on the output side, not input.
- [ ] Egress: in foyer-server/src/audio.rs encode_loop, resample the shim-side PCM to format.sample_rate before Opus/raw framing — wire it between the mpsc receiver and the encoder's frame batcher. Same Resampler helper.
- [ ] Bit depth: not a real concern — the whole pipeline is already f32 end-to-end (browser AudioWorklet, IPC pack_audio, Ardour AudioBuffer). No conversion needed unless we add a SampleFormat::S16Le variant later.
- [ ] Handshake: extend AudioIngressOpen so the client can send its actual AudioContext.sampleRate (don't hardcode 48k in audio-ingress.js:49), and have the shim echo back the engine's rate in AudioIngressOpened.format so the browser knows if it needs to resize its worklet buffer.


- [ ] UI hot-serving from folder (via a CLI flag / config option) instead of built-in 
- [ ] Serve http, https, or both (via CLI flag / config option)
- [ ] (optionally scale aware) chord modifier keys for music sequence editor
- [ ] scale-highlighting in piano roll w/ options for weird scales, maybe microtonal
- [ ] Time marker (see head) doesn't seem to align with MIDI, and it also doesn't align with audio output. We need to figure out an algorithm to account for the offset and set the time marker to account for the delay. Streaming devices with bluetooth have this really well figured out, we should peek at some implementations of how video streams are set to a delay to allow the audio latency to set in. We'll need this all over the place, meters, visualizations, seek heads. Just anything that displays real-time display to the user, have it pipe through a function that can set and maintain a stream delay on it

### UI:
- [ ] Refactor UI so it is modular and hackable. 
  - [ ] Move the core functionality necessary to run the UI for any possible configuration (websocket handling, audio workers, business logic for primary DAW functions as pure business logic like session handling, gruoups, busses, tracks, transports, plugins, etc. - everything common to all DAWs - but no UI, abstract out with __JSDoc__ so we get pseudo-typing). Avoid directly binding to browser-specific APIs and defer to facades with implementations that are run on startup if we detect we are in a browser. If there is any particular core feature that is DAW specific we need proper abstraction and/or registration so we don't couple to the DAW and just have an implementation for that DAW of a special feature. The core goal is that all of the hard work for the UI business logic is abstracted into a JavaScript library with zero opinion on interaction, look and feel, or back end, so people can hack front ends onto it. And if they want to port off of a browser to another platform, that should be possible too. Add a feature registry per DAW so we can easily omit features not supported by one DAW or another and the UI implementation should respect this.
  - [ ] Core should have a UI registry that can take multiple UIs and swap them out on demand, and can be used as either a bootstrapper or library (omitting this step). UIs should have a primary manifest that identify themselves as such, then have their own primary bootstrapping logic on top of this
  - [ ] CSS is subjective, so no opinions on this - this is per UI implementation
  - [ ] Register a shipping UI - foyer-ui - that takes foyer-core and paints it with what we made thus far. We want to make sure all controls, menu items, windows, etc. have a central registry that maps elements to DAW back ends so we can omit features buttons, menus etc that aren't supported. Need to push as much of this mapping logic as possible into core. We should also have swappable UIs as a whole for this project - a full-featured UI, a lite UI, a small and big touch UI, and a kids UI. Small and big touch UIs should be auto-detected based on client, but we want to be able to control track muting, arming, IO, and basic transport commands so someone could record themselves easily using their phone as a control surface for these tasks - advanced more for levels. Components should be sharable between UIs, but layouts should be scoped to the specific UI, so an advanced layout would not conflict with a simple layout for presets and last updated states
  - [ ] Shipping UI is the only one with opinions, the core just abstracts the hard as fuck stuff to do so you get a clean API to build any UI on top of
  - [ ] Click and drag plugins and midi instruments from one channel to another or from the plugins view to another
  - [ ] 1x high x 0.5x wide one panel, 0.5x high x 0.5x wide x 2 other panel layout (3 windows)

Long term:


- [ ] Add read-only, transport-only, and admin roles, map API keys to roles, enforce on FE and BE
- [ ] Semantic plugin search?
- [ ] Plugin snapshot system (maybe use lightweight containers and run process in there?) with session
  - [ ] Export a full foyer container that includes the plugins used during the session in addition to the audio session