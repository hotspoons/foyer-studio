/*
 * Foyer Studio — Ardour shim: MessagePack encoder.
 *
 * Hand-rolled to avoid an extra system dependency. Only supports the subset of
 * msgpack we need. The companion tests in `tests/msgpack_out_test.cc` (and the
 * end-to-end Rust integration once Ardour builds) verify wire parity.
 *
 * Types we emit:
 *  - nil
 *  - bool
 *  - int/uint (all widths)
 *  - float32, float64
 *  - str (utf-8)
 *  - array, fixarray
 *  - map, fixmap
 *
 * We use `rmp-serde`-compatible "serde-named" struct encoding: every struct is
 * a map keyed by field names.
 */
#include "msgpack_out.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <sstream>

#include "ardour/automation_control.h"
#include "ardour/automation_list.h"
#include "ardour/meter.h"
#include "ardour/monitor_control.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/source.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "ardour/types.h"
#include "evoral/ControlList.h"
#include "pbd/controllable.h"
#include "temporal/tempo.h"
#include "temporal/timeline.h"

#include "schema_map.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface::msgpack_out {

namespace {

// Convert Ardour's AutoState enum to the lowercase strings the Rust
// schema's `AutomationMode` deserializes. Unknown / off falls to
// "off" so the UI doesn't paint a lane it can't drive.
const char* automation_mode_str (ARDOUR::AutoState s)
{
	switch (s) {
		case ARDOUR::Play:   return "play";
		case ARDOUR::Write:  return "write";
		case ARDOUR::Touch:  return "touch";
		case ARDOUR::Latch:  return "latch";
		case ARDOUR::Off:
		default:             return "off";
	}
}

// ---------------- low-level msgpack primitives ----------------

struct Out
{
	std::vector<std::uint8_t>& buf;

	void u8  (std::uint8_t v)  { buf.push_back (v); }
	void be16 (std::uint16_t v) {
		buf.push_back (static_cast<std::uint8_t> (v >> 8));
		buf.push_back (static_cast<std::uint8_t> (v & 0xff));
	}
	void be32 (std::uint32_t v) {
		buf.push_back (static_cast<std::uint8_t> ((v >> 24) & 0xff));
		buf.push_back (static_cast<std::uint8_t> ((v >> 16) & 0xff));
		buf.push_back (static_cast<std::uint8_t> ((v >> 8) & 0xff));
		buf.push_back (static_cast<std::uint8_t> (v & 0xff));
	}
	void be64 (std::uint64_t v) { be32 (v >> 32); be32 (v & 0xffffffffull); }

	void nil ()  { u8 (0xc0); }
	void b (bool v) { u8 (v ? 0xc3 : 0xc2); }

	void u (std::uint64_t v) {
		if (v <= 0x7f) { u8 (static_cast<std::uint8_t> (v)); }
		else if (v <= 0xff)    { u8 (0xcc); u8 (static_cast<std::uint8_t> (v)); }
		else if (v <= 0xffff)  { u8 (0xcd); be16 (static_cast<std::uint16_t> (v)); }
		else if (v <= 0xffffffff) { u8 (0xce); be32 (static_cast<std::uint32_t> (v)); }
		else { u8 (0xcf); be64 (v); }
	}

	void i (std::int64_t v) {
		if (v >= 0) { u (static_cast<std::uint64_t> (v)); return; }
		if (v >= -32) { u8 (static_cast<std::uint8_t> (0xe0 | (v + 32))); return; }
		if (v >= -128)            { u8 (0xd0); u8 (static_cast<std::uint8_t> (v & 0xff)); return; }
		if (v >= -32768)          { u8 (0xd1); be16 (static_cast<std::uint16_t> (v)); return; }
		if (v >= -2147483648LL)   { u8 (0xd2); be32 (static_cast<std::uint32_t> (v)); return; }
		u8 (0xd3); be64 (static_cast<std::uint64_t> (v));
	}

	void f32 (float v) {
		u8 (0xca);
		std::uint32_t bits;
		std::memcpy (&bits, &v, 4);
		be32 (bits);
	}

	void f64 (double v) {
		u8 (0xcb);
		std::uint64_t bits;
		std::memcpy (&bits, &v, 8);
		be64 (bits);
	}

	void str (const std::string& s) {
		auto n = s.size ();
		if (n <= 31) u8 (static_cast<std::uint8_t> (0xa0 | n));
		else if (n <= 0xff)   { u8 (0xd9); u8 (static_cast<std::uint8_t> (n)); }
		else if (n <= 0xffff) { u8 (0xda); be16 (static_cast<std::uint16_t> (n)); }
		else { u8 (0xdb); be32 (static_cast<std::uint32_t> (n)); }
		buf.insert (buf.end (), s.begin (), s.end ());
	}

	void array (std::size_t n) {
		if (n <= 15)          u8 (static_cast<std::uint8_t> (0x90 | n));
		else if (n <= 0xffff) { u8 (0xdc); be16 (static_cast<std::uint16_t> (n)); }
		else                  { u8 (0xdd); be32 (static_cast<std::uint32_t> (n)); }
	}

