/*
 * Foyer Studio — Ardour shim: schema translation implementation.
 */
#include "schema_map.h"

#include <sstream>

#include "ardour/audioregion.h"
#include "ardour/file_source.h"
#include "ardour/midi_model.h"
#include "ardour/midi_region.h"
#include "ardour/parameter_descriptor.h"
#include "ardour/plug_insert_base.h"
#include "ardour/playlist.h"
#include "ardour/plugin.h"
#include "ardour/plugin_insert.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/route_group.h"
#include "ardour/session.h"
#include "ardour/source.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "pbd/controllable.h"

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

} // namespace

std::vector<PluginDesc>
enumerate_plugins (std::shared_ptr<Route> route)
{
	std::vector<PluginDesc> out;
	if (!route) return out;

	for (uint32_t i = 0; ; ++i) {
		std::shared_ptr<Processor> proc = route->nth_plugin (i);
		if (!proc) break;
		std::shared_ptr<PluginInsert> pi = std::dynamic_pointer_cast<PluginInsert> (proc);
		if (!pi) continue;
		std::shared_ptr<Plugin> plug = pi->plugin (0);
		if (!plug) continue;

		PluginDesc pd;
		pd.id       = "plugin." + plugin_insert_id_string (*pi);
		pd.name     = plug->name ();
		pd.uri      = plug->unique_id ();
		// Ardour treats "active" as "not bypassed"; invert for schema.
		pd.bypassed = !pi->active ();

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
	}
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

RegionDesc
describe_region (const Region& r, const std::string& track_id)
{
	RegionDesc d;
	d.id              = "region." + region_pbd_id_string (r);
	d.track_id        = track_id;
	d.name            = r.name ();
	d.start_samples   = static_cast<std::uint64_t> (std::max<samplepos_t> (r.position_sample (), 0));
	d.length_samples  = static_cast<std::uint64_t> (std::max<samplecnt_t> (r.length_samples (), 0));
	d.muted           = r.muted ();
	d.color           = ""; // PresentationInfo color would go here — deferred.
	d.source_path     = region_source_path (r);
	d.source_offset_samples = static_cast<std::uint64_t> (std::max<samplecnt_t> (r.start_sample (), 0));
	d.has_source_offset     = !d.source_path.empty ();

	// MIDI regions: extract the note list so the web UI's piano roll
	// has data to render. Done inline on the region emission so
	// clients don't need a separate `list_notes` round-trip.
	auto mr = dynamic_cast<const ARDOUR::MidiRegion*> (&r);
	if (mr) {
		auto model = const_cast<ARDOUR::MidiRegion*> (mr)->model ();
		if (model) {
			auto lock = model->read_lock ();
			std::uint32_t idx = 0;
			for (auto const& note : model->notes ()) {
				if (!note) continue;
				NoteDesc nd;
				std::ostringstream nid;
				nid << "note." << region_pbd_id_string (r) << "." << idx++;
				nd.id       = nid.str ();
				nd.pitch    = note->note ();
				nd.velocity = note->velocity ();
				nd.channel  = note->channel ();
				// Evoral::Note<Temporal::Beats>: times are in musical
				// beats. Convert to ticks (default 960 PPQN via
				// Temporal::ticks_per_beat) for the wire schema.
				nd.start_ticks  = static_cast<std::uint64_t> (note->time ().to_ticks ());
				nd.length_ticks = static_cast<std::uint64_t> (note->length ().to_ticks ());
				d.notes.push_back (nd);
			}
		}
	}

	return d;
}

} // namespace

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

} // namespace ArdourSurface::schema_map
