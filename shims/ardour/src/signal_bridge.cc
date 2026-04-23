/*
 * Foyer Studio — Ardour shim: signal bridge.
 *
 * Hooks Ardour's signals and funnels them into outgoing Envelope<Event>
 * frames. Also calls into `schema_map` for structural snapshot emission.
 */

// Set to false to silence per-cycle TICK log (30 Hz steady state noise).
static constexpr bool LOG_TRANSPORT_TICK = false;

#include "signal_bridge.h"

#include <chrono>
#include <functional>
#include <sstream>

#include <cstdlib>
#include <iostream>

#include "ardour/playlist.h"
#include "ardour/plugin.h"
#include "ardour/plugin_insert.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "evoral/Parameter.h"
#include "pbd/controllable.h"
#include "pbd/stacktrace.h"

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
			if constexpr (LOG_TRANSPORT_TICK) {
				PBD::warning << "foyer_shim: TICK playing=" << playing
				             << " sample=" << sample
				             << " rolling=" << session.transport_rolling ()
				             << " stopped=" << session.transport_stopped ()
				     << endmsg;
			}
		}

		// Per-tick peak-meter readout runs unconditionally at ~30 Hz
		// — unlike the transport-state emission below, we want meters
		// live even with transport stopped (e.g. input monitoring,
		// plugin noise bleed, hit-test sanity). Cheap: each
		// `meter_level()` is an atomic read from PeakMeter's
		// precomputed vector.
		//
		// THREAD SAFETY: this loop used to call `session.get_routes()`
		// which reads Ardour's route RCU. That RCU's backing pointer
		// can be freed while we're mid-read during session teardown,
		// and neither `session.loading()` nor
		// `session.deletion_in_progress()` close the race (the flag
		// is checked then acted on separately — Ardour can flip it
		// between the check and the call). Instead we snapshot our
		// own weak_ptr cache under a local mutex; weak_ptr::lock()
		// is always safe, returning nullptr if the Route is gone.
		std::vector<std::shared_ptr<ARDOUR::Route>> live_routes;
		{
			std::lock_guard<std::mutex> g (_tracked_routes_mx);
			live_routes.reserve (_tracked_routes.size ());
			for (auto const& wr : _tracked_routes) {
				if (auto r = wr.lock ()) {
					live_routes.push_back (std::move (r));
				}
			}
		}
		if (!live_routes.empty ()) {
			auto mbytes = msgpack_out::encode_track_meters_from_routes (live_routes);
			if (!mbytes.empty ()) {
				_shim.ipc ().send (foyer_ipc::FrameKind::Control, mbytes);
			}
		}

		// Skip most idle ticks for the TRANSPORT event to keep the
		// wire quiet when nothing is moving. We still emit every
		// ~6th idle tick (≈200 ms) so any drift between shim and
		// client reconciles.
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

/// One-shot diagnostic dump of every session-wide knob that could
/// plausibly cause transport to auto-start on session load. We log
/// this on subscribe_all so the next time Rich reproduces the
/// "transport starts rolling by itself" regression we have every
/// relevant Ardour config value in daw.log without needing another
/// build.
static void
dump_transport_diagnostics (ARDOUR::Session& s)
{
	PBD::warning << "foyer_shim: [DIAG] ── transport start-state dump ──" << endmsg;
	PBD::warning << "foyer_shim: [DIAG]   sample="           << s.transport_sample ()
	             << " rolling="                              << s.transport_rolling ()
	             << " state_rolling="                        << s.transport_state_rolling ()
	             << " stopped="                              << s.transport_stopped ()
	             << " stopped_or_stopping="                  << s.transport_stopped_or_stopping () << endmsg;
	PBD::warning << "foyer_shim: [DIAG]   speed="            << s.transport_speed ()
	             << " actual_speed="                         << s.actual_speed ()
	             << " default_play_speed="                   << s.default_play_speed ()
	             << " get_play_loop="                        << s.get_play_loop ()
	             << " get_play_range="                       << s.get_play_range () << endmsg;
	PBD::warning << "foyer_shim: [DIAG]   synced_to_engine=" << s.synced_to_engine ()
	             << " transport_master_is_external="         << s.transport_master_is_external () << endmsg;
	PBD::warning << "foyer_shim: [DIAG]   config.get_external_sync=" << s.config.get_external_sync ()
	             << " config.get_auto_play="                         << s.config.get_auto_play ()
	             << " config.get_auto_return="                       << s.config.get_auto_return () << endmsg;
	PBD::warning << "foyer_shim: [DIAG]   current_end_sample="  << s.current_end_sample ()
	             << " session_range_is_free="                   << s.session_range_is_free ()
	             << endmsg;
	PBD::warning << "foyer_shim: [DIAG] ── end dump ──" << endmsg;
}