	void map (std::size_t n) {
		if (n <= 15)          u8 (static_cast<std::uint8_t> (0x80 | n));
		else if (n <= 0xffff) { u8 (0xde); be16 (static_cast<std::uint16_t> (n)); }
		else                  { u8 (0xdf); be32 (static_cast<std::uint32_t> (n)); }
	}
};

// ---------------- envelope helpers ----------------

static std::uint64_t next_seq ()
{
	static std::uint64_t s = 1;
	return s++;
}

/// Writes the outer `Envelope<Control>` map with `dir="event"` and the supplied
/// body writer as the `body` value. The body writer should write an Event
/// enum externally-tagged by `type`.
template <typename BodyFn>
std::vector<std::uint8_t>
envelope_event (BodyFn write_body)
{
	std::vector<std::uint8_t> buf;
	Out o { buf };
	// Envelope { schema, seq, origin, body }
	o.map (4);
	o.str ("schema"); o.array (2); o.u (0); o.u (1);
	o.str ("seq");    o.u (next_seq ());
	o.str ("origin"); o.str ("shim");
	o.str ("body");
	// Control::Event — { "dir": "event", ... flattened Event fields ... }
	// serde internally tags enums with #[serde(tag = "dir")]; for Event we then
	// flatten #[serde(tag = "type")] on top. So the body map merges dir+event
	// fields at one level.
	write_body (o);
	return buf;
}

} // namespace

// ---------------- high-level encoders ----------------

std::vector<std::uint8_t>
encode_patch_reload ()
{
	return envelope_event ([] (Out& o) {
		o.map (3);
		o.str ("dir");   o.str ("event");
		o.str ("type");  o.str ("session_patch");
		o.str ("patch");
		o.map (1);
		o.str ("op"); o.str ("reload");
	});
}

std::vector<std::uint8_t>
encode_control_update (Session& session, const Controllable& c)
{
	std::string id = schema_map::id_for_controllable (session, c);
	if (id.empty ()) return {};
	double val = c.get_value ();

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");  o.str ("event");
		o.str ("type"); o.str ("control_update");
		o.str ("update");
		o.map (2);
		o.str ("id");    o.str (id);
		o.str ("value"); o.f64 (val);
	});
}

namespace {
// Verbose state dump we scatter through the transport paths so bugs
// like "play lights on at load" can be diagnosed from daw.log.
std::string
transport_state_str (ARDOUR::Session& s)
{
	std::ostringstream o;
	o << "sample=" << s.transport_sample ()
	  << " rolling()=" << s.transport_rolling ()
	  << " state_rolling()=" << s.transport_state_rolling ()
	  << " stopped()=" << s.transport_stopped ()
	  << " stopped_or_stopping()=" << s.transport_stopped_or_stopping ()
	  << " actively_recording()=" << s.actively_recording ()
	  << " get_play_loop()=" << s.get_play_loop ();
	return o.str ();
}
} // namespace

std::vector<std::uint8_t>
encode_transport_state (Session& session)
{
	// A compact `MeterBatch` with just the transport fields. The frontend
	// treats this the same as a metering batch for animation purposes.
	//
	// `transport_rolling()` turned out to read truthy on a freshly
	// loaded session (the FSM's default_speed is 1.0, so speed != 0
	// even when we haven't actually started). `!transport_stopped()`
	// reflects the FSM state machine directly — matches what "the
	// play button should be lit" really means.
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");  o.str ("event");
		o.str ("type"); o.str ("meter_batch");
		o.str ("values");
		// Fields: tempo, playing, recording, position
		o.array (4);

		o.map (2);
		o.str ("id");    o.str ("transport.tempo");
		o.str ("value"); o.f64 (Temporal::TempoMap::fetch ()->metric_at (Temporal::timepos_t (session.transport_sample ())).tempo ().note_types_per_minute ());

		o.map (2);
		o.str ("id");    o.str ("transport.playing");
		// FSM has 5 motion states (Stopped, Rolling, DeclickToStop,
		// DeclickToLocate, WaitingForLocate). Only `Rolling` means we're
		// actually playing — `!stopped()` incorrectly reads `true` while
		// the FSM is in a transient post-load WaitingForLocate state.
		o.str ("value"); o.b (session.transport_state_rolling ());

		o.map (2);
		o.str ("id");    o.str ("transport.recording");
		// `actively_recording()` only returns true mid-record (armed +
		// rolling). For the UI toggle "is the record button lit" we
		// want the arm state, not the rolling-and-capturing state —
		// `get_record_enabled()` = `record_status() >= Enabled`.
		o.str ("value"); o.b (session.get_record_enabled ());

		o.map (2);
		o.str ("id");    o.str ("transport.position");
		o.str ("value"); o.f64 (static_cast<double> (session.transport_sample ()));
	});
}

