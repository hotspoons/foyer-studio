/*
 * Foyer Studio — Ardour shim: schema translation implementation.
 */
#include "schema_map.h"

#include <sstream>

#include "ardour/parameter_descriptor.h"
#include "ardour/plug_insert_base.h"
#include "ardour/plugin.h"
#include "ardour/plugin_insert.h"
#include "ardour/route.h"
#include "ardour/route_group.h"
#include "ardour/session.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "pbd/controllable.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface::schema_map {

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
	(void)s;
	// Ardour stores colors as uint32 in the PresentationInfo; we can thread
	// that through here once we wire PresentationInfo access. Until then,
	// empty string — UI picks a default.
	return "";
}

} // namespace

std::string id_gain  (const Stripable& s) { return "track." + stripable_id_string (s) + ".gain"; }
std::string id_pan   (const Stripable& s) { return "track." + stripable_id_string (s) + ".pan"; }
std::string id_mute  (const Stripable& s) { return "track." + stripable_id_string (s) + ".mute"; }
std::string id_solo  (const Stripable& s) { return "track." + stripable_id_string (s) + ".solo"; }
std::string id_rec   (const Stripable& s) { return "track." + stripable_id_string (s) + ".rec"; }
std::string id_meter (const Stripable& s) { return "track." + stripable_id_string (s) + ".meter"; }

std::string
id_for_controllable (const Session& session, const Controllable& c)
{
	std::shared_ptr<RouteList const> routes = session.get_routes ();
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
	std::shared_ptr<RouteList const> routes = session.get_routes ();
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

		std::shared_ptr<RouteList const> routes = session.get_routes ();
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

} // namespace ArdourSurface::schema_map
