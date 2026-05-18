# Foyer Studio — active plan

Format:
- `[ ]` open, `[/]` partial, `[x]` done. Completed entries normally
  move to the archive on the next cleanup.
- A `+` prefix after the checkbox marks an item Rich has flagged as
  priority for the current push. A `-` prefix means backburnered.

Active decisions log: [DECISIONS.md](DECISIONS.md) (currently ≥ 41
entries). Shipping-state snapshot: [STATUS.md](STATUS.md).

---

## Local monitor config
- [ ] Unify local monitoring config - add a local audio monitor in 
  addition to local MIDI monitor, show a new button on the mixer 
  that only appears when ingress is enabled on a channel that enables
  local monitoring, and have a little slider to adjust volume

## Timeline edits outstanding:
- [x] Crossfades on overlapping regions
  - Drawn as paired X-curve overlays at the lane level whenever two
    audio regions on the same track share time. The L region's
    fade-out and R region's fade-in are read directly from
    `fade_out_samples` / `fade_in_samples`; when the fades don't
    cover the whole overlap, a faint dashed tint rect hints at the
    "Snap fades to overlap" menu entry that snaps both fades to the
    full overlap in one click. Curve shape comes from each region's
    own `fade_*_shape`. (timeline-view.js
    `_renderCrossfadeOverlaysForTrack`, `_applyCrossfadeToSelection`.)
- [x] Fade-in / fade-out per region (independent of crossfade)
  - Triangular grab handles anchored at each fade endpoint inside
    the region lozenge — at the corner when no fade exists, else
    flush with the fade's inside edge. Drag inward to grow, outward
    past the corner to clear. **Alt+drag** rotates through Ardour's
    five shapes (linear → fast → slow → constant_power → symmetric).
    **Shift+click** clears that fade. The curve renders as an SVG
    path inside the region with a semi-transparent fill over the
    attenuated portion. One `update_region` per drag, on pointer-up,
    same as move/resize. (`_startFadeDrag`,
    `_renderRegionFadeOverlay`, `_renderRegionFadeHandles`.)
- [x] Region groups (linked-edit)
  - `Region.group_id` + `RegionPatch.group_id` on the schema; clients
    allocate a fresh group slug and patch every member with it
    (empty-string sentinel clears membership so no separate command
    is needed). Click any member → selection fans out to every
    sibling automatically; hold **Alt** to break the link and pick
    one. Drag / trim / resize / fade / gain / mute / delete all
    cascade to siblings (delta-per-region for position, same value
    for everything else). Visual indicator: a 3 px color bar at the
    top of each lozenge, color hashed from the group_id so siblings
    read as one unit. Menu entries: **Group regions** /
    **Add to group** / **Ungroup**. (`groupSelectedRegions`,
    `ungroupSelectedRegions`, `_expandIdsToGroups`, `_colorForGroup`,
    `_groupOf`.) Ardour `RegionGroup` shim integration is a follow-up
    — stub round-trips the field today.
- [x] Region gain handle (per-region volume)
  - Thin strip across the lozenge top — hidden at unity, visible on
    hover or whenever the gain diverges from 0 dB. Drag up/down for a
    logarithmic dB response (10 px/dB, **Shift** = fine at 50 px/dB).
    Range clamped to −60..+6 dB. Double-click resets to unity. One
    `update_region { gain_linear }` on pointer-up; local-only
    optimistic preview during the drag matches the move/fade pattern.
    (`_startGainDrag`, `_renderRegionGainStrip`.)
- [x] Nudge region left/right by grid step (arrow keys)
  - `←` / `→` nudge selected regions by the active grid sub-step
    (or 50 ms when no grid). **Shift+arrow** nudges by a beat;
    **Ctrl/Cmd+arrow** nudges by 1 sample. Wired through
    `Keybinds._onKey` in [web/ui-core/layout/keybinds.js] →
    `TimelineView.nudgeSelectedRegions`. One undo group per arrow
    press so multi-selection moves replay atomically.
