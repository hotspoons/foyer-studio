// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: schema translation implementation.
 */
#include "schema_map.h"

#include <chrono>
#include <cctype>
#include <sstream>
#include <algorithm>
#include <map>

#include <glib.h>

#include "ardour/audioregion.h"
#include "ardour/file_source.h"
#include "ardour/instrument_info.h"
#include "ardour/lua_script_params.h"
#include "ardour/luascripting.h"
#include "lua/luastate.h"
#include "ardour/midi_model.h"
#include "ardour/midi_region.h"
#include "ardour/parameter_descriptor.h"
#include "ardour/plug_insert_base.h"
#include "ardour/playlist.h"
#include "ardour/playlist_source.h"
#include "ardour/plugin.h"
#include "ardour/plugin_insert.h"
#include "ardour/plugin_manager.h"
#include "ardour/region.h"
#include "ardour/region_sorters.h"
#include "ardour/route.h"
#include "ardour/route_group.h"
#include "ardour/session.h"
#include "ardour/source.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "ardour/unknown_processor.h"
#include "midi++/midnam_patch.h"
#include "pbd/controllable.h"
#include "pbd/xml++.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface::schema_map {

std::shared_ptr<ARDOUR::RouteList const>
safe_get_routes (const ARDOUR::Session& session)
{
	// Two windows when `session.get_routes()` will SIGSEGV in
	// `RCUManager::reader()` because the backing shared_ptr is
	// null or being freed:
	//
	//   1. Session is still loading. During `post_engine_init()`
	//      (when ControlProtocolManager activates us), the route-list
	//      RCU has been zero-initialized but its backing pointer
	//      hasn't been set. Gated by `session.loading()`.
	//
	//   2. Session is being destroyed. `Session::destroy()` at
	//      session.cc:674 sets `_state_of_the_state = (CannotSave |
	//      Deletion)` — which CLEARS the Loading flag — BEFORE
	//      calling `drop_protocols()` which then tears down our
	//      shim's tick thread. Between those two points our
	//      tick_loop still calls get_routes() but the RCU is
	//      already in free-me territory. Gated by
	//      `session.deletion_in_progress()`.
	//
	// In both cases we return an empty (non-null) list so callers'
	// `for (auto& r : *routes)` loops are harmless no-ops. Signal
	// bridge re-emits a Reload patch on the first `RouteAdded` so
	// the sidecar re-requests state once the session is ready.
	if (session.loading () || session.deletion_in_progress ()) {
		return std::make_shared<ARDOUR::RouteList> ();
	}
	return session.get_routes ();
}

namespace {

std::string
stripable_id_string (const Stripable& s)
{
	std::ostringstream o;
	o << s.id ();
	return o.str ();
}

std::string
kind_of (const Stripable& s)
{
	if (s.is_master ()) return "master";
	if (s.is_monitor ()) return "monitor";
	auto tr = dynamic_cast<const Track*> (&s);
	if (tr) {
		return tr->data_type () == DataType::MIDI ? "midi" : "audio";
	}
	// Anything else we see as a bus for now.
	return "bus";
}

std::string
color_hex (const Stripable& s)
{
	// Ardour's PresentationInfo stores color as ARGB in a uint32 (top
	// byte is alpha). We only emit an RGB web hex — the alpha is
	// implicitly opaque on the client.
	const std::uint32_t c = static_cast<std::uint32_t> (s.presentation_info ().color ());
	// Unset / transparent black is used as "no color assigned" by several
	// Ardour code paths. Fall through to "" so the client renders its
	// default gradient instead of #000.
	if (c == 0) return "";
	const std::uint32_t r = (c >> 24) & 0xff;
	const std::uint32_t g = (c >> 16) & 0xff;
	const std::uint32_t b = (c >>  8) & 0xff;
	char buf[8];
	std::snprintf (buf, sizeof (buf), "#%02x%02x%02x", r, g, b);
	return std::string (buf);
}

} // namespace

std::uint32_t
color_from_hex (const std::string& s)
{
	// Accepts "#rrggbb" or "rrggbb"; anything else returns 0 (clear).
	std::string h = s;
	if (!h.empty () && h[0] == '#') h.erase (0, 1);
	if (h.size () != 6) return 0;
	auto nib = [] (char c) -> int {
		if (c >= '0' && c <= '9') return c - '0';
		if (c >= 'a' && c <= 'f') return 10 + c - 'a';
		if (c >= 'A' && c <= 'F') return 10 + c - 'A';
		return -1;
	};
	int bytes[6];
	for (int i = 0; i < 6; ++i) {
		bytes[i] = nib (h[i]);
		if (bytes[i] < 0) return 0;
	}
	const std::uint32_t r = (bytes[0] << 4) | bytes[1];
	const std::uint32_t g = (bytes[2] << 4) | bytes[3];
	const std::uint32_t b = (bytes[4] << 4) | bytes[5];
	// ARGB layout — alpha = 0xff (opaque).
	return (r << 24) | (g << 16) | (b << 8) | 0xff;
}

std::string id_gain  (const Stripable& s) { return "track." + stripable_id_string (s) + ".gain"; }
std::string id_pan   (const Stripable& s) { return "track." + stripable_id_string (s) + ".pan"; }
std::string id_mute  (const Stripable& s) { return "track." + stripable_id_string (s) + ".mute"; }
std::string id_solo  (const Stripable& s) { return "track." + stripable_id_string (s) + ".solo"; }
std::string id_rec   (const Stripable& s) { return "track." + stripable_id_string (s) + ".rec"; }
std::string id_meter (const Stripable& s) { return "track." + stripable_id_string (s) + ".meter"; }

std::string
id_for_controllable (const Session& session, const Controllable& c)
{
	std::shared_ptr<RouteList const> routes = safe_get_routes (session);
	for (auto const& r : *routes) {
		if (!r) continue;
		if (r->gain_control ().get () == &c)         return id_gain (*r);
		if (r->pan_azimuth_control ().get () == &c)  return id_pan (*r);
		if (r->mute_control ().get () == &c)         return id_mute (*r);
		if (r->solo_control ().get () == &c)         return id_solo (*r);
		auto rec = r->rec_enable_control ();
		if (rec && rec.get () == &c)                 return id_rec (*r);
	}
	return {};
}

namespace {

std::shared_ptr<PluginInsert>
find_plugin_insert (Session& session, const std::string& pid)
{
	std::shared_ptr<RouteList const> routes = safe_get_routes (session);
	for (auto const& r : *routes) {
		if (!r) continue;
		for (uint32_t i = 0; ; ++i) {
			std::shared_ptr<Processor> proc = r->nth_plugin (i);
			if (!proc) break;
			std::shared_ptr<PluginInsert> pi = std::dynamic_pointer_cast<PluginInsert> (proc);
			if (!pi) continue;
			std::ostringstream o;
			o << pi->id ();
			if (o.str () == pid) return pi;
		}
	}
	return {};
}

} // namespace

