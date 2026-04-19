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

#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/stripable.h"
#include "ardour/track.h"
#include "pbd/controllable.h"
#include "temporal/tempo.h"
#include "temporal/timeline.h"

#include "schema_map.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface::msgpack_out {

namespace {

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

std::vector<std::uint8_t>
encode_transport_state (Session& session)
{
	// A compact `MeterBatch` with just the transport fields. The frontend
	// treats this the same as a metering batch for animation purposes.
	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");  o.str ("event");
		o.str ("type"); o.str ("meter_batch");
		o.str ("values");
		// Fields: tempo, playing, recording
		o.array (3);

		o.map (2);
		o.str ("id");    o.str ("transport.tempo");
		o.str ("value"); o.f64 (Temporal::TempoMap::fetch ()->metric_at (Temporal::timepos_t (session.transport_sample ())).tempo ().note_types_per_minute ());

		o.map (2);
		o.str ("id");    o.str ("transport.playing");
		o.str ("value"); o.b (session.transport_rolling ());

		o.map (2);
		o.str ("id");    o.str ("transport.recording");
		o.str ("value"); o.b (session.actively_recording ());
	});
}

std::vector<std::uint8_t>
encode_session_snapshot (Session& session)
{
	// M3 baseline: a minimal snapshot shape. Parameter metadata for plugins
	// gets filled in for M5; for now we emit transport + tracks with
	// gain/pan/mute/solo parameters only. The Rust HostBackend doesn't care
	// about fields it doesn't recognize.
	auto ids = schema_map::enumerate_stripables (session);

	return envelope_event ([&] (Out& o) {
		o.map (3);
		o.str ("dir");  o.str ("event");
		o.str ("type"); o.str ("session_snapshot");
		o.str ("session");

		// Session { schema_version, transport, tracks, meta }
		o.map (4);
		o.str ("schema_version"); o.array (2); o.u (0); o.u (1);

		// Transport is a struct; map keys are Rust field names, values are Parameter structs.
		double tempo_bpm = Temporal::TempoMap::fetch ()->metric_at (Temporal::timepos_t (session.transport_sample ())).tempo ().note_types_per_minute ();
		bool playing_b   = session.transport_rolling ();
		bool recording_b = session.actively_recording ();
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
		o.str ("playing");            emit_param_bool ("transport.playing",   "Play",     playing_b);
		o.str ("recording");          emit_param_bool ("transport.recording", "Record",   recording_b);
		o.str ("looping");            emit_param_bool ("transport.looping",   "Loop",     looping_b);
		o.str ("tempo");              emit_param_num  ("transport.tempo",     "Tempo",    "continuous", tempo_bpm);
		o.str ("time_signature_num"); emit_param_num  ("transport.ts.num",    "TS Num",   "discrete",   4.0);
		o.str ("time_signature_den"); emit_param_num  ("transport.ts.den",    "TS Den",   "discrete",   4.0);
		o.str ("position_beats");     emit_param_num  ("transport.position",  "Position", "meter",      static_cast<double> (session.transport_sample ()));

		// Per-track emission — includes loaded plugin instances with their
		// full parameter sets so the generic web plugin panel can render them
		// without a second round trip.
		std::shared_ptr<RouteList const> routes = session.get_routes ();
		// Map stripable-id → route for O(n) lookup while iterating ids.
		std::map<std::string, std::shared_ptr<Route>> route_by_id;
		for (auto const& r : *routes) {
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
			if (it != route_by_id.end ()) {
				plugins = schema_map::enumerate_plugins (it->second);
			}

			const std::size_t track_fields = plugins.empty () ? 8 : 9;
			o.map (track_fields);
			o.str ("id");   o.str (s.self_id);
			o.str ("name"); o.str (s.name);
			o.str ("kind"); o.str (s.kind);
			if (!s.color.empty ()) { o.str ("color"); o.str (s.color); } else { o.str ("color"); o.nil (); }
			o.str ("gain"); emit_param_num  ((s.self_id + ".gain").c_str (), "Gain", "continuous", 0.0);
			o.str ("pan");  emit_param_num  ((s.self_id + ".pan").c_str (),  "Pan",  "continuous", 0.0);
			o.str ("mute"); emit_param_bool ((s.self_id + ".mute").c_str (), "Mute", false);
			o.str ("solo"); emit_param_bool ((s.self_id + ".solo").c_str (), "Solo", false);

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
		}

		o.str ("meta"); o.nil ();
	});
}

} // namespace ArdourSurface::msgpack_out
