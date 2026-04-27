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
- [/] scale aware chord modifier keys for music sequence editor - we need somewhere to save the scale (probably already project built-in, need to surface it and put it as an option next to tempo in the main menu). Modifer keys should control auto-best-triad, 7th, 9th, some other jazz chords, then chromatic override for maj/min/7/9/4/dim/ etc. ignoring scale. Need opinions on keys to use for this as modifiers when clicking
  - **Done overnight (2026-04-25):** chord-on-click in the piano roll. Hold a digit (3..9) and click — the editor stacks a chord rooted at the clicked pitch. Modifier resolves the variant: Shift→major-flavored, Ctrl/Cmd→minor-flavored, both→dominant/third-option (e.g. Ctrl+9 = m9, Shift+7 = maj7, Ctrl+Shift+7 = dom7). With NO modifier the chord follows the active scale's stack-of-thirds (diatonic). Implemented in [midi-editor.js](web/ui-full/components/midi-editor.js) (`chordIntervals()`, `_heldChordDigit`, canvas-down chord branch). Scale + root come from the new toolbar pickers added for #36.
  - **Still pending:** session-level scale storage (so reopening a session restores root/mode); the same chord behavior in the beat sequencer's pitched mode; transport-bar "Scale" chip next to tempo. Today's prefs are per-browser localStorage.
- [/] Scale-highlighting in piano roll w/ options for weird scales
  - **Done overnight (2026-04-25):** added a Scale group to the piano-roll toolbar (root pitch class + mode dropdown). Twelve modes ship: major, natural minor, dorian, phrygian, lydian, mixolydian, locrian, harmonic minor, melodic minor, pentatonic major, pentatonic minor, blues, chromatic. In-scale keys on the keyboard rail get a soft accent-2 tint; the root note gets a stronger accent. Pref persists per-browser. See [midi-editor.js](web/ui-full/components/midi-editor.js) `SCALES` + `inScale`. Future weird scales (microtonal, Indian raga, etc.) drop in by adding entries to the `SCALES` table.
- [x] Plugin windows should have same frosted transparent background other widget windows have. Set `:host { background: transparent }` in [plugin-panel.js](web/ui-full/components/plugin-panel.js); the foyer-window's `backdrop-filter: blur(18px) saturate(130%)` shell now shows through.
- [x] Quantization grid on UI (hideable) based on BPMs. Ability to drag waveforms and sequences to snap to it with a modifer
  - **Done overnight:** BPM-quantized grid overlay on the timeline. New "Grid" checkbox in the toolbar + subdivision picker (1/4, 1/8, 1/16, 1/32, 1/8T, 1/16T). Beat boundaries get a stronger accent-2 line; in-beat subdivisions get a lighter one. Reads `transport.tempo` from the live store so a tempo change reflows the grid. Pref persists per-browser. See [timeline-view.js](web/ui-full/components/timeline-view.js) `_renderQuantGrid`.
  - **Still pending:** snap-to-grid on drag. Scaffolding is in place (the grid math gives you a sample-aligned step list); needs hookup in `_startDrag` for regions and selection-handle drags so a Shift-held drag commits to the nearest grid step.
- [x] Tunnel clients don't hear audio until they open the mixer once. Resolved by hoisting `AudioListener` into `audioController` (web/core/audio/master-controller.js); singleton attached at app boot regardless of mixer mount.
- [x] Chat notifications don't show on docked FAB, only floating FAB for chat. Need this to show on the FAB and we need a toast or what ever they are called if chats come in and the chat UI isn't open. Fixed in two parts: (1) [chat-panel.js](web/ui-full/components/chat-panel.js) now increments `_unreadCount` whenever the chat UI isn't `_open`, regardless of dock state, and exposes `dockBadge()`; (2) [right-dock.js](web/ui-full/components/right-dock.js) reads `fab.dockBadge?.()` on each render and overlays a red pill on the rail icon. Toast: arrives via [toast.js](web/ui-core/widgets/toast.js) for any non-self message received while chat is closed (3s ttl, click to dismiss).
- [x] Restore old slide-out panel behavior for docked FABs, it was a much nicer design 
  - **Done overnight:** real slide-out is back, this time via slot projection. Right-dock has `<slot name="slide-out">` and a width-resizable container. Each FAB exposes `enterSlideMode(dockHost)` / `exitSlideMode()` that physically reparent the FAB element under the right-dock's host with `slot="slide-out"`. The FAB renders in slide mode with `position: relative; width: 100%; height: 100%` — its OWN shadow root still owns styling so all the scoped CSS (transcript, composer, tabs, etc.) works correctly. Width persists as `foyer.rightdock.slide.w`. Tap rail icon → slide opens; tap same icon again → close; tap a different icon → swap. (Rich, TODO #41.)
  - **Pre-existing FAB-popout mode** also still works for the un-docked case — the floating FAB still renders its own quadrant-anchored popout. Slide-out only kicks in when the FAB is docked AND the user taps its rail icon.