std::shared_ptr<Controllable>
resolve (Session& session, const std::string& id)
{
	// ── track.<stripable-id>.<field> ──────────────────────────────────────
	if (id.rfind ("track.", 0) == 0) {
		auto last_dot = id.rfind ('.');
		if (last_dot == 5) return {};
		std::string sid = id.substr (6, last_dot - 6);
		std::string field = id.substr (last_dot + 1);

		std::shared_ptr<RouteList const> routes = safe_get_routes (session);
		for (auto const& r : *routes) {
			if (!r) continue;
			std::ostringstream o;
			o << r->id ();
			if (o.str () != sid) continue;
			if (field == "gain") return r->gain_control ();
			if (field == "pan")  return r->pan_azimuth_control ();
			if (field == "mute") return r->mute_control ();
			if (field == "solo") return r->solo_control ();
			if (field == "rec")  return r->rec_enable_control ();
			return {};
		}
		return {};
	}

	// ── plugin.<pi-id>.param.<n>  or  plugin.<pi-id>.bypass ───────────────
	if (id.rfind ("plugin.", 0) == 0) {
		// Trailing `.bypass` is a straight "plugin active" toggle. No
		// Controllable exists for it on Ardour's side — the shim dispatcher
		// has to special-case this one at the call site. We return an
		// empty shared_ptr so the caller falls back to that path.
		//
		// `.param.<n>` resolves to the PluginInsert's automation control
		// for that parameter index.
		const std::string suffix_param = ".param.";
		auto param_pos = id.rfind (suffix_param);
		if (param_pos != std::string::npos) {
			std::string pid = id.substr (7, param_pos - 7);
			std::string num = id.substr (param_pos + suffix_param.size ());
			uint32_t n = 0;
			try {
				n = (uint32_t) std::stoul (num);
			} catch (...) {
				return {};
			}
			auto pi = find_plugin_insert (session, pid);
			if (!pi) return {};
			return pi->automation_control (Evoral::Parameter (PluginAutomation, 0, n));
		}
	}

	return {};
}

namespace {

std::string
plugin_insert_id_string (const PluginInsert& pi)
{
	std::ostringstream o;
	o << pi.id ();
	return o.str ();
}

std::string
processor_id_string (const Processor& p)
{
	std::ostringstream o;
	o << p.id ();
	return o.str ();
}

std::string
scale_from_descriptor (const ParameterDescriptor& d)
{
	if (d.unit == ParameterDescriptor::DB)    return "decibels";
	if (d.unit == ParameterDescriptor::HZ)    return "hertz";
	if (d.logarithmic)                        return "logarithmic";
	return "linear";
}

std::string
unit_from_descriptor (const ParameterDescriptor& d)
{
	switch (d.unit) {
		case ParameterDescriptor::DB:        return "dB";
		case ParameterDescriptor::HZ:        return "Hz";
		case ParameterDescriptor::MIDI_NOTE: return "note";
		case ParameterDescriptor::NONE:
		default:                             return "";
	}
}

const char*
plugin_format_label (ARDOUR::PluginType t)
{
	switch (t) {
		case ARDOUR::AudioUnit:   return "au";
		case ARDOUR::LADSPA:      return "ladspa";
		case ARDOUR::LV2:         return "lv2";
		case ARDOUR::Windows_VST: return "vst2";
		case ARDOUR::LXVST:       return "vst2";
		case ARDOUR::MacVST:      return "vst2";
		case ARDOUR::Lua:         return "lua";
		case ARDOUR::VST3:        return "vst3";
	}
	return "internal";
}

} // namespace

std::vector<PluginDesc>
enumerate_plugins (std::shared_ptr<Route> route)
{
	std::vector<PluginDesc> out;
	if (!route) return out;

	// Walk every processor on the route — NOT `route->nth_plugin()`,
	// which only yields PluginInserts. Ardour replaces missing
	// plugins with `UnknownProcessor` stubs at session-load time
	// (see libardour/route.cc::set_state), and those need to surface
	// to the client so the missing-plugin banner shows up. The
	// nth_plugin path silently skips them, which was the cause of
	// "Ardour shows the missing-plugin dialog but Foyer's mixer
	// strip looks empty."
	route->foreach_processor ([&out] (std::weak_ptr<Processor> wp) {
		std::shared_ptr<Processor> proc = wp.lock ();
		if (!proc) return;

		// Missing-plugin stub. Ardour preserves the original
		// processor's name+state on the UnknownProcessor so we can
		// at least show "{plugin name} — missing" in the strip.
		auto unk = std::dynamic_pointer_cast<UnknownProcessor> (proc);
		if (unk) {
			PluginDesc pd;
			pd.id       = "plugin." + processor_id_string (*proc);
			pd.name     = proc->name ();
			pd.missing  = true;
			pd.bypassed = !proc->active ();
			// Synthetic bypass param so the client-side panel doesn't
			// crash on empty params (matches the Plugin::null branch
			// below).
			ParamDesc bypass;
			bypass.id        = pd.id + ".bypass";
			bypass.label     = "Bypass";
			bypass.kind      = "trigger";
			bypass.scale     = "linear";
			bypass.has_range = false;
			bypass.lower     = 0.0f;
			bypass.upper     = 0.0f;
			bypass.value     = pd.bypassed ? 1.0 : 0.0;
			pd.params.push_back (std::move (bypass));
			out.push_back (std::move (pd));
			return;
		}

		std::shared_ptr<PluginInsert> pi = std::dynamic_pointer_cast<PluginInsert> (proc);
		if (!pi) return;
		std::shared_ptr<Plugin> plug = pi->plugin (0);

		PluginDesc pd;
		pd.id       = "plugin." + plugin_insert_id_string (*pi);
		pd.bypassed = !pi->active ();

		if (!plug) {
			// Plugin insert exists but the binary/library is missing or
			// unloadable. In practice Ardour converts these to
			// `UnknownProcessor` (handled above), so this branch is
			// the rare "PluginInsert constructed but plugin slot
			// never got populated" case — keep it as a safety net.
			pd.name    = pi->name ();
			pd.missing = true;
			ParamDesc bypass;
			bypass.id        = pd.id + ".bypass";
			bypass.label     = "Bypass";
			bypass.kind      = "trigger";
			bypass.scale     = "linear";
			bypass.has_range = false;
			bypass.lower     = 0.0f;
			bypass.upper     = 0.0f;
			bypass.value     = pd.bypassed ? 1.0 : 0.0;
			pd.params.push_back (std::move (bypass));
			out.push_back (std::move (pd));
			return;
		}
		pd.name     = plug->name ();
		pd.uri      = plug->unique_id ();
		// `last_preset()` carries the most recently applied preset (or
		// the saved preset if loaded from a session). Empty `uri` means
		// "no preset active" — left as "" on the wire so the UI shows
		// the placeholder.
		pd.current_preset = plug->last_preset ().uri;

		// Native-GUI capability probe. `Plugin::has_editor()` is the
		// uniform virtual every backend overrides (LV2Plugin checks the
		// lilv UI list, VST3Plugin asks for IEditController, etc.) so
		// we don't need format-specific lilv walks here. Pair it with
		// the format label so the UI can render "Show native VST3 GUI"
		// without re-deriving the format from the URI.
		if (plug->has_editor ()) {
			pd.has_native_gui   = true;
			auto info = plug->get_info ();
			pd.native_gui_kind  = info ? plugin_format_label (info->type) : "";
		}

		// Synthetic bypass parameter — matches the stub's shape so the web
		// plugin panel can render the same switch regardless of backend.
		ParamDesc bypass;
		bypass.id        = pd.id + ".bypass";
		bypass.label     = "Bypass";
		bypass.kind      = "trigger";
		bypass.scale     = "linear";
		bypass.has_range = false;
		bypass.lower     = 0.0f;
		bypass.upper     = 0.0f;
		bypass.value     = pd.bypassed ? 1.0 : 0.0;
		pd.params.push_back (std::move (bypass));

		const uint32_t pcount = plug->parameter_count ();
		for (uint32_t p = 0; p < pcount; ++p) {
			if (!plug->parameter_is_control (p)) continue;
			bool ok = false;
			uint32_t which = plug->nth_parameter (p, ok);
			if (!ok) continue;
			ParameterDescriptor desc;
			if (plug->get_parameter_descriptor (which, desc) != 0) continue;

			ParamDesc prm;
			prm.id        = pd.id + ".param." + std::to_string (which);
			prm.label     = desc.label.empty () ? ("p" + std::to_string (which)) : desc.label;
			prm.scale     = scale_from_descriptor (desc);
			prm.unit      = unit_from_descriptor (desc);
			prm.has_range = true;
			prm.lower     = desc.lower;
			prm.upper     = desc.upper;
			prm.value     = plug->get_parameter (which);

			if (desc.toggled) {
				prm.kind      = "trigger";
				prm.has_range = false;
			} else if (desc.enumeration && desc.scale_points) {
				prm.kind = "enum";
				for (auto const& kv : *desc.scale_points) {
					prm.enum_labels.push_back (kv.first);
					prm.enum_values.push_back (kv.second);
				}
				// Enum value is the index, not the raw float.
				int idx = 0, best = 0;
				float closest = 1e30f;
				for (float v : prm.enum_values) {
					float d = std::abs (v - prm.value);
					if (d < closest) { closest = d; best = idx; }
					++idx;
				}
				prm.value     = best;
				prm.has_range = false;
			} else if (desc.integer_step) {
				prm.kind = "discrete";
			} else {
				prm.kind = "continuous";
			}
			pd.params.push_back (std::move (prm));
		}

		out.push_back (std::move (pd));
	});
	return out;
}