std::vector<std::uint8_t>
encode_session_snapshot (Session& session,
                         const std::vector<std::shared_ptr<Route>>& routes)
{
	PBD::warning << "foyer_shim: SNAPSHOT: " << transport_state_str (session) << endmsg;
	// M3 baseline: a minimal snapshot shape. Parameter metadata for plugins
	// gets filled in for M5; for now we emit transport + tracks with
	// gain/pan/mute/solo parameters only. The Rust HostBackend doesn't care
	// about fields it doesn't recognize.
	//
	// Stripables enumeration uses the caller-supplied routes directly
	// rather than `session.get_stripables()` (which reads the RCU and
	// is unsafe during Session lifecycle transitions). Stripable
	// metadata we need (name, kind, color) is reachable through the
	// Route's Stripable interface.
	std::vector<schema_map::StripableIds> ids;
	ids.reserve (routes.size ());
	for (auto const& r : routes) {
		if (!r) continue;
		schema_map::StripableIds entry;
		std::ostringstream tmp;
		tmp << r->id ();
		entry.self_id = "track." + tmp.str ();
		entry.name    = r->name ();
		// Route IS a Stripable — kind + color come through it.
		entry.kind    = r->is_master () ? "master"
		              : r->is_monitor () ? "monitor"
		              : (dynamic_cast<const Track*> (r.get ())
		                  ? ((dynamic_cast<const Track*> (r.get ())->data_type () == DataType::MIDI)
		                     ? "midi" : "audio")
		                  : "bus");
		{
			const std::uint32_t c = static_cast<std::uint32_t> (r->presentation_info ().color ());
			if (c != 0) {
				char buf[8];
				std::snprintf (buf, sizeof (buf), "#%02x%02x%02x",
				               (c >> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff);
				entry.color = std::string (buf);
			}
		}
		ids.push_back (std::move (entry));
	}

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");  o.str ("event");
		o.str ("type"); o.str ("session_snapshot");
		o.str ("session");

		// Session { schema_version, transport, tracks, dirty, meta }
		o.map (5);
		o.str ("schema_version"); o.array (2); o.u (0); o.u (1);

		// Transport is a struct; map keys are Rust field names, values are Parameter structs.
		double tempo_bpm = Temporal::TempoMap::fetch ()->metric_at (Temporal::timepos_t (session.transport_sample ())).tempo ().note_types_per_minute ();
		bool playing_b   = session.transport_rolling ();
		bool recording_b = session.get_record_enabled ();
		bool looping_b   = session.get_play_loop ();

		auto emit_param_num = [&] (const char* id, const char* label, const char* kind, double v) {
			o.map (5);
			o.str ("id");    o.str (id);
			o.str ("kind");  o.str (kind);
			o.str ("label"); o.str (label);
			o.str ("scale"); o.str ("linear");
			o.str ("value"); o.f64 (v);
		};
		auto emit_param_bool = [&] (const char* id, const char* label, bool v) {
			o.map (5);
			o.str ("id");    o.str (id);
			o.str ("kind");  o.str ("trigger");
			o.str ("label"); o.str (label);
			o.str ("scale"); o.str ("linear");
			o.str ("value"); o.b (v);
		};

		o.str ("transport");
		o.map (7);
		// NB: `transport_rolling()` reads truthy on a fresh session
		// because the FSM's default speed is non-zero; `!transport_stopped()`
		// also reads truthy while the FSM is transiently in
		// WaitingForLocate after load. `transport_state_rolling()`
		// maps 1:1 onto the FSM's Rolling state — exactly the
		// "play button should be lit" semantic.
		playing_b = session.transport_state_rolling ();
		o.str ("playing");            emit_param_bool ("transport.playing",   "Play",     playing_b);
		o.str ("recording");          emit_param_bool ("transport.recording", "Record",   recording_b);
		o.str ("looping");            emit_param_bool ("transport.looping",   "Loop",     looping_b);
		o.str ("tempo");              emit_param_num  ("transport.tempo",     "Tempo",    "continuous", tempo_bpm);
		o.str ("time_signature_num"); emit_param_num  ("transport.ts.num",    "TS Num",   "discrete",   4.0);
		o.str ("time_signature_den"); emit_param_num  ("transport.ts.den",    "TS Den",   "discrete",   4.0);
		o.str ("position_beats");     emit_param_num  ("transport.position",  "Position", "meter",      static_cast<double> (session.transport_sample ()));

		// Per-track emission — includes loaded plugin instances with their
		// full parameter sets so the generic web plugin panel can render them
		// without a second round trip. Uses caller-supplied routes (no RCU
		// read) for the same reason explained in the function header.
		std::map<std::string, std::shared_ptr<Route>> route_by_id;
		for (auto const& r : routes) {
			if (!r) continue;
			std::ostringstream tmp;
			tmp << r->id ();
			route_by_id["track." + tmp.str ()] = r;
		}

		auto emit_param_full = [&] (const schema_map::ParamDesc& p) {
			// Variable map shape — omit keys we don't have.
			std::size_t n = 5; // id, kind, label, scale, value
			if (!p.unit.empty ()) ++n;
			if (p.has_range) ++n;
			if (!p.enum_labels.empty ()) ++n;
			o.map (n);
			o.str ("id");    o.str (p.id);
			o.str ("kind");  o.str (p.kind);
			o.str ("label"); o.str (p.label);
			o.str ("scale"); o.str (p.scale);
			if (p.has_range) {
				o.str ("range");
				o.array (2);
				o.f64 ((double) p.lower);
				o.f64 ((double) p.upper);
			}
			if (!p.unit.empty ()) { o.str ("unit"); o.str (p.unit); }
			if (!p.enum_labels.empty ()) {
				o.str ("enum_labels");
				o.array (p.enum_labels.size ());
				for (auto const& s : p.enum_labels) o.str (s);
			}
			o.str ("value");
			// Booleans for triggers, ints for enums/discrete, else float.
			if (p.kind == "trigger") {
				o.b (p.value >= 0.5);
			} else if (p.kind == "enum" || p.kind == "discrete") {
				o.i ((std::int64_t) p.value);
			} else {
				o.f64 (p.value);
			}
		};

		o.str ("tracks");
		o.array (ids.size ());
		for (auto const& s : ids) {
			auto it = route_by_id.find (s.self_id);
			std::vector<schema_map::PluginDesc> plugins;
			std::shared_ptr<AutomationControl> rec_ctl;
			std::shared_ptr<ARDOUR::MonitorControl> mon_ctl;
			// Well-known automation-lane sources. Lanes without a
			// real AutomationList get dropped; the UI treats "no
			// list" as "host doesn't expose automation for this
			// control" rather than "empty lane".
			struct LaneSrc {
				std::string                         control_id;
				std::shared_ptr<AutomationControl>  ac;
			};
			std::vector<LaneSrc> lane_srcs;
			if (it != route_by_id.end ()) {
				plugins = schema_map::enumerate_plugins (it->second);
				rec_ctl = it->second->rec_enable_control ();
				mon_ctl = it->second->monitoring_control ();
				auto const& r = it->second;
				lane_srcs.push_back ({ s.self_id + ".gain", r->gain_control () });
				lane_srcs.push_back ({ s.self_id + ".pan",  r->pan_azimuth_control () });
				lane_srcs.push_back ({ s.self_id + ".mute", r->mute_control () });
				lane_srcs.push_back ({ s.self_id + ".solo", r->solo_control () });
			}
			std::size_t lane_count = 0;
			for (auto const& l : lane_srcs) {
				if (l.ac && l.ac->alist ()) ++lane_count;
			}

			// Base track shape is 9 fields (id, name, kind, color,
			// gain, pan, mute, solo, peak_meter). `record_arm` and
			// `plugins` are both skip-when-missing in the schema,
			// so we only bump the map size for the ones actually
			// present.
			std::size_t track_fields = 9;
			if (rec_ctl) ++track_fields;
			if (mon_ctl) ++track_fields;
			if (!plugins.empty ()) ++track_fields;
			if (lane_count > 0) ++track_fields;

			o.map (track_fields);
			o.str ("id");   o.str (s.self_id);
			o.str ("name"); o.str (s.name);
			o.str ("kind"); o.str (s.kind);
			if (!s.color.empty ()) { o.str ("color"); o.str (s.color); } else { o.str ("color"); o.nil (); }
			o.str ("gain"); emit_param_num  ((s.self_id + ".gain").c_str (), "Gain", "continuous", 0.0);
			o.str ("pan");  emit_param_num  ((s.self_id + ".pan").c_str (),  "Pan",  "continuous", 0.0);
			o.str ("mute"); emit_param_bool ((s.self_id + ".mute").c_str (), "Mute", false);
			o.str ("solo"); emit_param_bool ((s.self_id + ".solo").c_str (), "Solo", false);
			// `peak_meter` is an EntityId string — the client
			// subscribes to it via ControlController in track-strip.js
			// and renders the value that arrives in meter_batch events.
			// Without this, `track.peak_meter` is None on the client
			// and no subscription ever happens, so the meter sits at
			// -60 dB forever even if meter_batch events arrive.
			o.str ("peak_meter"); o.str (s.self_id + ".meter");
			if (rec_ctl) {
				o.str ("record_arm");
				emit_param_bool ((s.self_id + ".rec").c_str (), "Rec", rec_ctl->get_value () >= 0.5);
			}
			if (mon_ctl) {
				const int v = static_cast<int> (mon_ctl->get_value ());
				const char* lbl =
					(v == ARDOUR::MonitorInput) ? "input" :
					(v == ARDOUR::MonitorDisk)  ? "disk"  :
					(v == ARDOUR::MonitorCue)   ? "cue"   : "auto";
				o.str ("monitoring");
				o.str (lbl);
			}

			if (!plugins.empty ()) {
				o.str ("plugins");
				o.array (plugins.size ());
				for (auto const& pd : plugins) {
					o.map (5);
					o.str ("id");       o.str (pd.id);
					o.str ("name");     o.str (pd.name);
					o.str ("uri");      o.str (pd.uri);
					o.str ("bypassed"); o.b (pd.bypassed);
					o.str ("params");
					o.array (pd.params.size ());
					for (auto const& p : pd.params) emit_param_full (p);
				}
			}

			// Automation lanes for the well-known track controls. Each
			// lane gets `{ control_id, mode, points }` with points as
			// `{ time_samples, value }` pairs read from the underlying
			// AutomationList under its reader lock.
			if (lane_count > 0) {
				o.str ("automation_lanes");
				o.array (lane_count);
				for (auto const& l : lane_srcs) {
					if (!l.ac) continue;
					auto alist = l.ac->alist ();
					if (!alist) continue;
					std::vector<std::pair<std::uint64_t, double>> pts;
					{
						PBD::RWLock::ReaderLock lm (alist->lock ());
						for (auto const* ev : alist->events ()) {
							if (!ev) continue;
							const auto sp = ev->when.samples ();
							pts.emplace_back (
							    static_cast<std::uint64_t> (std::max<Temporal::samplepos_t> (sp, 0)),
							    ev->value);
						}
					}
					o.map (3);
					o.str ("control_id"); o.str (l.control_id);
					o.str ("mode");       o.str (automation_mode_str (alist->automation_state ()));
					o.str ("points");
					o.array (pts.size ());
					for (auto const& p : pts) {
						o.map (2);
						o.str ("time_samples"); o.u (p.first);
						o.str ("value");        o.f64 (p.second);
					}
				}
			}
		}

		o.str ("dirty"); o.b (session.dirty ());
		o.str ("meta"); o.nil ();
	});
}

