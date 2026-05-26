// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: ControlProtocol subclass implementation.
 */
#include "surface.h"

#include "pbd/abstract_ui.inc.cc" // instantiate AbstractUI<FoyerShimUIRequest>
#include "pbd/i18n.h"
#include "pbd/pthread_utils.h"
#include "ardour/async_midi_port.h"
#include "ardour/audioengine.h"
#include "ardour/rc_configuration.h"
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
		// Suppress Ardour's interactive instrument-setup dialogs.
		//
		// When the shim adds a multi-output instrument (avldrums,
		// any plugin with `has_output_presets`) via Route::add_processor,
		// the Route fires the global PluginSetup signal asking
		// "should we replace the existing instrument? fan-out the
		// outputs?". The Editor connects a handler that pops a
		// GtkDialog to ask the user.
		//
		// Problem: the signal is emitted from our shim's UI thread
		// (FoyerShim), not the Ardour GTK thread. The dialog
		// constructor calls CairoWidget::set_dirty() which aborts
		// with SIGABRT when invoked off-thread (witnessed
		// 2026-05-25 — full crash stack in docs/SPRUNKADOO_HANDOFF.md).
		//
		// Both prefs default to true in rc_configuration_vars.inc.h.
		// We flip them OFF in-memory at shim activation; the Config
		// object isn't auto-persisted to the user's RC file unless
		// `save_state()` is called, so this doesn't corrupt the
		// user's saved preferences. If the user runs Ardour
		// standalone (without Foyer) in a fresh process, their
		// prefs are restored from disk.
		if (ARDOUR::Config) {
			ARDOUR::Config->set_ask_replace_instrument (false);
			ARDOUR::Config->set_ask_setup_instrument (false);
		}

		_ipc->start ();
		_bridge->start ();
		// Register a virtual MIDI source port for the browser bridge.
		// Users see this in Ardour's track input picker as
		// "foyer_shim:Foyer Web MIDI" (canonical name follows the same
		// convention as the generic-MIDI surface's "MIDI Control In").
		// The dispatcher writes bytes received from the sidecar onto
		// this port via `AsyncMIDIPort::write`; connected MIDI tracks
		// see the events on the next process cycle.
		try {
			auto p = AudioEngine::instance ()->register_output_port (
			    DataType::MIDI, _("Foyer Web MIDI"), true);
			_web_midi_port = std::dynamic_pointer_cast<AsyncMIDIPort> (p);
			if (!_web_midi_port) {
				PBD::warning << "foyer_shim: Foyer Web MIDI port registered but cast failed"
				             << endmsg;
			}
		} catch (...) {
			PBD::warning << "foyer_shim: failed to register Foyer Web MIDI port"
			             << endmsg;
		}
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
		if (_web_midi_port) {
			try {
				AudioEngine::instance ()->unregister_port (_web_midi_port);
			} catch (...) {
				// Engine may already be torn down on quit; ignore.
			}
			_web_midi_port.reset ();
		}
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