std::vector<StripableIds>
enumerate_stripables (Session& session)
{
	std::vector<StripableIds> out;
	StripableList list;
	session.get_stripables (list);
	for (auto const& s : list) {
		if (!s) continue;
		StripableIds ids;
		ids.self_id = "track." + stripable_id_string (*s);
		ids.name    = s->name ();
		ids.kind    = kind_of (*s);
		ids.color   = color_hex (*s);
		out.push_back (std::move (ids));
	}
	return out;
}

namespace {

std::string
region_pbd_id_string (const Region& r)
{
	std::ostringstream o;
	o << r.id ();
	return o.str ();
}

// Pull the on-disk path from a region's first source when that source is a
// FileSource. Empty otherwise (silent sources, MIDI, etc).
std::string
region_source_path (const Region& r)
{
	auto src = r.source (0);
	if (!src) return {};
	auto fs = std::dynamic_pointer_cast<FileSource> (src);
	if (!fs) return {};
	return fs->path ();
}

static void
append_playlist_audio_segments (
	std::shared_ptr<const Playlist> pl,
	std::vector<AudioSourceSegmentDesc>& out)
{
	if (!pl) {
		return;
	}
	/* `Playlist::region_list()` is non-const in libardour; the PlaylistSource
	 * accessor hands us `shared_ptr<const Playlist>`. Peeking the region
	 * list for schema export does not mutate playlist state. */
	std::shared_ptr<RegionList> rlist_sp =
	    std::const_pointer_cast<Playlist> (pl)->region_list ();
	if (!rlist_sp || rlist_sp->empty ()) {
		return;
	}
	RegionList sorted = *rlist_sp;
	sorted.sort (RegionSortByLayerAndPosition ());
	for (std::shared_ptr<Region> const& reg : sorted) {
		if (!reg) {
			continue;
		}
		std::shared_ptr<AudioRegion> ar = std::dynamic_pointer_cast<AudioRegion> (reg);
		if (!ar) {
			continue;
		}
		std::string path = region_source_path (*ar);
		if (!path.empty ()) {
			AudioSourceSegmentDesc seg;
			seg.path           = path;
			seg.offset_samples = static_cast<std::uint64_t> (
			    std::max<samplecnt_t> (ar->start_sample (), 0));
			seg.length_samples = static_cast<std::uint64_t> (
			    std::max<samplecnt_t> (ar->length_samples (), 0));
			out.push_back (std::move (seg));
			continue;
		}
		std::shared_ptr<PlaylistSource> inner_pls =
		    std::dynamic_pointer_cast<PlaylistSource> (ar->source (0));
		if (inner_pls && inner_pls->playlist ()) {
			append_playlist_audio_segments (inner_pls->playlist (), out);
		}
	}
}

// Best-effort: find the track whose id matches the `"track.<pbd-id>"` form
// that msgpack_out emits. Busses/masters are skipped — they don't host
// regions.
std::shared_ptr<Track>
track_by_foyer_id (Session& session, const std::string& track_id)
{
	if (track_id.rfind ("track.", 0) != 0) return {};
	const std::string sid = track_id.substr (6);
	std::shared_ptr<RouteList const> routes = safe_get_routes (session);
	for (auto const& r : *routes) {
		if (!r) continue;
		std::ostringstream tmp;
		tmp << r->id ();
		if (tmp.str () != sid) continue;
		return std::dynamic_pointer_cast<Track> (r);
	}
	return {};
}

// Parse `<Foyer><Sequencer>` out of a region's `_extra_xml` if
// present. Returns `SequencerLayoutDesc{present=false}` when nothing
// is stashed. Extra-xml is opt-in per Ardour's `Stateful` base; the
// class preserves unknown nodes through save/load so round-trips
// work out of the box.
static SequencerLayoutDesc
read_sequencer_from_region (const Region& r)
{
	SequencerLayoutDesc out;
	XMLNode* foyer = const_cast<Region&> (r).extra_xml ("Foyer");
	if (!foyer) return out;
	XMLNode* seq = foyer->child ("Sequencer");
	if (!seq) return out;
	out.present = true;
	seq->get_property ("version",       out.version);
	seq->get_property ("mode",          out.mode);
	seq->get_property ("resolution",    out.resolution);
	// `active` was added after the initial v2 shape — older
	// saved sessions don't have the attribute, so we default to
	// true (the behavior pre-deactivate-feature).
	if (!seq->get_property ("active", out.active)) { out.active = true; }
	// Accept legacy "steps" attribute alongside the v2 name.
	if (!seq->get_property ("pattern_steps", out.pattern_steps)) {
		seq->get_property ("steps", out.pattern_steps);
	}
	for (XMLNode* rn : seq->children ("Row")) {
		if (!rn) continue;
		SequencerRowDesc row;
		std::uint32_t p = 0, c = 9;
		rn->get_property ("pitch",   p);
		rn->get_property ("channel", c);
		rn->get_property ("label",   row.label);
		rn->get_property ("color",   row.color);
		rn->get_property ("muted",   row.muted);
		rn->get_property ("soloed",  row.soloed);
		row.pitch   = static_cast<std::uint8_t> (std::min<std::uint32_t> (p, 127));
		row.channel = static_cast<std::uint8_t> (c & 0x0f);
		out.rows.push_back (std::move (row));
	}
	// v1 top-level cells (legacy migration carry-through).
	for (XMLNode* cn : seq->children ("Cell")) {
		if (!cn) continue;
		SequencerCellDesc cell;
		std::uint32_t v = 100;
		cn->get_property ("row",          cell.row);
		cn->get_property ("step",         cell.step);
		cn->get_property ("velocity",     v);
		cn->get_property ("length_steps", cell.length_steps);
		cell.velocity = static_cast<std::uint8_t> (std::min<std::uint32_t> (v, 127));
		out.cells.push_back (cell);
	}
	// v2 patterns + arrangement.
	for (XMLNode* pn : seq->children ("Pattern")) {
		if (!pn) continue;
		SequencerPatternDesc pat;
		pn->get_property ("id",    pat.id);
		pn->get_property ("name",  pat.name);
		pn->get_property ("color", pat.color);
		for (XMLNode* cn : pn->children ("Cell")) {
			if (!cn) continue;
			SequencerCellDesc cell;
			std::uint32_t v = 100;
			cn->get_property ("row",          cell.row);
			cn->get_property ("step",         cell.step);
			cn->get_property ("velocity",     v);
			cn->get_property ("length_steps", cell.length_steps);
			cell.velocity = static_cast<std::uint8_t> (std::min<std::uint32_t> (v, 127));
			pat.cells.push_back (cell);
		}
		out.patterns.push_back (std::move (pat));
	}
	for (XMLNode* sn : seq->children ("Slot")) {
		if (!sn) continue;
		SequencerSlotDesc slot;
		sn->get_property ("pattern_id",      slot.pattern_id);
		sn->get_property ("bar",             slot.bar);
		sn->get_property ("arrangement_row", slot.arrangement_row);
		out.arrangement.push_back (slot);
	}
	return out;
}

// Build a fresh `<Foyer><Sequencer>` XML subtree from a typed
// layout. Returns an owned XMLNode*; caller hands it to
// `region->add_extra_xml` which takes ownership.
static XMLNode*
sequencer_to_xml (const SequencerLayoutDesc& layout)
{
	XMLNode* foyer = new XMLNode ("Foyer");
	XMLNode* seq   = foyer->add_child ("Sequencer");
	seq->set_property ("version",       layout.version);
	seq->set_property ("mode",          layout.mode);
	seq->set_property ("resolution",    layout.resolution);
	seq->set_property ("pattern_steps", layout.pattern_steps);
	seq->set_property ("active",        layout.active);
	for (auto const& r : layout.rows) {
		XMLNode* rn = seq->add_child ("Row");
		rn->set_property ("pitch",   static_cast<std::uint32_t> (r.pitch));
		rn->set_property ("channel", static_cast<std::uint32_t> (r.channel));
		rn->set_property ("label",   r.label);
		if (!r.color.empty ()) rn->set_property ("color", r.color);
		if (r.muted)  rn->set_property ("muted",  true);
		if (r.soloed) rn->set_property ("soloed", true);
	}
	// v1 carry-through cells (only when patterns is empty).
	if (layout.patterns.empty ()) {
		for (auto const& c : layout.cells) {
			XMLNode* cn = seq->add_child ("Cell");
			cn->set_property ("row",      c.row);
			cn->set_property ("step",     c.step);
			cn->set_property ("velocity", static_cast<std::uint32_t> (c.velocity));
			if (c.length_steps > 1) cn->set_property ("length_steps", c.length_steps);
		}
	}
	for (auto const& p : layout.patterns) {
		XMLNode* pn = seq->add_child ("Pattern");
		pn->set_property ("id",   p.id);
		pn->set_property ("name", p.name);
		if (!p.color.empty ()) pn->set_property ("color", p.color);
		for (auto const& c : p.cells) {
			XMLNode* cn = pn->add_child ("Cell");
			cn->set_property ("row",      c.row);
			cn->set_property ("step",     c.step);
			cn->set_property ("velocity", static_cast<std::uint32_t> (c.velocity));
			if (c.length_steps > 1) cn->set_property ("length_steps", c.length_steps);
		}
	}
	for (auto const& s : layout.arrangement) {
		XMLNode* sn = seq->add_child ("Slot");
		sn->set_property ("pattern_id",      s.pattern_id);
		sn->set_property ("bar",             s.bar);
		sn->set_property ("arrangement_row", s.arrangement_row);
	}
	return foyer;
}

RegionDesc
describe_region (const Region& r, const std::string& track_id)
{
	RegionDesc d;
	d.id              = "region." + region_pbd_id_string (r);
	d.track_id        = track_id;
	d.name            = r.name ();
	// Signed: Ardour's `position_sample()` can return a negative
	// value when the region has been dragged before the timeline's
	// zero mark (a standard pre-roll workflow). Emit verbatim so
	// the wire format preserves the sign.
	d.start_samples   = static_cast<std::int64_t> (r.position_sample ());
	d.length_samples  = static_cast<std::uint64_t> (std::max<samplecnt_t> (r.length_samples (), 0));
	d.muted           = r.muted ();
	d.color           = ""; // PresentationInfo color would go here — deferred.
	d.source_path     = region_source_path (r);
	d.source_offset_samples = static_cast<std::uint64_t> (std::max<samplecnt_t> (r.start_sample (), 0));
	d.has_source_offset     = !d.source_path.empty ();
	d.source_segments.clear ();
	if (d.source_path.empty ()) {
		auto pls = std::dynamic_pointer_cast<PlaylistSource> (r.source (0));
		if (pls) {
			append_playlist_audio_segments (pls->playlist (), d.source_segments);
		}
	}

	// MIDI regions: extract the note list so the web UI's piano roll
	// has data to render. Done inline on the region emission so
	// clients don't need a separate `list_notes` round-trip.
	auto mr = dynamic_cast<const ARDOUR::MidiRegion*> (&r);
	if (mr) {
		auto model = const_cast<ARDOUR::MidiRegion*> (mr)->model ();
		if (model) {
			auto lock = model->read_lock ();
			for (auto const& note : model->notes ()) {
				if (!note) continue;
				NoteDesc nd;
				// Stable note id keyed on Evoral's event_id_t. That's
				// the same integer the MidiModel uses internally to
				// identify the note across edits — position-based
				// indexing (our previous scheme) shifted under any
				// insert/remove and made UpdateNote / DeleteNote
				// target the wrong note after a roundtrip. Keep the
				// region-pbd-id prefix so IDs are unique across
				// regions (Evoral event IDs are region-local).
				std::ostringstream nid;
				nid << "note." << region_pbd_id_string (r) << "." << note->id ();
				nd.id       = nid.str ();
				nd.pitch    = note->note ();
				nd.velocity = note->velocity ();
				nd.channel  = note->channel ();
				// Evoral::Note<Temporal::Beats>: times are in musical
				// beats. `Beats::to_ticks()` (no arg) returns ticks
				// at `Beats::PPQN = Temporal::ticks_per_beat = 1920`.
				// The session snapshot's `ppqn` field carries this
				// scale so clients render notes at the right x.
				nd.start_ticks  = static_cast<std::uint64_t> (note->time ().to_ticks ());
				nd.length_ticks = static_cast<std::uint64_t> (note->length ().to_ticks ());
				d.notes.push_back (nd);
			}
			d.sequencer = read_sequencer_from_region (r);
			// Patch/bank-change events embedded in the region.
			for (auto const& pc : model->patch_changes ()) {
				if (!pc) continue;
				PatchChangeDesc pd;
				std::ostringstream pid;
				pid << "patchchange." << region_pbd_id_string (r) << "." << pc->id ();
				pd.id      = pid.str ();
				pd.channel = pc->channel ();
				pd.program = pc->program ();
				pd.bank    = static_cast<std::int32_t> (pc->bank ());
				pd.start_ticks = static_cast<std::uint64_t> (pc->time ().to_ticks ());
				d.patch_changes.push_back (pd);
			}
		}
	}

	// Render layer within the playlist's stack. `Region::layer()` is
	// the order index Ardour paints in; we emit it verbatim so the
	// FE's `(layer, source-order)` sort matches Ardour's playback
	// stack. Set even for non-audio regions (MIDI lanes can stack
	// too).
	d.layer = static_cast<std::int64_t> (const_cast<ARDOUR::Region&> (r).layer ());

	if (auto const* ar = dynamic_cast<const ARDOUR::AudioRegion*> (&r)) {
		d.emit_audio_envelope = true;
		d.gain_linear         = ar->scale_amplitude ();
		/* Ardour declares fade_in/out_length() non-const; reads are logically const. */
		auto* ar_mut = const_cast<ARDOUR::AudioRegion*> (ar);
		d.fade_in_samples =
		    static_cast<std::uint64_t> (std::max<samplecnt_t> (ar_mut->fade_in_length ().samples (), 0));
		d.fade_out_samples =
		    static_cast<std::uint64_t> (std::max<samplecnt_t> (ar_mut->fade_out_length ().samples (), 0));
	}

	return d;
}

} // namespace