// `Event::SessionDirtyChanged { dirty }` — emitted whenever libardour's
// Session::DirtyChanged signal fires. Clients mirror it onto the status
// bar indicator; we don't bother re-sending the whole snapshot.
std::vector<std::uint8_t>
encode_session_dirty_changed (bool dirty)
{
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");   o.str ("event");
		o.str ("type");  o.str ("session_dirty_changed");
		o.str ("dirty"); o.b (dirty);
	});
}

// Per-route peak-meter readout. Emitted as a `meter_batch` event
// containing one `control.update` per route's `.meter` parameter.
// Ardour's `Route::peak_meter()->meter_level(ch, MeterPeak)`
// returns the current dBFS peak (with normal falloff) for the
// given channel; we summarize to a single value per track by
// taking the channel max. Called from the shim's tick thread at
// ~30 Hz. Keeping this in the existing `meter_batch` shape means
// no schema or client-side changes: the store already routes
// `control.update` events keyed by `track.<id>.meter` into the
// `<foyer-meter>` bindings.
// Shared body: walk the provided routes, sample peak meters, build the
// id/dBFS pair list. Both public entry points below feed into this.
static std::vector<std::pair<std::string, double>>
meter_snapshot_from_routes (
    const std::vector<std::shared_ptr<Route>>& routes)
{
	std::vector<std::pair<std::string, double>> snap;
	snap.reserve (routes.size ());
	for (auto const& r : routes) {
		if (!r) continue;
		auto pm = r->peak_meter ();
		if (!pm) continue;
		// Take the maximum across all channels so stereo/mono
		// routes render the same way — one bar per track.
		// `MeterPeak` is Ardour's standard peak-with-falloff
		// reading; `meter_level` returns dBFS directly.
		float peak_db = -120.0f;
		const ChanCount cc = pm->input_streams ();
		const uint32_t n = cc.n_audio ();
		for (uint32_t ch = 0; ch < n; ++ch) {
			const float v = pm->meter_level (ch, ARDOUR::MeterPeak);
			if (v > peak_db) peak_db = v;
		}
		if (n == 0) peak_db = -60.0f; // no audio channels — show floor
		std::ostringstream idss;
		idss << "track." << r->id () << ".meter";
		snap.emplace_back (idss.str (), static_cast<double> (peak_db));
	}
	return snap;
}

