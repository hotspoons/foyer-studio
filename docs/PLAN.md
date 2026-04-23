Observed issues:

- [x] ✅ Make audio streaming console prints with chunk data for FE and BE debug only. Keep connections, disconnections, subscriptions, etc. silence the constant noise
  - Already in good shape in tree (`VERBOSE` in `audio-listener.js`, encode path uses `tracing::debug!` in `audio.rs`); no extra changes needed.
- [x] ✅ Loader/throbber after selecting a project, before it loads
  - `foyer-app` full-viewport overlay on `launch_project` (WS `project_launch_start`); clears on `backend_swapped` or `launch_failed`. Covers welcome/recents/modal paths. Removed duplicate overlay from `session-view` (it only fired inside the picker).
- [x] ✅ Show audio placeholder as we are recording, figure out live waveforms later
  - Timeline: pulsing span record-start→playhead; per **record-armed** lane via `.recording-lane-fill`, full-stack fallback when recording but nothing armed. Live waveforms still future work.
    - Fixed: timeline now latches a record anchor at record-start and grows forward from that fixed position.
    - Looks lovely!
- [x] ✅Seek head (time marker) is jumping around on some projects, going back and forward like 3 seconds
  - Timeline/store now ignore out-of-order `transport.position` packets and reject non-seek backward jumps during active playback.
  - Added dev-gated drop counters (`localStorage['foyer.dev.transportDiag']="1"`) to diagnose race suppression.
    - Will continue to monitor, it isn't consistent, will check local storage if it occurs
- [x] ✅Can't adjust tempo, changing it just immediately resets it
  - Shim now applies `transport.tempo` via Ardour `TempoMap::write_copy()` + `change_tempo()`, so FE control writes persist and echo correctly.
- [x] ✅Zoom to selection in timeline
  - Already implemented in `foyer-timeline-view` (`zoomToSelection` / `zoomPrevious`) and wired in menu + keybinds (`Ctrl+Shift+E`, `Ctrl+Shift+Backspace`).
    - Added an inline `Zoom to selection` toolbar button beside zoom controls when a selection exists.
- [x] ✅Loop selection don't work
  - Timeline `Loop selection` now drives `set_loop_range`; server/backend-host/shim wire loop start/end and loop-enable with Ardour auto-loop location updates.
- [/] Routing and groups are incomplete, no UI for them, just static RO track info
  - Routing panel now supports input selection, bus assignment, sends, and group assignment write-path via `update_track.group_id`.
  - Shim snapshot now emits `session.groups` + per-track `group_id`; remaining gap is dedicated create/rename/delete group UI workflow.
- [x]  ✅Bypass button on plugin doesn't light up in track editor view (but does in plugin view)
  - Plugin strip now listens to store control updates and re-renders bypass state live in embedded track-editor strip.
    - Updated plugin-strip bypass affordance styling: stronger BY text, dimmer baseline row, and explicit bypass-highlight treatment.
- [/] Plugin's can't be deleted from channel configs!!
  - Added remove flow in channel plugin strip context menu (`remove_plugin` command).
    - Delete key doesn't work after focusing on a plugin. Need to be able to delete via a key
- [x]  ✅Double clicking a sequence or midi region should open the respective editor
  - Region double-click now opens the appropriate editor on MIDI tracks (beat sequencer for active sequencer layouts, piano roll otherwise).
- [x]  ✅Double clicking effects strip or empty part of strip in mixer should open track editor
  - Mixer track strip dblclick already opened track editor; plugin-strip area/empty slot now also routes dblclick to track editor.
    - Fixed MIDI region editor routing: sequencer opens only when sequencer metadata exists and is active; plain MIDI regions now open piano roll without conversion prompt.
- [/] When clicking on a region, delete key should delete the region 
  - Added explicit region click-selection and keyboard delete path for selected regions.
    - Global keybind listener now runs in capture phase so Delete/Backspace region deletion is reliable despite focus churn.
      - NEITHER DELETE OR BACKSPACE DOES SHIT WHEN SELECTED ON A REGION!!!
- [/] Multi-select regions!
  - Added modifier multi-select/toggle for regions (Shift/Ctrl/Cmd on region click) plus selected styling and batch delete support.
    - Multi move/multi delete doesn't work, mouse or otherwise
- [x] ✅Switching tile layouts should delete any existing floating tile-classed windows
  - `layout-store` now clears generic floating tile windows on preset/named layout load (`loadPreset`, `loadNamed`).