std::shared_ptr<ARDOUR::Playlist>
playlist_for_track_id (Session& session, const std::string& track_id)
{
	auto track = track_by_foyer_id (session, track_id);
	if (!track) return {};
	return track->playlist ();
}

std::vector<RegionDesc>
enumerate_regions (Session& session, const std::string& track_id)
{
	std::vector<RegionDesc> out;
	auto track = track_by_foyer_id (session, track_id);
	if (!track) return out;
	auto playlist = track->playlist ();
	if (!playlist) return out;

	std::shared_ptr<RegionList> regions = playlist->region_list ();
	if (!regions) return out;

	out.reserve (regions->size ());
	for (auto const& r : *regions) {
		if (!r) continue;
		out.push_back (describe_region (*r, track_id));
	}
	return out;
}

RegionDesc
describe_region_desc (const ARDOUR::Region& r, const std::string& track_id)
{
	return describe_region (r, track_id);
}

bool
set_sequencer_layout (Session& session, const std::string& region_id, const SequencerLayoutDesc& layout)
{
	auto hit = find_region (session, region_id);
	if (!hit.region) {
		PBD::warning << "foyer_shim: set_sequencer_layout: unknown region "
		             << region_id << endmsg;
		return false;
	}
	PBD::warning << "foyer_shim: set_sequencer_layout region=" << region_id
	             << " patterns=" << layout.patterns.size ()
	             << " arrangement=" << layout.arrangement.size ()
	             << " resolution=" << layout.resolution
	             << " pattern_steps=" << layout.pattern_steps
	             << endmsg;
	// IMPORTANT: `add_extra_xml` internally calls
	// `_extra_xml->add_child_nocopy(node)` which stores the raw
	// pointer in Ardour's XML tree — Ardour takes ownership. We
	// must NOT delete the node afterwards (dangling child pointer
	// → session-save traverses freed memory → the Foyer block
	// silently gets dropped from the serialized .ardour file).
	XMLNode* node = sequencer_to_xml (layout);
	hit.region->add_extra_xml (*node);

	// Resize the region to fit the arrangement extent. Each bar
	// is `pattern_steps` cells × (PPQN / resolution) ticks. The
	// last_bar across all arrangement slots determines the total
	// length. We do the conversion here (not in the sidecar) so
	// the tempo-aware Beats → samples math lives where the live
	// tempo map is.
	std::uint32_t last_bar_plus_one = 0;
	for (auto const& slot : layout.arrangement) {
		if (slot.bar + 1 > last_bar_plus_one) last_bar_plus_one = slot.bar + 1;
	}
	if (last_bar_plus_one == 0 && !layout.cells.empty ()) {
		// v1 legacy layout — single implicit pattern at bar 0.
		last_bar_plus_one = 1;
	}
	if (last_bar_plus_one > 0) {
		const std::uint32_t res = std::max<std::uint32_t> (layout.resolution, 1);
		const std::uint32_t pat_steps = std::max<std::uint32_t> (layout.pattern_steps, 1);
		// Ardour's Temporal::Beats uses PPQN=1920 internally
		// (`libs/temporal/temporal/types.h:66`). Earlier code
		// hardcoded 960 here — half the right scale — which made
		// the region length come out at half the intended duration
		// AND notes from the server's matching expand call land at
		// half-time positions. Use Ardour's PPQN explicitly so
		// shim-side and server-side ticks agree.
		const std::int64_t step_ticks = static_cast<std::int64_t> (Temporal::ticks_per_beat) / static_cast<std::int64_t> (res);
		const std::int64_t bar_ticks  = static_cast<std::int64_t> (pat_steps) * step_ticks;
		const std::int64_t total_ticks = static_cast<std::int64_t> (last_bar_plus_one) * bar_ticks;
		auto length = Temporal::timecnt_t (
		    Temporal::Beats::ticks (total_ticks),
		    hit.region->position ());
		// Don't shrink the region below its current length — that
		// can clip out source notes that were authored before the
		// arrangement extent shrank, and forces the source to
		// reload. Only grow.
		const Temporal::timecnt_t cur_length = hit.region->length ();
		if (length.distance () > cur_length.distance ()) {
			hit.region->set_length (length);
		}
	}

	// `add_extra_xml` doesn't run through the PropertyChange
	// bookkeeping — flip the dirty flag manually so the next save
	// catches our write.
	session.set_dirty ();
	return true;
}

