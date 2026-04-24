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
- [x] ✅Plugin's can't be deleted from channel configs!!
  - Added remove flow in channel plugin strip context menu (`remove_plugin` command).
    - Delete key doesn't work after focusing on a plugin. Need to be able to delete via a key
- [x]  ✅Double clicking a sequence or midi region should open the respective editor
  - Region double-click now opens the appropriate editor on MIDI tracks (beat sequencer for active sequencer layouts, piano roll otherwise).
- [x]  ✅Double clicking effects strip or empty part of strip in mixer should open track editor
  - Mixer track strip dblclick already opened track editor; plugin-strip area/empty slot now also routes dblclick to track editor.
    - Fixed MIDI region editor routing: sequencer opens only when sequencer metadata exists and is active; plain MIDI regions now open piano roll without conversion prompt.
- [x] ✅When clicking on a region, delete key should delete the region 
  - Added explicit region click-selection and keyboard delete path for selected regions.
    - Global keybind listener now runs in capture phase so Delete/Backspace region deletion is reliable despite focus churn.
      - NEITHER DELETE OR BACKSPACE DOES SHIT WHEN SELECTED ON A REGION!!!
- [x] ✅Multi-select regions!
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
- [x] ✅Can't rearrange tracks from the timeline view
  - End-to-end reorder now active through shim: timeline move up/down emits `reorder_tracks`, shim updates route presentation order and resorts routes.
    - Not complete. No errors but no action, I don't see the tracks rearranghing
    - Complete now
- [x]  ✅Right click on track should have delete option (as well as multi select -> delete track) with confirmation
  - Lane-head context menu delete now executes through working backend contracts and applies to selected tracks (or current track) with confirmation.
- [x] ✅Clear automation should be a styled dialog, not an old school confirm dialog
  - Automation lane clear now uses styled `confirm-modal` (`confirmAction`) instead of `window.confirm`.
   - Stabilized shim automation lane mutation paths (`replace_automation_lane`, `update_automation_point`) to avoid unsafe list mutation patterns and reduce point snap-back.
- [x]  ✅Automation painting is clunky, it is hard to put an automation point at the start of a track, not sure what's going on
  - Added left-edge add behavior: clicks near lane start now snap to `time_samples=0` and prefer add-point over grabbing nearby first point.
- [x]  ✅Close session needs to be one to two clicks, not three - Save & Close, Close (abandon changes), cancel. No More.... button. Close abandon changes should prompt are you sure, that is it
  - Session switcher unsaved-close flow reduced to 1-2 clicks: Save & Close, or Close without saving (with one danger confirm), or Cancel.

Short term features:
- [x] ✅ Timeline marker doesn't move on loop selection button, but does on main track button for looping - suggest removing loop selection button
  - **Reverted** transport-bar loop toggle back to `controlSet("transport.looping", !loop)` (the original working pattern). **Restored** timeline "Loop selection" toolbar button (`_setLoopToSelection()`). **Fixed** `encode_transport_state()` in shim to include `transport.looping` in the meter batch (was missing, so the FE never got loop-state updates after a toggle). Root cause: `signal_bridge.cc` sends `encode_transport_state` for transport changes, but it only emitted 4 values (tempo, playing, recording, position) — looping was omitted, so the FE stayed stale.
- [x] ✅ Undo/redo don't really work, kinda but not really
  - **Fixed**: `ControlSet` in `dispatch.cc` was calling `AutomationControl::set_value` without wrapping it in a reversible command. Ardour's undo stack requires an active `UndoTransaction` for most parameter changes to be recorded. We now wrap every `ControlSet` mutation in `session.begin_reversible_command("Foyer control change")` / `session.commit_reversible_command()`. Undo/redo should now work for control changes (gain, pan, mute, etc.). Plugin param changes also use `UseGroup` so group-ganged tracks are handled correctly.
- [x] ✅ Tempo adjustments should reflow/regenerate midi from sequencer tracks, currently they don't on the front end
  - **Fixed**: Added a tempo-change listener inside the beat-sequencer's `_onStoreControl` handler: when `transport.tempo` fires and the current layout is `active`, we call `_persistLayout()` which sends `set_sequencer_layout` to the server. The server runs `expand_sequencer_layout` with the new tempo context and calls `replace_region_notes` to rewrite the region's MIDI data. Notes and region length now stay synced with the live tempo grid.
