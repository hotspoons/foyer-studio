// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: auto-dispatch the native "Missing
 * Plugins" dialog so it doesn't block session loads.
 *
 * Ardour opens a modal "Missing Plugins" dialog whenever the session
 * being loaded references plugins that aren't currently installed
 * (`gtk2_ardour/missing_plugin_dialog.cc`). The dialog calls
 * `dialog.run()` and blocks on a nested GTK main loop — fatal in
 * headless deploys, and even in interactive use it prevents the
 * session from being marked dirty / responding to control-surface
 * input until a human clicks "Yes" / "No" inside the Ardour GUI.
 *
 * Sibling design to [crash_dialog_handler.cc] — same dlsym approach
 * (resolve GTK symbols at runtime so we don't link a second GTK
 * implementation into Ardour's address space), same toplevel-title
 * scan, same response-injection via `gtk_dialog_response`.
 *
 * Differences:
 *
 *   • Persistent watcher. The crash dialog appears at most once per
 *     Ardour startup; the missing-plugin dialog can fire on every
 *     session swap, so we never disarm. 200 ms ticks are essentially
 *     free on the GLib main loop.
 *
 *   • Default ON. Crash recovery only auto-dispatches when the
 *     sidecar explicitly sets `FOYER_CRASH_RECOVERY=recover|discard`
 *     because the user's intent is unknowable at shim load time.
 *     "Don't scan VST plugins right now" is the correct answer for
 *     a control-surface-driven session every time: the surface
 *     shouldn't trigger a multi-minute plugin scan as a side-effect
 *     of opening a session. Users who want the dialog back can
 *     export `FOYER_MISSING_PLUGINS_AUTODISMISS=0`.
 *
 *   • Dispatch matches the Ardour dialog's two branches
 *     (`missing_plugin_dialog.cc:52-69`):
 *       - cache_valid path → single "OK" button → RESPONSE_OK (-5)
 *       - cache invalid    → "Yes" / "No" → RESPONSE_NO (-9)
 *     We try RESPONSE_NO first; the dialog reads it as "skip the
 *     scan, keep inactive stubs". For the OK-only branch the dialog
 *     just acknowledges; either response value dismisses cleanly
 *     because Ardour falls back to delete-event handling for
 *     anything outside its registered buttons.
 *
 *   • Same "we don't include <gtk/gtk.h>" rationale as the crash
 *     handler — Ardour bundles its own ytk fork and we resolve via
 *     dlsym(RTLD_DEFAULT) so the loader returns whichever GTK is
 *     already mapped.
 *
 * Locale note: the dialog title is gettext'd via `_("Missing Plugins")`.
 * Container deploys run under C / en_US.UTF-8 so the English literal
 * wins. If a non-English locale ever ships, add a second name here.
 */

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>

#include <glib.h>

namespace {

struct GtkWindowOpaque;
struct GtkDialogOpaque;
using gtk_window_list_toplevels_fn = GList* (*)(void);
using gtk_window_get_title_fn = const char* (*)(GtkWindowOpaque*);
using gtk_dialog_response_fn = void (*)(GtkDialogOpaque*, int);

// GTK response constants — see gtk/gtkdialog.h. The missing-plugin
// dialog uses RESPONSE_NO when the "Yes/No" pair is shown (cache
// invalid) and RESPONSE_OK when only "OK" is shown (cache valid).
// Dispatching RESPONSE_NO works for both branches because the OK-
// only branch dismisses on any registered response and Ardour
// treats unrecognized responses as close-events; the safer choice
// is to detect which button-set is present, but the dialog doesn't
// expose that, and either RESPONSE_NO or RESPONSE_OK cleanly closes
// the window.
constexpr int RESPONSE_NO = -9;

// Track which dialog instances we've already dispatched against, so
// we don't fire repeatedly while Ardour's main loop is still
// servicing the same dialog (the response is queued, not immediate).
// Use the GtkWindowOpaque pointer as the identifier — the same
// dialog widget address is reused for the duration of its modal
// lifetime.
struct WatcherState {
	GtkWindowOpaque* last_dispatched = nullptr;
};

gboolean
tick (gpointer data)
{
	auto* st = static_cast<WatcherState*>(data);

	auto list_toplevels = reinterpret_cast<gtk_window_list_toplevels_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_window_list_toplevels"));
	auto get_title = reinterpret_cast<gtk_window_get_title_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_window_get_title"));
	auto dialog_response = reinterpret_cast<gtk_dialog_response_fn>(
	        dlsym (RTLD_DEFAULT, "gtk_dialog_response"));
	if (!list_toplevels || !get_title || !dialog_response) {
		return G_SOURCE_CONTINUE;
	}

	GList* tops = list_toplevels ();
	GtkWindowOpaque* target = nullptr;
	for (GList* l = tops; l != nullptr; l = l->next) {
		auto* win = static_cast<GtkWindowOpaque*>(l->data);
		const char* title = get_title (win);
		if (title == nullptr) continue;
		// Untranslated title is "Missing Plugins". Substring match
		// on "Missing Plugin" so trivial decoration / pluralization
		// shifts don't break the matcher.
		if (std::strstr (title, "Missing Plugin") != nullptr) {
			target = win;
			break;
		}
	}
	g_list_free (tops);

	if (target == nullptr) {
		// No dialog in flight — reset so a fresh dialog with the
		// same widget address gets dispatched if Ardour ever reuses
		// the pointer.
		st->last_dispatched = nullptr;
		return G_SOURCE_CONTINUE;
	}
	if (target == st->last_dispatched) {
		// Already dispatched; waiting for Ardour to actually close
		// the window. Stay armed for the next session swap.
		return G_SOURCE_CONTINUE;
	}

	std::fprintf (stderr,
	              "foyer_shim: auto-dispatching Ardour 'Missing Plugins' dialog → No (response=%d)\n",
	              RESPONSE_NO);
	dialog_response (reinterpret_cast<GtkDialogOpaque*>(target), RESPONSE_NO);
	st->last_dispatched = target;
	return G_SOURCE_CONTINUE;
}

__attribute__((constructor))
void
install_missing_plugin_dialog_watcher ()
{
	const char* off = std::getenv ("FOYER_MISSING_PLUGINS_AUTODISMISS");
	if (off != nullptr && (std::strcmp (off, "0") == 0
	                       || std::strcmp (off, "false") == 0)) {
		std::fprintf (stderr,
		              "foyer_shim: FOYER_MISSING_PLUGINS_AUTODISMISS=%s — auto-dismiss disabled\n",
		              off);
		return;
	}

	auto* st = new WatcherState ();
	std::fprintf (stderr,
	              "foyer_shim: armed 'Missing Plugins' dialog auto-dispatch (response=No)\n");
	// 200 ms tick: same cadence as crash_dialog_handler. Cheap on
	// the main loop, single-frame latency to dismiss.
	g_timeout_add (200, tick, st);
}

}  // namespace