- [x] Crop / trim around time selection
  - "Crop to time selection" in the region edit menu (and the global
    Edit menu's contextual Region section). Replaces each selected
    region with the slice carved by the ruler selection — adjusts
    `start_samples`, `length_samples`, AND `source_offset_samples`
    in a single patch so the audio content lines up with the new
    timeline span. Single undo entry per region.
- [x] Move/cut/copy/paste regions between same-kind tracks (audio↔audio,
    midi↔midi); cross-kind paste rejected with a friendly toast
  - Schema: optional `target_track_id` on `DuplicateRegion` and
    `DuplicateRegionRange` ([crates/foyer-schema/src/message.rs]).
    `None` = source track (back-compat). Backend trait + stub honor
    it; stub validates kind compatibility and rejects audio↔midi
    pastes server-side. UI resolves the destination track from the
    mouse Y position at paste time
    ([web/ui-full/components/timeline-view.js] `_trackAtMouseY`,
    `pasteRegions`) and pre-flights kind compatibility so an
    audio→midi paste shows a toast instead of bouncing off the
    server. The Ardour shim hasn't yet been taught to respect the
    new field — its existing same-track paste path still works. True
    audio→midi conversion (transcription / note rendering) is out of
    scope; reject is the right answer.
- [x] Add region options to the edit menu under a contextual
    section that appears only when one or more regions are selected
  - The Edit dropdown grows a "Region" / "N regions" header + the
    same action list the right-click menu surfaces (Quantize, Crop
    to selection, Snap fades to overlap, Clear fades, Reset gain,
    Glue, Reverse audio, Strip silence, Pitch shift). Driven by
    `_renderEditRegionSection` in [main-menu.js] which delegates to
    the timeline's `_regionEditMenuActions()` so behavior stays one
    source of truth.
- [x] Z-index controls for regions (layering)
  - `Region.layer` + `RegionPatch.layer` on the schema; `_renderLane`
    sorts by `(layer, dom-tiebreaker)` AND uses Lit's `repeat()`
    keyed by `r.id` so the DOM nodes physically reorder when the
    sort changes (positional reuse silently broke the first cut —
    the sort changed but Lit reused nodes in place, so layer ops
    were a visual no-op). Combined with per-region
    `isolation: isolate` (from the earlier overlap-flicker fix),
    changing layer now actually changes what the user sees in an
    overlap. Menu entries: **Bring to front / Bring forward / Send
    backward / Send to back**, each emitting one
    `update_region { layer }` per region in an undo group.
    (`_adjustSelectedRegionLayers`.) Stub round-trips today; Ardour
    `set_layer` shim integration is a follow-up.
- [x] Cross-track region drag
  - `RegionPatch.track_id` on the schema; stub honors the move
    between bucket-per-track storage via `RegionStore::move_to_track`
    and validates kind compatibility (audio↔midi rejected
    server-side). The drag's `move` handler reads the lane under the
    cursor on every pointermove (`_trackAtClientY`) and adds a
    `cross-track-pending` outline + glow when the destination
    differs and the kind matches; on pointer-up the commit patch
    includes `track_id` so the backend relocates. `RegionRemoved`
    fires for the source track so every client clears the old lane
    cleanly. Ardour shim integration is a follow-up.
- [x] Crossfade visibility in the overlap zone
  - Crossfade curves bumped to 2 px stroke with a dark drop-shadow
    halo so they read against any waveform. The overlap rectangle
    fills with a diagonal-hatch pattern (white when fades cover the
    whole overlap = clean crossfade; amber when there's a gap =
    call-to-action to "Snap fades to overlap"). A floating badge
    above the overlap names both regions and the overlap length in
    ms so the user can sanity-check the math at a glance.
- [x] Automation reimagined — overlay on the timeline + dedicated modal
  - **Overlay** ([web/ui-full/components/timeline-view.js]
    `_renderAutomationOverlay`): each track's "A" lane-head button
    toggles an SVG of color-coded polylines drawn **on top of** the
    region row, one per active automation lane. Color is fixed per
    well-known control (Gain=orange, Pan=teal, Mute=amber, Solo=red)
    and hashed from `control_id` for everything else. Hover surfaces
    a `Track → Control` tooltip; click a line opens the modal
    focused on that lane. Alpha + stroke width come from the Viz
    panel (`automationOverlayAlpha`, `automationOverlayWidth`) so
    users can dial it into the background without losing it. The
    legacy inline lane stack under the regions is gone.
  - **Modal** ([web/ui-full/components/automation-modal.js],
    `openAutomationModal`): full-window editor opened by
    double-clicking the "A" button or by clicking a polyline. Top
    bar has a track switcher dropdown so the user can move between
    tracks without closing, a **zoom slider** that writes back to
    the timeline's `_zoom` (and a `SYNC` chip), and a filter input.
    Pan/zoom is **always synced with the timeline** via a low-cost
    rAF watcher — panning in the modal pans the timeline and vice
    versa. A shared ruler across the top of the editors panel shows
    seconds + adaptive minor ticks at whatever the synced zoom is.
  - **Legend** is a tree of expandable sections — *Core* (Gain /
    Pan / Mute / Solo) at the top, then one section per plugin on
    the track. Each section header has a chevron + a **master
    checkbox** with proper indeterminate state (set imperatively in
    Lit's `updated()` since the attribute isn't declarative). Click
    master → check/uncheck every enabled child. Section bodies
    collapse/expand on click; state persists per track in
    localStorage. Plugin-param rows render disabled with a "soon"
    tag until the shim ships them.
  - **Plugin parameter automation is real** (third time it was
    asked for, finally landed). The stub seeds an `AutomationLane`
    per Parameter on every track — core (gain/pan/mute/solo) AND
    every plugin param ([crates/foyer-backend-stub/src/fixtures.rs]
    `empty_lane`). The wire commands (`add_automation_point`,
    `set_automation_mode`, `update_automation_point`,
    `delete_automation_point`, `replace_automation_lane`) now
    broadcast `Event::TrackUpdated` after every mutation
    (`broadcast_track_for_lane`) so every connected client sees the
    change land — previously the stub mutated silently. The modal
    legend drops the "soon" / disabled treatment; plugin params
    show their live point counts in the legend like core lanes do.
    Default-visible set stays at core only (a track has 22+ plugin
    params; defaulting them all visible would bury the user); they
    opt in via the legend checkbox.
  - **Waveform behind each editor card** — `foyer-waveform-gl` per
    region rendered at the same x scale as the lane SVG, dimmed to
    35% so the automation polyline stays readable on top. Peaks
    come from the active timeline-view's `WaveformCache` via
    deep-find; the existing rAF sync tick pushes fresh peaks on
    every frame. Lets users align automation moves to audible
    events without flipping back to the timeline.
  - **Vertically resizable editor cards** — native CSS
    `resize: vertical` on each `.card-body`, default 120 px / max
    600 px / min 60 px. The lane's internal coordinate math reads
    `host.offsetHeight` (with a `ResizeObserver` to re-render on
    drag) instead of a hardcoded 48 px, so taller cards give finer
    dB-per-pixel control on continuous params (the original "gain
    snaps almost always" complaint — it was just 1.65 dB/px on a
    -60..+6 range at the default 48 px lane height).
  - **Selection UX**: Shift+click on a point toggles it in the
    multi-selection (additive to the existing Cmd/Ctrl marquee).
    A `?` chip in each lane header surfaces all the gestures
    (free-draw, marquee, shift-click, alt-click) on hover.
  - **Per-lane editor** ([automation-lane.js]) reworked from
    Ardour's clunky model:
    · **Per-region endpoints**: when a control transitions from
      `off` → any active mode and points is empty, the lane auto-
      seeds a point at every region edge (start + end of each
      region on the track) at the current value, wrapped in one
      undo group. Endpoints render as squares with a `▶` / `■`
      glyph so the user can grab them directly to adjust the
      value at t=region-start without faking it with a new point.
    · **Discrete / state-machine inference**: `Parameter.kind` of
      `trigger` / `enum` / `discrete` (plus the muted/solo fallback)
      flips the curve to **stepped rendering** (horizontal-then-
      vertical at each transition) and snaps drag values to the
      nearest allowed option. A `N-state` chip in the lane header
      makes the discrete behavior visible at a glance.
    · **Alt+click on a point** → delete it (faster than right-click
      for mouse-only workflows).
    · **Click+drag on empty grid** → **pen mode**: a free-draw
      stroke that samples points at ~6 px intervals and commits
      them as a single `replace_automation_lane` (one undo entry).
    · **Cmd/Ctrl+click+drag** → **marquee select**: rubber-band
      picks every point inside; drag any selected point to move
      the whole set; Backspace / Delete clears the selection in
      one undo group; Escape cancels.
    · Region list + Parameter struct are passed down from the
      modal so the lane has everything it needs to render
      endpoints + snap to states without round-tripping the
      session snapshot.
  - **Patch picker rework** ([automation-modal.js]
    `_renderPatchPicker`): the bank/program/channel three-prompt
    chain was replaced by a single floating panel anchored inside
    the modal. Channel + bank dropdowns up top (bank options come
    from MIDNAM via `list_midi_patch_names` so each entry shows
    its instrument name); a search box filters across every program
    in every bank by name, bank, or program number; a scrolling
    program list renders one row per patch with the instrument name
    visible. Clicking a row selects (Save commits, double-click
    saves immediately). The picker seeds new add-flows from the
    last committed `{channel, bank, program}` so dropping multiple
    copies of the same patch around a track stays one-click.
  - **Lane-head sits above every overlay**: the sticky `.lane-head`
    z-index was raised from 2 to 10 so wide crossfade badges +
    long automation polylines no longer paint into the track-
    header strip at the scroll origin (the long badge text was
    `transform: translate(-50%)` to its own width — when the
    overlap zone sat near sample 0, the badge extended well left
    of `HEAD_WIDTH` and visibly straddled the head). Companion to
    the existing per-region `isolation: isolate` rule.
  - **Layer ops actually layer in Ardour now**: `RegionPatch.layer`
    was wired through the shim ([shims/ardour/src/dispatch.cc]
    new `patch_layer` field + `Playlist::set_layer` call inside
    `UpdateRegion`, plus a `StatefulDiffCommand` on the playlist
    so Ctrl+Z undoes the layer move). `RegionDesc.layer` is now
    populated from `Region::layer()` and emitted in
    `emit_region_map` so the FE's `(layer, source-order)` sort
    reflects what Ardour paints. The FE got an optimistic
    in-place layer update so the visual reorder happens on the
    pointer-up instead of waiting on the round-trip — this was
    the immediate root cause of "bring to front does nothing"
    against the previous shim (echo carried the old layer and
    snapped the sort back).
  - **Right-click adds "Automation editor…"**: the region context
    menu and the lane-head context menu both surface the entry,
    each pointing at `_openAutomationModal(track_id)`. Was only
    reachable via double-click on the "A" lane button before.
  - **Gesture chips no longer absorb pointer events**: the
    automation-lane header chips (`draw`, `⌘drag = pick`,
    `⇧click = add`, `drag = move`, `⌥click = del`) dropped their
    `cursor: help` + `title` tooltips and got `pointer-events:
    none` on the bar. They're still visible as documentation but
    a free-draw stroke that starts near the header now passes
    through the chip onto the lane instead of getting eaten by
    the chip's hit area.


## Ingress drain — port off MasterTap dependency

- [ ] Loop button quirk: main loop button loops last selection when no selection active
  - Transport-bar toggle uses `controlSet("transport.looping", !loop)` (absolute boolean).
    When no explicit selection exists, Ardour's `loop_toggle()` falls back to the previous
    loop range. Want: if no selection, either no-op or hint. Timeline "Loop selection"
    button works correctly because it explicitly sends `set_loop_range` with bounds.
- [/] Flakiness on Monitoring/listening setting with multiple clients connected
  - Tile-leaf element-reuse fix (no more remount-on-tick) + per-peer
    `PeerAudioPrefs` (each peer's manual capture offset is isolated)
    + Primary-only audio gate (Secondary windows can't open a competing
    listener stream) all address known stacking failure modes. The auto-start
    on a fresh client now bails on Secondary connections so the "open a
    second tab and the listener thrashes" failure mode is closed.
    Per-client persistence + multi-client stability still need verification on
    a live Ardour session with 2+ browsers — can't bench-test from this side.

## UI shape

- [x] Multi-window/multi-monitor support
  - Shipped 2026-05-12 on `feature/drift-take-2`:
    · `ConnectionRole` (Primary/Secondary) + per-connection `connection_id` + reusable
      `peer_id` via `?parent=` (`crates/foyer-schema/src/message.rs`,
      `crates/foyer-server/src/ws.rs`). Server gates `audio_*` commands on
      Primary; Secondaries are control-plane only.
    · `multiWindow` singleton + `BroadcastChannel("foyer:<peer_id>")` for sibling
      sync + pane-handoff transport (`web/core/multi-window.js`).
    · "Identify" overlay flashes "Window N" on every sibling — analogous to
      macOS Identify Displays (`web/core/multi-window-identify.js`).
    · Send-to-window items on tile-leaf AND foyer-window context menus
      (`web/ui-core/layout/tile-leaf.js`, `web/ui-core/widgets/window.js`).
    · `windowRestore` persists per-display-fingerprint slot positions; auto-reopens
      children on Primary boot; live-only slot allocation, forget-on-close,
      boot-time prune, "Forget saved windows" reset in Preferences
      (`web/core/window-restore.js`).
    · Spawner moved out of the status bar into Preferences → Windows + global
      `Ctrl+Alt+W` (Mac users hit the same chord — `Cmd+Alt+W` left alone to
      avoid the "close all windows" conflict).
  - Follow-ups deferred: per-slot persistence for floating-widget windows
    (`foyer.window:<key>` still keys on storageKey + sessionScope only — two
    primaries on different monitors share their plugin float positions), and
    a "promote secondary to primary" path when the spawning window closes
    with audio mid-flight (today: audio just drops).
- [x] Once over on floating widgets layer versus tile layer, adding auto-tile layouts
    for tile layer, make sure z-indexes for pop-outs make sense, remove nonsense or
    old controls
- [x] Drop original "share" dialog and share button from main menu
- [x] Sequencer - clicking on an arrangement cell navigates the timeline to
  that cell. Add arrangement-relative looping functionality so you can select
  part of the arrangement and loop it as if it were arbitrary on the timeline
  - Plain click on a cell now toggles the slot AND emits `locate` to the
    bar's timeline-absolute sample position
    ([beat-sequencer.js](../web/ui-full/components/beat-sequencer.js)
    `_onArrCellClick` + `_barToTimelineSamples` + `_samplesPerBar`). Shift-
    click sets the loop range from the last-clicked bar to the current bar;
    alt-click loops just that bar. The arrangement header gets a "Loop arr"
    button that loops the full populated arrangement (`_loopArrangement`).
- [ ] Sequencer view writes a fresh starter layout back to the backend on
  mount, clobbering whatever was just persisted. Reproduces by setting a
  layout via `sequencer.set_layout` (MCP) and then opening the beat-sequencer
  tile in any browser tab — round-tripping `sequencer.show` immediately
  before/after the mount shows the persisted "Groove" pattern being replaced
  with the auto-generated `Pattern 1` + extended row set. Fix: mounting
  should be read-only against the region; only explicit user edits inside
  the grid should emit `set_sequencer_layout`. Component: `foyer-beat-sequencer`
  in `web/ui-full/components/beat-sequencer.js`.
- [ ] Sequencer layout `note_count` is 0 after a successful `set_layout` with
  non-empty cells. The set call reports `(N cell+note events)` but the
  subsequent `sequencer.show` reads `note_count: 0` from the region snapshot,
  suggesting the shim either isn't expanding the layout into MIDI notes or
  isn't updating `region.notes` until a follow-up event. Check
  `expand_sequencer_layout` plumbing on the Ardour shim side; the FE-only
  stub backend may behave differently than the live ardour shim and that's
  worth a side-by-side.
- [x] Large resizable bottom scroll area with zoom and scrub and track high levels
   like ardour, that is really well done
- [x] The + launcher should have other windows from the main menu - audio pool,
   midi devices, on screen keyboard, remote access, preferences, group manager
   maybe organized by theme?
- [x] FAB is dragged around by the window handle, but the window isn't dragged
   around by the FAB. 
- [x] Dragging the FAB over the dock sometimes show it will land in the dock, but
   not reliable and releasing it even with the lit up landing area doesn't 
   dock the FAB
- [ ] Native GUI for plugins and instruments via xpra stopped working at some 
  point, need to fix. It worked before!
- [ ] Make vertical sizing limits for individual channels higher than the 400 px or
  what ever it is right now - in fact, a maximize channel button where the 
  single channel and its waveform take up the entire tiemline view would be dope

## Infra + ops

- [x] Serve HTTP, HTTPS, or both simultaneously
  - HTTPS solo works today (`just run-tls`, `--tls-cert/--tls-key`, or
    `server.tls_cert`/`server.tls_key` in config.yaml). Running HTTP + HTTPS concurrently
    on two sockets isn't wired yet — would need a second listener task off the same
    `AppState`.


## Long term
- [x] Scope RBAC denials to offender + admins
  - `Event::Error` grew an optional `target_peer_id` field
    ([crates/foyer-schema/src/message.rs]); when set, `should_forward_event`
    in [crates/foyer-server/src/ws.rs] forwards the event only to the
    matching peer's connection(s) plus LAN connections and tunnel roles
    that hold `tunnel_create_token` (the same admin proxy used for
    tunnel-admin events). All three "addressed at the offender"
    denial sites — `secondary_window_audio`, `auth_required`,
    `forbidden_for_role` — fill it with the dispatching connection's
    `peer_id`. Every other Error broadcast keeps `target_peer_id: None`
    (session-wide). The field is `#[serde(default, skip_serializing_if =
    "Option::is_none")]` so legacy clients see the same wire shape and
    new clients can be added without a schema bump beyond the additive
    field. Companion to DECISION 38 (message-side recipient naming).
- [ ] Semantic plugin search
  - Plugin picker today is substring match on name + vendor. Search by sonic description
    ("warm saturation", "long reverb tail") using a local embeddings model against the
    plugin catalog's description fields.
- [/] Plugin snapshot system with session
  - Bundle the specific plugin binaries + presets into the session archive so a session
    opens with the same plugin state on another machine (or a shipping
    Foyer container). Export a full Foyer container that includes the plugins used
    during the session in addition to the audio. 
    - Big task, maybe defer to a DAW vendor and don't quit my day job. But containers/
    OverlayFS with split compute environment snapshots and working project files would 
    be a good fit for fixing DAW bitrot issues
      - WIP got the basics done, conceptually it would work but it needs to be tested
      and further refined

## AI Agent
- [/] AI Agent harness — Rust-first (see DECISIONS.md 48-51)
  - [x] `foyer-agent` crate: conversation, LLM client, engine loop, tool dispatch,
        autonomy gate, filesystem store under `$XDG_DATA_HOME/foyer/agent/{skills,memory,templates}/`
  - [x] `foyer-mcp` crate exposing the same tool registry over stdio + Unix socket
        + streamable HTTP (per the wishlist, on a separate port so deployments can
        firewall the MCP surface independently)
  - [x] Polymorphic tools (one per domain, `subcommand` discriminator inside args):
        `welcome`, `transport`, `mixer`, `tracks`, `regions`, `automation`, `plugins`,
        `midi`, `session`, `visualize`. The `welcome` tool is the priming surface
        external MCP agents (Claude Code, Cursor) must call first to load Foyer's
        system prompt + enabled skills + memory.
  - [x] Schema: `Event::Agent*` (Message / Token / ToolUpdate / History / State /
        SkillsListed / MemoriesListed / TemplatesListed) + 14 `Command::Agent*` (Send /
        Stop / ClearHistory / SetAutonomy / SetConfig / ConfirmTool / HistoryRequest +
        skill / memory / template management).
  - [x] Server wiring: `AppState.agent: RwLock<Option<Arc<AgentRuntime>>>`, all
        agent commands dispatched in `ws::dispatch_command`, forwarder task
        translates `AgentEvent` → schema `Event::Agent*` for fan-out, foyer-cli
        attaches at boot.
  - [x] WebLLM bridge — zip-ties pattern (DECISION 49): browser registers itself
        as an OpenAI-compatible "endpoint" at `/llm/v1/*` via `/ws/webllm`, the Rust
        harness sees it as a regular HTTP endpoint identical in shape to Anthropic /
        OpenAI / Ollama. Same config surface across all providers.
  - [x] Browser FAB unparked: `agent-panel.js` dispatches `agent_send` and renders
        `agent_message` / `agent_token` / `agent_tool_update` / `agent_state` events
        into the existing transcript UI; settings modal carries autonomy toggle
        (Safe/Trust/Yolo, per-session per DECISION 51), skills picker, memory viewer.
  - [x] Visualization tools — both renderers wired. The `visualize` tool prefers
        the FE-attached path (`Event::AgentRenderRequest` round-trip; the browser's
        [viz-capture.js](web/core/viz-capture.js) deep-finds the requested viz and
        captures via canvas.toBlob / SVG-to-canvas) and falls back to the headless
        path (`chromiumoxide` driving a chromium subprocess against `/?subcommand=…`;
        [headless-viz.js](web/core/headless-viz.js) swaps the layout to a single
        full-window tile and signals `data-foyer-viz-ready`). Headless is gated by
        the `headless-render` cargo feature (default on); when chromium isn't on
        PATH the error string carries platform-specific install commands.
  - [/] Backend-side spectrography (instant + temporal, per-channel + main mix)
        through the shim — wire surface, stub producer, FE widget, MCP tool all
        landed. Ardour shim's FFT pipeline itself is still TBD.
        - Schema ([spectrum.rs](../crates/foyer-schema/src/spectrum.rs)):
          `SpectrumFrame { target, bins, sample_rate, window, min_db, channels[],
          server_mono_ns }`, `SpectrumOpts { fft_size, hop_size, window, min_db,
          max_bins, per_channel }`, `SpectrumTarget { master | monitor |
          track{id} }`, `SpectrumCapabilities { available, fft_sizes[],
          windows[], max_frame_rate_hz }`. Session snapshot carries the caps
          inline so the FE gates its UI off `session.spectrum.available`.
        - Backend trait ([foyer-backend/lib.rs](../crates/foyer-backend/src/lib.rs)):
          `spectrum_capabilities`, `subscribe_spectrum`, `unsubscribe_spectrum`,
          `snapshot_spectrum`. Defaults return Unsupported.
        - Stub backend
          ([foyer-backend-stub/src/spectrum.rs](../crates/foyer-backend-stub/src/spectrum.rs)):
          synthesises plausible frames at 50 Hz — pink-ish noise floor + one
          tone per track (id-derived freq, slow sweep) so the waterfall has
          visible motion. Per-track gain attenuates the peak; muted tracks
          drop out. Master/monitor sum the tracks; Track{id} renders just
          that one.
        - Server WS ([foyer-server/ws.rs](../crates/foyer-server/src/ws.rs)):
          dispatch arms for `subscribe_spectrum` / `unsubscribe_spectrum` +
          fan-out of `Event::SpectrumFrame` / `SpectrumSubscribed` /
          `SpectrumUnsubscribed`.
        - FE widget
          ([web/ui-core/viz/spectrum.js](../web/ui-core/viz/spectrum.js)):
          `<foyer-spectrum>` renders bars (current frame) + log-y waterfall
          history on 2D canvas with a magma colour ramp. Tile wrapper
          ([web/ui-full/components/spectrum-tile.js](../web/ui-full/components/spectrum-tile.js))
          adds a source picker (Master / Monitor / per-track).
          [viz-capture.js](../web/core/viz-capture.js) +
          [headless-viz.js](../web/core/headless-viz.js) updated to mount
          the new widget for `visualize.spectrogram` and wait for the
          waterfall to fill before capturing.
        - MCP tool
          ([foyer-agent/tools/spectrum.rs](../crates/foyer-agent/src/tools/spectrum.rs)):
          `spectrum.capabilities` (probe host) + `spectrum.snapshot` (one
          FFT frame returned as JSON, per-channel dBFS bins). `visualize.spectrogram`
          continues to return the waterfall PNG.
        - Ardour shim ([dispatch.cc](../shims/ardour/src/dispatch.cc) +
          [msgpack_out.cc](../shims/ardour/src/msgpack_out.cc)): subscribe /
          unsubscribe dispatch arms wired; today they emit a polite "FFT
          pipeline not yet shipped" `Event::Error` and the snapshot carries
          `spectrum.available=false` so the FE hides the analyser surfaces.
          Implementing the real path means: tap the destination Route's
          outputs through a per-subscription disk-thread analyser, run a
          Hann-windowed FFT every hop, and emit `encode_spectrum_frame`
          from a low-priority idle slot.
        - Playwright spec
          ([spectrum.spec.js](../tests-ui/specs/spectrum.spec.js)) covers
          cap advertisement, subscribe → frame stream → unsubscribe
          round-trip, and tile-view mount with non-blank waterfall pixels.
  - [x] Fuck ton of `.unwrap()` with dubious error handling - lock this down so we
    have a minimally panicky app, use `.unwrap_or_else()`, `.expect()` with a value,
    or more robust pattern matching
    - Audited 20 production-path `.unwrap()` calls across `foyer-server`,
      `foyer-backend-host`, and `foyer-cli`. Every Mutex `.lock().unwrap()`
      got an `.expect("<mutex name> not poisoned")` so a poisoned lock now
      reports which subsystem panicked first. The "constant addr parse"
      sites (`"127.0.0.1:3838".parse().unwrap()`) became
      `.expect("hardcoded default socket addr is statically valid")`.
      The unreachable-after-loop unwrap in `plugin_gui_ws` became a `match
      tcp` that closes the WS cleanly on the impossible-but-now-handled
      None branch. `pick_single` in `foyer-backend-host::discovery` uses
      `pop()` + `ok_or` instead of `into_iter().next().unwrap()`.
      `session_scrub`'s quarantine drain documents the depth-zero
      invariant with `.expect("quarantine state must be Some at depth-zero end")`.
      Test code (138 unwraps in `#[cfg(test)]` modules) intentionally
      left alone — panicking on test-time setup failures is the right
      call there.
  - [x] One of the hardest parts of DAWs is the insane number of controls, even for a very stripped down one like this one. We need a tool that the agent can call that takes a screencapture of exactly what the user sees so the agent can guide them on what to click or drag where to achieve a goal
  - [x] Scripting editor - support DAW scripting in a generic fashion, look at Ardour's
        lua support, expose tools for all layers bidning to what Ardour exposes, query
        the active shim on start up so we can limit the the available scripting to what
        is in the DAW, but make this binding work.
        - Shim-declared surface landed
          ([scripting.rs](../crates/foyer-schema/src/scripting.rs)): `Session.scripting`
          carries `ScriptingCapabilities { languages, script_types, hooks, features }`.
          The Backend trait grew `scripting_capabilities` / `list_scripts` / `save_script`
          / `delete_script` / `enable_script` / `run_script` /
          `recover_disabled_scripts` with default-empty impls; the stub advertises an
          Ardour-shaped surface (DSP / EditorAction / EditorHook / SessionScript /
          SessionInit / Snippet × Lua) so the FE iterates against it today. WS dispatch
          + on-attach `Event::ScriptList` push are wired in
          [foyer-server/src/ws.rs](../crates/foyer-server/src/ws.rs); host backend +
          IPC bridge is wired in
          [foyer-backend-host/src/client.rs](../crates/foyer-backend-host/src/client.rs)
          and [foyer-backend-host/src/lib.rs](../crates/foyer-backend-host/src/lib.rs).
        - FE primitive
          ([code-editor.js](../web/ui-core/widgets/code-editor.js)): `<foyer-code-editor>`
          is a contenteditable highlighted editor; hljs + the requested grammar are
          lazy-loaded (vendor at
          [web/vendor/highlight/hljs-lua.min.js](../web/vendor/highlight/hljs-lua.min.js)).
          Adding a future grammar is one entry in `LANG_URLS`.
        - FE manager
          ([scripts-view.js](../web/ui-full/components/scripts-view.js)):
          two-pane list + editor, hook picker for hookable types, args grid for
          `takes_args` types, disabled-on-upload banner, run-output log. Right-dock
          launcher gets a `Scripts` entry; suppressed when the active backend doesn't
          advertise a scripting surface
          ([right-dock.js](../web/ui-full/components/right-dock.js)).
        - Agent surface
          ([scripts.rs](../crates/foyer-agent/src/tools/scripts.rs)):
          new `scripts` polymorphic MCP tool with subcommands `capabilities`, `list`,
          `get`, `save`, `delete`, `enable`, `run`, `recover_disabled`. Validates
          script_type / language / hook against the live caps so a typo errors
          instead of silently saving a broken record.
        - Playwright spec
          ([scripts-panel.spec.js](../tests-ui/specs/scripts-panel.spec.js))
          covers cap surface + save/list/run round-trip + custom-element mount.
        - Ardour C++ shim landed: the snapshot's `scripting` field is emitted by
          [msgpack_out.cc](../shims/ardour/src/msgpack_out.cc)
          (`emit_scripting_capabilities`); the bridge to Ardour's Lua VM lives in
          [schema_map.cc](../shims/ardour/src/schema_map.cc). `save_script` calls
          `Session::register_lua_function(name, body, params)`, `delete_script`
          calls `unregister_lua_function`, `run_script` validates with
          `LuaScripting::try_compile`. A process-wide `ScriptStore` caches the
          metadata (body, args, hook, type, language) that Ardour's bookkeeping
          loses. Dispatch arms for all six commands are wired in
          [dispatch.cc](../shims/ardour/src/dispatch.cc).
        - Outstanding (follow-ups):
          - One-shot script invocation: `run_script` compiles cleanly via
            `LuaScripting::try_compile` but doesn't actually call the factory
            yet. Wiring the real execution path means walking through
            `LuaInstance` (gtk2_ardour) or duplicating enough of its dispatch
            into the shim to fire the factory in the same Lua state.
          - DSP-type instantiation: a `script_type=dsp` save caches the body but
            doesn't yet register a luaproc plugin source — a follow-up
            `plugins.insert` referencing the cached id should translate to one.
          - `<Script>` base64 recovery: `Session::state()` / `get_state()` are
            private in libardour, so the recovery path needs to read the .ardour
            file off disk (via `session.path()`) and parse the XML directly. The
            shim returns a placeholder entry that explains this to the user
            until that lands.
          - Script-manager FAB: surface scripts in the chat agent's quick
            actions so the agent can show what's installed without a separate panel.

        

- [x] MCP tools — implemented as 10 polymorphic tools with subcommands (DECISION 50)
- [x] Agent's native tools mapped to MCP tools but without MCP overhead — same
      `ToolRegistry` is dispatched directly from `AgentEngine` (no serialization
      hop) and exposed verbatim through `foyer-mcp` for external consumers
- [x] Back end vs front end split mapped — everything except live DOM-rendered
      visualizations lives in Rust and is reachable via MCP for external agents
- [x] Expose the in-process agent as an OpenAI-compatible upstream
  - Add an HTTP surface at `/v1/*` so external apps (Cursor, OpenWebUI,
    custom Python clients, etc.) can treat Foyer as a regular OpenAI
    endpoint and inherit the full agent — tool registry, system prompt,
    skills/memory, autonomy gate. Each request runs in a transient
    conversation so the FAB's persistent transcript isn't polluted.
    - `POST /v1/chat/completions` — accepts an OpenAI chat request,
      replays the prior `messages[]` as a transient `Conversation`
      (importing user/assistant turns + any image/audio content blocks
      as `AgentAttachment`s), then runs the agent loop. Streaming (SSE)
      AND non-streaming both supported. Forwards content tokens to the
      caller as standard `delta.content` chunks; tool calls + tool
      results execute INSIDE Foyer and are invisible to the caller
      (they want a smart chatbot, not raw tool plumbing). On stream
      the caller sees Foyer's content stream from every internal round
      concatenated, then `[DONE]`.
    - `GET /v1/models` — advertises a single `foyer-agent` model so
      clients that probe the model list before connecting see exactly
      one entry and don't have to guess at a model id.
    - Multi-modal in: parse OpenAI content arrays (`{type: "text"}` +
      `{type: "image_url"}` + `{type: "input_audio"}`) → text body +
      `Vec<AgentAttachment>`. Both images and audio get forwarded to
      the upstream LLM via the multi-modal path in `record_to_llm`
      (audio as `input_audio` blocks matching the gpt-4o-audio
      convention). Models that don't speak a modality drop the block
      silently — no client-side gating on provider capabilities.
    - Multi-modal out: tools that produce media (e.g. `visualize`'s
      PNG renders) surface their output as outbound attachments on
      the assistant response. Convention: a tool returns the bytes
      via `ToolResult.image_png_b64` OR via a
      `data.attachments: [{name, mime, b64}]` array — both shapes
      are scraped by the proxy's sink and emitted as
      `ExternalChatStreamEvent::Attachment`. The HTTP layer renders
      each attachment two ways simultaneously: a markdown reference
      (`![…](data:…)` for images, `<audio controls src="data:…">`
      for audio) inlined into `delta.content` so plain-text clients
      see something, and a structured block (`image_url`,
      `input_audio`, or a fallback `file` shape) in either
      `message.content` (non-streaming) or
      `delta.foyer_attachments` (streaming) so multi-modal-aware
      clients can pull the raw bytes without re-decoding the data URL.
    - Auth: optional Bearer token on the exposed endpoint. When
      `agent.api_key` is unset everywhere, the endpoint is open
      (loopback-only is the operator's responsibility). When set, every
      `/v1/*` request requires `Authorization: Bearer <key>`.
    - Config sources (priority CLI > env > config.yaml > store >
      default), applied at boot via a non-persisting `apply_boot_overrides`
      on `AgentRuntime` so an env var doesn't quietly rewrite what the
      FAB user saved last:
      · upstream endpoint — `--agent-upstream-endpoint`,
        `FOYER_AGENT_UPSTREAM_ENDPOINT`, `agent.upstream_endpoint`
      · upstream model — `--agent-upstream-model`,
        `FOYER_AGENT_UPSTREAM_MODEL`, `agent.upstream_model`
      · upstream API key — `--agent-upstream-api-key`,
        `FOYER_AGENT_UPSTREAM_API_KEY`, `agent.upstream_api_key`
      · exposed (our) API key — `--agent-api-key`,
        `FOYER_AGENT_API_KEY`, `agent.api_key`
    - Lives in `crates/foyer-agent/src/openai_proxy.rs` (transient
      conversation + engine wiring) with the axum routes in
      `crates/foyer-server/src/openai_proxy.rs` (router, auth layer,
      SSE plumbing) — matches the split used for the WebLLM bridge.

## Feature improvements from Ardour MCP review

Notes from a walk through Ardour 9.4's `mcp_http` tool catalog
(`ext/ardour-github-main/libs/surfaces/mcp_http/tools_json.inc`,
~90 tools across session/transport/markers/tracks/sends/plugins/
regions/MIDI). Foyer's high-level tools cover the everyday workflow
and we already proxy Ardour's surface lazily via `daw_proxy`, but
there are categories of feature both we and Ardour-via-proxy do
worse than we could. Items below are ordered by impact-per-day-of-
work, not strict priority.

Foyer and Ardour cover different ground. Ardour brings 25+ years
of professional-engine maturity — the real-time audio graph, the
plugin host, the .ardour session format, the tempo map, the
control-protocol substrate that Foyer's shim plugs into. Foyer's
contribution sits on top: **beat sequencer, real-time spectrum
analyser, agent-driven visualization, UI automation, multi-session
coordination, OpenAI-compat agent proxy, web-native control
surface**. Where Ardour already covers a workflow well we proxy
through to its native surface via `daw_proxy` instead of
re-implementing; this section is about lifting Ardour's lower-level
primitives into Foyer's friendlier abstractions for users who
aren't already DAW-fluent.

### Polymorphic time arguments — one tool, sample-OR-BBT

- [ ] Refactor every Foyer tool that takes a time component to
  accept EITHER samples/seconds OR BBT (`{bar, beat, tick}`), with
  exactly one provided. Ardour's `mcp_http` recently split each
  multi-form tool into two explicit variants (`_sample` + `_bbt`)
  — a defensible call given how some LLM clients trip on
  discriminated-union input schemas. Foyer's smaller surface lets
  us keep one tool per operation if we lean on a `oneOf` JSON-
  schema branch and validate server-side. Touched surfaces:
  - `transport.locate` (today: `samples: u64`)
  - `regions.create` (today: `at_samples`, `length_samples`)
  - `regions.move` / `duplicate` (today: `start_samples`)
  - `automation.add_point` / `update_point` (today: `time_samples`)
  - `midi.note_add` / region-create variants (today: ticks-only)
  - `markers.add` (when sections land, below)
  - `session.locate_to_section` / similar
  - Schema shape (proposed): `time: { samples?: u64, seconds?: f64,
    bbt?: { bar: u32, beat: u32, tick: u32 } }` — server picks
    whichever non-null field is set, errors on multiple. Live tempo
    map drives the conversion server-side so the agent doesn't need
    to know the session BPM.
  - Why this matters: musicians + AI agents both think in BBT,
    audio engineers think in samples/seconds. Locking the schema
    to one or the other has been a recurring pain point. The
    polymorphic argument lets each caller use whatever's natural
    for the task at hand without tool sprawl.

### Track + region creation: "what plays through this?" in one shot

- [ ] **`tracks.create_with_instrument`** path — extend the existing
  `tracks.create` to atomically accept an instrument selection +
  optional patch (program / channel / GM map). Today the flow is
  three commands: `tracks.create` → `plugins.insert(instrument_uri)`
  → `midi.set_patch`. Collapse to one undo group + one round trip.
  Schema-side that's already half there (`instrument_uri` /
  `plugins[]` / `copy_from_track_id` on `Op::Create`); needs a
  `gm_program?: u8` / `channel?: u8` extension on the same op.
- [ ] **UI prompt on first edit of an empty MIDI track** — when the
  user opens the piano roll / beat sequencer on a MIDI track with
  no instrument inserted, surface a modal: "This track has no
  instrument. Pick one before recording / playing." Drop-down
  lists `gmsynth` (default, with GM-program picker), the user's
  installed synth plugins (read from `plugin.list_available`), and
  "I'll add my own later" (closes the modal). The piano roll renders
  read-only until either an instrument is present OR the user
  explicitly opts in. Matches the existing midi-track-setup skill
  the agent already knows — this lifts it into the UI for
  non-agent workflows.
- [ ] **Bulk MIDI region + notes in one call** (mirror Ardour's
  `midi_note_import_json_to_new_region_*`). `regions.create_midi`
  grows an optional `notes: [{pitch, on_beat, off_beat, velocity}]`
  array; when set, the region is created AND populated atomically.
  Same pattern for `sequencer.create_region_with_pattern` for the
  beat-sequencer flow. One undo entry.

### Plugins: parameters at insert time, addressable by name

- [ ] **`plugins.insert` accepts a `params: [{name | index, value}]`
  array** so an LLM can ship a fully-configured plugin in one
  call. Today: insert, then per-param `set_parameter`. Each round
  trip is a turn the agent doesn't have.
- [ ] **Address parameters by control name** alongside index. Mirror
  Ardour's `plugin_set_parameter_by_control_value/_interface` —
  expose both `name` (display label or symbol) and `index` on
  every parameter setter. Index is stable; name is human-readable
  and what the agent will pick first if both are documented.
- [ ] **`plugins.describe(track_id, plugin_id)` returns the full
  parameter graph** including current values, ranges, units,
  enum labels, scale curve. Foyer already has all this on the
  schema; the agent tool surface just doesn't expose a per-plugin
  read. Cheap addition; high agent value.

### Mixer scenes (NEW — Foyer has zero today)

A "mixer scene" is a snapshot of every track's fader / pan / mute /
solo / send levels, named and saved with the session. Recall flips
the entire mix state in one operation. Common live + production
use case (verse balance vs chorus balance, A/B comparison of
mixes, recall a starting point after deep edits).

- [ ] Schema (`crates/foyer-schema/src/mixer.rs` new):
      `MixerScene { id, name, color?, created_at, snapshots: [{
        track_id, gain_db, pan, mute, solo, send_levels_db: [{
        target_track_id, db }] }] }`. Session carries
      `Vec<MixerScene>` + an optional `active_scene_id` (the last
      one recalled — UI shows a "drifted from <name>" indicator
      when current state diverges).
- [ ] Backend trait — `store_mixer_scene(name, color?)`,
      `recall_mixer_scene(id)`, `list_mixer_scenes`, `delete_mixer_scene`,
      `rename_mixer_scene`. Stub stores in `Session.mixer_scenes`;
      Ardour shim wraps `Session::store_mixer_scene` / `recall_mixer_scene`
      (Ardour ships these natively — `daw_proxy` already exposes
      them).
- [ ] Agent tool — `mixer.store_scene(name, color?)`,
      `mixer.recall_scene(id|name)`, `mixer.list_scenes`,
      `mixer.delete_scene`. Use the same schema for natural language
      ("recall the chorus scene").
- [ ] UI — a compact scene strip docked above the mixer:
      one chip per scene with a colored swatch; click to recall,
      right-click for rename/delete/duplicate; a "Store…" button
      next to the chip row prompts for a name. "Drifted" indicator
      when the active scene's snapshot differs from current
      controls (compare-by-value, tolerance ~0.1 dB).

### "Sections" — replacement for markers / ranges / auto-loop / auto-punch

Traditional DAWs expose four distinct primitives for what is
fundamentally one concept ("a named span of time you do something
to"):
- **Cue marker**: 0-length, named, navigation only ("Verse 1")
- **Range marker**: span, named, navigation only
- **Auto-loop range**: a hidden, special-cased range that the
  transport loops over when Loop is on
- **Auto-punch range**: another hidden, special-cased range that
  records-arm becomes active inside of

The cognitive load is way out of proportion to the underlying
data model. Users who don't live in DAWs read "auto-punch" and
ask what they did wrong.

Foyer's proposal — collapse all four into ONE primitive: **Section**.

- [ ] Schema:
      ```
      Section {
        id, name, start_samples, end_samples: Option<u64>, color,
        flags: { is_loop_target, is_punch_target, is_navigation }
      }
      ```
      - `end_samples = None` → 0-length cue (replaces "cue marker")
      - `end_samples = Some(_)` → time span (replaces "range marker")
      - `is_loop_target` → when set + transport.loop is on, this
        section IS the loop range. Mutually exclusive across
        sections (only one section can be the active loop target).
      - `is_punch_target` → same, for punch recording. Mutually
        exclusive.
      - `is_navigation` → shows up in the section nav bar / arrow-
        key cycle. Default true. Allows hiding utility sections
        without deleting them.
- [ ] UI — a **Section bar** strip above the timeline (not crammed
      into the ruler — its own affordance, ~24 px tall):
      - Each section renders as a colored pill spanning its bounds
        (or a single thin tab for 0-length cues).
      - Click name → seek to start.
      - Right-click → context menu: rename, recolor, set as loop
        target, set as punch target, delete.
      - Drag the pill's edges to resize; drag the body to move.
      - Tiny icons on the active loop / active punch sections
        (🔁 / ⏺) — single-source-of-truth for what the transport
        will do when Loop / Record is engaged.
      - Add a new section: click an empty area of the bar →
        text-input mode → name → press Enter. Or right-click the
        ruler at a time position. Or `Cmd+Shift+M` (mnemonic:
        "Mark"). Or via the agent.
- [ ] Backend trait — `list_sections`, `create_section`,
      `update_section`, `delete_section`. Stub stores natively;
      Ardour shim translates:
      - `is_loop_target=true` → maps to Ardour's auto-loop location
        via `markers_set_auto_loop_*` (`daw_proxy` already has it)
      - `is_punch_target=true` → maps to auto-punch via
        `markers_set_auto_punch_*`
      - cue (end=None) → Ardour `markers_add`
      - range → Ardour `markers_add_range_*`
      The Foyer-side abstraction is one primitive; the Ardour-side
      plumbing is its existing four primitives wired up automatically.
- [ ] Agent tool — `sections.list / create / update / delete /
      set_loop_target / set_punch_target`. Each accepts the polymorphic
      time arg (samples OR BBT — see above).
- [ ] Workflow examples this enables:
      - "Mark this 8 bars as 'Verse 1'" → creates a section.
      - "Loop the chorus" → finds section named "Chorus" → sets
        `is_loop_target=true` → if transport.loop wasn't already
        on, turns it on. ONE agent intent, ONE user click.
      - "Punch in for the bridge" → finds section "Bridge" →
        `is_punch_target=true` + sets transport.record_armed=true.
        ONE agent intent.
      - "Skip to the bridge" → seeks to the section's start.
- [ ] Migration: existing Ardour sessions opened in Foyer read
      markers/ranges + auto-loop/auto-punch from the .ardour file
      and surface them as sections automatically. Saving back
      writes the same primitives, so round-tripping doesn't lose
      anything.

### Smaller wins worth picking off

- [ ] **`regions.normalize`** — audio peak normalization (Ardour
      has it; we don't). One sample-pass scan + a `gain_linear`
      patch in one undo group.
- [ ] **`session.snapshot(name?)`** — Ardour's `quick_snapshot`,
      writes a named copy of the current .ardour file alongside
      the session so users can A/B without leaving the project.
      Wrap `daw_proxy.call("session_quick_snapshot")` for the
      Ardour case + native impl for the stub. Surface in the UI
      as a "📸 Snapshot" button in the session-info modal.
- [ ] **`tracks.set_rec_safe`** — separate from rec_enable. When
      `rec_safe=true` the track refuses to arm even on a global
      record + arm — protects keeper takes from accidental
      overwrite. Useful during long sessions where the user wants
      to keep arming new tracks without worrying about hot mics.
      Tiny addition: one bool on `Track`, one UI button (matches
      the existing M/S/R/A row), one ControlSet path.
- [ ] **`plugins.describe`** (full parameter graph readout) — see
      above under Plugins. Cheap, high agent value.
- [ ] **MIDI patch graph via `list_midi_patch_names`** — already
      shipped but worth surfacing in the agent's instrument-picker
      response so it can choose "Acoustic Grand Piano" vs "Honky
      Tonk" vs "Electric Grand" by name instead of program number.
      Tool exists; the welcome / midi-track-setup skill could
      lean on it harder.

### Plumbing debt surfaced by the MCP work

- [ ] **One Ardour launch path, not two.** Today
  [crates/foyer-cli/src/main.rs:1278-1431](../crates/foyer-cli/src/main.rs#L1278)
  is ~150 lines of bash heredoc embedded in Rust — the dev-build
  branch sources `ardev_common_waf.sh`, prepends the shim to
  `ARDOUR_SURFACES_PATH`, and runs its own session-XML preflight
  inline. The system-Ardour branch right below it does the same
  prep work in pure Rust via `preflight_session()`. Every new
  session-XML edit (sample-rate patch, Foyer-shim activation, now
  the per-session MCPHttp port pin) has to be added twice, and
  the bash branch is the one that keeps falling behind — for
  example the new MCPHttp port pin only landed on the Rust path,
  so dev-build users get the default 4820 and a collision on the
  second session.
  - Port the entire prep flow into `preflight_session()`. The
    dev-build branch becomes "Rust prepares the .ardour file +
    sets the right env, then exec's Ardour directly" — same shape
    as the system path. No bash, no perl-pi.
  - Externalize dev-build paths. Hard-coded references to
    `ext/ardour-github-main/build/...`, `gtk2_ardour/ardour-9`,
    `ardev_common_waf.sh`, the shim's `build/libs/surfaces/foyer_shim`
    location, etc. should all come from runtime discovery
    (walk the Ardour source tree once at boot, cache the
    resolved paths) or from env vars injected by the relevant
    `just` recipe. The `Justfile` already knows which dev tree
    it's pointing at; passing those locations as `FOYER_ARDOUR_DEV_*`
    env vars rather than baking them into Rust string literals
    cuts the coupling.
  - This also lets `foyer_config::ardour_dev_root()` retire — its
    only consumer is the bash-branch selector and its only job
    is "did the operator point us at a dev tree?". A boolean env
    var (or just the presence of `FOYER_ARDOUR_DEV_TREE`) does
    the same job without filesystem heuristics.
- [ ] **Discover MCPHttp port on reuse-existing-shim path.** The
  reuse path in `launch_and_wait_for_shim` ([main.rs:1164](../crates/foyer-cli/src/main.rs#L1164))
  reattaches to a still-running Ardour without forking — we don't
  know what MCP port the user's Ardour bound to, so the session
  shows up with `mcp_endpoint=None` and is invisible to
  `daw_proxy` even though the live Ardour likely IS serving MCP.
  Need a discovery side-channel that's:
  - **Backwards compatible**: 9.2 (no `mcp_http` surface compiled
    in) keeps working with no extra fields — the discovery just
    returns "no MCP" and Foyer hides the proxy entry for that
    session, same as today.
  - **Live for 9.4+**: query the actually-bound port at reuse
    time. Options, roughly in order of ABI fragility:
    1. **Shim writes the port into the advert.** Cleanest. The
       Foyer shim is already C++ that links Ardour, so it can
       walk `ControlProtocolManager::instance()` to find the
       MCPHttp protocol and read its bound port via the
       protocol's own XML state. Stash the value in the
       per-shim advert JSON
       ([shims/ardour/src/ipc.cc](../shims/ardour/src/ipc.cc) —
       same place we already write `socket` and `project_path`).
       Foyer reads it from `discovery::find_for_project` and
       fills in `mcp_endpoint` directly. Zero version coupling:
       the field is absent on 9.2 builds, present on 9.4+, and
       JSON's open-ended schema means neither side breaks the
       other.
    2. **Read the session's `.ardour` XML at reuse time.** Less
       clean — we'd parse the running session file to find
       `<Protocol name="MCPHttp" active="1" port="N"/>`. Works
       even if the shim doesn't ship the new field, but only
       reports the *configured* port, not the actually-bound
       one. A user who hand-edited the XML after Ardour started
       would get a wrong answer.
    3. **Reflection-style: shim re-introspects on demand.** Add
       an IPC command (`Foyer → shim → "what's MCPHttp running
       on?"`) that walks `ControlProtocolManager` at query time.
       Pure C++ — same access pattern as today's `list_ports`
       handler in `dispatch.cc`. Most accurate, slightly more
       wire surface. Probably the right answer if (1) turns out
       to be racy on shim cold-start (the protocol might not be
       instantiated when the advert is first written).
  - **Recommendation**: ship (1) first as the default, add (3)
    as a fallback IPC the discovery path can poll if the advert
    didn't carry the port (handles shim-was-built-pre-MCP cases
    + the cold-start race). (2) is the absolute fallback for
    pathological reattach scenarios where neither shim path is
    available, but probably not worth implementing.

## i18n / runtime translation

- [x] Drupal-style runtime i18n landed (en, de, es, it, ja, ko, zh).
  Shared catalogs at `web/locales/<lang>.json` baked into Rust binaries
  via `include_dir!` AND served statically to the browser; `tr!()` /
  `tn!()` / `loc!()` macros in [foyer-i18n](../crates/foyer-i18n/);
  `t()` / `tn()` / `setLocale()` in [i18n.js](../web/core/i18n.js);
  picker in Preferences; `just i18n-extract` harvests every wrapped
  string and reports missing/orphaned per locale. `Event::Error` carries
  an additive `localized: Option<LocalizedString>` so new emit sites
  use `Event::error_localized(code, loc!(…), target_peer_id)`. Legacy
  English-only `message` stays populated for back-compat.
- [x] Shim-side migration of `encode_error` to a structured payload.
  Today the Ardour shim ships plain `(code, message)` strings to the
  sidecar via msgpack — see `shims/ardour/src/msgpack_out.{h,cc}`'s
  `encode_error()` and the call sites at `shims/ardour/src/dispatch.cc`
  lines 3884, 3923, 4849 (plus older ones at 3910, 3972, 5130, …). When
  the shim emits an Error, the sidecar logs + re-broadcasts as-is, so
  shim-originated errors render in English regardless of the client's
  locale. The path forward:
  1. Grow `encode_error` to `encode_error(code, key, params_map)`. Keys
     stay English source strings (Drupal style); params is a flat
     `map<string,string>`. msgpack is already self-describing so it's
     additive — older sidecars that read just `(code, message)` ignore
     the extra fields and fall back to the pre-rendered message the
     shim can emit alongside.
  2. Update each `dispatch.cc` call site to pass `(code, key, {param,
     value, …})` instead of concatenating a string.
  3. Mirror the keys into `web/locales/*.json` so every locale catalog
     has translations.
  4. Sidecar's [foyer-backend-host/src/client.rs] `Event::Error` arm
     turns the structured shim payload into a `LocalizedString` and
     attaches it to the WS-side emit.
  - Shim builds in seconds against `/usr/lib/ardour9/libardourcp.so`
    from `shims/ardour/build` (already pre-warmed in the devcontainer),
    so iteration is fast — just touch + `make -j2`.
- [x] Wrap the long-tail FE surfaces (mixer, timeline, agent panel,
  file / audio modals, …). Infrastructure is solid; remaining work is
  mechanical and parallelizable per-component. Pattern: add
  `import { t, onLocaleChange } from "/core/i18n.js"`, wire `onLocaleChange`
  in `connectedCallback`, wrap visible strings with `t()`, re-run
  `just i18n-extract`, fill missing keys in each locale's JSON.
- [ ] Migrate the rest of the ~95 server-side `Event::Error` emit sites
  (those that still carry `localized: None`) to `Event::error_localized`
  + `loc!()`. Each one is a 5-line mechanical change against a known
  message template. The compiler-enforced field guarantees no emit
  site can be missed.
- [ ] Native-speaker review for ja / ko / zh catalogs (flagged in each
  `_meta.translator_notes`). First-pass translations follow established
  DAW vocabulary (Cubase / Logic / Studio One localizations) but the
  longer descriptive strings haven't been audited for idiomatic phrasing
  or formality register.

- [x] Browser-ingress UI gating
  - `Record stop delay` AND `Recording alignment` sections in Preferences now
    grey out + show an explanatory banner when no track currently has its Take
    chip on. Wired via `globalThis.__foyerTrackMics.size > 0` + `onTrackMicChange`
    so the controls re-enable live as soon as ingress starts.
    ([settings-modal.js](../web/ui-full/components/settings-modal.js)
    `_renderRecordStopSection`, `_ingressActive`.)
- [x] Listen button hidden on secondary windows
  - The Listen chip in the mixer toolbar now also gates on
    `multiWindow.isSecondary` alongside the existing tunnel-guest gate.
    Secondary windows are control-plane-only by server-side policy so opening
    a listener stream from one would be rejected by `dispatch_command`; hiding
    avoids the dead-button UX.
    ([mixer.js:467](../web/ui-full/components/mixer.js#L467).)
- [x] Agent regression — `tracks.create` against Ardour
  - HostBackend was inheriting `Backend::create_track`'s default ("not
    supported") because the Ardour shim doesn't expose a single
    `Command::CreateTrack`. Wired through `invoke_action` with
    `track.add_audio` / `track.add_midi` / `track.add_bus`, then poll the
    snapshot for the new track id (the one that wasn't there before),
    then patch name/color via `update_track`. 1.5 s polling budget covers
    a healthy session-thread tick.
    ([foyer-backend-host/src/lib.rs](../crates/foyer-backend-host/src/lib.rs)
    `create_track`.) The default `Backend::create_track_full` then layers
    on the optional plugin/instrument/copy_from_track chain for free.
- [x] Agent mid-turn session swap — tools were hitting the previous shim
  - `ToolContext.backend` used to be a `Weak<dyn Backend>` snapshotted at
    `build_engine_and_ctx`. When the agent ran `session.new` mid-turn,
    `install_active_backend` correctly updated `AgentRuntime.backend`,
    but the ctx in the current turn held a stale Weak — subsequent
    calls (`plugins.catalog`, `tracks.list`, …) kept hitting the
    previously-focused session. Symptom: UI correctly showed the new
    project (Master-only), Ardour still held the old project, and the
    agent's `tracks.list` returned the old project's tracks.
  - Fix: `ToolContext.backend` is now a `BackendRef =
    Arc<std::sync::RwLock<Option<Weak<dyn Backend>>>>` shared with the
    runtime. `ctx.backend()` reads the LIVE Weak on every call.
    `attach_backend` updates both the legacy tokio-locked field
    (kept for the "is a backend attached at all?" gate in
    `build_engine_and_ctx` / `external_engine_parts`) AND the shared
    sync ref. ([tools/mod.rs](../crates/foyer-agent/src/tools/mod.rs)
    `BackendRef`, [runtime.rs](../crates/foyer-agent/src/runtime.rs)
    `backend_ref`, `attach_backend`,
    [foyer-mcp/src/server.rs](../crates/foyer-mcp/src/server.rs)
    constructs its own per-call `BackendRef` via `make_backend_ref`.)
- [x] Spectrum analyser — real FFT in the Ardour shim
  - **Stub backend optimisation** (earlier in this session):
    50 Hz → 25 Hz tick, default `max_bins` clamped to 512 unless
    callers ask for more, state locked only AFTER subs are
    confirmed non-empty.
    ([foyer-backend-stub/src/spectrum.rs](../crates/foyer-backend-stub/src/spectrum.rs).)
  - **Ardour shim FFT pipeline shipped**:
    · New
      [spectrum_pipeline.h/.cc](../shims/ardour/src/spectrum_pipeline.h)
      with `SpectrumTap` (RT-safe `ARDOUR::Processor` writing
      per-channel `PBD::RingBuffer<float>`) and `SpectrumHub`
      (subscribe/unsubscribe/tick/stop_all, owns one tap +
      `ARDOUR::DSP::FFTSpectrum` per subscription).
    · The RT callback only memcpys into the ring — no FFT work in
      the audio thread. A `g_timeout_add` at 40 ms drains the ring
      into rolling per-channel windows, runs libardour's
      `FFTSpectrum::set_data_hann` + `execute`, downsamples native
      bins → `max_bins` evenly-spaced output bins (max-pool to
      preserve transients), and emits via
      `encode_spectrum_frame`.
    · `subscribe_spectrum` resolves the target route on the session
      thread (`session.master_out()` / `monitor_out()` / id-walked
      `safe_get_routes()`), then hands off to the hub; `Dispatcher`
      owns a `SpectrumHub` member and calls `stop_all` on shutdown
      for clean shim unload. ([dispatch.cc](../shims/ardour/src/dispatch.cc).)
    · `encode_spectrum_subscribed` / `encode_spectrum_unsubscribed`
      / `encode_spectrum_frame` added to
      [msgpack_out.cc](../shims/ardour/src/msgpack_out.cc); the
      session-snapshot emit now flips `spectrum.available = true`
      with `{ fft_sizes: [256, 512, 1024, 2048, 4096], windows:
      ["hann"], max_frame_rate_hz: 25 }`. The FE auto-shows the
      analyser surfaces once this flag is true (no client change
      needed).
    · `CMakeLists.txt` picks up the new `.cc`; `cd shims/ardour/build
      && make -j2` and `cargo check --all` both pass.
  - **Follow-ups** (not blocking):
    · Only Hann is honoured — the capability advertises Hann-only
      so the FE doesn't request a window we can't produce. Adding
      Hamming / Blackman-Harris would need a custom pre-window
      path (Ardour's API folds Hann into `set_data_hann`).
    · Sub-tick hop overlap (multiple FFTs per 40 ms tick) isn't
      implemented; subscribers that ask for very small hops will
      still get only one frame per tick. Acceptable for a
      waterfall, may need work if anyone wants tight onset
      tracking.
    · Per-channel cap is hard-coded to 2 — surround sources fold
      to stereo. Schema supports more; FE waterfall isn't ready
      for >2 yet.
- [x] i18n long-tail wrap + translations
  - Wrapped mixer strip + track-strip (~17 keys via the existing `tr`
    alias), agent-panel chrome (~40+ keys), session-view (~15 keys),
    project-picker-modal. `just i18n-extract` now reports **207 keys
    total with 0 missing / 0 orphaned across all 6 locales**
    (de/es/it/ja/ko/zh).
- [x] Browser auto-detect locale (already shipped — verified)
  - [i18n.js](../web/core/i18n.js) `installI18n` already resolves
    localStorage > `navigator.language` > English at boot. Gated against
    the catalog manifest so we never request a locale the server
    doesn't ship.
- [x] Agent system-prompt language directive
  - `AgentConfig.ui_locale` (new, `Option<String>`) + new
    `Command::AgentSetConfig.ui_locale` field (additive, serde
    `skip_if_none` so older clients keep parsing). When set and
    non-English, `build_engine_and_ctx` appends a `UI LOCALE: …
    Respond to the user in <Language Name> …` directive to the system
    prompt. The FE bootstraps the value via `agent_set_config` on
    connection-open AND on every `onLocaleChange`.
    ([runtime.rs](../crates/foyer-agent/src/runtime.rs) `set_ui_locale` +
    `language_name_for`, [bootstrap.js:88](../web/core/bootstrap.js#L88)
    `pushLocaleToAgent`.)
- [x] Agent stops responding after auto-compaction
  - Two stacked bugs. (1) Every `visualize` / screenshot tool result
    carried a fat `image_png_b64` field that re-rode the LLM context on
    every subsequent round — after 3-4 visualize calls the conversation
    blew the 256k window. (2) When compaction kicked in, it serialised
    those same fat base64 blobs INTO the summariser request, which
    itself hit overflow.
    - New `redact_records_for_llm` strips >24kB base64 from every Tool
      role record except the most recent one, AND strips attachments
      from records older than the last User message. Runs on every
      `build_request_with_nudge` so the working set is small by default.
    - Compaction now redacts before serialising AND falls back to a
      binary-split chunked summarisation (`summarise_records` recurses
      when `payload_chars > 600kB`).
    - Post-compaction the live tail is redacted/truncated too, so the
      retry doesn't immediately re-overflow.
    - `visualize.spectrogram`'s `track_id` is now optional (was required
      → "missing field track_id" on the unprompted agent path).
    ([engine.rs](../crates/foyer-agent/src/engine.rs)
    `redact_records_for_llm`, `compact_conversation_inline`,
    `summarise_records`; [visualize.rs:34](../crates/foyer-agent/src/tools/visualize.rs#L34).)
  - Note: `visualize.screen` was NOT actually broken — the FAB
    screenshot showed `visualize.screen rendered 4719 bytes`. And
    `spectrum.capabilities returns an error` was a misread — against an
    Ardour shim it returns `available: false` (correct, given the shim
    FFT pipeline isn't shipped), not an error.
- [x] Docked-agent toggle no longer opens the agent-settings modal
  - The agent-settings-modal close / cancel / backdrop-click paths set
    `this.open = false` but never dispatched a "close" event, so the
    agent-panel's `_settingsOpen` stayed `true`; any subsequent re-render
    of the agent-panel re-applied `?open=true` to the modal and it
    popped back. Those three paths now also dispatch a composed `close`
    event; agent-panel listens with `@close=` on all three modal mount
    points and resets `_settingsOpen` accordingly.
    ([agent-settings-modal.js](../web/ui-full/components/agent-settings-modal.js),
    [agent-panel.js](../web/ui-full/components/agent-panel.js).)
- [x] Contextual command palette
  - Cmd+K now prepends selection-aware entries before the static
    `list_actions` catalog:
    · time-range selection → **Loop selection** / **Zoom to selection**;
    · single-track selection → **Mute/Unmute**, **Solo/Unsolo**, **Add
      plugin** (or **Add instrument or effect** on MIDI tracks),
      **Open piano roll** on MIDI;
    · region selection → the full edit-menu list pulled live from
      `_regionEditMenuActions()` (Quantize / Crop / Snap fades / Clear
      fades / Reset gain / Glue / Reverse / Strip silence / Pitch shift)
      with disabled entries elided so the palette only shows what'll
      actually run;
    · single MIDI region → **Open piano roll** AND **Open beat sequencer**
      where applicable.
    Selection state is read live via a `deepFindTag` walk for
    `foyer-timeline-view`. ([command-palette.js](../web/ui-full/components/command-palette.js).)
- [x] Full-app keyboard navigation — first pass shipped
  - **Timeline**
    ([timeline-view.js](../web/ui-full/components/timeline-view.js)
    `_onTimelineKey`, `_onRegionKeydown`): host is `tabindex="0"`
    with `data-foyer-focus-domain="timeline"`. Arrow-up / arrow-down
    moves the track selection through `store.selectTrack(id,
    "replace" | "extend")` and scrolls the new row into view;
    Shift+Up/Down extends the selection; Enter opens the track
    editor for the focused track; Ctrl/Cmd+Enter toggles it in the
    multi-selection. Regions are already `tabindex="0"` — now they
    accept Enter (select replace) and Ctrl/Cmd+Enter (additive
    toggle), with a dashed focus ring so users can see which region
    they're parked on.
  - **Mixer** ([mixer.js](../web/ui-full/components/mixer.js)
    `_onMixerKey`): host is `tabindex="0"` with
    `data-foyer-focus-domain="mixer"`. Arrow-left / arrow-right
    walks the strip order (inputs → master/monitor matching the
    visual layout); Shift extends the selection; Enter solos the
    focused strip (Ctrl/Cmd+Enter toggles multi-select); plain
    `m`/`s`/`r` toggle mute/solo/arm via `update_track`. Track
    strips themselves are `tabindex="0"` so Tab steps through the
    row.
  - **Region nudge — focus-scoped**: the old global left/right
    arrow capture in [keybinds.js](../web/ui-core/layout/keybinds.js)
    is gone; the same fine/beat semantics now live on
    `foyer-timeline-view` so a left/right press only nudges regions
    while the timeline is focused. Other panels (mixer, agent,
    sessions list) get their arrows back.
  - **Knob + Fader** ([knob.js](../web/ui-core/widgets/knob.js),
    [fader.js](../web/ui-core/widgets/fader.js)): both are now
    `tabindex="0"` + `role="slider"`. Arrow keys nudge value
    (Shift = fine), Home/End jump to range bounds, Enter resets to
    the configured default. Focus ring inset 2px so it doesn't
    push neighbours. This is what makes the track-editor's gain
    and pan controls keyboard-friendly — the modal renders foyer-knob
    for both.
  - **MIDI roll / beat sequencer / plugin panel**: each gets a
    `tabindex="0"` + `data-foyer-focus-domain` so the tile focus
    tree can land on them. MIDI roll keeps its existing window-
    level keydown (delete / undo / copy / paste); sequencer
    + plugin panel rely on the now-tabbable native inputs inside
    (knobs, faders, range inputs).
  - **Smoke spec**:
    [tests-ui/specs/keyboard-nav.spec.js](../tests-ui/specs/keyboard-nav.spec.js)
    covers the timeline track-nav round trip, the mixer track-nav
    round trip, and a standalone `<foyer-knob>` ArrowUp emit.
  - Deferred (not in this pass): MIDI-roll arrow-key note nav
    (selection model is per-note, complex enough to deserve its
    own pass); beat-sequencer cell arrow nav (same — needs an
    "active cell" pointer to track). The host-focus + tabindex
    are in place so wiring those later is mechanical.
- [x] Tool-call round limit reframed + hidden extend tool
  - Old behaviour: hard cap at 32 tool rounds; the wrap-up nudge
    threatened a stop in nervous-making language; round 32+1 dropped
    every queued tool call with an error. Rich saw the agent ditch
    legitimately-mid-task work because of this.
  - New behaviour
    ([engine.rs](../crates/foyer-agent/src/engine.rs) `TurnBudget`,
    [tools/continue_working.rs](../crates/foyer-agent/src/tools/continue_working.rs)):
    · `TurnBudget { cap, extensions }` is per-turn shared state
      (`Arc<std::sync::Mutex<…>>`) cloned into every `ToolContext`
      built inside `run_turn` (the field is `Option` so MCP +
      `/v1/chat/completions` keep their own short-lived budgets
      and the extend tool no-ops there cleanly).
    · The wrap-up nudge is reframed as a *friendly reminder* —
      "you're on round R/N, wrap up OR call `continue_working` for
      another batch — no pressure". The cliff message still tells
      the model what'll happen if it ignores both paths but never
      threatens.
    · `continue_working` is a hidden tool — not mentioned in the
      welcome payload, not in the system prompt, only surfaced by
      name inside the wrap-up nudge. Calling it bumps the budget
      by `ROUND_BUDGET_EXTENSION` (currently 32) and the loop
      re-reads the cap on the very next iteration. Each extension
      is counted + surfaced in the trace so an operator can audit
      a runaway agent.
    · Truncation messaging now reads as a soft pause, not an
      error: "Pausing here — that was N rounds of tool calls. Reply
      'continue' …". When the agent extended at least once, the
      banner notes the extension count so the user sees the
      pattern.