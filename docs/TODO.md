# Foyer Studio — active plan

~~Fresh cut as of 2026-04-24. Everything already landed is archived in [old/PLAN.md](old/PLAN.md) under the "Archived 2026-04-24" section.~~
(deleted, not needed)

Format:
- `[ ]` open, `[/]` partial, `[x]` done. Completed entries normally
  move to the archive on the next cleanup.
- A `+` prefix after the checkbox marks an item Rich has flagged as
  priority for the current push. A `-` prefix means backburnered.

Active decisions log: [DECISIONS.md](DECISIONS.md) (currently ≥ 41
entries). Shipping-state snapshot: [STATUS.md](STATUS.md).

---

## License
- [x] SPDX headers on entry points + top-level `LICENSE` split. `shims/ardour/` under GPL-2.0-or-later (inherits libardour); main project under Apache-2.0. Rationale in DECISION 15.

## In app communications layer
- [x] Relay chat — FAB + dockable panel next to the agent FAB. `marked` + `highlight.js` (yaml grammar bundled) vendored under `web/vendor/`; lazy-loaded on first panel open. Server keeps a bounded in-memory ring (`chat::ChatState`, cap 500); admins (and LAN users, trusted) can clear. `Command::ChatSnapshot` writes JSONL under `$XDG_DATA_HOME/foyer/chat/<filename>.jsonl` with basename-only sanitisation.
- [x] Push-to-talk rides binary frames on the existing control `/ws` (no extra socket — stays under the 6-connection-per-origin cap). Wire format in `chat.rs`: `[P][v][ts_ms_BE][peer_id_hex][f32 LE @ 48 kHz mono]`. `Event::PttState` announces the active speaker so the UI pulses a ring around the FAB, shows a "Alice speaking…" banner, and blocks simultaneous presses.

## Remote session engineering
- [x] Track editor's "Use browser mic for this track" replaced with a user selector listing performer+ peers (including the host as "This machine"). Routes through `Command::SetTrackBrowserSource`; server broadcasts `Event::TrackBrowserSourceChanged` and snapshots the whole map in the post-greeting handshake. Peer disconnect clears their entries automatically.
- [x] Transport bar grows a mic button when this browser is the assigned source for ≥1 track. Click starts mic ingress and wires the track's `input_port`; click again stops and clears. Button disappears when the assignment goes away (host unassign, peer leave, etc.).
- [x] Live monitoring forced off for browser-sourced tracks — server sets `monitoring="off"` whenever an assignment lands, mixer strip shows `MON OFF` in place of the Auto/In/Disk triplet. No live collab over the browser leg; overdubs only.

## Next issues
- [x] Let's have the access token in the link be a base64-encoded SHA of the username/password combo, not just the username/password combo
- [x] Disable space global binding if the role can't mess with the transport (e.g. read only, performer) - causing issues in remote sessions