bool
clear_sequencer_layout (Session& session, const std::string& region_id)
{
	auto hit = find_region (session, region_id);
	if (!hit.region) return false;
	// `Stateful` doesn't expose a removal API, so we replace with
	// an empty placeholder that `extra_xml("Foyer")` can still
	// find (returns a childless node → UI flips back to piano-
	// roll). Don't delete — Ardour owns it via add_child_nocopy.
	XMLNode* empty = new XMLNode ("Foyer");
	hit.region->add_extra_xml (*empty);
	session.set_dirty ();
	return true;
}

std::vector<PluginCatalogDesc>
list_plugin_catalog ()
{
	std::vector<PluginCatalogDesc> out;
	auto& mgr = ARDOUR::PluginManager::instance ();

	// If every list is empty, Ardour hasn't scanned (or its cache is
	// stale/empty). Kick a refresh and re-read. This is the common
	// case on first dev-container boot where no Ardour GUI has ever
	// run its startup scan.
	bool all_empty = true;
	auto check_empty = [&all_empty] (const ARDOUR::PluginInfoList& list) {
		for (auto const& info : list) { if (info) { all_empty = false; break; } }
	};
	check_empty (mgr.lv2_plugin_info ());
	check_empty (mgr.vst3_plugin_info ());
	check_empty (mgr.ladspa_plugin_info ());
	if (all_empty) {
		PBD::warning << "foyer_shim: plugin catalog empty — triggering refresh" << endmsg;
		mgr.refresh ();
	}

	// `get_all_plugins` is private — walk each format's public list
	// directly. The frontend re-sorts the catalog by role / name for
	// presentation, so the per-format ordering here is fine.
	auto append = [&out] (const char* label, const ARDOUR::PluginInfoList& list) {
		std::size_t count = 0;
		for (auto const& info : list) {
			if (!info) continue;
			PluginCatalogDesc d;
			d.id     = info->unique_id;
			d.name   = info->name;
			d.format = plugin_format_label (info->type);
			d.role   = info->is_instrument () ? "instrument" : "effect";
			d.vendor = info->creator;
			// `unique_id` doubles as the URI Foyer's AddPlugin
			// command echoes back — same round-trip for every
			// plugin format Ardour supports.
			d.uri    = info->unique_id;
			if (!info->category.empty ()) d.tags.push_back (info->category);
			out.push_back (std::move (d));
			++count;
		}
		PBD::warning << "foyer_shim: plugin catalog " << label << " count=" << count << endmsg;
	};
	append ("lv2",     mgr.lv2_plugin_info ());
	append ("vst3",    mgr.vst3_plugin_info ());
	append ("win_vst", mgr.windows_vst_plugin_info ());
	append ("lx_vst",  mgr.lxvst_plugin_info ());
	append ("mac_vst", mgr.mac_vst_plugin_info ());
	append ("au",      mgr.au_plugin_info ());
	append ("ladspa",  mgr.ladspa_plugin_info ());
	append ("lua",     mgr.lua_plugin_info ());
	PBD::info << "foyer_shim: plugin catalog total=" << out.size () << endmsg;
	return out;
}

