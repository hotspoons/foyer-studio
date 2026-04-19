/*
 * Foyer Studio — Ardour shim: signal bridge.
 *
 * Hooks Ardour's signals and funnels them into outgoing Envelope<Event>
 * frames. Also calls into `schema_map` for structural snapshot emission.
 */
#include "signal_bridge.h"

#include <chrono>
#include <functional>
#include <sstream>

#include "ardour/playlist.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "pbd/controllable.h"

#include "ipc.h"
#include "msgpack_out.h"
#include "schema_map.h"
#include "surface.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface {

SignalBridge::SignalBridge (FoyerShim& s)
    : _shim (s)
{
}

SignalBridge::~SignalBridge ()
{
	stop ();
}

void
SignalBridge::start ()
{
	subscribe_all ();
	_tick_stop.store (false);
	_tick_thread = std::thread (&SignalBridge::tick_loop, this);
}

void
SignalBridge::stop ()
{
	_tick_stop.store (true);
	if (_tick_thread.joinable ()) {
		_tick_thread.join ();
	}
	_connections.drop_connections ();
}

void
SignalBridge::tick_loop ()
{
	// Poll Ardour's transport state at 30 Hz. Every 30 ticks (1 s) we
	// dump the full transport state dict into daw.log so we can trace
	// what's happening without needing a debugger. Once transport works
	// reliably we'll drop the verbosity back to emit-only.
	int idle_counter = 0;
	int log_counter = 0;
	samplepos_t last_logged_sample = -1;
	while (!_tick_stop.load ()) {
		std::this_thread::sleep_for (std::chrono::milliseconds (33));
		if (_tick_stop.load ()) break;

		auto& session = _shim.session ();
		const bool playing = session.transport_state_rolling ();
		const samplepos_t sample = session.transport_sample ();

		if (++log_counter >= 30) {
			log_counter = 0;
			PBD::warning << "foyer_shim: TICK playing=" << playing
			             << " sample=" << sample
			             << " rolling=" << session.transport_rolling ()
			             << " stopped=" << session.transport_stopped ()
			             << " rec_enabled=" << session.get_record_enabled ()
			             << " actively_rec=" << session.actively_recording ()
			             << " (last_emitted_sample=" << last_logged_sample << ")" << endmsg;
		}

		// Skip most idle ticks to keep the wire quiet when nothing is
		// moving. We still emit every ~6th idle tick (≈200 ms) so any
		// drift between shim and client reconciles.
		if (!playing) {
			if (++idle_counter < 6) continue;
			idle_counter = 0;
		} else {
			idle_counter = 0;
		}

		last_logged_sample = sample;
		auto bytes = msgpack_out::encode_transport_state (session);
		_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
	}
}

void
SignalBridge::subscribe_all ()
{
	Session& session = _shim.session ();

	session.RouteAdded.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_route_added, this, _1),
	    _shim.event_loop ());

	session.TransportStateChange.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_transport_state_changed, this),
	    _shim.event_loop ());

	session.RecordStateChanged.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_record_state_changed, this),
	    _shim.event_loop ());

	session.DirtyChanged.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_dirty_changed, this),
	    _shim.event_loop ());

	// Walk existing routes and wire per-control + per-playlist signals.
	std::shared_ptr<RouteList const> routes = session.get_routes ();
	for (auto const& r : *routes) {
		if (!r) continue;
		subscribe_controls_on_route (*r);
		subscribe_playlist_for_route (*r);
		subscribe_presentation_for_route (*r);
	}
}

void
SignalBridge::subscribe_controls_on_route (Route& r)
{
	auto wire = [&] (std::shared_ptr<AutomationControl> c) {
		if (!c) return;
		c->Changed.connect (
		    _connections, MISSING_INVALIDATOR,
		    std::bind<void> (&SignalBridge::on_controllable_changed, this, c.get ()),
		    _shim.event_loop ());
	};
	wire (r.gain_control ());
	wire (r.pan_azimuth_control ());
	wire (r.mute_control ());
	wire (r.solo_control ());
	if (auto rec = r.rec_enable_control ()) wire (rec);
}