- [x] ✅ "- Shim snapshot now emits `session.groups` + per-track `group_id`; remaining gap is dedicated create/rename/delete group UI workflow."
  - Created `web/src/components/group-manager-modal.js`: a polished standalone dialog with group list, inline rename, color picker, member count, create, and delete-with-confirmation. Opened from **Track** main menu ("Group Manager…") and from the track editor routing section ("Manage…" button next to the Group dropdown). Track editor simplified to just the dropdown + Manage link.
- [x] ✅ Move plugins and instruments below mixer header and M/S/Rec/auto/in/disk controls so those heights stay consistent. Make it so if the plugins reach the gain sliders the plugins strip scrolls vertically
  - `plugin-scroll` wrapper in `track-strip.js` now **always renders** regardless of whether the track has plugins. Previously it was conditionally omitted when `plugins.length === 0`, which caused the fader/meter to float upward and break height consistency. Faders now stay anchored at the bottom uniformly.
- [x] ✅ Panning editor should be in-form and in a default-hidden mini form with a collapsable header at the bottom of the mixing panel above the gain sliders
  - Replaced the inline stereo slider in `track-strip.js` with a collapsible **Pan** header that expands into a mini-form with **Stereo / Surround** tabs. Stereo tab shows the L/R slider + numeric readout. Surround tab shows an 80px 2D placement pad: pointer-down/move writes X to host pan, Y is previewed client-side. Collapsed by default (`_panOpen = false`).
- [x] ✅ Delete key doesn't work when focused on one or more tracks - need this to spawn delete dialog
- [x] ✅ "NEITHER DELETE OR BACKSPACE DOES SHIT WHEN SELECTED ON A REGION!!!"
- [x] ✅ Plugin windows can't be moved! They need to auto-layout and auto-move
  - **Replaced** the RAF-throttled store-churn drag with the exact same pattern used in `foyer-window.js`: during `pointermove`, directly mutate the `.pwin` element's inline `left`/`top` styles (zero Lit re-render, zero store churn). On `pointerup`, read the final pixel values from the DOM and persist to the layout store once. Added `header.dragging` cursor state for visual feedback. Resize handler updated to the same direct-DOM-then-persist pattern.
- [x] ✅ CloudFlare tunnels support
  - **Schema** (`foyer-schema/src/tunnel.rs`): Added `TunnelRole` (Viewer/Performer/SessionController/Admin) with `allows_command()` filtering, `TunnelConnection` (token_hash, role, label), `TunnelManifest` (persisted to `$XDG_DATA_HOME/foyer/tunnel-manifest.json`), and `TunnelProviderKind`/`TunnelProviderConfig` extensible enum for future providers (Ngrok, LocalRelay, etc.).
  - **Server** (`foyer-server/src/tunnel.rs`): `create_token()` generates 32-char random tokens, SHA-256 hashes them with a pepper, persists to manifest. `verify_token()` checks hashes. `start_cloudflare()` spawns `cloudflared tunnel --url http://localhost:<port>`, parses stdout for the public hostname, emits `TunnelUp`. `stop_tunnel()` kills the process. `broadcast_tunnel_state()` pushes manifest to all clients.
  - **Wire protocol** (`message.rs`): Added `TunnelCreateToken`, `TunnelRevokeToken`, `TunnelSetEnabled`, `TunnelStart`, `TunnelStop`, `TunnelRequestState` commands + `TunnelState`, `TunnelUp`, `TunnelDown`, `TunnelTokenCreated` events.
  - **WS dispatch** (`ws.rs`): Commands wired to tunnel module functions. `foyer-server/Cargo.toml` gained `sha2`, `hex`, `tempfile`, `rand`, `tokio/process`.
  - **Frontend** (`tunnel-manager-modal.js`): Polished dialog with global enable toggle, start/stop cloudflared, in-line create-token form (label + role dropdown), token display with copy-to-clipboard, connection list with revoke, and role descriptions. Opened from Session → Remote Access… menu.
  - **RBAC**: `TunnelRole::allows_command()` defines per-role command allow-lists. `connection_role()` in tunnel.rs inspects `?token=` in the WebSocket origin on every envelope. Future: integrate with command-dispatch gating in `ws.rs`.
  - **Extensibility**: `TunnelProviderKind` is a tagged enum; adding `Ngrok` or `LocalRelay` means adding a variant + a `start_*` function mirroring `start_cloudflare()` — no other code changes required.