- [x] Clicking "Unsaved" should launch a confirmation dialog "Would you like to save"? Save/Cancel. Replaced with `document-save` icon, click triggers `confirmAction` then sends `session.save`. (See status-bar.js.)
- [x] The layout-dirty indicator: replaced with a `squares-2x2` icon, no text — turns yellow when the layout is unsaved. (See status-bar.js.)
- [x] Solo states not synced on session load. Root cause: the shim's `session_snapshot` emitter hardcoded `mute`/`solo`/`gain`/`pan` to default values (`false`/`0.0`) on the initial state instead of reading `route->{solo,mute,gain,pan}_control()->get_value()`. Live updates worked (signal_bridge wires the controls), so toggling the channel re-synced. Fixed in shims/ardour/src/msgpack_out.cc — snapshot now reads live values.
- [/] Undo/redo in the midi editor doesn't repaint the notes, it should always sync with the back end
  - **Note from overnight:** the user said this looked fixed for the piano roll already; left as `[/]` pending re-verification with the latest build. The piano roll's undo/redo path goes through the shim's `MidiModel::apply_diff_command_as_commit`, which is reversible at Ardour's level. The note re-render relies on the `region_updated` echo updating `editor.notes`. If the symptom returns, instrument the `_onChatChange`-style `region_updated` listener in [timeline-view.js](web/ui-full/components/timeline-view.js) `_openMidiEditor` to confirm it's firing.
- [x] Undo/redo icons are 90 degrees off, they should be the same as the title bar. Rotated the SVG 90° in [transport-bar.js](web/ui-full/components/transport-bar.js) `.btn.edit svg { transform: rotate(90deg) }` so the heroicons arrow-uturn-left/right read like the conventional ↶/↷ undo glyph used in the piano roll.
- [x] Icon padding in undo/redo/music icon for midi channel in midi editor is skewed to the top, the icons are top heavy. Added a `translateY(1px)` nudge on the rotated SVG span in [transport-bar.js](web/ui-full/components/transport-bar.js) to balance the rotated arrowhead's bbox.
- [x] Slide out midi form is too cramped - consider just having it be a small modal over top of the midi roll that can be dismisses instead of sliding out
- [x] No midi instrument/patch form in the beat editor! Need this to match the piano roll
  - **Done overnight:** the side-strip with `<foyer-midi-manager>` already exists in beat-sequencer; only the toolbar trigger was missing, so users couldn't discover the strip. Added a chevron/musical-note button to the toolbar (parity with the piano-roll toolbar) in [beat-sequencer.js](web/ui-full/components/beat-sequencer.js).
- [x] The tiling controls on the tiled windows (mixer and timeline) are dubious and don't really do anything. Let's get rid of them and drop the code. Removed split-right / split-below / float / dock-to-slot buttons from the tile header in [tile-leaf.js](web/ui-core/layout/tile-leaf.js); kept view-swap + close. Helpers (`_float`, `_dockTarget`, the split modes) stay because the right-click context menu still references them.
- [/] Selection resize handles! And visualization when hovering over the timeline of where the cursor is (e.g. a vertical line) to help with setting up selections
  - **Done overnight:** time-range selection now has `.selection-handle.{left,right}` divs at the band's edges. Hover shows the handle (accent-2 fill); drag mutates `selection.{start,end}Samples` and fires `timeline-selection` on release. Hover cursor: `_hoverSamples` state tracks the pointer's sample position via `@pointermove` on the `.grid`; `.cursor-line` renders a 1px muted vertical line distinct from the playhead. See [timeline-view.js](web/ui-full/components/timeline-view.js).
  - **Pending:** audio region edge resize. Region rectangles in the lanes don't yet have hover handles — same shape as the selection handles, just per-region.