std::shared_ptr<PluginInsert>
find_plugin_insert_by_foyer_id (Session& session, const std::string& plugin_id)
{
	// Foyer ids for plugins are `"plugin.<pi-id>"` — strip the prefix
	// before falling through to the internal resolver.
	if (plugin_id.rfind ("plugin.", 0) != 0) return {};
	const std::string pid = plugin_id.substr (7);
	return find_plugin_insert (session, pid);
}

std::vector<PluginPresetDesc>
list_plugin_presets (Session& session, const std::string& plugin_id)
{
	std::vector<PluginPresetDesc> out;
	auto pi = find_plugin_insert_by_foyer_id (session, plugin_id);
	if (!pi) return out;
	auto plug = pi->plugin ();
	if (!plug) return out;
	auto presets = plug->get_presets ();
	out.reserve (presets.size ());
	for (auto const& pr : presets) {
		PluginPresetDesc d;
		d.id         = pr.uri;
		d.name       = pr.label;
		d.bank       = "";
		d.is_factory = !pr.user;
		out.push_back (std::move (d));
	}
	return out;
}

MidiPatchNamesDesc
list_midi_patch_names (Session& session, const std::string& track_id, std::uint8_t channel)
{
	MidiPatchNamesDesc out;
	out.track_id = track_id;
	out.channel = static_cast<std::uint8_t> (std::min<int> (15, channel));
	if (track_id.rfind ("track.", 0) != 0) return out;
	const std::string sid = track_id.substr (6);

	std::shared_ptr<Route> route;
	{
		std::shared_ptr<RouteList const> routes = safe_get_routes (session);
		for (auto const& r : *routes) {
			if (!r) continue;
			std::ostringstream tmp;
			tmp << r->id ();
			if (tmp.str () != sid) continue;
			route = r;
			break;
		}
	}
	if (!route) return out;

	auto& info = route->instrument_info ();
	if (!info.model ().empty ()) out.model = info.model ();
	if (!info.mode ().empty ()) out.mode = info.mode ();

	auto chan_set = info.get_patches (out.channel);
	if (!chan_set) return out;
	std::map<std::uint16_t, MidiPatchBankDesc> generic_banks;
	for (auto const& bank : chan_set->patch_banks ()) {
		if (!bank) continue;
		if (bank->number () == UINT16_MAX) {
			// Ardour's patch selector treats UINT16_MAX PatchBanks as
			// "generic" name lists: the bank to send lives on each Patch
			// primary key, not on the PatchBank itself. Mirror that shape
			// on the wire so selecting e.g. SC-55 "Piano" sends the real
			// 14-bit bank instead of 0xffff/16383.
			for (auto const& patch : bank->patch_name_list ()) {
				if (!patch) continue;
				const std::uint16_t real_bank = patch->bank_number ();
				auto& b = generic_banks[real_bank];
				b.bank = real_bank;
				if (b.name.empty ()) {
					std::ostringstream name;
					name << "Bank " << (static_cast<unsigned> (real_bank) + 1);
					if (!bank->name ().empty ()) name << " (" << bank->name () << ")";
					b.name = name.str ();
				}
				MidiPatchProgramDesc p;
				p.program = patch->program_number ();
				p.name = patch->name ();
				b.programs.push_back (std::move (p));
			}
		} else {
			MidiPatchBankDesc b;
			b.bank = static_cast<std::uint16_t> (std::max<int> (0, bank->number ()));
			b.name = bank->name ();
			for (auto const& patch : bank->patch_name_list ()) {
				if (!patch) continue;
				MidiPatchProgramDesc p;
				p.program = patch->program_number ();
				p.name = patch->name ();
				b.programs.push_back (std::move (p));
			}
			std::sort (b.programs.begin (), b.programs.end (), [] (auto const& a, auto const& z) {
				return a.program < z.program;
			});
			out.banks.push_back (std::move (b));
		}
	}
	for (auto& it : generic_banks) {
		auto& b = it.second;
		std::sort (b.programs.begin (), b.programs.end (), [] (auto const& a, auto const& z) {
			return a.program < z.program;
		});
		out.banks.push_back (std::move (b));
	}
	std::sort (out.banks.begin (), out.banks.end (), [] (auto const& a, auto const& z) {
		return a.bank < z.bank;
	});
	return out;
}

bool
load_plugin_preset (Session& session, const std::string& plugin_id, const std::string& preset_id)
{
	auto pi = find_plugin_insert_by_foyer_id (session, plugin_id);
	if (!pi) return false;
	auto plug = pi->plugin ();
	if (!plug) return false;
	const auto* rec = plug->preset_by_uri (preset_id);
	if (!rec) return false;
	return plug->load_preset (*rec);
}

RegionHit
find_region (Session& session, const std::string& region_id)
{
	RegionHit hit;
	if (region_id.rfind ("region.", 0) != 0) return hit;
	const std::string rid = region_id.substr (7);

	std::shared_ptr<RouteList const> routes = safe_get_routes (session);
	for (auto const& r : *routes) {
		if (!r) continue;
		auto track = std::dynamic_pointer_cast<Track> (r);
		if (!track) continue;
		auto playlist = track->playlist ();
		if (!playlist) continue;
		auto regs = playlist->region_list ();
		if (!regs) continue;
		for (auto const& reg : *regs) {
			if (!reg) continue;
			std::ostringstream tmp;
			tmp << reg->id ();
			if (tmp.str () != rid) continue;
			hit.region   = reg;
			std::ostringstream trk;
			trk << r->id ();
			hit.track_id = "track." + trk.str ();
			return hit;
		}
	}
	return hit;
}

std::shared_ptr<PBD::Controllable>
resolve_automation_control (Session& session, const std::string& control_id)
{
	// resolve returns a Controllable; AutomationControl inherits from it.
	return resolve (session, control_id);
}