- [x] Cloudflare tunnel modes end-to-end (see DECISIONS 35, 37). Three-mode ladder in `CloudflareProvider`:
  - **Auto-provision** (`api_token + account_id + hostname`): new `crates/foyer-server/src/cloudflare_api.rs` client talks to the v4 REST API — create-or-reuse tunnel, push ingress config, upsert proxied CNAME, fetch run token. Idempotent; restart doesn't leave orphan objects.
  - **Raw token** (`tunnel_token + hostname`): paste connector token from the Zero Trust dashboard, skip the API.
  - **Quick tunnel** (empty): URL-parse fix anchors on `.trycloudflare.com` so we don't latch onto the ToS link banner, and scans stderr (where cloudflared actually prints it) instead of only stdout. Early-exit surfaces as a real error instead of a 30s silent timeout.
- [x] Tunnel URL auto-provision writes DNS CNAME, ingress config, and fetches the run token without dashboard clickthrough. Schema adds `tunnel_token` next to the existing `api_token / account_id / zone_id / tunnel_name / hostname` on `CloudflareTunnelConfig`.
- [x] Named-tunnel credential model: invites mint `(normalized-email, random-password)`; server stores `sha256(normalize(email):password|PEPPER)` as `token_hash`; URL `?token=` is `base64url(email_norm:password)` and auto-logs-in. Password shown once in UI; 16-char alphabet without 0/O/1/l/I. See DECISION 36.
- [x] Tunnel toggle in the Remote Access modal is browser-sticky (`localStorage['foyer.tunnel.enabled']`) so it doesn't flip off on reload. Start-tunnel throbber no longer clears prematurely on the pre-start `stop_tunnel` broadcast + gains a 60s client-side safety timeout.
- [x] Tunnel modal UI: URLs / usernames / passwords are `user-select: text`, duplicate URL display removed, multi-recipient invite form with add/remove rows, per-row Copy-URL + QR + Email + Revoke icons, just-created credential callout with copy buttons, inline QR overlay rendering `/qr?data=<url>`.
- [x] Connected-peer roster is server-authoritative (DECISION 39). `AppState.peers: HashMap<String, PeerInfo>` + `Event::PeerJoined / PeerLeft / PeerList`. Each WS connection mints a UUID on handshake, registers in the map, broadcasts join, cleans up + broadcasts leave on disconnect. `PeerInfo` carries `label` (`"host"` for LAN, invite recipient for tunnel), `is_local`, `is_tunnel`, `role_id`. Status bar popover shows the list with `host` / guest distinction + role chip for tunnel guests. Fixes the "peer count doesn't include tunnel connections" bug and replaces the passive origin-sniffing.