- [x] Clicks inside of buttons inside of buttons (e.g. M/S/R/A buttons) shouldn't propogate to double-click sensitive parents like timeline strip headers. Added `@dblclick=${e => e.stopPropagation()}` on the `.lane-controls` wrapper in [timeline-view.js](web/ui-full/components/timeline-view.js); a fast double-tap on M/S/R/A no longer bubbles to lane-head and spawns the track editor. The track-strip mixer already filtered foyer-toggle in `_onStripDblClick` so it was already covered there.
- [x] Some widgets like combo boxes steal focus and don't give it back as long as they are on screen, like plugin config widgets. I can't start the session roll with the space key if it keeps opening the scale root picker. Installed a global capture-phase `change` listener in [app.js](web/ui-full/app.js) that blurs any `<select>` once it commits a value. Covers all existing combo boxes plus future ones (the new scale root picker, beat-sequencer drum kit, plugin enums) without per-handler `target.blur()` ceremony.
- [x] Clicking the tiled window picker (mixer and timeline) renders the pop-up in the upper-left corner always, not where you would expect. The tile-leaf menu was pinned to `left: 6px; top: 28px`. `_openMenu` now reads the trigger button's bounding rect and sets inline `left`/`top` on the `.menu` so it drops below whichever button opened it. See [tile-leaf.js](web/ui-core/layout/tile-leaf.js).
- [/] Create MacOS and Linux builds (arm64 and amd64) against 9.2 tag, fix the tag in the clone process for this repo, come up with plan for building plugins for multiple versions of ardour codebase (Let's plan to support Ardour 9.0 and newer) - and is there a free tier for github runners? How can we build this? I have a Mac but I am running from a dev container - can I mount the darwin SDK into the dev container? Help me out here. I also have an AI startup with a lab and kubernetes but this is a personal project so I probably shouldn't stand up a runner in our environment. Maybe I'll look into that
  - **Shipped 2026-04-25 (scaffolding):**
    - [release.yml](../.github/workflows/release.yml) — 4-cell matrix
      `{ubuntu-24.04, ubuntu-24.04-arm, macos-13, macos-14}`, builds Ardour
      @ `ARDOUR_TAG` (default `9.2` — Ardour tags are `<major>.<minor>` only),
      shim, and `foyer` release; bundles
      each cell into `foyer-<os>-<arch>.zip` and attaches them (plus a
      mirrored `install.sh`) to a GitHub release on `v*` tag push.
      `workflow_dispatch` exposes `ardour_tag` + `release_tag` inputs so
      the matrix can be exercised without cutting a tag. Ardour
      source+build dir is cached per `(os, arch, tag)` — first run is the
      slow ~30 min path, repeats are fast.
    - [scripts/dev/ardour.sh](../scripts/dev/ardour.sh) — `do_clone` is now
      `git clone --depth 1 --branch $ARDOUR_TAG`, parameterized by an
      `ARDOUR_TAG` env (default `9.2`).
    - [scripts/release/bundle.sh](../scripts/release/bundle.sh) — packages
      `foyer` + `libfoyer_shim.{so,dylib}` + LICENSE + LICENSE-GPL + a
      copy of `install.sh` + a README into the per-platform zip. Driven
      by `OS_LABEL` / `ARCH` env so the GitHub matrix and a local
      `just release-bundle` produce identical layouts.
    - [install.sh](../install.sh) — one-shot installer. Detects platform,
      downloads the matching zip from the GH release, drops `foyer` at
      `~/.local/share/foyer/bin/foyer`, drops the shim at the OS-specific
      Ardour surfaces dir (`~/.config/ardour9/surfaces` on Linux,
      `~/Library/Preferences/Ardour9/surfaces` on macOS), and idempotently
      adds `~/.local/share/foyer/bin` to PATH in `~/.bashrc`/`.zshrc`/
      `.profile` (sentinel-marked, removed on uninstall). On macOS it
      strips the quarantine xattr so Gatekeeper won't block dlopen of an
      unsigned bundle. `install.sh uninstall` reverses; `install.sh
      uninstall --purge` also wipes `~/.local/share/foyer`. Also supports
      `--from-bundle DIR` for offline / pre-extracted installs. Smoke-
      tested locally with a faked bundle; the network path is unverified
      until the first tag push lands.
    - [Justfile](../Justfile) — `just release-bundle` recipe builds the
      same zip locally for sanity checks.
  - **Still pending:**
    - First real CI run will probably surface missing apt/brew packages
      (Ardour's transitive dep list is long; we erred generous but didn't
      enumerate exhaustively). Iterate the dep blocks until a green run
      lands.
    - macOS shim build uses Homebrew system deps via `--boost-include`
      and a `PKG_CONFIG_PATH` extension (see [scripts/dev/ardour.sh](../scripts/dev/ardour.sh)
      `do_configure`). Ardour upstream prefers their bundled GTK stack
      (`tools/osx_packaging/nettle.gtk-stack`) — if Homebrew-deps starts
      drifting in subtle ways (e.g. macOS bundle won't run on a vanilla
      Mac without Homebrew), switch to the bundled-stack path.
    - Multi-Ardour-version matrix. Today the matrix is single-axis on
      Ardour 9.2; growing to `{9.0, 9.1, 9.2}` is a `matrix.include`
      expansion + a `compat.h` of `#if`-guarded shims for the two known
      drift points. Defer until a 9.3 release shows up and forces it.
    - macOS code signing. The shipped `.dylib` is unsigned; the install
      script's `xattr -dr com.apple.quarantine` is the workaround. A
      notarized developer-ID-signed bundle would be cleaner but requires
      an Apple developer account and a signing cert in CI secrets.
  - **Original research note (overnight, was planning-only — kept for context):**
  - **GitHub runners — free tier reality.** Public repos get free macOS runners (M1, both arm64 & x86_64 via Rosetta) and free Linux x86_64. **Linux arm64 is NOT in the free tier** as of the cutoff — needs the new `ubuntu-24.04-arm` runners which are only free on public repos as of 2025. If Foyer goes public, the matrix is `{macos-14, macos-13, ubuntu-24.04, ubuntu-24.04-arm}` × `{Ardour 9.0, 9.1, 9.2}` and stays on the free tier. If it stays private, expect ~$0.16/min for macOS and ~$0.008/min for Linux x64 — modest given a build is ~10 min, so a full matrix run is < $5. Rough math: 12 build cells × 10 min × ($0.16 macOS / $0.008 Linux) ≈ $4 a run.
  - **Mac SDK in the dev container — don't.** Apple's licensing forbids redistributing the macOS SDK or running it on non-Apple hardware. The dev container path is to *cross-compile from Linux to macOS* using `osxcross`, which is technically possible but it (a) needs an SDK you legally extracted from your own Mac, (b) breaks every time Apple changes a header, (c) doesn't run the resulting binary, so testing still requires hardware. Practical answer: keep the dev container for the Linux build & web/Rust work, and run macOS builds either on your Mac directly or on a GitHub macOS runner.
  - **Multi-Ardour-version plan.** The shim ABI surface is small: `dispatch.cc`, `signal_bridge.cc`, `msgpack_out.cc`, plus a few headers from `ext/ardour/libs/ardour/`. The realistic strategy is one build cell per supported Ardour major.minor (9.0, 9.1, 9.2) × OS — checkout the corresponding Ardour tag as a submodule and let CMake link against that tree. Where Ardour's API drifts (e.g. `MonitorControl::Changed` signature, `Route::reorder_processors` collection type), gate on `#if ARDOUR_VERSION_AT_LEAST(...)`. Ardour exposes `libs/ardour/ardour/version.h` with `LIBARDOUR_VERSION_*` macros; we should grow a small `compat.h` of `#if`-guarded shims when divergences appear. So far we've hit two: `reorder_processors` taking `ProcessorList` (std::list) vs vector pre-9.x, and `MonitorControl::Changed` arity. Both are short-circuited today via the existing code; a real matrix would catch them at compile time.
  - **CI shape that scales.** `.github/workflows/release.yml` matrix: `os ∈ {macos-14, macos-13, ubuntu-24.04, ubuntu-24.04-arm}`, `ardour ∈ {9.0.0, 9.1.0, 9.2.0}`, fan-out via the existing `just prep` recipe. Cache the `ext/ardour` clone keyed on the tag so each cell pays Ardour's ~3 min checkout once, not per build. Cache the cmake-build dir keyed on `(os, ardour, shim source hash)`. Artifacts: `foyer_shim.so` per cell, `foyer` Rust binary per (os, arch), tarred together as a release. The Rust binary is OS+arch-dependent only (no Ardour version coupling); the shim is the version-pinned half.
  - **Personal vs work resources.** Public-repo + GitHub free runners is the right answer — keeps Foyer disentangled from anything you don't want lab compute associated with. K8s in the lab would be overkill and would create a "if I leave the company, the build pipeline dies" failure mode you don't want for a personal project. If the matrix ever DOES outgrow free-tier, look at GitHub's `ubuntu-24.04-arm` (newly free on public repos) before standing up self-hosted.
  - **Fix the clone process.** `just prep` (or wherever Ardour gets cloned) probably hardcodes a branch instead of the tag. Make it `git -c advice.detachedHead=false clone --depth 1 --branch v9.2.0 https://...`, parameterized by an `ARDOUR_TAG` env var with a sensible default. Then the CI matrix sets `ARDOUR_TAG` per cell. — This is a 5-line change to the Justfile when you're ready.


- [ ] Cut/copy/paste/delete/duplicate/mute region selections 
  - Need this standard DAW workflow to function for true basic feature completion, and it needs to work with multiple tracks selected. Getting waveform previews of ranges can either be easy or hard depending on how Ardour handles this internally - if they are just crops to existing full waveforms, it should be pretty easy. Nothing under edit excep undo and redo works, but this is all well handled on the back end so it should just be tapping into that and making sure we update front end visualizations
- [ ] Need beats per bar and note value to provide proper timing grid/time signature for composition
- [ ] Need clock view (should be hide-able, maybe in a common grouping with tempo and time signature - this isn't always required to run the DAW so having this so it can be hidden or shown when not needed would be helpful)
- [ ] Layouts should be first menu item in FAB dock, windows last item
- [ ] Clear peak cache doesn't seem to do anything, maybe we delete
- [ ] Adjusting track height on one track when multiple are selected in the timeline should resize all of the selected tracks, not just the one being resized

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
- [x] Track Auto/In/Disk monitor buttons ignored the first click. Two-part bug:
  (a) Ardour's `MonitorControl::set_value` queues to the audio thread, so dispatch.cc's
  inline `encode_track_updated` after the patch read the OLD enum and broadcast a stale
  echo that overwrote the client's optimistic update. Fixed by wiring
  `r.monitoring_control()->Changed` in `signal_bridge.cc` to `on_route_presentation_changed`
  so the settled-state echo always lands. (b) The track-strip's optimistic mutation lived
  on `this.track`, which the parent's next render replaced with the stale store value.
  Moved the optimistic state to a dedicated `_monitoringPending` Lit state field that's
  cleared on echo.

## UI shape

- [x] UX for floating windows vs tiles (tiles being core UI)
  - Widgets layer shipped (DECISION 42 + the 2026-04-25 push). Track editor, plugin
    configs, beat sequencer, MIDI editor, console, diagnostics all share `<foyer-window>`
    chrome — frosted shell (`backdrop-filter: blur(18px) saturate(130%)`), dock list with
    eye/lock/tile-all/spawn controls, idempotent on storage-key, persist across reload,
    `kind: "external"` discriminator so the dock lists them without touching tile-class
    floats. Right-dock rail is the home for the dock; clicking a rail icon focuses the
    existing window. Restore-all kept; minimize-all retired (eye toggle covers it).
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
    - [x] `move_plugin` end-to-end. Wired through trait + HostBackend + shim
      `Kind::MovePlugin` handler using `Route::reorder_processors` (std::list).
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