std::string
track_id_for_control (Session& session, const std::string& control_id)
{
	// Format: track.<pbd-id>.<field>  or  plugin.<pi-id>...
	if (control_id.rfind ("track.", 0) == 0) {
		auto last_dot = control_id.rfind ('.');
		if (last_dot != std::string::npos && last_dot > 6) {
			return control_id.substr (0, last_dot);
		}
	}
	// Plugin params: find which route hosts the plugin.
	if (control_id.rfind ("plugin.", 0) == 0) {
		const std::string suffix_param = ".param.";
		auto param_pos = control_id.rfind (suffix_param);
		if (param_pos != std::string::npos) {
			std::string pid = control_id.substr (7, param_pos - 7);
			std::shared_ptr<RouteList const> routes = safe_get_routes (session);
			for (auto const& r : *routes) {
				if (!r) continue;
				for (uint32_t i = 0; ; ++i) {
					auto proc = r->nth_plugin (i);
					if (!proc) break;
					auto pi = std::dynamic_pointer_cast<PluginInsert> (proc);
					if (!pi) continue;
					std::ostringstream o; o << pi->id ();
					if (o.str () == pid) {
						std::ostringstream trk; trk << r->id ();
						return "track." + trk.str ();
					}
				}
			}
		}
	}
	return {};
}

// ── Scripting ───────────────────────────────────────────────────────

namespace {
std::uint64_t now_ms ()
{
    return static_cast<std::uint64_t> (
        std::chrono::duration_cast<std::chrono::milliseconds> (
            std::chrono::system_clock::now ().time_since_epoch ()).count ());
}

/// Derive a stable Lua function name from a display name. Ardour's
/// `register_lua_function` enforces a single global namespace so we
/// must produce identifiers that survive a round-trip through Lua's
/// syntax: ASCII letters / digits / underscore, never leading digit.
std::string slugify (const std::string& display)
{
    std::string s;
    s.reserve (display.size () + 4);
    for (char c : display) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '_') {
            s.push_back (c);
        } else if (c == ' ' || c == '-' || c == '.' || c == '/') {
            s.push_back ('_');
        }
    }
    if (s.empty () || (s.front () >= '0' && s.front () <= '9')) {
        s.insert (s.begin (), 'f');
    }
    return s;
}

/// Translate a Foyer `args` table into Ardour's `LuaScriptParamList`
/// shape so we can hand it through `register_lua_function`. Every
/// entry rides as a single non-optional, pre-seeded parameter — we
/// don't know enough about the script's expected param descriptors
/// at this point to be smarter, and Ardour's
/// `try_compile`-then-register flow only cares about coverage.
LuaScriptParamList build_param_list (const std::map<std::string, std::string>& args)
{
    LuaScriptParamList out;
    for (auto const& kv : args) {
        // (name, title, default, optional, preseeded)
        auto p = std::make_shared<LuaScriptParam> (
            kv.first, kv.first, kv.second, /*optional=*/false, /*preseeded=*/true);
        p->is_set = true;
        p->value = kv.second;
        out.push_back (p);
    }
    return out;
}
} // namespace

// ── ScriptStore ────────────────────────────────────────────────────
ScriptStore& ScriptStore::instance ()
{
    static ScriptStore inst;
    return inst;
}

std::vector<ScriptRecord> ScriptStore::list () const
{
    std::lock_guard<std::mutex> g (_m);
    std::vector<ScriptRecord> out;
    out.reserve (_by_id.size ());
    for (auto const& kv : _by_id) out.push_back (kv.second);
    return out;
}

std::optional<ScriptRecord> ScriptStore::get (const std::string& id) const
{
    std::lock_guard<std::mutex> g (_m);
    auto it = _by_id.find (id);
    if (it == _by_id.end ()) return std::nullopt;
    return it->second;
}

void ScriptStore::put (ScriptRecord rec)
{
    std::lock_guard<std::mutex> g (_m);
    if (rec.updated_at_ms == 0) rec.updated_at_ms = now_ms ();
    auto id = rec.id;
    _by_id[id] = std::move (rec);
}

bool ScriptStore::remove (const std::string& id)
{
    std::lock_guard<std::mutex> g (_m);
    return _by_id.erase (id) > 0;
}

void ScriptStore::clear ()
{
    std::lock_guard<std::mutex> g (_m);
    _by_id.clear ();
}

void ScriptStore::replace_all (std::vector<ScriptRecord> rec)
{
    std::lock_guard<std::mutex> g (_m);
    _by_id.clear ();
    for (auto& r : rec) {
        auto id = r.id;
        _by_id[id] = std::move (r);
    }
}

// ── save_script ────────────────────────────────────────────────────
ScriptRecord
save_script (Session& session, ScriptRecord rec)
{
    if (rec.id.empty ()) rec.id = slugify (rec.name.empty () ? "script" : rec.name);
    if (rec.id.empty ()) rec.id = "foyer_script";
    rec.disabled_on_upload = false;
    rec.updated_at_ms = now_ms ();

    // Replace-by-name semantics: Ardour's
    // `register_lua_function(name, ...)` REPLACES any prior
    // registration under that name, so we don't need a separate
    // unregister step. Wrapping the call so it throws cleanly if
    // the script body is malformed — caller logs the error and
    // surfaces it back to the FE.
    if (rec.script_type != "dsp") {
        try {
            auto params = build_param_list (rec.args);
            session.register_lua_function (rec.id, rec.body, params);
        } catch (...) {
            // Best-effort; the FE save still records the body so the
            // user can fix syntax errors without losing their work.
        }
    } else {
        // DSP scripts ride the luaproc plugin path. Write the body
        // to Ardour's user_script_dir() so the in-tree
        // `LuaScripting::scan` picks it up. NOTE: do NOT call
        // `PluginManager::refresh(true)` here — that is the
        // FULL plugin rescan (LV2 + VST + AU + LADSPA + Lua)
        // and crashes when invoked from a control-surface
        // thread mid-session. `LuaScripting::refresh(run_scan=true)`
        // emits the `scripts_changed` signal which
        // `PluginManager::lua_refresh_cb` is already connected to
        // (see plugin_manager.cc:335), so the Lua-only plugin
        // catalog updates automatically without us reaching into
        // PluginManager directly.
        try {
            const std::string dir = LuaScripting::user_script_dir ();
            if (!dir.empty ()) {
                const std::string fname = dir + "/" + rec.id + ".lua";
                FILE* fp = std::fopen (fname.c_str (), "w");
                if (fp) {
                    std::fwrite (rec.body.data (), 1, rec.body.size (), fp);
                    std::fclose (fp);
                }
                LuaScripting::instance ().refresh (/*run_scan=*/true);
            }
        } catch (...) {
            // Best-effort; the FE save still records the body even
            // if the file write fails (e.g. read-only home).
        }
    }

    ScriptStore::instance ().put (rec);
    return rec;
}

void
delete_script (Session& session, const std::string& id)
{
    if (id.empty ()) return;
    // Mirror save's DSP-vs-non-DSP split: DSP scripts live as files
    // in `user_script_dir()` (not in the session's Lua registration
    // table), so unregister + file removal are different paths.
    auto rec_opt = ScriptStore::instance ().get (id);
    const bool is_dsp = rec_opt && rec_opt->script_type == "dsp";
    if (!is_dsp) {
        try {
            session.unregister_lua_function (id);
        } catch (...) {
            // Idempotent: an unknown name throws but we treat as success.
        }
    } else {
        // Mirror save_script: `LuaScripting::refresh(true)` cascades
        // through `scripts_changed` → `PluginManager::lua_refresh_cb`,
        // which is what we want here. Calling
        // `PluginManager::refresh(true)` directly is a FULL plugin
        // rescan and crashes when invoked from a control-surface
        // thread mid-session.
        try {
            const std::string dir = LuaScripting::user_script_dir ();
            if (!dir.empty ()) {
                const std::string fname = dir + "/" + id + ".lua";
                std::remove (fname.c_str ());
                LuaScripting::instance ().refresh (true);
            }
        } catch (...) {}
    }
    ScriptStore::instance ().remove (id);
}