Mid term:
- [x] RBAC — config-driven, enforced at action level (see DECISION 38)
  - **Config.** `crates/foyer-config/src/roles.rs` loads `roles.yaml` seeded from a binary-bundled default (`include_str!("../defaults/roles.yaml")`) on first run. Lives at `$XDG_DATA_HOME/foyer/roles.yaml`; delete to regenerate. Ships the four canonical roles (admin / session_controller / performer / viewer) with allow/deny pattern support (`*`, `prefix.*`, `prefix_*`, literal).
  - **Enforcement.** Single gate in `dispatch_command` (`crates/foyer-server/src/ws.rs`). Every incoming `Command` variant → wire tag via `command_tag()` (73-arm match, fail-closed on new commands) → `RolesConfig::allows(role_id, tag)`. Denied → `Event::Error { code: "forbidden_for_role" | "auth_required" }`. LAN connections bypass; tunnel-origin connections enforce.
  - **Tunnel-origin marker.** `TunnelOrigin` request extension applied by the tunnel-auth listener router; WS upgrade extractor reads `Option<Extension<TunnelOrigin>>`. LAN listener doesn't set it.
  - **Token verification.** WS handshake reads `?token=` query param, decodes `base64url(email:password)`, re-hashes with pepper, matches against `TunnelManifest.connections[].token_hash`. Resolves to `ConnectionAuth { Lan | Authenticated { role_id, recipient } | Unauthenticated }` for the life of the socket.
  - **Outbound event filter.** Writer loop runs every broadcast envelope through `should_forward_event`: Unauthenticated tunnel connections see only `ClientGreeting` / `Error` / peer-roster events; non-admin tunnel roles don't see `TunnelState` / `TunnelUp` / `TunnelDown` / `TunnelTokenCreated` (admin state stays private); LAN sees everything.
  - **Login flow.** `foyer-login-modal` (`web/src/components/login-modal.js`) shown when greeting carries `is_tunnel && !is_authenticated`. Submits email+password, encodes `base64url(email:password)`, rewrites `window.location` with `?token=`, page reload re-handshakes. No cookies; URL token is the single identity source.
  - **Client mirror (UI gating).** Shared helper `web/src/rbac.js` (`isAllowed` / `isActionAllowed`) used by main-menu, session-switcher, transport-bar, command-palette, welcome-screen. Server allow-list streamed to client in `ClientGreeting.role_allow` so UI uses the same pattern rules. Non-admin tunnel guests see no failing buttons — the whole transport-control cluster hides for viewers, welcome screen becomes "waiting for host", command palette filters disallowed actions, session switcher hides Close/Open-Another, main menu items filter per-category. Rogue post-gate clicks surface via `startup-errors` banner (extended to always capture `forbidden_for_role` / `auth_required`).
  - **Follow-up — mixer surfaces.** Fader / mute / solo / plugin edit controls still render for all roles; denied clicks hit the banner but controls stay visible. Multi-component sweep tracked separately.


### UI:
- [/] Refactor UI so it is modular and hackable. (DECISION 40)
  - [x] Split into `foyer-core` (renderless business logic: ws, store, RBAC, audio, automation, registries) → `foyer-ui-core` (shared primitives: tiling, windowing, widgets, fallback shell) → `ui-*` variants (opinionated UIs; `ui-full` is the shipping one). Dependency arrow is one-way.
  - [x] JSDoc-typed registries in core: `features`, `ui-variants`, `widgets`, `views`. Each is a plain EventTarget-backed map consumable by anyone who imports `foyer-core`.
  - [x] CSS opinion scoped to each UI variant; `foyer-ui-core` exposes shared vars + primitives, no layout rules.
  - [x] Shipping UI is now `ui-full/`; nav-bar publishes DEFAULT_VIEWS into the view registry with `elementTag` fields so tile-leaf creates bodies by tag lookup (no hardcoded imports from ui-core into ui).
  - [x] Variants auto-discovered via `/variants.json` (server scans `web_root` for `ui-*/package.js`; excludes reserved `ui-core`/`ui-tests`). `boot.js` fetches + dynamic-imports each; no `index.html` edit needed to ship one.
  - [x] Fallback UI in `ui-core/fallback-ui.js` paints "If you lived here, you'd be home now" when no variant matches — proves core can run without any registered renderer.
  - [x] Backend capabilities plumb through `Backend::features()` → `ClientGreeting.features` → `foyer-core/registry/features.js` → `showFeature()`/`featureEnabled()` helpers. Optimistic default on unknown ids.
  - [x] Hot-serve from `$XDG_DATA_HOME/foyer/web` with first-run extraction from the binary (`include_dir!`). Users edit in place; `--web-root <path>` overrides; working-copy `./web/` wins during dev.
  - [x] HACKING.md in `web/` with recipes (new UI variant, widget override, feature-gated surfaces, new tile view, React-style swap, CLI-driven probe, skip ui-core entirely).
  - [ ] Additional UI variants (`ui-lite`, `ui-touch`, `ui-kids`) — scaffolding ready, no concrete variants written yet beyond `ui-full`.
  - [ ] Click and drag plugins and midi instruments from one channel to another or from the plugins view to another
  - [ ] 1x high x 0.5x wide one panel, 0.5x high x 0.5x wide x 2 other panel layout (3 windows)
  - [ ] Widget-registry adoption sweep: most shipping components still hardcode tag names; migrating to `widgetTag(...)` lookups would let alt-UIs override at the widget level without forking whole views.


