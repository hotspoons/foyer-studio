/*
 * Foyer Studio — Ardour shim: subscribes to Ardour's signals, emits Foyer
 * events over the IPC connection.
 */
#ifndef foyer_shim_signal_bridge_h
#define foyer_shim_signal_bridge_h

#include "pbd/controllable.h"
#include "pbd/signals.h"

namespace ARDOUR {
class Route;
typedef std::list<std::shared_ptr<Route>> RouteList;
} // namespace ARDOUR

namespace ArdourSurface {

class FoyerShim;

class SignalBridge
{
public:
	explicit SignalBridge (FoyerShim&);
	~SignalBridge ();

	void start ();
	void stop ();

private:
	FoyerShim&                   _shim;
	PBD::ScopedConnectionList    _connections;

	void on_route_added (ARDOUR::RouteList&);
	void on_transport_state_changed ();
	void on_record_state_changed ();
	void on_controllable_changed (PBD::Controllable*);

	void subscribe_all ();
	void subscribe_controls_on_route (ARDOUR::Route&);
};

} // namespace ArdourSurface

#endif
