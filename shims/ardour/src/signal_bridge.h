// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: subscribes to Ardour's signals, emits Foyer
 * events over the IPC connection.
 */
#ifndef foyer_shim_signal_bridge_h
#define foyer_shim_signal_bridge_h

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

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

	// Edge-detector for 0→1 rolling transitions. Flagged via atomic
	// so the signal handler (event-loop thread) and any future
	// non-rt reader don't race. Seeded false; first TransportStateChange
	// after load either confirms stopped or marks a start we can
	// capture a stacktrace for.
	std::atomic<bool>            _last_rolling { false };

	// Auto-play suppression window. Ardour's FSM can flip to Rolling
	// at any point during the first few seconds post-session-load
	// (root cause still TBD — see on_session_loaded). A single-shot
	// stop at subscribe time (the original workaround) catches it
	// only if the flip happened BEFORE subscribe fired, which it
	// frequently doesn't. This window lets every TransportStateChange
	// within N seconds of subscribe cross-check against the last
	// user play-request: if we see a 0→1 transition with no recent
	// dispatch-path `transport.playing=true`, we stop it.
	std::chrono::steady_clock::time_point _startup_grace_until {};
	std::atomic<std::int64_t>    _last_user_play_ms { 0 };

public:
	/// Called by the dispatcher when the client explicitly sets
	/// `transport.playing = true`. Records a timestamp so the
	/// auto-play suppression window can tell "user clicked play"
	/// from "Ardour FSM spontaneously started rolling" and only
	/// interdict the latter.
	void note_user_play_request ();
private:

	// Session route-list readiness gate. `Session::get_routes()` crashes
	// in RCUManager::reader() if called before Ardour populates the
	// RCU's backing pointer (which happens during session load, AFTER
	// ControlProtocolManager activates us). The tick_loop polls at
	// 30 Hz and would race into get_routes() immediately — this gate
	// stays false until `RouteAdded` fires (Ardour emits it ONCE after
	// adding all XML-loaded routes in a batch). Atomic because
	// `on_route_added` runs on the shim's event-loop thread while
	// the tick thread reads it.
	std::atomic<bool>            _routes_ready { false };

	// Our own cache of routes, populated by `on_route_added` and
	// pruned by walking weak_ptr::expired() before each use. This
	// exists because `Session::get_routes()` is NOT thread-safe
	// against Session destruction: its RCU's backing pointer can
	// be freed while we're mid-read, and neither
	// `session.loading()` nor `session.deletion_in_progress()`
	// close the race (they're checked-then-called, not locked).
	// weak_ptr::lock() is safe even on destroyed objects — returns
	// null. The tick_loop walks this instead of calling get_routes.
	mutable std::mutex                               _tracked_routes_mx;
	std::vector<std::weak_ptr<ARDOUR::Route>>        _tracked_routes;

public:
	// Resolve `_tracked_routes` into a vector of strong refs. Any
	// entry whose Route has been destroyed returns as lock() == null
	// and is filtered out. Callers on any thread can call this —
	// weak_ptr::lock() is thread-safe and NEVER dereferences the
	// underlying RCU. Used by both the tick loop (meters) and the
	// dispatch path (session snapshot) so neither races with Session
	// teardown.
	std::vector<std::shared_ptr<ARDOUR::Route>> snapshot_tracked_routes () const;
private:

	// One-shot latch for the "RouteAdded FIRST fire" diagnostic. Flips
	// true the first time `on_route_added` runs; keeps us from spamming
	// the log on every subsequent route addition. `exchange` gives us
	// atomic test-and-set in one operation.
	std::atomic<bool>            _route_added_logged { false };

	void on_route_added (ARDOUR::RouteList&);
	void on_session_loaded ();
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
