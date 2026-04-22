Observed issues:

- Routing and groups are incomplete, no UI for them, just static RO track info
- Bypass button on plugin doesn't light up in track editor view (but does in plugin view)
- Plugin's can't be deleted!!
- Double clicking a sequence or midi region should open the respective editor
- Double clicking effects strip or empty part of strip in mixer should open track editor
- Auto/in/disk needs vertical layout grouping like M/S/rec with a divider between
- Panning editor is missing, need stereo and surround pans
- Plugin windows can't be moved! They need to auto-layout and auto-move
- Can't delete tracks from the timeline view (should also work with multiple tracks)
- Can't rearrange tracks from the timeline view
- Clear automation should be a styled dialog, not an old school confirm dialog
- Automation painting is clunky, it is hard to put an automation point at the start of a track, not sure what's going on
- Close session needs to be one to two clicks, not three - Save & Close, Close (abandon changes), cancel. No More.... button. Close abandon changes should prompt are you sure, that is it
- UX idea:
  - The track editor, plugin windows, beat editor, midi roll, and maybe a couple of other windows should be a different class of windows than the primary interfaces that has it's own separate dock lower on the right strip with small window indicators, and quick controls to tile all open windows, untile (capture last position before tiling, restore to this), minimize all, unminimize all. They should be styled differently to show they are a different layer of the application and should always float above core windows. Maybe add a hint of transparency and/or blur to background too.
  - Optionally have a tiled panel that can be scrolled h and v that contains a different view of all open float-class windows


- (optionally scale aware) chord modifier keys for music sequence editor
- scale-highlighting in piano roll w/ options for weird scales, maybe microtonal
- UI hot-serving from folder (via a CLI flag or config option)
- Serve http, https, or both (via CLI flag or config option)
- CloudFlare tunnels support - connect foyer studio API to tunnel, create DNS or pick existing DNS (optionally), when connected strongly encourage using auto-generated connection tokens that can be part of URL or pop up in a form on first load required to establish session
  - Make extensible API to support other tunnel providers later
- Add read-only, transport-only, and admin roles, map API keys to roles, enforce on FE and BE
- Semantic plugin search?
- Plugin snapshot system (maybe use lightweight containers and run process in there?) with session
  - Export a full foyer container that includes the plugins used during the session in addition to the audio session