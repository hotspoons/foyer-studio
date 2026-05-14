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
- [ ] Region groups (linked-edit)
  - Mark several regions as a group; subsequent move / trim / fade /
    delete on any one applies to all. Ardour has a native
    `RegionGroup` concept; surface it as
    `Command::CreateRegionGroup { region_ids }` + a group-id field
    in the `Region` payload, then the timeline view applies edits to
    every group sibling.
    (or MIDI note transform) — skip.
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
- [ ] Move/cut/copy/paste regions between audio and midi tracks
  - **Today:** the wire protocol pins `DuplicateRegion` /
    `DuplicateRegionRange` to the source's own track, so paste always
    stays on the source track regardless of where the user clicks.
    Cross-track paste needs an optional `target_track_id` on those
    commands + a type-compatibility check in the shim (audio→midi
    needs MIDI rendering of audio, which is a wholly different op;
    likely just reject incompatible pairs with a friendly toast).
- [x] Add region options to the edit menu under a contextual
    section that appears only when one or more regions are selected
  - The Edit dropdown grows a "Region" / "N regions" header + the
    same action list the right-click menu surfaces (Quantize, Crop
    to selection, Snap fades to overlap, Clear fades, Reset gain,
    Glue, Reverse audio, Strip silence, Pitch shift). Driven by
    `_renderEditRegionSection` in [main-menu.js] which delegates to
    the timeline's `_regionEditMenuActions()` so behavior stays one
    source of truth.
- [ ] Z-index controls for regions (layering in ardour)
  - Needs `Region.layer` (or analogous) on the schema + shim wiring
    to Ardour's `set_layer` / `raise` / `lower`. Pure UI ordering
    would violate the backend-source-of-truth rule (CLAUDE.md) since
    other clients need to see the layering. Pending schema work.
- [ ] Automation needs to support *all* automation including plugin
    controls. Suggest making a dedicated UI that opens in a modal
    for editing automation with an automation channel picker (allow
    picking multiple automation channels at once, drawing the same
    automation for each type)


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
- [ ] Scope RBAC denials to offender + admins
  - Today `forbidden_for_role` / `auth_required` errors broadcast to every connected
    client, so a viewer can see another viewer's denial banner flash by. Clean fix: add
    an optional `target_peer_id` field to `Event::Error` (or a new admin-only
    `Event::RbacDenied`) and extend `should_forward_event` in
    `crates/foyer-server/src/ws.rs` to route denials only to the offending connection +
    LAN/admin roles. Message already names the recipient in current builds (DECISION 38);
    this is the client-scope half.
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
