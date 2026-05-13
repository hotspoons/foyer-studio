// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: auto-dispatch the native crash-recovery
 * dialog so it doesn't block headless container deploys.
 *
 * When Ardour reopens a session that has a live `<session>.pending`
 * file, `Session::load_state` fires the `AskAboutPendingState` signal,
 * which `gtk2_ardour/ardour_ui.cc:ARDOUR_UI::pending_state_dialog()`
 * answers with a modal "Crash Recovery" dialog asking the user to
 * Recover or Ignore. That dialog calls `dialog.run()` and blocks on a
 * nested GTK main loop — fatal in Cloud Run / headless Xvfb where
 * there's no human to click it.
 *
 * The Foyer backend already knows the user's preference at spawn time
 * (web prompt before LaunchProject) and conveys it via the
 * `FOYER_CRASH_RECOVERY={recover,discard}` env var. This file picks
 * that up at .so load time and arms a GMainContext timeout that
 * scans GTK toplevels until it finds the dialog, then dispatches the
 * matching response programmatically.
 *
 * Why we resolve symbols via `dlsym(RTLD_DEFAULT)` instead of linking
 * GTK: Ardour ships its own forked GTK2 (`libytk`) and uses it instead
 * of system GTK. Both expose the same `gtk_*` symbols at the same
 * ABI, so we let the loader resolve them from whichever the host
 * process has already mapped. Linking `-lgtk-x11-2.0` here would
 * inject a SECOND GTK implementation into Ardour's address space,
 * which is at best wasteful and at worst will cause widget-vs-loader
 * mismatches. Calling `dlsym` once-per-tick is essentially free.
 *
 * The `Discard` branch is mostly cosmetic on this side — the WS
 * server already deleted `.pending` before the spawn, so the
 * `AskAboutPendingState` signal never fires and no dialog opens.
 * We still arm the watcher (and log) for symmetry / belt-and-braces.
 *
 * Locale note: the dialog title is gettext'd via `_("Crash Recovery")`.
 * The container deploy runs under `C` / `en_US.UTF-8` so the
 * untranslated English literal wins. If a future deploy adds a non-
 * English locale, this matcher will need a second name to check
 * against — but until that's a real problem we don't speculate.
 */

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>

#include <glib.h>

namespace {

// Opaque forward declarations — we don't include <gtk/gtk.h> on
// purpose (see file comment above). The runtime types are GtkWindow*
// / GtkDialog* in ytk; passing them through opaque pointers is
// type-safe enough for the three calls we make.
struct GtkWindowOpaque;
struct GtkDialogOpaque;
using gtk_window_list_toplevels_fn = GList* (*)(void);
using gtk_window_get_title_fn = const char* (*)(GtkWindowOpaque*);
using gtk_dialog_response_fn = void (*)(GtkDialogOpaque*, int);

// GTK response convention used by ARDOUR_UI::pending_state_dialog()
// in gtk2_ardour/ardour_ui.cc:
//   "Recover from crash" → RESPONSE_ACCEPT (-3) → signal returns 1 → load .pending
//   "Ignore crash data"  → RESPONSE_REJECT (-2) → signal returns 0 → discard .pending
constexpr int RESPONSE_ACCEPT = -3;
constexpr int RESPONSE_REJECT = -2;

// Per-arm state. Lives until either we dispatch the dialog or we
// exhaust the deadline; freed inside the tick callback.
struct State {
	int desired_response = 0;
	// Max ticks before we give up and stop polling. Sized for a slow
	// dev container cold-start where session load can take 20-30s
	// after splash. Polling is cheap, but unbounded polling is silly.
	int ticks_remaining = 600;  // 600 × 200 ms = 2 min budget
};

gboolean
tick (gpointer data)
{
	auto *st = static_cast<State*>(data);

	if (--st->ticks_remaining <= 0) {
		std::fprintf (stderr,
		              "foyer_shim: crash-dialog watcher timed out without seeing dialog — disarming\n");
		delete st;
		return G_SOURCE_REMOVE;
	}

	// Resolve symbols every tick. The first tick may run before
	// Ardour's gtk_init() has loaded ytk, in which case dlsym
	// returns null and we just wait for the next tick.
	auto list_toplevels = reinterpret_cast<gtk_window_list_toplevels_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_window_list_toplevels"));
	auto get_title = reinterpret_cast<gtk_window_get_title_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_window_get_title"));
	auto dialog_response = reinterpret_cast<gtk_dialog_response_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_dialog_response"));
	if (!list_toplevels || !get_title || !dialog_response) {
		return G_SOURCE_CONTINUE;
	}

	GList *tops = list_toplevels ();
	GtkDialogOpaque *target = nullptr;
	for (GList *l = tops; l != nullptr; l = l->next) {
		auto *win = static_cast<GtkWindowOpaque*>(l->data);
		const char *title = get_title (win);
		if (title == nullptr) {
			continue;
		}
		// The dialog's untranslated title is "Crash Recovery". A
		// substring match on "Crash" / "crash" tolerates trivial
		// prefix/suffix decoration without depending on the exact
		// literal.
		if (std::strstr (title, "Crash") != nullptr ||
		    std::strstr (title, "crash") != nullptr) {
			target = reinterpret_cast<GtkDialogOpaque*>(win);
			break;
		}
	}
	g_list_free (tops);

	if (target == nullptr) {
		return G_SOURCE_CONTINUE;
	}

	const char *label = (st->desired_response == RESPONSE_ACCEPT) ? "Recover" : "Ignore";
	std::fprintf (stderr,
	              "foyer_shim: auto-dispatching Ardour crash-recovery dialog → %s (response=%d)\n",
	              label, st->desired_response);
	dialog_response (target, st->desired_response);
	delete st;
	return G_SOURCE_REMOVE;
}

// Library constructor — runs at dlopen() time, which for the shim
// is during Ardour's `ControlProtocolManager::discover_control_protocols()`
// call inside `ARDOUR::init()`. That's well before `gtk_init()` and
// well before any session load, so we have plenty of time to install
// the watcher before the dialog ever opens.
__attribute__((constructor))
void
install_crash_dialog_watcher ()
{
	const char *mode = std::getenv ("FOYER_CRASH_RECOVERY");
	if (mode == nullptr || *mode == '\0') {
		return;
	}

	int response = 0;
	if (std::strcmp (mode, "recover") == 0) {
		response = RESPONSE_ACCEPT;
	} else if (std::strcmp (mode, "discard") == 0) {
		response = RESPONSE_REJECT;
	} else {
		std::fprintf (stderr,
		              "foyer_shim: unknown FOYER_CRASH_RECOVERY=%s — ignoring (expected recover|discard)\n",
		              mode);
		return;
	}

	auto *st = new State ();
	st->desired_response = response;
	std::fprintf (stderr,
	              "foyer_shim: armed crash-dialog auto-dispatch (mode=%s)\n", mode);
	// 200 ms tick: dialog appears once-per-session in <5s on dev
	// hardware, <30s on slow containers. Burst-checking at 200ms
	// keeps user-visible latency to a single frame while costing
	// effectively nothing on the GLib main loop.
	g_timeout_add (200, tick, st);
}

}  // namespace
