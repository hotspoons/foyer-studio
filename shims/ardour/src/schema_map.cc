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
#include "ardour/plugin_manager.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/route_group.h"
#include "ardour/session.h"
#include "ardour/source.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
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
				// beats. Convert to ticks (default 960 PPQN via
				// Temporal::ticks_per_beat) for the wire schema.
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

static const char*
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

} // namespace ArdourSurface::schema_map