void
SignalBridge::subscribe_all ()
{
	Session& session = _shim.session ();

	dump_transport_diagnostics (session);

	// Band-aid: Ardour's transport FSM sometimes flips Stopped→Rolling
	// right after session load (root cause TBD — TransportStateChange
	// fires without any caller-visible request_roll from our shim;
	// config.auto_play is 0, transport master is internal + not
	// external, and no ControlSet came through). The flip can arrive
	// BEFORE or AFTER our subscribe timeslot, and previously we only
	// checked once at subscribe — post-subscribe flips slipped through
	// and the session started playing on every open.
	//
	// Fix: arm a grace window. For the next N seconds, every
	// TransportStateChange that sees a 0→1 rolling transition cross-
	// checks `_last_user_play_ms`. If the user didn't just click
	// play (set via SignalBridge::note_user_play_request from
	// dispatch.cc), we call transport_stop(). Legitimate user-
	// initiated play still works because the ControlSet path calls
	// note_user_play_request *before* transport_play, so the
	// timestamp is fresh when TransportStateChange fires.
	//
	// FOYER_ALLOW_AUTO_ROLL=1 disables the whole guard for debugging.
	{
		const char* allow = std::getenv ("FOYER_ALLOW_AUTO_ROLL");
		const bool disable = allow && std::string (allow) == "1";
		if (!disable) {
			_startup_grace_until =
			    std::chrono::steady_clock::now () + std::chrono::seconds (15);
			// Also do the one-shot stop at subscribe time for the
			// already-rolling case (covers the pre-subscribe flip).
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				auto& s = shim->session ();
				if (s.transport_state_rolling ()) {
					PBD::warning << "foyer_shim: [AUTO-PLAY GUARD] session opened "
					             << "with transport already rolling — stopping."
					             << endmsg;
					shim->transport_stop ();
				}
			});
		} else {
			PBD::warning << "foyer_shim: FOYER_ALLOW_AUTO_ROLL=1 — "
			             << "auto-play guard disabled." << endmsg;
		}
	}

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

	// Defer the initial walk of routes to `Session::SessionLoaded`.
	// Why not walk now:
	//   `subscribe_all` runs from `FoyerShim::set_active(true)`,
	//   invoked by `ControlProtocolManager::set_session` at
	//   session_state.cc:336 — this is INSIDE `Session::post_engine_init`.
	//   Line 318 of session_state.cc reads `routes.reader()` safely
	//   just before our call, so intuitively the RCU should be safe.
	//   Empirically it's not: `session.get_routes()` from our
	//   subscribe_all SIGSEGVs in `RCUManager::reader()`. The RCU
	//   backing pointer is in some transient state we can't cheaply
	//   detect. session_loaded() (which clears the Loading flag and
	//   emits SessionLoaded) runs later in the ctor body, AFTER the
	//   state machine has fully stabilized.
	//
	// `Session::SessionLoaded` is the signal Ardour designed exactly
	// for "your surface can now trust the session." MidiTrack also
	// connects to it ([../ardour/libs/ardour/midi_track.cc:96]).
	// Our handler does the initial walk + populates the weak_ptr
	// cache once the session is definitively ready.
	// connect_same_thread (not `connect(...event_loop())`) is load-bearing.
	// SessionLoaded fires from session_loaded() on the main thread, which
	// is still inside the Session ctor and will immediately run more
	// state work (force_locate, etc.) after returning from the signal
	// emission. If we marshal to our event-loop thread, our handler races
	// with those post-signal mutations — `get_routes()` from our thread
	// while the main thread is touching the RCU is a SIGSEGV. Running
	// SAME-thread means Ardour blocks on our handler inside the signal,
	// no concurrent modification possible. MidiTrack uses this exact
	// pattern (libs/ardour/midi_track.cc:96).
	session.SessionLoaded.connect_same_thread (
	    _connections,
	    std::bind<void> (&SignalBridge::on_session_loaded, this));
}