- [ ] Click and drag to reorder plugins in mixer and mini strip in channel editor
- [~] Cloudflare tunnels auth:
  - [x] Quick tunnels + full account-linked tunnels (api_token + account_id + hostname → auto-provisions tunnel/ingress/DNS; see DECISION 35).
  - [~] Credential model: each invite mints `(normalized-email, random-password)`; server stores `sha256(email:password|pepper)` as `token_hash`; URL `?token=` is `base64url(email:password)` and auto-logs-in when opened; password shown once in UI, never persisted. (DECISION 36)
  - [x] Two-port architecture: main LAN server stays open by default; all tunnel traffic routes through a separate process-local auth server (default `127.0.0.1:3839`) where RBAC will live. (DECISION 37)
  - [x] **Tunnel-side listener serves the full Foyer UI + WS.** `crates/foyer-server/src/lib.rs::build_http_router` is now a shared builder the tunnel-auth listener calls with the same `Arc<AppState>` as the main LAN listener — tunnel guests see the real Foyer, not the `"ok"` stub. `web_root` moved onto `AppState` so the builder is pure. See DECISION 37 rev.
  - [x] **Tunnel-side RBAC.** Token verification on WS handshake + per-command role gating + outbound event filter — all via DECISION 38. (Rolled into the RBAC item above.)
  - [x] Multi-recipient access-link form: one row per email+role, submitted as N `tunnel_create_token`s. Role set = Viewer / Performer / Session Controller / Admin.
  - [x] Per-recipient "Email connection info" button spawns mailto with the direct link (plus username+password if just-created).
  - [ ] Storing the credential hashes in extended Ardour XML session metadata (currently stored in `$XDG_DATA_HOME/foyer/tunnel-manifest.json`). Deferred to a future pass — requires shim XML surgery and is orthogonal to the wire auth model.
- [ ] Both beat sequencer and midi roll should have a strip that can slide out from the right for managing instruments, patches, etc. (just a compact view of the same form on the track editor)
- [ ] You should not be able to hook up a mic from the browser to a midi track  
- [ ] Res (1/4, 1/8, 1/16, etc.) keeps resetting randomly when opening the beat sequencer. Make sure there is no default value clobbering the state value from the back end, thats what it seems like
- [x] Anonymous-visitor login page (when someone has the URL host but no token). `foyer-login-modal` shown on `is_tunnel && !is_authenticated`, submits email+password as `base64url` token, reloads. Rolled into DECISION 38.
- [ ] Remote sessions over the tunnel should have listen enabled by default, maybe even hidden from view
- [ ] Flakiness on Monitoring/listening setting with multiple clients connected. Make sure this is per client and sticky per client
- [x] For each recipient created, a "QR" icon renders the personal link as a QR code in an overlay (uses the existing `/qr` SVG endpoint).
- [ ] Projects should always be by absolute path - I see the same projects repeated, some are relative, some are absolute. From the UI perspective the jail's prefix should be stripped off of anything displayed on screen
- [ ] UX for floating windows versus tiles (tiles being core UI):
  - The track editor, plugin windows, beat editor, midi roll, and maybe a couple of other windows should be a different class of windows than the primary interfaces that has it's own separate dock lower on the right strip with small window indicators, and quick controls to tile all open windows, untile (capture last position before tiling, restore to this), minimize all, unminimize all. They should be styled differently to show they are a different layer of the application and should always float above core windows. Maybe add a hint of transparency and/or blur to background too.
  - Optionally have a tiled panel that can be scrolled h and v that contains a different view of all open float-class windows


