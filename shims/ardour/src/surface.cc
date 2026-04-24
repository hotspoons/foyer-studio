// SPDX-License-Identifier: GPL-2.0-or-later
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
#include "session_uuid.h"
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
		// Resolve / assign the persistent session UUID and write a
		// registry entry so the sidecar can find this shim on
		// next startup (or via reattach if Foyer died without
		// cleanly closing). The UUID lives in the session's
		// extra_xml under <Foyer><Session id="…"/> so it persists
		// across save/load across machines.
		try {
			_session_uuid = session_uuid::ensure_uuid (session ());
			std::string project_path;
			std::string project_name;
			try { project_path = session ().path (); } catch (...) {}
			try { project_name = session ().snap_name (); } catch (...) {}
			session_uuid::write_registry_entry (
			    _session_uuid,
			    project_path,
			    project_name,
			    _ipc->resolved_path (),
			    "ardour");
		} catch (...) {
			PBD::warning << "foyer_shim: session_uuid bootstrap failed (non-fatal)" << endmsg;
		}
	} else {
		_bridge->stop ();
		_ipc->stop ();
		// Clean shutdown — remove our registry entry so the
		// sidecar doesn't misclassify us as a crashed orphan
		// on its next startup.
		if (!_session_uuid.empty ()) {
			session_uuid::remove_registry_entry (_session_uuid);
			_session_uuid.clear ();
		}
	}
	ControlProtocol::set_active (yn);
	return 0;
}