void
SignalBridge::subscribe_playlist_for_route (Route& r)
{
	// Only Tracks have playlists; Busses/Masters don't host regions.
	auto track = dynamic_cast<Track*> (&r);
	if (!track) return;
	auto playlist = track->playlist ();
	if (!playlist) return;

	std::ostringstream o;
	o << r.id ();
	const std::string track_id = "track." + o.str ();

	playlist->RegionAdded.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_region_added, this, _1, track_id),
	    _shim.event_loop ());
	playlist->RegionRemoved.connect (
	    _connections, MISSING_INVALIDATOR,
	    std::bind<void> (&SignalBridge::on_region_removed, this, _1, track_id),
	    _shim.event_loop ());
}

void
SignalBridge::subscribe_presentation_for_route (Route& r)
{
	// The Stripable's PresentationInfo emits PropertyChanged when its
	// name, color, order, or flags change. We funnel that into a single
	// `track_updated` event (re-reading the current state) — simpler
	// than filtering by PropertyDescriptor, and the payload is small.
	std::ostringstream o;
	o << r.id ();
	const std::string track_id = "track." + o.str ();

	// PropertyChanged carries a `PBD::PropertyChange` that we don't need
	// to inspect — any change on the stripable warrants a full
	// `track_updated` re-emit. Lambda discards the arg.
	r.presentation_info ().PropertyChanged.connect (
	    _connections, MISSING_INVALIDATOR,
	    [this, track_id] (PBD::PropertyChange const&) {
	        on_route_presentation_changed (track_id);
	    },
	    _shim.event_loop ());
	r.PropertyChanged.connect (
	    _connections, MISSING_INVALIDATOR,
	    [this, track_id] (PBD::PropertyChange const&) {
	        on_route_presentation_changed (track_id);
	    },
	    _shim.event_loop ());
}

void
SignalBridge::on_route_presentation_changed (std::string track_id)
{
	auto bytes = msgpack_out::encode_track_updated (_shim.session (), track_id);
	if (!bytes.empty ()) {
		_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
	}
}

void
SignalBridge::on_route_added (RouteList& added)
{
	for (auto const& r : added) {
		if (!r) continue;
		subscribe_controls_on_route (*r);
		subscribe_playlist_for_route (*r);
		subscribe_presentation_for_route (*r);
	}

	// Simplest correct behavior for M3: emit a Reload patch hinting clients
	// to re-request a full snapshot. Per-op patches can land as an optimization.
	auto bytes = msgpack_out::encode_patch_reload ();
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_transport_state_changed ()
{
	auto& s = _shim.session ();
	PBD::warning << "foyer_shim: SIGNAL TransportStateChange: "
	             << "sample=" << s.transport_sample ()
	             << " rolling=" << s.transport_rolling ()
	             << " state_rolling=" << s.transport_state_rolling ()
	             << " stopped=" << s.transport_stopped ()
	             << " rec_enabled=" << s.get_record_enabled () << endmsg;
	auto bytes = msgpack_out::encode_transport_state (s);
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_record_state_changed ()
{
	PBD::warning << "foyer_shim: SIGNAL RecordStateChanged: "
	             << "rec_enabled=" << _shim.session ().get_record_enabled ()
	             << " actively_rec=" << _shim.session ().actively_recording () << endmsg;
	on_transport_state_changed ();
}

void
SignalBridge::on_controllable_changed (PBD::Controllable* c)
{
	if (!c) return;
	auto bytes = msgpack_out::encode_control_update (_shim.session (), *c);
	if (!bytes.empty ()) {
		_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
	}
}

void
SignalBridge::on_dirty_changed ()
{
	auto bytes = msgpack_out::encode_session_dirty_changed (_shim.session ().dirty ());
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_region_added (std::weak_ptr<Region>, std::string track_id)
{
	// Coarse-grained: re-emit the whole regions_list for the affected track.
	// A per-region `RegionUpdated` would be slimmer; this is the minimum
	// correct behavior and the wire form clients already expect when they
	// refetch on `BackendSwapped` / reload.
	auto bytes = msgpack_out::encode_regions_list (_shim.session (), track_id);
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_region_removed (std::weak_ptr<Region> wr, std::string track_id)
{
	auto r = wr.lock ();
	if (r) {
		std::ostringstream o;
		o << r->id ();
		auto bytes = msgpack_out::encode_region_removed (track_id, "region." + o.str ());
		_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
	} else {
		// Lost the region before we could describe it; fall back to a
		// list refresh so clients re-converge.
		auto bytes = msgpack_out::encode_regions_list (_shim.session (), track_id);
		_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
	}
}

} // namespace ArdourSurface