- [ ] UI hot-serving from folder (via a CLI flag / config option) instead of built-in, and dump it from the rust binary on first load and serve it from the local folder instead of the bin
- [ ] Serve http, https, or both (via CLI flag / config option)
- [ ] (optionally scale aware) chord modifier keys for music sequence editor
- [ ] scale-highlighting in piano roll w/ options for weird scales, maybe microtonal
- [ ] Time marker (see head) doesn't seem to align with MIDI, and it also doesn't align with audio output. We need to figure out an algorithm to account for the offset and set the time marker to account for the delay. Streaming devices with bluetooth have this really well figured out, we should peek at some implementations of how video streams are set to a delay to allow the audio latency to set in. We'll need this all over the place, meters, visualizations, seek heads. Just anything that displays real-time display to the user, have it pipe through a function that can set and maintain a stream delay on it


- [ ] Undo/redo still broken
  - The `begin_reversible_command` wrapping we added makes single control changes undoable, but bulk operations (region deletes, plugin moves, track reorders) and rapid-fire sequences still don't group properly. Ardour's undo scope is complex — needs deeper investigation into `UndoTransaction` grouping, `Session::begin_reversible_command` naming for merge semantics, and whether Foyer should bundle rapid mutations into a single scoped command.
- [x] Plugin window drag still lags / feels "drunk"
  - DECISION 41: removed the `transition: left 0.18s ease, top 0.18s ease, ...` that turned every pointermove into a rubber-band animation, and dropped the `_repack()` clamp that snapped manually-dragged windows back into the workspace rect. Plugin floats now behave like `foyer-window` — dumb, direct, no fancy event-loop layer.
- [ ] Scrolling in midi roll is broken, can't vertically scroll after screen is painted, stuck at C7
Long term:

- [ ] **Scope RBAC denials to offender + admins.** Today `forbidden_for_role` / `auth_required` errors broadcast to every connected client, so a viewer can see another viewer's denial banner flash by. Clean fix: add an optional `target_peer_id` field to `Event::Error` (or a new admin-only `Event::RbacDenied`) and extend `should_forward_event` in `crates/foyer-server/src/ws.rs` to route denials only to (a) the offending connection and (b) LAN/admin roles. Offender gets a concise "you can't do that"; host + admins get the full `{recipient, role_id, command}` payload for audit; other guests see nothing. Message already names the recipient in current builds (DECISION 38), so the host-visibility half is in place — this is the client-scope half.


### Resampler:
- [ ] Add a foyer-audio crate (or module in foyer-backend) wrapping rubato::SincFixedIn with a small Resampler { in_rate, out_rate, channels } helper that pushes/pops f32 chunks.
- [ ] Ingress: in shim_input_port.cc drain_loop, check _sample_rate vs AudioEngine::instance()->sample_rate(); when mismatched, hold a rubato instance per port and run captured chunks through it before buf.read_from. Keep the 20 ms frame-size invariant on the output side, not input.
- [ ] Egress: in foyer-server/src/audio.rs encode_loop, resample the shim-side PCM to format.sample_rate before Opus/raw framing — wire it between the mpsc receiver and the encoder's frame batcher. Same Resampler helper.
- [ ] Bit depth: not a real concern — the whole pipeline is already f32 end-to-end (browser AudioWorklet, IPC pack_audio, Ardour AudioBuffer). No conversion needed unless we add a SampleFormat::S16Le variant later.
- [ ] Handshake: extend AudioIngressOpen so the client can send its actual AudioContext.sampleRate (don't hardcode 48k in audio-ingress.js:49), and have the shim echo back the engine's rate in AudioIngressOpened.format so the browser knows if it needs to resize its worklet buffer.

- [ ] Loop button quirk: main loop button loops last selection when no selection active
  - The transport-bar loop toggle uses `controlSet("transport.looping", !loop)` which sets an absolute boolean. When no explicit selection exists, Ardour's `loop_toggle()` falls back to the previous loop range. User wants: if no selection, either do nothing or show a hint. The timeline "Loop selection" button works correctly because it explicitly sends `set_loop_range` with selection bounds.


- [ ] Add read-only, transport-only, and admin roles, map API keys to roles, enforce on FE and BE
- [ ] Semantic plugin search?
- [ ] Plugin snapshot system (maybe use lightweight containers and run process in there?) with session
  - [ ] Export a full foyer container that includes the plugins used during the session in addition to the audio session
