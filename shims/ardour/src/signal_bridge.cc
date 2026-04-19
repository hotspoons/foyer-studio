/*
 * Foyer Studio — Ardour shim: signal bridge.
 *
 * Hooks Ardour's signals and funnels them into outgoing Envelope<Event>
 * frames. Also calls into `schema_map` for structural snapshot emission.
 */
#include "signal_bridge.h"

#include <functional>

#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/stripable.h"
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
}

void
SignalBridge::stop ()
{
	_connections.drop_connections ();
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

	// Walk existing routes and wire per-control signals.
	std::shared_ptr<RouteList const> routes = session.get_routes ();
	for (auto const& r : *routes) {
		if (r) subscribe_controls_on_route (*r);
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
SignalBridge::on_route_added (RouteList& added)
{
	for (auto const& r : added) {
		if (r) subscribe_controls_on_route (*r);
	}

	// Simplest correct behavior for M3: emit a Reload patch hinting clients
	// to re-request a full snapshot. Per-op patches can land as an optimization.
	auto bytes = msgpack_out::encode_patch_reload ();
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_transport_state_changed ()
{
	auto bytes = msgpack_out::encode_transport_state (_shim.session ());
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_record_state_changed ()
{
	// Same envelope as transport — record-enable is just a transport field in
	// our schema.
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

} // namespace ArdourSurface