// ── run_script ─────────────────────────────────────────────────────
//
// Execute a saved script in a FRESH sandboxed LuaState, NOT the
// session's persistent VM. Two reasons:
//   1. One-shot semantics — the user's expectation is "run this and
//      tell me what happened", not "register and call later".
//   2. Sandbox isolation — Ardour's sandbox mode strips dangerous
//      globals (`os.execute`, `io.open`, ...) so a malformed snippet
//      can't tamper with the host process. The session VM has those
//      back because Session::setup_lua needs them for project-side
//      IO; we'd rather not expose that surface from the FAB.
//
// `print()` output is captured via `LuaState::Print` (a sigc signal);
// args are exposed as a global `foyer_args` table so script bodies
// can read inputs without ceremony.
ScriptRunOutcome
run_script (Session& session, const std::string& id,
            const std::map<std::string, std::string>& args_override)
{
    (void) session;
    ScriptRunOutcome out;
    auto t0 = std::chrono::steady_clock::now ();
    auto rec_opt = ScriptStore::instance ().get (id);
    if (!rec_opt) {
        out.ok = false;
        out.error_text = "unknown script: " + id;
        out.elapsed_ms = 0;
        return out;
    }
    auto& rec = *rec_opt;
    auto args = args_override.empty () ? rec.args : args_override;

    LuaState lua (/*sandbox=*/true, /*rt_safe=*/false);
    std::string captured;
    sigc::connection print_conn = lua.Print.connect (
        [&captured] (std::string s) {
            captured.append (s);
            if (captured.empty () || captured.back () != '\n') captured.push_back ('\n');
        });

    // Build a Lua snippet that pre-seeds `foyer_args` then executes
    // the body. Strings are emitted with safe quoting so a value
    // containing `"` or backslashes can't break out of the literal.
    auto lua_quote = [] (const std::string& s) {
        std::string out;
        out.reserve (s.size () + 2);
        out.push_back ('"');
        for (char c : s) {
            switch (c) {
                case '\\': out.append ("\\\\"); break;
                case '"':  out.append ("\\\""); break;
                case '\n': out.append ("\\n");  break;
                case '\r': out.append ("\\r");  break;
                case '\t': out.append ("\\t");  break;
                default:
                    if (static_cast<unsigned char> (c) < 0x20) {
                        char buf[8];
                        std::snprintf (buf, sizeof (buf), "\\%03d", (int) (unsigned char) c);
                        out.append (buf);
                    } else {
                        out.push_back (c);
                    }
            }
        }
        out.push_back ('"');
        return out;
    };
    std::string prelude = "foyer_args = {}\n";
    for (auto const& kv : args) {
        prelude += "foyer_args[" + lua_quote (kv.first) + "] = " + lua_quote (kv.second) + "\n";
    }
    const std::string chunk = prelude + rec.body;
    int rc = 0;
    try {
        rc = lua.do_command (chunk);
    } catch (std::exception const& e) {
        out.ok = false;
        out.error_text = e.what ();
    } catch (...) {
        out.ok = false;
        out.error_text = "unknown error in lua execution";
    }
    print_conn.disconnect ();

    // `do_command` returns the result of `luaL_dostring` — 0 on
    // success, non-zero on syntax/runtime error. The error message
    // itself rides on Lua's stack; LuaState's print sink forwards it
    // through the Print signal we connected above, so the caller sees
    // it in `captured`.
    if (rc != 0 && out.error_text.empty ()) {
        out.ok = false;
        out.error_text = captured.empty ()
            ? std::string ("lua error (rc=") + std::to_string (rc) + ")"
            : captured;
    }
    out.stdout_text = std::move (captured);
    out.elapsed_ms = static_cast<std::uint32_t> (
        std::chrono::duration_cast<std::chrono::milliseconds> (
            std::chrono::steady_clock::now () - t0).count ());
    return out;
}

// ── recover_disabled_scripts ───────────────────────────────────────
//
// Pulls the `<Script lua="VERSION">` element out of the session's
// in-memory XML state and decodes its base64 payload. The payload
// is the serialized Lua function table the session previously
// stored — a `do ... end` block, NOT individual function names.
// We capture the whole blob as a single recovered record so the
// user can inspect it; granular per-function recovery would need
// us to teach the Lua VM to enumerate without registering.
std::vector<ScriptRecord>
recover_disabled_scripts (Session& session)
{
    std::vector<ScriptRecord> recovered;
    // Session's in-memory XML accessors (`state()` / `get_state()`)
    // are private to libardour, so we read the .ardour file off disk
    // and parse it ourselves. Path comes from `session.path()` and
    // the active snapshot's filename is `<snap_name>.ardour`.
    const std::string dir = session.path ();
    const std::string snap = session.snap_name ();
    if (dir.empty () || snap.empty ()) return recovered;
    std::string file = dir;
    if (!file.empty () && file.back () != '/') file.push_back ('/');
    file += snap + ".ardour";

    XMLTree tree;
    if (!tree.read (file)) {
        // Session has never been saved (no .ardour file yet) OR the
        // file isn't readable from this process. Silent — caller
        // logs a warning if it cares.
        return recovered;
    }
    XMLNode* root = tree.root ();
    if (!root) return recovered;
    XMLNode* script_node = root->child ("Script");
    if (!script_node) return recovered;

    // <Script lua="VERSION"> holds a single base64-encoded text node
    // that, on session load, Ardour `g_base64_decode`s into a chunk
    // of Lua source and feeds to `_lua_load` (see
    // libs/ardour/session_state.cc). The chunk re-registers all
    // previously-saved functions; here we just surface it as ONE
    // recovered record so the user can audit before re-enabling.
    std::string b64_payload;
    for (auto const* child : script_node->children ()) {
        if (!child || !child->is_content ()) continue;
        b64_payload += child->content ();
    }
    // Strip whitespace base64 sometimes picks up across line breaks
    // in pretty-printed XML.
    b64_payload.erase (
        std::remove_if (b64_payload.begin (), b64_payload.end (),
                        [] (char c) { return std::isspace ((unsigned char) c); }),
        b64_payload.end ());
    if (b64_payload.empty ()) return recovered;

    gsize size = 0;
    guchar* raw = g_base64_decode (b64_payload.c_str (), &size);
    if (!raw) return recovered;
    std::string body (reinterpret_cast<const char*> (raw), size);
    g_free (raw);

    ScriptRecord rec;
    rec.id = "recovered_script_payload";
    rec.name = "Recovered <Script> payload";
    rec.description =
        "Decoded from the session's <Script lua=...> XML element. "
        "This is the raw Lua chunk that Ardour normally executes on "
        "session load to re-register every Foyer-authored script. "
        "Review before enabling — recovered scripts can run "
        "arbitrary code.";
    rec.script_type = "snippet";
    rec.language = "lua";
    rec.enabled = false;
    rec.body = std::move (body);
    rec.disabled_on_upload = true;
    rec.updated_at_ms = now_ms ();
    recovered.push_back (std::move (rec));

    for (auto const& r : recovered) ScriptStore::instance ().put (r);
    return recovered;
}

} // namespace ArdourSurface::schema_map
