/*
 * Foyer Studio — Ardour shim: ControlProtocol subclass implementation.
 */
#include "surface.h"

#include "pbd/abstract_ui.inc.cc" // instantiate AbstractUI<FoyerShimUIRequest>
#include "pbd/i18n.h"
#include "pbd/pthread_utils.h"
#include "ardour/session.h"
#include "ardour/session_event.h"

#include "dispatch.h"
#include "ipc.h"
#include "signal_bridge.h"

using namespace ARDOUR;
using namespace ArdourSurface;

const char* const FoyerShim::surface_name = "Foyer Studio Shim";
const char* const FoyerShim::surface_id   = "uri://foyer-studio.org/surface/shim";

FoyerShim::FoyerShim (Session& s)
    : ControlProtocol (s, surface_name)
    , AbstractUI<FoyerShimUIRequest> (X_("FoyerShim"))
{
	_ipc        = std::make_unique<IpcServer> (*this);
	_dispatcher = std::make_unique<Dispatcher> (*this);
	_bridge     = std::make_unique<SignalBridge> (*this);

	BaseUI::run ();
}

FoyerShim::~FoyerShim ()
{
	_bridge.reset ();
	_dispatcher.reset ();
	_ipc.reset ();
	BaseUI::quit ();
}

void
FoyerShim::thread_init ()
{
	// Same pattern every other ControlProtocol follows (see
	// MackieControlProtocol::thread_init). Without these two registrations
	// any call from this thread into Ardour code that allocates via the
	// per-thread pool (e.g. Playlist::region_list, SessionEvent::alloc)
	// aborts with a FATAL "no per-thread pool" error.
	PBD::notify_event_loops_about_thread_creation (pthread_self (), event_loop_name (), 2048);
	ARDOUR::SessionEvent::create_per_thread_pool (event_loop_name (), 128);
}

int
FoyerShim::set_active (bool yn)
{
	if (yn == active ()) {
		return 0;
	}
	if (yn) {
		_ipc->start ();
		_bridge->start ();
	} else {
		_bridge->stop ();
		_ipc->stop ();
	}
	ControlProtocol::set_active (yn);
	return 0;
}