void
SignalBridge::on_session_loaded ()
{
	// This runs AFTER `Session::session_loaded()` has called
	// `set_clean()` which cleared the Loading flag. Routes are
	// populated, state machine stable, and `get_routes()` is safe.
	Session& session = _shim.session ();
	PBD::warning << "foyer_shim: on_session_loaded — doing initial route walk" << endmsg;
	std::shared_ptr<ARDOUR::RouteList const> initial;
	try {
		initial = session.get_routes ();
	} catch (...) {
		PBD::warning << "foyer_shim: on_session_loaded: get_routes threw" << endmsg;
		return;
	}
	if (!initial) return;
	{
		std::lock_guard<std::mutex> g (_tracked_routes_mx);
		for (auto const& r : *initial) {
			if (!r) continue;
			_tracked_routes.emplace_back (r);
		}
	}
	for (auto const& r : *initial) {
		if (!r) continue;
		subscribe_controls_on_route (*r);
		subscribe_playlist_for_route (*r);
		subscribe_presentation_for_route (*r);
	}
	_routes_ready.store (true, std::memory_order_release);
	PBD::warning << "foyer_shim: on_session_loaded — " << initial->size ()
	             << " routes tracked" << endmsg;
	// Push a Reload patch so the sidecar re-requests the snapshot
	// with the now-ready route list. Without this, the sidecar's
	// initial snapshot request (sent at subscribe-time, before this
	// signal fires) came back with zero tracks and the UI stays
	// empty until some other event happens to re-trigger a snapshot.
	auto bytes = msgpack_out::encode_patch_reload ();
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
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

	// Plugin-param live updates. Without these subscriptions the web
	// UI only sees the values it SET itself — Ardour's native GUI
	// moving the same param wouldn't round-trip back to the browser.
	// For each PluginInsert on the route, wire every automation
	// control we surface in `schema_map` + the insert's own
	// ActiveChanged (bypass toggle) signal.
	std::ostringstream ridss;
	ridss << r.id ();
	const std::string track_id = "track." + ridss.str ();
	for (uint32_t i = 0;; ++i) {
		auto proc = r.nth_plugin (i);
		if (!proc) break;
		auto pi = std::dynamic_pointer_cast<ARDOUR::PluginInsert> (proc);
		if (!pi) continue;
		// ActiveChanged fires when the user bypasses/enables the
		// plugin from Ardour's GUI. Re-emit a track_updated so the
		// web UI's plugin strip reflects the new bypass state.
		std::string tid = track_id;
		pi->ActiveChanged.connect (
		    _connections, MISSING_INVALIDATOR,
		    [this, tid] () { on_route_presentation_changed (tid); },
		    _shim.event_loop ());
		// Wire every exposed automatable param so moves in Ardour's
		// GUI round-trip back to the web UI. Iterating via the
		// PluginInsert's automation_control list covers the "what we
		// expose in the schema" set.
		auto plug = pi->plugin ();
		if (plug) {
			for (uint32_t p = 0; p < plug->parameter_count (); ++p) {
				if (!plug->parameter_is_control (p) || !plug->parameter_is_input (p)) continue;
				auto pid = Evoral::Parameter (ARDOUR::PluginAutomation, 0, p);
				auto ctrl = pi->automation_control (pid, false);
				if (ctrl) wire (ctrl);
			}
		}
	}
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

std::vector<std::shared_ptr<ARDOUR::Route>>
SignalBridge::snapshot_tracked_routes () const
{
	std::vector<std::shared_ptr<ARDOUR::Route>> out;
	std::lock_guard<std::mutex> g (_tracked_routes_mx);
	out.reserve (_tracked_routes.size ());
	for (auto const& wr : _tracked_routes) {
		if (auto r = wr.lock ()) {
			out.push_back (std::move (r));
		}
	}
	std::sort (out.begin (), out.end (),
		[] (const std::shared_ptr<ARDOUR::Route>& a,
		    const std::shared_ptr<ARDOUR::Route>& b) {
			return a->presentation_info ().order () < b->presentation_info ().order ();
		});
	return out;
}

void
SignalBridge::on_route_added (RouteList& added)
{
	// Diagnostic: confirm the signal actually fires + how many routes
	// came in. Gated to first-fire so long sessions don't spam the
	// log; if Rich sees "tracks load but meters stay flat", this is
	// the fastest way to tell whether the signal never fired vs.
	// it fired but our handler had a bug.
	if (!_route_added_logged.exchange (true, std::memory_order_acq_rel)) {
		PBD::warning << "foyer_shim: on_route_added FIRST fire — "
		             << added.size () << " routes added" << endmsg;
	}
	// Populate our weak_ptr cache BEFORE we subscribe per-route
	// signals so the tick thread can start metering as soon as
	// possible. weak_ptr is the right lifetime primitive here:
	// expired()/lock() are safe even after the Route is gone, so
	// the tick thread never touches freed memory the way a
	// `get_routes()` / RouteList* read would.
	{
		std::lock_guard<std::mutex> g (_tracked_routes_mx);
		for (auto const& r : added) {
			if (!r) continue;
			_tracked_routes.emplace_back (r);
		}
	}
	for (auto const& r : added) {
		if (!r) continue;
		subscribe_controls_on_route (*r);
		subscribe_playlist_for_route (*r);
		subscribe_presentation_for_route (*r);
	}
	_routes_ready.store (true, std::memory_order_release);

	// Simplest correct behavior for M3: emit a Reload patch hinting clients
	// to re-request a full snapshot. Per-op patches can land as an optimization.
	auto bytes = msgpack_out::encode_patch_reload ();
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::on_transport_state_changed ()
{
	auto& s = _shim.session ();
	// Track the last observed rolling state so we can tag 0→1
	// transitions — those are the "transport started" events we
	// care about for the auto-play regression.
	const bool now_rolling = s.transport_state_rolling ();
	const bool was_rolling = _last_rolling.exchange (now_rolling);
	const bool started     = now_rolling && !was_rolling;

	PBD::warning << "foyer_shim: SIGNAL TransportStateChange: "
	             << "sample=" << s.transport_sample ()
	             << " rolling=" << s.transport_rolling ()
	             << " state_rolling=" << now_rolling
	             << " stopped=" << s.transport_stopped ()
	             << " rec_enabled=" << s.get_record_enabled ()
	             << " speed=" << s.transport_speed ()
	             << " default_speed=" << s.default_play_speed ()
	             << (started ? " **STARTED**" : "")
	             << endmsg;

	if (started) {
		// Rolling just flipped 0→1. Log everything that could have
		// caused it, plus a C-stack backtrace so we can see which
		// Ardour code path drove us into Rolling state.
		PBD::warning << "foyer_shim: [DIAG-STARTED] "
		             << "sync_to_engine=" << s.synced_to_engine ()
		             << " master_is_external=" << s.transport_master_is_external ()
		             << " config.external_sync=" << s.config.get_external_sync ()
		             << " config.auto_play=" << s.config.get_auto_play ()
		             << " config.auto_return=" << s.config.get_auto_return ()
		             << " get_play_loop=" << s.get_play_loop ()
		             << " get_play_range=" << s.get_play_range ()
		             << endmsg;

		// Auto-play guard: if we're still inside the post-subscribe
		// grace window AND the user didn't just ask for play, stop
		// the transport. The 500ms threshold accommodates the IPC
		// round-trip between dispatch.cc's note_user_play_request()
		// and Ardour's TransportStateChange fire.
		const auto now_tp = std::chrono::steady_clock::now ();
		if (now_tp < _startup_grace_until) {
			const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
			    now_tp.time_since_epoch ()).count ();
			const auto last_user = _last_user_play_ms.load ();
			const bool user_asked = last_user > 0 && (now_ms - last_user) < 500;
			if (!user_asked) {
				PBD::warning << "foyer_shim: [AUTO-PLAY GUARD] suppressing "
				             << "spontaneous transport start (grace window active; "
				             << "no recent user play request) — calling "
				             << "transport_stop()." << endmsg;
				_shim.transport_stop ();
				// Don't emit SIGNAL-STARTED to the client — the
				// subsequent stop will race through another
				// TransportStateChange and undo this one at the UI
				// level. Let that second signal be the one clients
				// see.
				auto bytes = msgpack_out::encode_transport_state (s);
				_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				return;
			}
			PBD::warning << "foyer_shim: [AUTO-PLAY GUARD] allowed "
			             << "user-initiated play (" << (now_ms - last_user)
			             << "ms since request)." << endmsg;
		}

		PBD::warning << "foyer_shim: [DIAG-STARTED] backtrace below — "
		             << "look for `start_transport`, `request_roll`, "
		             << "`transport_play`, or a MIDI-clock / JACK slave "
		             << "entry point." << endmsg;
		PBD::stacktrace (std::cerr, 24);
	}

	auto bytes = msgpack_out::encode_transport_state (s);
	_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SignalBridge::note_user_play_request ()
{
	const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
	    std::chrono::steady_clock::now ().time_since_epoch ()).count ();
	_last_user_play_ms.store (now_ms);
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