- [x] ✅For midi channels, combine the "Track editor" dialog and midi settings dialog into a single dialog switchable with tabs, remember last tab
  - Track editor now embeds a MIDI tab for MIDI tracks and persists last selected tab in localStorage.
- [x] ✅Auto/in/disk needs vertical layout grouping like M/S/rec with a divider between
  - Track strip now renders M/S/rec and monitoring mode in a vertical stack with a divider (`monitor-stack` + `divider`).
    - Monitoring mode buttons now stack vertically to avoid clipping in narrow strip widths.
- [x] ✅Panning editor is missing, need stereo and surround pans
  - Added `foyer-pan-editor-modal`: stereo slider writes host pan, and surround pad UX is present (X writes current pan, Y previewed for future surround backend axes).
- [/] Plugin windows can't be moved! They need to auto-layout and auto-move
  - Plugin float windows remain auto-packed by default and are now draggable; manual position persists in layout store and is clamped to the visible workspace.
     - They are resizable (with an ugly corner marker that doesn't match the theme) but they are still fixed in place, headers not draggable. Please fix
- [x] ✅Can't delete tracks from the timeline view (should also work with multiple tracks)
  - End-to-end command path now active: schema/server/backend-host/shim `delete_track`, plus timeline single/multi selection delete actions with confirmation.
- [/] Can't rearrange tracks from the timeline view
  - End-to-end reorder now active through shim: timeline move up/down emits `reorder_tracks`, shim updates route presentation order and resorts routes.
    - Not complete. No errors but no action, I don't see the tracks rearranghing
- [x]  ✅Right click on track should have delete option (as well as multi select -> delete track) with confirmation
  - Lane-head context menu delete now executes through working backend contracts and applies to selected tracks (or current track) with confirmation.
- [/] Clear automation should be a styled dialog, not an old school confirm dialog
  - Automation lane clear now uses styled `confirm-modal` (`confirmAction`) instead of `window.confirm`.
   - Stabilized shim automation lane mutation paths (`replace_automation_lane`, `update_automation_point`) to avoid unsafe list mutation patterns and reduce point snap-back.
- [x]  ✅Automation painting is clunky, it is hard to put an automation point at the start of a track, not sure what's going on
  - Added left-edge add behavior: clicks near lane start now snap to `time_samples=0` and prefer add-point over grabbing nearby first point.
- [x]  ✅Close session needs to be one to two clicks, not three - Save & Close, Close (abandon changes), cancel. No More.... button. Close abandon changes should prompt are you sure, that is it
  - Session switcher unsaved-close flow reduced to 1-2 clicks: Save & Close, or Close without saving (with one danger confirm), or Cancel.

Short term features: 
  - Make extensible API to support other tunnel providers later
- [ ] Undo/redo don't really work, kinda but not really
- [ ] Tempo adjustments should reflow/regenerate midi from sequencer tracks
- [ ] Timeline marker doesn't move on loop selection button, but does on main track button for looping - suggest removing loop selection button
- [ ] Sends says we are already sending to every available bus - is that true?
- [ ] "- Shim snapshot now emits `session.groups` + per-track `group_id`; remaining gap is dedicated create/rename/delete group UI workflow."
- [ ] Move plugins and instruments below mixer header and M/S/Rec/auto/in/disk controls so those heights stay consistent. Make it so if the plugins reach the gain sliders the plugins strip scrolls vertically
- [ ] Panning editor should be in-form and in a default-hidden mini form with a collapsable header at the bottom of the mixing panel above the gain sliders
- [ ] Delete key doesn't work when focused on one or more tracks - need this to spawn delete dialog
- [ ] "NEITHER DELETE OR BACKSPACE DOES SHIT WHEN SELECTED ON A REGION!!!"
- [ ] CloudFlare tunnels support - connect foyer studio API to tunnel, create DNS or pick existing DNS (optionally), when connected strongly encourage using auto-generated connection tokens via URL or auto-generated email/password combos that essentially base64 to the connection token. Make form to share connection - hook into default system e-mail to generate e-mails with connection URLs and passwords (if they don't click the URL with the access token, they enter their username and password). We need a form to do this and we persist sha's of the connection infoformation locally for each user in a manifest file. Each user gets mapped to a role (viewer/listener (read-only), performer (read only + capture input on a channel from browser), session controller (can play/pause/seek/mute/solo/channel gain + capture input), and admin (default/can do everything)). Will require RBAC construct in UI



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