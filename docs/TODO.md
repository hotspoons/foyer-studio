# Foyer Studio — active plan

Format:
- `[ ]` open, `[/]` partial, `[x]` done. Completed entries normally
  move to the archive on the next cleanup.
- A `+` prefix after the checkbox marks an item Rich has flagged as
  priority for the current push. A `-` prefix means backburnered.

Active decisions log: [DECISIONS.md](DECISIONS.md) (currently ≥ 41
entries). Shipping-state snapshot: [STATUS.md](STATUS.md).

---

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
- [ ] AI Agent harness in GUI
  - Should have access to UI visualizations for:
    - waveforms
    - event heatmaps
    - MIDI viz with notes
    - automation visualization
    - mixer state visualization
    - plugin visualizations
    - midi config form visualizations
    - timeline visualization
    - look into back end generated spectogrpaphy (instant and temporal, per channel and from main mix), and look at hooking up through shim
  - Should have textual reports (minimal, either hand crafted or sparsified JSON) for:
    - channel + audio region start/end
    - automation points per channel
    - mixer config including each channel's state w/ fader, M/S/R/I, plugins, plugin configs (base)
    - midi config per channel
    - automation events per channel (e.g. fade in/out, full automation spectrum including plugins (and list unused plugin automations))
    - latency reports and front end config
    - Messages (add AI agent to chat)
  - WebLLM integration for in-browser assistant (should already be in codebase)
  - Add chat completions endpoint with optional api key (should already be in codebase)
  - Needs strong prompting with a handful of skills that can be managed by and extended by the user and stored under ~/.local/share/foyer, including the ability
    to save off project templates, browse the templates from there, and use them for new projects
  - Agent should have a memory tool that will save off snippets of knowledge as one or more .md files somewhere under ~/.local/share/foyer that are
    automatically injected into context on each session start, and the user should be able to direct the agent to remember something
  - Try to push as much of this as far down as possible into the back end so Claude could engineer a session via MCP and have access to all of this stuff. Investigate
    using rendering captured from the front-end of the app and sending it to the back end MCP tools for the visualizations

- [ ] MCP tools (minimum number of tools with rich + polymorphic with subcommands)
- [ ] Agent's native tools mapped to MCP tools but without MCP overhead
- [ ] Map out back end vs front end tools, move as much as possible to back end via MCP 
    so it can be used by other agents