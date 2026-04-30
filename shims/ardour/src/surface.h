// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: ControlProtocol subclass.
 */
#ifndef foyer_shim_surface_h
#define foyer_shim_surface_h

#include <memory>
#include <string>

#include "pbd/abstract_ui.h"
#include "pbd/event_loop.h"
#include "ardour/types.h"
#include "control_protocol/control_protocol.h"
// Pull in TempoMap so do_request can fetch the thread-local read
// pointer before invoking each queued slot. See do_request below
// for the full rationale.
#include "temporal/tempo.h"

namespace ArdourSurface {

struct FoyerShimUIRequest : public BaseUI::BaseRequestObject {};

class IpcServer;
class SignalBridge;
class Dispatcher;

/// `foyer_shim` ControlProtocol implementation.
///
/// Owns the IPC server, the signal bridge that turns Ardour events into Foyer
/// event envelopes, and the dispatcher that applies incoming commands.
class FoyerShim
    : public ARDOUR::ControlProtocol
    , public AbstractUI<FoyerShimUIRequest>
{
public:
	FoyerShim (ARDOUR::Session&);
	virtual ~FoyerShim ();

	static const char* const surface_name;
	static const char* const surface_id;

	int  set_active (bool yn) override;
	void stripable_selection_changed () override {}

	// AbstractUI bits. `thread_init` runs on this object's event-loop
	// thread — we MUST register with PBD's per-thread pool system so
	// libardour operations (playlist walks, SessionEvent allocation)
	// don't abort with "no per-thread pool".
	void thread_init () override;
	// `do_request` is where AbstractUI hands us each queued request.
	// For CallSlot requests (all of ours), we just invoke the stored
	// functor — without this, `call_slot` posts are silently dropped.
	// Took an outage + a shim crash to learn that the hard way.
	//
	// `Temporal::TempoMap::fetch()` is called BEFORE every slot to
	// refresh this thread's thread-local TempoMap read pointer.
	// `Region::set_position` (and any other timepos_t / timecnt_t
	// API that converts between sample / superclock / beats) reaches
	// into the thread-local TempoMap and SIGSEGVs when it isn't set
	// — which is the default state on a thread that didn't go
	// through Ardour's audio/GUI startup paths. Ardour's own surface
	// implementations (push2, mackie, faderport8, websockets) all do
	// this fetch at the equivalent boundary; doing it here means
	// every handler in dispatch.cc inherits the right state without
	// having to remember to call it itself. Cheap (atomic ptr swap).
	void do_request (FoyerShimUIRequest* req) override
	{
		if (req && req->type == BaseUI::CallSlot && req->the_slot) {
			Temporal::TempoMap::fetch ();
			req->the_slot ();
		}
	}

	// Accessors for subcomponents.
	IpcServer&    ipc ()           { return *_ipc; }
	Dispatcher&   dispatcher ()    { return *_dispatcher; }
	SignalBridge& signal_bridge () { return *_bridge; }

	// Publish BasicUI's protected session pointer through a stable accessor.
	ARDOUR::Session& session () const { return *BasicUI::session; }

	// Cast this object into the PBD::EventLoop our signal connections need.
	PBD::EventLoop* event_loop ()
	{
		return static_cast<PBD::EventLoop*> (this);
	}

	/// Stable session identifier (UUID v4 string) persisted inside
	/// the .ardour file's extra_xml. Populated on `set_active(true)`.
	/// Empty before the shim finishes activation or after a clean
	/// shutdown. Accessors let the dispatcher advertise it to the
	/// sidecar on the initial hello.
	const std::string& session_uuid () const { return _session_uuid; }

private:
	std::unique_ptr<IpcServer>    _ipc;
	std::unique_ptr<Dispatcher>   _dispatcher;
	std::unique_ptr<SignalBridge> _bridge;
	std::string                   _session_uuid;
};

} // namespace ArdourSurface

#endif
