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
	void do_request (FoyerShimUIRequest* req) override
	{
		if (req && req->type == BaseUI::CallSlot && req->the_slot) {
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