## Features/updates
- [ ] (optionally scale aware) chord modifier keys for music sequence editor
- [ ] Scale-highlighting in piano roll w/ options for weird scales
- [ ] Quantization grid on UI (hideable) based on BPMs. Ability to drag waveforms and sequences to snap to it with a modifer
- [ ] Tunnel clients don't hear audio until they open the mixer once, we need audio always on for them and not reliant on a UI tweak
- [ ] Chat notifications don't show on docked FAB, only floating FAB for chat. Need this to show on the FAB and we need a toast or what ever they are called if chats come in and the chat UI isn't open
- [ ] Restore old slide-out panel behavior for docked FABs, it was a much nicer design 
- [ ] Clicking "Unsaved" should launch a confirmation dialog "Would you like to save"? Save/Cancel. Maybe replace with a disk icon, no text
- [ ] The widget prompting to save the layout is way too big, maybe just make this an icon with a grid or something that lights up yellow when the layout is unsaved, don't inject the whole name in it
- [ ] Solo states don't seem to be well synced on the front end. When I load a project that had a soloed channel, it doesn't reflect on the UI and I have solo and unsolo everything to get the channels in a good state. We need to take a good look at this
- [ ] Undo/redo in the midi editor doesn't repaint the notes, it should always sync with the back end
- [ ] Undo/redo icons are 90 degrees off, they should be the same as the title bar
- [ ] Icon padding in undo/redo/music icon for midi channel in midi editor is skewed to the top, the icons are top heavy
- [ ] Slide out midi form is too cramped - consider just having it be a small modal over top of the midi roll that can be dismisses instead of sliding out
- [ ] No midi instrument/patch form in the beat editor! Need this to match the piano roll
- [ ] The tiling controls on the tiled windows (mixer and timeline) are dubious and don't really do anything. Let's get rid of them and drop the code
- [ ] Selection resize handles! And visualization when hovering over the timeline of where the cursor is (e.g. a vertical line) to help with setting up selections
- [ ] Clicking the tiled window picker (mixer and timeline) renders the pop-up in the upper-left corner always, not where you would expect
- [ ] Create MacOS and Linux builds (arm64 and amd64) against 9.2 tag, fix the tag in the clone process for this repo, come up with plan for building plugins for multiple versions of ardour codebase (Let's plan to support Ardour 9.0 and newer) - and is there a free tier for github runners? How can we build this? I have a Mac but I am running from a dev container - can I mount the darwin SDK into the dev container? Help me out here. I also have an AI startup with a lab and kubernetes but this is a personal project so I probably shouldn't stand up a runner in our environment. Maybe I'll look into that


## Bugs

- [ ] Time marker (see head) doesn't align with MIDI, and it doesn't align with audio
  output. Need a stream-delay function that every real-time surface (meters,
  visualizations, seek heads) routes through — set the delay once per session,
  all displays stay consistent. Bluetooth audio stacks solve this already; crib
  from a video-jitter-buffer reference implementation.
- [ ] Loop button quirk: main loop button loops last selection when no selection active
  - Transport-bar toggle uses `controlSet("transport.looping", !loop)` (absolute boolean).
    When no explicit selection exists, Ardour's `loop_toggle()` falls back to the previous
    loop range. Want: if no selection, either no-op or hint. Timeline "Loop selection"
    button works correctly because it explicitly sends `set_loop_range` with bounds.
- [/] Flakiness on Monitoring/listening setting with multiple clients connected
  - Likely helped by the tile-leaf element-reuse fix (mixer no longer remounts on every
    store tick, which was re-running `_applyListenPref` and stacking concurrent
    `AudioListener` starts). Per-client persistence + multi-client stability still need
    verification on a live Ardour session with 2+ browsers.

## UI shape

- [ ] UX for floating windows vs tiles (tiles being core UI)
  - Track editor, plugin windows, beat editor, midi roll, and similar should be a
    different class of window than the primary interfaces. Dedicated dock lower on the
    right strip with small window indicators + quick controls (tile all open, untile,
    minimize all, unminimize all). Styled differently to show they're a separate layer;
    should always float above core windows. Consider transparency/blur on the background.
  - Optionally a tiled panel scrollable H/V containing a different view of all open
    float-class windows.
- [/] Widget-registry adoption sweep
  - `registerWidget` / `widgetTag` registries exist but most shipping components still
    hardcode tag names. Migrating to `widgetTag(...)` lookups would let alt-UIs override
    at widget granularity without forking whole views.
- [ ] - Additional UI variants (`ui-lite`, `ui-touch`, `ui-kids`)
  - Scaffolding is ready (auto-discovery via `/variants.json`, layered overlays, the
    variant registry picks by `match(env)` score). No concrete variants written yet
    beyond `ui-full`.



## Infra + ops

- [/] Serve HTTP, HTTPS, or both simultaneously
  - HTTPS solo works today (`just run-tls`, `--tls-cert/--tls-key`, or
    `server.tls_cert`/`server.tls_key` in config.yaml). Running HTTP + HTTPS concurrently
    on two sockets isn't wired yet — would need a second listener task off the same
    `AppState`.

## Undo/redo (continuation)

- [/] Extend undo-group wrapping to the remaining bulk ops
  - Wire scaffolding + nesting-depth counter: complete (`Command::UndoGroupBegin/End` +
    shim `_undo_group_depth`; mutation handlers skip their own begin/commit when a group
    is open).
  - Shim mutation handlers wrapped: `DeleteRegion`, `UpdateRegion`, `UpdateTrack`,
    `DeleteTrack`, `ReorderTracks`, `AddPlugin`, `RemovePlugin`, `AddAutomationPoint`,
    `UpdateAutomationPoint`, `DeleteAutomationPoint`, `ReplaceAutomationLane`.
    `AddNote` / `UpdateNote` / `DeleteNote` / `ReplaceRegionNotes` are *already*
    reversible via `MidiModel::apply_diff_command_as_commit` (Ardour's own pattern), so
    they don't need our wrap.
  - Client bulk-op group wrapping: `deleteSelectedRegions`, `_deleteSelectedTracks`
    (now wraps N `delete_track`s in one group), and plugin-strip cross-track drag
    (wraps add+remove in one group so the move is a single Ctrl+Z).
  - Still pending:
    - [ ] `move_plugin` end-to-end: schema has the command, server routes to a
      `backend.move_plugin()` but the backend trait method + HostBackend forwarder +
      shim `Kind::MovePlugin` handler don't exist yet. Today the drop handler on
      cross-track drag goes through add+remove (grouped), and same-track reorder still
      emits `move_plugin` which the server catches in the `not-implemented` arm. Wire
      the full path or rewrite same-track reorder as a remove+add too.
    - [ ] Rapid-fire coalesce: if the user scrubs a fader for 2s, today that's N
      separate undo steps. Option: have `dispatch.cc` keep a short time-window merger
      on `ControlSet` so consecutive writes to the same control id within ~200ms stack
      into one transaction. Separate concern from the group API.

## Long term

- [ ] Scope RBAC denials to offender + admins
  - Today `forbidden_for_role` / `auth_required` errors broadcast to every connected
    client, so a viewer can see another viewer's denial banner flash by. Clean fix: add
    an optional `target_peer_id` field to `Event::Error` (or a new admin-only
    `Event::RbacDenied`) and extend `should_forward_event` in
    `crates/foyer-server/src/ws.rs` to route denials only to the offending connection +
    LAN/admin roles. Message already names the recipient in current builds (DECISION 38);
    this is the client-scope half.
- [x] Add read-only, transport-only, and admin roles with API keys
  - Roles already config-driven (DECISION 38) but API-key-to-role mapping isn't wired.
    Shape: `roles.yaml` gains an `api_keys: {key_hash: role_id}` section; server accepts
    `Authorization: Bearer <key>` on WS handshake and resolves to the role.
- [ ] Semantic plugin search
  - Plugin picker today is substring match on name + vendor. Search by sonic description
    ("warm saturation", "long reverb tail") using a local embeddings model against the
    plugin catalog's description fields.
- [ ] Plugin snapshot system with session
  - Bundle the specific plugin binaries + presets into the session archive so a session
    opens with the same plugin state on another machine (or a shipping
    Foyer container). Export a full Foyer container that includes the plugins used
    during the session in addition to the audio. 
    - Big task, maybe defer to a DAW vendor and don't quit my day job. But containers/
    OverlayFS with split compute environment snapshots and working project files would 
    be a good fit for fixing DAW bitrot issues

## Resampler (audio ingress / egress sample-rate handling)

- [ ] Add a `foyer-audio` crate (or module in `foyer-backend`) wrapping
  `rubato::SincFixedIn` with a small `Resampler { in_rate, out_rate, channels }` helper
  that pushes/pops f32 chunks.
- [ ] Ingress: in `shim_input_port.cc` `drain_loop`, check `_sample_rate` vs
  `AudioEngine::instance()->sample_rate()`; when mismatched, hold a `rubato` instance per
  port and run captured chunks through it before `buf.read_from`. Keep the 20 ms
  frame-size invariant on the output side, not input.
- [ ] Egress: in `foyer-server/src/audio.rs` `encode_loop`, resample the shim-side PCM to
  `format.sample_rate` before Opus/raw framing — wire it between the mpsc receiver and
  the encoder's frame batcher. Same Resampler helper.
- [ ] Bit depth: not a real concern — the whole pipeline is already f32 end-to-end
  (browser `AudioWorklet`, IPC `pack_audio`, Ardour `AudioBuffer`). No conversion needed
  unless we add a `SampleFormat::S16Le` variant later.
- [ ] Handshake: extend `AudioIngressOpen` so the client can send its actual
  `AudioContext.sampleRate` (don't hardcode 48k in `audio-ingress.js:49`); shim echoes
  back the engine's rate in `AudioIngressOpened.format` so the browser knows whether to
  resize its worklet buffer.

## Known deferred

- Storing tunnel credential hashes in extended Ardour XML session metadata (currently in
  `$XDG_DATA_HOME/foyer/tunnel-manifest.json`). Rich's call: "Is this even worthwhile?
  Defer." Leave in manifest file indefinitely.