static std::vector<std::uint8_t>
encode_meter_snapshot (const std::vector<std::pair<std::string, double>>& snap);

std::vector<std::uint8_t>
encode_track_meters (Session& session)
{
	std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
	std::vector<std::shared_ptr<Route>> copy;
	if (routes) {
		copy.reserve (routes->size ());
		for (auto const& r : *routes) copy.push_back (r);
	}
	auto snap = meter_snapshot_from_routes (copy);
	return encode_meter_snapshot (snap);
}

std::vector<std::uint8_t>
encode_track_meters_from_routes (
    const std::vector<std::shared_ptr<Route>>& routes)
{
	auto snap = meter_snapshot_from_routes (routes);
	return encode_meter_snapshot (snap);
}

static std::vector<std::uint8_t>
encode_meter_snapshot (const std::vector<std::pair<std::string, double>>& snap)
{

	if (snap.empty ()) return {};

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");    o.str ("event");
		o.str ("type");   o.str ("meter_batch");
		o.str ("values");
		o.array (snap.size ());
		for (auto const& [id, db] : snap) {
			o.map (2);
			o.str ("id");    o.str (id);
			o.str ("value"); o.f64 (db);
		}
	});
}

// `Event::AudioEgressStarted { stream_id }` — M6a ack that the shim
// has installed its master tap. The HostBackend's pending_egress
// oneshot resolves on receipt so `open_egress` returns successfully.
std::vector<std::uint8_t>
encode_audio_egress_started (std::uint32_t stream_id)
{
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");       o.str ("event");
		o.str ("type");      o.str ("audio_egress_started");
		o.str ("stream_id"); o.u (stream_id);
	});
}

std::vector<std::uint8_t>
encode_audio_egress_stopped (std::uint32_t stream_id)
{
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");       o.str ("event");
		o.str ("type");      o.str ("audio_egress_stopped");
		o.str ("stream_id"); o.u (stream_id);
	});
}

std::vector<std::uint8_t>
encode_audio_ingress_opened (std::uint32_t stream_id, std::uint32_t sample_rate, std::uint32_t channels)
{
	return envelope_event ([&] (Out& o) {
		o.map (5);
		o.str ("dir");          o.str ("event");
		o.str ("type");         o.str ("audio_ingress_opened");
		o.str ("stream_id");    o.u (stream_id);
		o.str ("source");
		o.map (1);
		o.str ("kind");         o.str ("virtual_input");
		o.str ("format");
		o.map (2);
		o.str ("sample_rate");  o.u (sample_rate);
		o.str ("channels");     o.u (channels);
	});
}

std::vector<std::uint8_t>
encode_audio_ingress_closed (std::uint32_t stream_id)
{
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");       o.str ("event");
		o.str ("type");      o.str ("audio_ingress_closed");
		o.str ("stream_id"); o.u (stream_id);
	});
}

