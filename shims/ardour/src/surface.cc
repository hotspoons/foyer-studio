/*
 * Foyer Studio — Ardour shim: ControlProtocol subclass implementation.
 */
#include "surface.h"

#include "pbd/abstract_ui.inc.cc" // instantiate AbstractUI<FoyerShimUIRequest>
#include "pbd/i18n.h"
#include "ardour/session.h"

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
