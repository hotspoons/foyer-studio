Observed issues:

- Make audio streaming console prints with chunk data for FE and BE debug only. Keep connections, disconnections, subscriptions, etc. silence the constant noise
- Loader/throbber after selecting a project, before it loads
- Show audio placeholder as we are recording, figure out live waveforms later
- Resampler in 
- Can't adjust tempo, changing it just immediately resets it
- Zoom to selection in timeline
- Loop selection don't work
- Routing and groups are incomplete, no UI for them, just static RO track info
- Bypass button on plugin doesn't light up in track editor view (but does in plugin view)
- Plugin's can't be deleted from channel configs!!
- Double clicking a sequence or midi region should open the respective editor
- Double clicking effects strip or empty part of strip in mixer should open track editor
- When clicking on a region, delete key should delete the region 
- Multi-select regions!
- Switching tile layouts should delete any existing floating tile-classed windows
- For midi channels, combine the "Track editor" dialog and midi settings dialog into a single dialog switchable with tabs, remember last tab
- Auto/in/disk needs vertical layout grouping like M/S/rec with a divider between
- Panning editor is missing, need stereo and surround pans
- Plugin windows can't be moved! They need to auto-layout and auto-move
- Can't delete tracks from the timeline view (should also work with multiple tracks)
- Can't rearrange tracks from the timeline view
- Right click on track should have delete option (as well as multi select -> delete track) with confirmation
- Clear automation should be a styled dialog, not an old school confirm dialog
- Automation painting is clunky, it is hard to put an automation point at the start of a track, not sure what's going on
- Close session needs to be one to two clicks, not three - Save & Close, Close (abandon changes), cancel. No More.... button. Close abandon changes should prompt are you sure, that is it

Short term features: 
- CloudFlare tunnels support - connect foyer studio API to tunnel, create DNS or pick existing DNS (optionally), when connected strongly encourage using auto-generated connection tokens that can be part of URL or pop up in a form on first load required to establish session
  - Make extensible API to support other tunnel providers later

Mid term:

- UX for floating windows versus tiles (tiles being core UI):
  - The track editor, plugin windows, beat editor, midi roll, and maybe a couple of other windows should be a different class of windows than the primary interfaces that has it's own separate dock lower on the right strip with small window indicators, and quick controls to tile all open windows, untile (capture last position before tiling, restore to this), minimize all, unminimize all. They should be styled differently to show they are a different layer of the application and should always float above core windows. Maybe add a hint of transparency and/or blur to background too.
  - Optionally have a tiled panel that can be scrolled h and v that contains a different view of all open float-class windows

### Resampler:
- Add a foyer-audio crate (or module in foyer-backend) wrapping rubato::SincFixedIn with a small Resampler { in_rate, out_rate, channels } helper that pushes/pops f32 chunks.
- Ingress: in shim_input_port.cc drain_loop, check _sample_rate vs AudioEngine::instance()->sample_rate(); when mismatched, hold a rubato instance per port and run captured chunks through it before buf.read_from. Keep the 20 ms frame-size invariant on the output side, not input.
- Egress: in foyer-server/src/audio.rs encode_loop, resample the shim-side PCM to format.sample_rate before Opus/raw framing — wire it between the mpsc receiver and the encoder's frame batcher. Same Resampler helper.
- Bit depth: not a real concern — the whole pipeline is already f32 end-to-end (browser AudioWorklet, IPC pack_audio, Ardour AudioBuffer). No conversion needed unless we add a SampleFormat::S16Le variant later.
- Handshake: extend AudioIngressOpen so the client can send its actual AudioContext.sampleRate (don't hardcode 48k in audio-ingress.js:49), and have the shim echo back the engine's rate in AudioIngressOpened.format so the browser knows if it needs to resize its worklet buffer.


- UI hot-serving from folder (via a CLI flag / config option) instead of built-in 
- Serve http, https, or both (via CLI flag / config option)
- (optionally scale aware) chord modifier keys for music sequence editor
- scale-highlighting in piano roll w/ options for weird scales, maybe microtonal



Long term:


- Add read-only, transport-only, and admin roles, map API keys to roles, enforce on FE and BE
- Semantic plugin search?
- Plugin snapshot system (maybe use lightweight containers and run process in there?) with session
  - Export a full foyer container that includes the plugins used during the session in addition to the audio session