namespace {

// Emit a single `Region` struct map. The size is variable because three of
// its fields use `skip_serializing_if = "Option::is_none"` on the Rust side
// (color, source_path, source_offset_samples). Keep this in lock-step with
// `foyer_schema::Region`.
void
emit_region_map (Out& o, const schema_map::RegionDesc& r)
{
	std::size_t n = 6; // id, track_id, name, start_samples, length_samples, muted
	const bool emit_color       = !r.color.empty ();
	const bool emit_source_path = !r.source_path.empty ();
	const bool emit_source_off  = r.has_source_offset && !r.source_path.empty ();
	const bool emit_notes       = !r.notes.empty ();
	const bool emit_patches     = !r.patch_changes.empty ();
	const bool emit_sequencer   = r.sequencer.present;
	if (emit_color)       ++n;
	if (emit_source_path) ++n;
	if (emit_source_off)  ++n;
	if (emit_notes)       ++n;
	if (emit_patches)     ++n;
	if (emit_sequencer)   ++n;

	o.map (n);
	o.str ("id");             o.str (r.id);
	o.str ("track_id");       o.str (r.track_id);
	o.str ("name");           o.str (r.name);
	o.str ("start_samples");  o.u (r.start_samples);
	o.str ("length_samples"); o.u (r.length_samples);
	if (emit_color)       { o.str ("color"); o.str (r.color); }
	o.str ("muted"); o.b (r.muted);
	if (emit_source_path) { o.str ("source_path"); o.str (r.source_path); }
	if (emit_source_off)  { o.str ("source_offset_samples"); o.u (r.source_offset_samples); }
	if (emit_notes) {
		o.str ("notes");
		o.array (r.notes.size ());
		for (auto const& nd : r.notes) {
			o.map (6);
			o.str ("id");            o.str (nd.id);
			o.str ("pitch");         o.u (nd.pitch);
			o.str ("velocity");      o.u (nd.velocity);
			o.str ("start_ticks");   o.u (nd.start_ticks);
			o.str ("length_ticks");  o.u (nd.length_ticks);
			o.str ("channel");       o.u (nd.channel);
		}
	}
	if (emit_patches) {
		o.str ("patch_changes");
		o.array (r.patch_changes.size ());
		for (auto const& pc : r.patch_changes) {
			// Foyer schema: PatchChange { id, channel, program, bank, start_ticks }.
			o.map (5);
			o.str ("id");          o.str (pc.id);
			o.str ("channel");     o.u (pc.channel);
			o.str ("program");     o.u (pc.program);
			o.str ("bank");        o.i (pc.bank);
			o.str ("start_ticks"); o.u (pc.start_ticks);
		}
	}
	if (r.sequencer.present) {
		o.str ("foyer_sequencer");
		// SequencerLayout v2 { version, mode, resolution,
		// pattern_steps, active, rows, patterns, arrangement,
		// cells (v1 carry-through) }.
		o.map (9);
		o.str ("version");       o.u (r.sequencer.version);
		o.str ("mode");          o.str (r.sequencer.mode);
		o.str ("resolution");    o.u (r.sequencer.resolution);
		o.str ("pattern_steps"); o.u (r.sequencer.pattern_steps);
		o.str ("active");        o.b (r.sequencer.active);
		o.str ("rows");
		o.array (r.sequencer.rows.size ());
		for (auto const& row : r.sequencer.rows) {
			std::size_t mn = 5; // pitch, label, channel, muted, soloed
			const bool emit_color = !row.color.empty ();
			if (emit_color) ++mn;
			o.map (mn);
			o.str ("pitch");   o.u (row.pitch);
			o.str ("label");   o.str (row.label);
			o.str ("channel"); o.u (row.channel);
			if (emit_color) { o.str ("color"); o.str (row.color); }
			o.str ("muted");   o.b (row.muted);
			o.str ("soloed");  o.b (row.soloed);
		}
		o.str ("patterns");
		o.array (r.sequencer.patterns.size ());
		for (auto const& p : r.sequencer.patterns) {
			std::size_t pn = 3; // id, name, cells
			const bool emit_color = !p.color.empty ();
			if (emit_color) ++pn;
			o.map (pn);
			o.str ("id");   o.str (p.id);
			o.str ("name"); o.str (p.name);
			if (emit_color) { o.str ("color"); o.str (p.color); }
			o.str ("cells");
			o.array (p.cells.size ());
			for (auto const& c : p.cells) {
				const bool emit_len = c.length_steps > 1;
				o.map (emit_len ? 4 : 3);
				o.str ("row");      o.u (c.row);
				o.str ("step");     o.u (c.step);
				o.str ("velocity"); o.u (c.velocity);
				if (emit_len) {
					o.str ("length_steps"); o.u (c.length_steps);
				}
			}
		}
		o.str ("arrangement");
		o.array (r.sequencer.arrangement.size ());
		for (auto const& s : r.sequencer.arrangement) {
			o.map (3);
			o.str ("pattern_id");      o.str (s.pattern_id);
			o.str ("bar");             o.u (s.bar);
			o.str ("arrangement_row"); o.u (s.arrangement_row);
		}
		// v1 cells carry-through for sessions saved by the old shim.
		o.str ("cells");
		o.array (r.sequencer.cells.size ());
		for (auto const& c : r.sequencer.cells) {
			o.map (3);
			o.str ("row");      o.u (c.row);
			o.str ("step");     o.u (c.step);
			o.str ("velocity"); o.u (c.velocity);
		}
	}
}

} // namespace

