/*
 * Foyer Studio — Ardour shim: ControlProtocol subclass.
 */
#ifndef foyer_shim_surface_h
#define foyer_shim_surface_h

#include <memory>

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

	// AbstractUI bits — no-ops for now; RT-safe request fanout lives here.
	void thread_init () override {}
	void do_request (FoyerShimUIRequest*) override {}

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

private:
	std::unique_ptr<IpcServer>    _ipc;
	std::unique_ptr<Dispatcher>   _dispatcher;
	std::unique_ptr<SignalBridge> _bridge;
};

} // namespace ArdourSurface

#endif
