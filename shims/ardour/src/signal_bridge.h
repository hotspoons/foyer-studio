/*
 * Foyer Studio — Ardour shim: subscribes to Ardour's signals, emits Foyer
 * events over the IPC connection.
 */
#ifndef foyer_shim_signal_bridge_h
#define foyer_shim_signal_bridge_h

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "pbd/controllable.h"
#include "pbd/signals.h"

namespace ARDOUR {
class Route;
class Region;
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

	// Position/transport-state ticker. Ardour only emits PositionChanged
	// for non-sequential motion (locates) — continuous playhead motion
	// has no signal, so we poll at ~30 Hz and broadcast a meter_batch
	// containing the live transport fields. Running as a plain
	// std::thread keeps the glib main-loop integration simple.
	std::thread                  _tick_thread;
	std::atomic<bool>            _tick_stop { false };
	void tick_loop ();

	void on_route_added (ARDOUR::RouteList&);
	void on_transport_state_changed ();
	void on_record_state_changed ();
	void on_controllable_changed (PBD::Controllable*);
	void on_region_added (std::weak_ptr<ARDOUR::Region>, std::string track_id);
	void on_region_removed (std::weak_ptr<ARDOUR::Region>, std::string track_id);
	void on_route_presentation_changed (std::string track_id);
	void on_dirty_changed ();

	void subscribe_all ();
	void subscribe_controls_on_route (ARDOUR::Route&);
	void subscribe_playlist_for_route (ARDOUR::Route&);
	void subscribe_presentation_for_route (ARDOUR::Route&);
};

} // namespace ArdourSurface

#endif