std::vector<std::uint8_t>
encode_regions_list (Session& session, const std::string& track_id)
{
	auto regions = schema_map::enumerate_regions (session, track_id);
	const std::uint32_t sample_rate = static_cast<std::uint32_t> (session.sample_rate ());
	const std::uint64_t length_samples =
	    static_cast<std::uint64_t> (std::max<samplepos_t> (session.current_end_sample (), 0));

	return envelope_event ([&] (Out& o) {
		o.map (5);
		o.str ("dir");      o.str ("event");
		o.str ("type");     o.str ("regions_list");
		o.str ("track_id"); o.str (track_id);

		o.str ("timeline");
		o.map (2);
		o.str ("sample_rate");    o.u (sample_rate);
		o.str ("length_samples"); o.u (length_samples);

		o.str ("regions");
		o.array (regions.size ());
		for (auto const& r : regions) emit_region_map (o, r);
	});
}

std::vector<std::uint8_t>
encode_region_updated (Session& session, const std::string& region_id)
{
	auto hit = schema_map::find_region (session, region_id);
	if (!hit.region) return {};

	// Reuse the same extraction path as the initial snapshot so MIDI
	// notes (and any other per-region derived data) ride along on every
	// update. Prior to this, encode_region_updated manually constructed
	// a RegionDesc and silently dropped `notes`, which made the web
	// piano-roll context menu vanish after the first update.
	schema_map::RegionDesc d = schema_map::describe_region_desc (*hit.region, hit.track_id);
	// `find_region` returns the canonical "region.<pbd-id>" form; keep
	// what the caller passed in, which already matches.
	d.id = region_id;

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");    o.str ("event");
		o.str ("type");   o.str ("region_updated");
		o.str ("region");
		emit_region_map (o, d);
	});
}

std::vector<std::uint8_t>
encode_plugins_list ()
{
	auto entries = schema_map::list_plugin_catalog ();
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");      o.str ("event");
		o.str ("type");     o.str ("plugins_list");
		o.str ("entries");
		o.array (entries.size ());
		for (auto const& e : entries) {
			// Foyer schema: PluginCatalogEntry { id, name, format,
			// role, vendor?, uri, tags? }. Keep field count
			// matching the actual emitted keys to stay valid msgpack.
			std::size_t n = 5;  // id, name, format, role, uri
			const bool emit_vendor = !e.vendor.empty ();
			const bool emit_tags   = !e.tags.empty ();
			if (emit_vendor) ++n;
			if (emit_tags)   ++n;
			o.map (n);
			o.str ("id");     o.str (e.id);
			o.str ("name");   o.str (e.name);
			o.str ("format"); o.str (e.format);
			o.str ("role");   o.str (e.role);
			o.str ("uri");    o.str (e.uri);
			if (emit_vendor) { o.str ("vendor"); o.str (e.vendor); }
			if (emit_tags) {
				o.str ("tags");
				o.array (e.tags.size ());
				for (auto const& t : e.tags) o.str (t);
			}
		}
	});
}

std::vector<std::uint8_t>
encode_plugin_presets_listed (Session& session, const std::string& plugin_id)
{
	auto presets = schema_map::list_plugin_presets (session, plugin_id);
	return envelope_event ([&] (Out& o) {
		o.map (4);
		o.str ("dir");       o.str ("event");
		o.str ("type");      o.str ("plugin_presets_listed");
		o.str ("plugin_id"); o.str (plugin_id);
		o.str ("presets");
		o.array (presets.size ());
		for (auto const& p : presets) {
			// Foyer schema: PluginPreset { id, name, bank, is_factory }.
			std::size_t n = 2; // id, name
			const bool emit_bank = !p.bank.empty ();
			if (emit_bank) ++n;
			// is_factory is a bool so always emit
			++n;
			o.map (n);
			o.str ("id");   o.str (p.id);
			o.str ("name"); o.str (p.name);
			if (emit_bank) { o.str ("bank"); o.str (p.bank); }
			o.str ("is_factory"); o.b (p.is_factory);
		}
	});
}

std::vector<std::uint8_t>
encode_region_removed (const std::string& track_id, const std::string& region_id)
{
	return envelope_event ([&] (Out& o) {
		o.map (4);
		o.str ("dir");       o.str ("event");
		o.str ("type");      o.str ("region_removed");
		o.str ("track_id");  o.str (track_id);
		o.str ("region_id"); o.str (region_id);
	});
}

namespace {

// Compact param-map emitter shared by TrackUpdated. Keeps the wire-shape
// identical to what `encode_session_snapshot` emits for the same field.
void
emit_named_param (Out& o, const std::string& id, const char* label,
                  const char* kind, bool is_bool, double num_val, bool bool_val)
{
	o.map (5);
	o.str ("id");    o.str (id);
	o.str ("kind");  o.str (kind);
	o.str ("label"); o.str (label);
	o.str ("scale"); o.str ("linear");
	o.str ("value");
	if (is_bool) o.b (bool_val); else o.f64 (num_val);
}

} // namespace

