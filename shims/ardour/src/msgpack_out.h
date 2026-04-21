/*
 * Foyer Studio — Ardour shim: MessagePack encoding helpers for outbound
 * Envelope<Control> frames.
 *
 * This is a small, hand-rolled encoder that writes only the msgpack forms we
 * need — keeps the shim's external deps to zero beyond the Ardour tree itself.
 * If this becomes fiddly we swap in `msgpack-c` and eat the system dep.
 *
 * Wire parity with the Rust side is verified via the integration test that
 * runs `foyer-cli --backend=host` against this shim (landing once Ardour is
 * actually built in the dev container).
 */
#ifndef foyer_shim_msgpack_out_h
#define foyer_shim_msgpack_out_h

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ARDOUR {
class Session;
class Route;
}
namespace PBD {
class Controllable;
}

namespace ArdourSurface::msgpack_out {

/// Encode `session.snapshot` from the current session state. The
/// `routes` list must come from the caller's own weak_ptr tracking
/// (see `SignalBridge::snapshot_tracked_routes`) — we do NOT touch
/// `session.get_routes()` here because that call can SIGSEGV on
/// RCU teardown races during session lifecycle transitions.
std::vector<std::uint8_t> encode_session_snapshot (
    ARDOUR::Session&,
    const std::vector<std::shared_ptr<ARDOUR::Route>>& routes);

/// Encode a `control.update` event for a single controllable.
std::vector<std::uint8_t> encode_control_update (ARDOUR::Session&, const PBD::Controllable&);

/// Encode the transport subtree as a batch of `control.update` messages (one
/// envelope, bundled in a meter_batch-style `Event::MeterBatch` shape).
std::vector<std::uint8_t> encode_transport_state (ARDOUR::Session&);

/// Encode a `session.patch` op=reload. Used when we don't want to compute
/// per-op patches for a structural change.
std::vector<std::uint8_t> encode_patch_reload ();

/// Encode `Event::RegionsList` — the reply to a `Command::ListRegions` for
/// one track. Carries timeline meta (sample rate + length) alongside the
/// regions so the client can lay things out without a second round trip.
std::vector<std::uint8_t> encode_regions_list (ARDOUR::Session&, const std::string& track_id);

/// Encode `Event::RegionUpdated` — a single region changed (position, length,
/// name, muted, etc). Clients patch their per-track region list in place.
std::vector<std::uint8_t> encode_region_updated (ARDOUR::Session&, const std::string& region_id);

/// Encode `Event::RegionRemoved` — the region was removed from its track.
std::vector<std::uint8_t> encode_region_removed (const std::string& track_id, const std::string& region_id);

/// Encode `Event::TrackUpdated { track }` for the route whose Foyer id
/// is `track_id`. Emits an empty payload if the track isn't found —
/// the caller should check `.empty()` before sending.
std::vector<std::uint8_t> encode_track_updated (ARDOUR::Session&, const std::string& track_id);

/// Encode `Event::SessionDirtyChanged { dirty }`.
std::vector<std::uint8_t> encode_session_dirty_changed (bool dirty);

/// Encode a `meter_batch` event containing `track.<id>.meter`
/// entries for every Track / Bus / Master in the session. Values
/// are peak-level dBFS, sampled at call time via
/// `Route::peak_meter()->meter_level(0, MeterPeak)`. Empty if the
/// session has no routes.
std::vector<std::uint8_t> encode_track_meters (ARDOUR::Session&);

/// Variant of `encode_track_meters` that reads from a caller-supplied
/// list of strong references instead of `Session::get_routes()`. Used
/// by the 30 Hz tick loop which maintains its own weak_ptr cache
/// (`SignalBridge::_tracked_routes`) and locks each entry just before
/// each tick — avoids the RCU teardown race where `get_routes()` can
/// SIGSEGV during session destruction with no Ardour-side hook
/// reliably firing "stop your reads now" for us.
std::vector<std::uint8_t> encode_track_meters_from_routes (
    const std::vector<std::shared_ptr<ARDOUR::Route>>& routes);

/// Encode `Event::PluginPresetsListed { plugin_id, presets }` answering
/// a `Command::ListPluginPresets` request.
std::vector<std::uint8_t> encode_plugin_presets_listed (
    ARDOUR::Session&, const std::string& plugin_id);

/// Encode `Event::PluginsList { entries }` — the catalog of every
/// plugin Ardour's PluginManager has scanned. Answers
/// `Command::ListPlugins`.
std::vector<std::uint8_t> encode_plugins_list ();

/// Encode `Event::AudioEgressStarted { stream_id }`. Sent after the
/// shim has installed a master tap — the HostBackend awaits this
/// ACK to resolve its `open_egress` oneshot.
std::vector<std::uint8_t> encode_audio_egress_started (std::uint32_t stream_id);

/// Encode `Event::AudioEgressStopped { stream_id }`.
std::vector<std::uint8_t> encode_audio_egress_stopped (std::uint32_t stream_id);

} // namespace ArdourSurface::msgpack_out

#endif
