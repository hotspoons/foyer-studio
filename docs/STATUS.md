# Capability snapshot

What's shipping, what's partial, what's next. Maintained alongside
[PLAN.md](PLAN.md); PLAN is the forward-looking backlog, this is
the "where we are today" table. Updated by convention on feature
merges.

| Capability | State |
|---|---|
| Stub backend (in-memory demo session) | Shipping — 6 tracks with realistic plugin params |
| Ardour shim — transport (play/stop/rec/loop), control updates, 30 Hz playhead tick | Shipping |
| Ardour shim — real regions + source paths (playlist walk + Playlist signals) | Shipping |
| Ardour shim — per-track plugin enumeration + parameter emission | Shipping |
| Ardour shim — track rename/color (`UpdateTrack` → `set_name` / `PresentationInfo::set_color`) | Shipping |
| Ardour shim — action dispatch (`edit.undo/redo`, `session.save`, `session.save_as`, `plugin.rescan`, `track.add_audio/bus`) | Shipping |
| Ardour shim — session dirty + signal bridge | Shipping |
| Ardour shim — plugin parameter live updates (`ParameterChangedExternally` + `ActiveChanged`) | Shipping |
| Ardour shim — MIDI note emission (MidiModel walk, inline on region list) | Shipping |
| Symphonia-backed waveform peak decoder (WAV / FLAC / AIFF / OGG / Vorbis) | Shipping |
| Vector waveform renderer — port of Ardour's WaveView connected-line algorithm, viewport-cropped Canvas2D | Shipping |
| Schema-driven plugin panels | Shipping — `<foyer-plugin-panel>` renders any `PluginInstance.params` |
| Plugin picker modal + Add/Remove round-tripped through shim | Shipping |
| Errored-plugin row in the track strip with localStorage-persisted dismiss | Shipping |
| Track editor modal (right-click track label → rename/color/comment + embedded mixer strip) | Shipping |
| Tile tree + floating windows + slot picker + paired-edge resize | Shipping |
| Tear-out (tile header, plugin strip, menu items) + right-dock | Shipping |
| Layouts + Agents FABs as right-dock slide-out panels | Shipping |
| Layout presets + user-assigned chords | Shipping |
| Keyboard-first WM + AHK-flavored automation | Shipping |
| Transport bar with pulsing record, 3-mode return-on-stop, undo/redo/save cluster | Shipping |
| Multi-track selection + zoom-to-selection w/ back-stack | Shipping |
| Selection ops — delete / mute toggle across selection | Shipping |
| Return-on-stop mode (stay / zero / play-start) with front-end position lock + mid-play seek tracking | Shipping |
| MIDI piano roll component (modal via region right-click; reads shim-emitted notes) | Shipping |
| Client-side settings modal (preferences, waveform style/palette, transport mode) | Shipping |
| Session share modal with QR + URL copy | Shipping |
| Dev integration test harness (`/dev/run-tests` + diagnostics panel) | Shipping — 9 probes, all green against stub |
| Playwright smoke harness (`just test-ui`, `just ui-probe`) | Shipping — 7 specs covering boot + chrome |
| Session save + save-as (shim-side `session.save_state(path)`) | Shipping |
| Audio I/O schema (IoPort + WebRTC/WebSocket transport negotiation) | Shipping — wire types land; runtime stubs pending |
| Audio egress test-tone path (sidecar synth → Opus / raw f32 → binary WS fan-out) | Shipping — listen button works against synth |
| Audio egress real master tap (shim RT `Processor` + ring buffer + drain thread) | Shipping — real master-bus audio flows via host backend |
| Out-of-tree shim build (CMake, no Ardour source edits, `ARDOUR_SURFACES_PATH`-installable) | Shipping — `just shim build && just shim install` |
| Cloudflare tunnel auto-provision + RBAC-gated remote access | Shipping — quick tunnels + full account-linked; see DECISIONS 35–38 |
| Three-tier web split (`foyer-core` / `foyer-ui-core` / `ui-*` variants) with auto-discovery | Shipping — see DECISION 40 + [../web/HACKING.md](../web/HACKING.md) |
| Hot-serve web assets from `$XDG_DATA_HOME/foyer/web/` + runtime overlay dirs | Shipping — users hack UI in place; see [DEVELOPMENT.md](DEVELOPMENT.md) |
| Server-authoritative peer roster (host + tunnel guests) | Shipping — DECISION 39 |
| WebRTC audio forwarding (M6b ingress, M6c latency probe) | Schema ready; runtime pending |
| Busses / groups / sends (schema fields + mixer UI) | Partial — schema + routing panel; group CRUD modal shipping, sends UI pending |
| Region fade-in / fade-out / trim-to-selection ops | Not yet |
| Standalone `.so` shim (drop-in for upstream Ardour) | Not yet |
| MCP agent round-trip | Panel + settings stub; no tool runtime yet |
| Voice chat between connected clients | Planned |
| Multi-window pop-out via `?window=N` | Planned |
| Alternate UI variants (`ui-lite`, `ui-touch`, `ui-kids`) | Scaffolding ready, no concrete variants written beyond `ui-full` |