std::vector<std::uint8_t>
encode_track_updated (Session& session, const std::string& track_id)
{
	// Find the route by foyer id ("track.<stripable-id>").
	if (track_id.rfind ("track.", 0) != 0) return {};
	const std::string sid = track_id.substr (6);
	std::shared_ptr<Route> route;
	std::shared_ptr<Stripable> stripable;
	{
		std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
		for (auto const& r : *routes) {
			if (!r) continue;
			std::ostringstream tmp;
			tmp << r->id ();
			if (tmp.str () != sid) continue;
			route     = r;
			stripable = r;
			break;
		}
	}
	if (!route) return {};

	// Re-describe the stripable the same way the snapshot does.
	auto ids = schema_map::enumerate_stripables (session);
	schema_map::StripableIds matched;
	bool found_ids = false;
	for (auto const& s : ids) {
		if (s.self_id == track_id) { matched = s; found_ids = true; break; }
	}
	if (!found_ids) return {};

	auto plugins = schema_map::enumerate_plugins (route);
	auto rec_ctl = route->rec_enable_control ();
	auto mon_ctl = route->monitoring_control ();

	struct LaneSrc {
		std::string                        control_id;
		std::shared_ptr<AutomationControl> ac;
	};
	std::vector<LaneSrc> lane_srcs;
	lane_srcs.push_back ({ matched.self_id + ".gain", route->gain_control () });
	lane_srcs.push_back ({ matched.self_id + ".pan",  route->pan_azimuth_control () });
	lane_srcs.push_back ({ matched.self_id + ".mute", route->mute_control () });
	lane_srcs.push_back ({ matched.self_id + ".solo", route->solo_control () });
	std::size_t lane_count = 0;
	for (auto const& l : lane_srcs) {
		if (l.ac && l.ac->alist ()) ++lane_count;
	}

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");   o.str ("event");
		o.str ("type");  o.str ("track_updated");
		o.str ("track");

		std::size_t track_fields = 9; // +1 for peak_meter
		if (rec_ctl) ++track_fields;
		if (mon_ctl) ++track_fields;
		if (!plugins.empty ()) ++track_fields;
		if (lane_count > 0) ++track_fields;

		o.map (track_fields);
		o.str ("id");   o.str (matched.self_id);
		o.str ("name"); o.str (matched.name);
		o.str ("kind"); o.str (matched.kind);
		if (!matched.color.empty ()) { o.str ("color"); o.str (matched.color); }
		else                         { o.str ("color"); o.nil (); }
		// Values echo the snapshot shape; the client overwrites them from
		// ControlUpdate events, so exact numerical accuracy isn't required.
		o.str ("gain"); emit_named_param (o, matched.self_id + ".gain", "Gain", "continuous", false, route->gain_control () ? route->gain_control ()->get_value () : 0.0, false);
		o.str ("pan");  emit_named_param (o, matched.self_id + ".pan",  "Pan",  "continuous", false, route->pan_azimuth_control () ? route->pan_azimuth_control ()->get_value () : 0.0, false);
		o.str ("mute"); emit_named_param (o, matched.self_id + ".mute", "Mute", "trigger", true, 0.0, route->mute_control () && route->mute_control ()->get_value () >= 0.5);
		o.str ("solo"); emit_named_param (o, matched.self_id + ".solo", "Solo", "trigger", true, 0.0, route->solo_control () && route->solo_control ()->get_value () >= 0.5);
		// Must match the snapshot's peak_meter id so the client's
		// ControlController keeps listening after a TrackUpdated.
		o.str ("peak_meter"); o.str (matched.self_id + ".meter");
		if (rec_ctl) {
			o.str ("record_arm");
			emit_named_param (o, matched.self_id + ".rec", "Rec", "trigger", true, 0.0, rec_ctl->get_value () >= 0.5);
		}
		if (mon_ctl) {
			const int v = static_cast<int> (mon_ctl->get_value ());
			const char* lbl =
				(v == ARDOUR::MonitorInput) ? "input" :
				(v == ARDOUR::MonitorDisk)  ? "disk"  :
				(v == ARDOUR::MonitorCue)   ? "cue"   : "auto";
			o.str ("monitoring");
			o.str (lbl);
		}

		if (!plugins.empty ()) {
			o.str ("plugins");
			o.array (plugins.size ());
			for (auto const& pd : plugins) {
				o.map (5);
				o.str ("id");       o.str (pd.id);
				o.str ("name");     o.str (pd.name);
				o.str ("uri");      o.str (pd.uri);
				o.str ("bypassed"); o.b (pd.bypassed);
				o.str ("params");
				o.array (pd.params.size ());
				for (auto const& p : pd.params) {
					o.map (5);
					o.str ("id");    o.str (p.id);
					o.str ("kind");  o.str (p.kind);
					o.str ("label"); o.str (p.label);
					o.str ("scale"); o.str (p.scale);
					o.str ("value"); o.f64 (p.value);
				}
			}
		}

		if (lane_count > 0) {
			o.str ("automation_lanes");
			o.array (lane_count);
			for (auto const& l : lane_srcs) {
				if (!l.ac) continue;
				auto alist = l.ac->alist ();
				if (!alist) continue;
				std::vector<std::pair<std::uint64_t, double>> pts;
				{
					PBD::RWLock::ReaderLock lm (alist->lock ());
					for (auto const* ev : alist->events ()) {
						if (!ev) continue;
						const auto sp = ev->when.samples ();
						pts.emplace_back (
						    static_cast<std::uint64_t> (std::max<Temporal::samplepos_t> (sp, 0)),
						    ev->value);
					}
				}
				o.map (3);
				o.str ("control_id"); o.str (l.control_id);
				o.str ("mode");       o.str (automation_mode_str (alist->automation_state ()));
				o.str ("points");
				o.array (pts.size ());
				for (auto const& p : pts) {
					o.map (2);
					o.str ("time_samples"); o.u (p.first);
					o.str ("value");        o.f64 (p.second);
				}
			}
		}
	});
}

} // namespace ArdourSurface::msgpack_out
