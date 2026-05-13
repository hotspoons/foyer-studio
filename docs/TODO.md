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
- [ ] Crossfades on overlapping regions
  - When two regions on the same track overlap, render a crossfade
    in the overlap region (linear by default, exposed shape later).
    Ardour models this as `AudioRegion::set_fade_in_length` /
    `set_fade_out_length` plus the playlist-level overlap detection.
    Schema needs `RegionPatch.fade_{in,out}_samples` + a fade-shape
    enum, and the timeline view needs to draw the X curve in the
    overlap. Hover handles on the overlap edges adjust the curve.
  - **Shim (2026-05):** `RegionPatch` carries `fade_{in,out}_samples`,
    `fade_{in,out}_shape` (`FadeShape`), and `gain_linear`; Ardour
    `update_region` maps them to `AudioRegion::set_fade_in` /
    `set_fade_out`, `set_fade_in/out_shape`, and `set_scale_amplitude`.
    **Still not 1:1 here:** pairing overlaps, mutual autofades, and
    drawing the crossfade curve are UI/playlist concerns — not done.
- [ ] Fade-in / fade-out per region (independent of crossfade)
  - Same `fade_{in,out}_samples` patch fields, applied to a
    non-overlapping region. UI: a small triangular handle in the top-
    inside corner of the lozenge that you drag inward to set the fade
    length. Holding the modifier rotates through fade shapes (linear,
    log, exp, S-curve).
  - **Shim (2026-05):** backend + schema above; Ardour exposes linear,
    fast, slow, constant_power, symmetric — not separate log/exp/S
    names. **UI handles** still needed.
- [ ] Region groups (linked-edit)
  - Mark several regions as a group; subsequent move / trim / fade /
    delete on any one applies to all. Ardour has a native
    `RegionGroup` concept; surface it as
    `Command::CreateRegionGroup { region_ids }` + a group-id field
    in the `Region` payload, then the timeline view applies edits to
    every group sibling.
    (or MIDI note transform) — skip.
- [ ] Region gain handle (per-region volume)
  - A draggable strip across the region top renders gain in dB. Edge
    cases: live preview during the drag without sending N
    `update_region`s (use a `RegionGainPreview` envelope or just one
    write on pointer-up, like the move/resize commit pattern).
  - **Shim (2026-05):** `RegionPatch.gain_linear` →
    `AudioRegion::set_scale_amplitude` (linear gain). **UI** (dB strip,
    drag preview) still TODO — wire is ready.
- [ ] Nudge region left/right by grid step (arrow keys)
  - Plain Left/Right when a region is selected nudges by the active
    grid sub-step (16th by default); Shift+arrow nudges by a beat;
    Ctrl/Cmd+arrow nudges by 1 sample. Already partially wired for
    automation points; extend the same handler to regions.
  - **Already expressible** as `update_region { start_samples }` with
    client-computed deltas — no new backend mapping.
- [ ] Crop / trim around time selection
  - With a region + ruler time selection, "Crop to selection" trims
    the region to the carved range (mirror of Cut, but destructive
    on the original — the slice REPLACES the region). One menu
    entry; reuses the existing slice-capture math.
  - **Compose-only:** combine `update_region` (start, length,
    `source_offset_samples`) — UI orchestration; skip shim.
- [ ] Move/cut/copy/paste regions between audio and midi tracks
- [ ] Add region options (mute/quantize start/fade in/out/reverse
    /strip/pitch shift/duplicate) to edit menu under a contextual
    section that appears only when one or more regions are selected
- [ ] Z-index controls for regions (layering in ardour)
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
- [ ] Once over on floating widgets layer versus tile layer, adding auto-tile layouts
    for tile layer, make sure z-indexes for pop-outs make sense, remove nonsense or
    old controls
- [ ] Drop original "share" dialog and share button from main menu


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
