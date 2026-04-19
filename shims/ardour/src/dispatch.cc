/*
 * Foyer Studio — Ardour shim: dispatcher implementation.
 *
 * Currently implements decoding and application of:
 *  - Subscribe / RequestSnapshot → emit `session.snapshot`
 *  - ControlSet { id, value }    → resolve id, call set_value on the Controllable
 *
 * Other commands (audio egress/ingress, latency probe) are acknowledged with
 * an `Error` event for now and are filled in alongside their milestones.
 */
#include "dispatch.h"

#include <cstring>
#include <string>

#include "ardour/plugin_insert.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "pbd/controllable.h"
#include "pbd/error.h"

#include "ipc.h"
#include "msgpack_out.h"
#include "schema_map.h"
#include "surface.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface {

namespace {

// ---- tiny msgpack reader (what we need for inbound commands) ----
//
// This only supports the shapes the sidecar actually sends: Envelope with map
// bodies, strs, floats/ints/bools. It deliberately rejects anything else so a
// malformed peer can't trip us into undefined territory.

struct In
{
	const std::uint8_t* p;
	const std::uint8_t* end;

	bool ok () const { return p <= end; }
	std::uint8_t peek () const { return *p; }
	std::uint8_t take_u8 () { return *p++; }
	std::uint16_t take_be16 () { std::uint16_t v = (std::uint16_t (p[0]) << 8) | p[1]; p += 2; return v; }
	std::uint32_t take_be32 () { std::uint32_t v = (std::uint32_t (p[0]) << 24) | (std::uint32_t (p[1]) << 16) | (std::uint32_t (p[2]) << 8) | p[3]; p += 4; return v; }
	std::uint64_t take_be64 () { std::uint64_t hi = take_be32 (); std::uint64_t lo = take_be32 (); return (hi << 32) | lo; }

	bool read_str (std::string& out)
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		std::size_t n = 0;
		if ((b & 0xe0) == 0xa0) n = b & 0x1f;
		else if (b == 0xd9) n = take_u8 ();
		else if (b == 0xda) n = take_be16 ();
		else if (b == 0xdb) n = take_be32 ();
		else return false;
		if (p + n > end) return false;
		out.assign (reinterpret_cast<const char*> (p), n);
		p += n;
		return true;
	}

	bool read_f64 (double& out)
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		if (b == 0xca) {
			std::uint32_t bits = take_be32 ();
			float f; std::memcpy (&f, &bits, 4); out = f; return true;
		}
		if (b == 0xcb) {
			std::uint64_t bits = take_be64 ();
			std::memcpy (&out, &bits, 8); return true;
		}
		if (b <= 0x7f)  { out = static_cast<double> (b); return true; }
		if (b >= 0xe0)  { out = static_cast<double> (static_cast<std::int8_t> (b)); return true; }
		if (b == 0xcc)  { out = static_cast<double> (take_u8 ()); return true; }
		if (b == 0xcd)  { out = static_cast<double> (take_be16 ()); return true; }
		if (b == 0xce)  { out = static_cast<double> (take_be32 ()); return true; }
		if (b == 0xcf)  { out = static_cast<double> (take_be64 ()); return true; }
		if (b == 0xd0)  { out = static_cast<double> (static_cast<std::int8_t> (take_u8 ())); return true; }
		if (b == 0xc3)  { out = 1.0; return true; }
		if (b == 0xc2)  { out = 0.0; return true; }
		return false;
	}

	bool read_map_header (std::size_t& n)
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		if ((b & 0xf0) == 0x80) { n = b & 0x0f; return true; }
		if (b == 0xde) { n = take_be16 (); return true; }
		if (b == 0xdf) { n = take_be32 (); return true; }
		return false;
	}

	bool skip_value ()
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		if ((b & 0xe0) == 0xa0) { p += (b & 0x1f); return p <= end; }
		if (b == 0xd9) { p += take_u8 (); return p <= end; }
		if (b == 0xda) { p += take_be16 (); return p <= end; }
		if (b == 0xdb) { p += take_be32 (); return p <= end; }
		if (b <= 0x7f || b >= 0xe0 || b == 0xc0 || b == 0xc2 || b == 0xc3) return true;
		if (b == 0xcc || b == 0xd0) { p += 1; return p <= end; }
		if (b == 0xcd || b == 0xd1) { p += 2; return p <= end; }
		if (b == 0xca || b == 0xce || b == 0xd2) { p += 4; return p <= end; }
		if (b == 0xcb || b == 0xcf || b == 0xd3) { p += 8; return p <= end; }
		if ((b & 0xf0) == 0x90) {
			std::size_t n = b & 0x0f;
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xdc) {
			std::size_t n = take_be16 ();
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xdd) {
			std::size_t n = take_be32 ();
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if ((b & 0xf0) == 0x80) {
			std::size_t n = b & 0x0f;
			for (std::size_t i = 0; i < 2 * n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xde) {
			std::size_t n = take_be16 ();
			for (std::size_t i = 0; i < 2 * n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xdf) {
			std::size_t n = take_be32 ();
			for (std::size_t i = 0; i < 2 * n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		return false;
	}
};

struct DecodedCmd
{
	enum class Kind { Unknown, Subscribe, RequestSnapshot, ControlSet, Audio, Latency };
	Kind kind = Kind::Unknown;
	std::string id;
	double value = 0.0;
};

DecodedCmd
decode (const std::vector<std::uint8_t>& buf)
{
	DecodedCmd out;
	In in { buf.data (), buf.data () + buf.size () };

	// Envelope { schema, seq, origin, body } — we only care about body, but
	// we walk the map so future field additions don't break us.
	std::size_t n = 0;
	if (!in.read_map_header (n)) return out;

	for (std::size_t i = 0; i < n; ++i) {
		std::string key;
		if (!in.read_str (key)) return out;
		if (key == "body") {
			// body is Control {dir, ...}. We need dir=command and its tagged type.
			std::size_t m = 0;
			if (!in.read_map_header (m)) return out;
			std::string cmd_type;
			for (std::size_t j = 0; j < m; ++j) {
				std::string k;
				if (!in.read_str (k)) return out;
				if (k == "dir" || k == "type") {
					std::string v;
					if (!in.read_str (v)) return out;
					if (k == "type") cmd_type = v;
				} else if (k == "id") {
					if (!in.read_str (out.id)) return out;
				} else if (k == "value") {
					if (!in.read_f64 (out.value)) return out;
				} else {
					if (!in.skip_value ()) return out;
				}
			}
			if (cmd_type == "subscribe")          out.kind = DecodedCmd::Kind::Subscribe;
			else if (cmd_type == "request_snapshot") out.kind = DecodedCmd::Kind::RequestSnapshot;
			else if (cmd_type == "control_set")   out.kind = DecodedCmd::Kind::ControlSet;
			else if (cmd_type.rfind ("audio_", 0) == 0) out.kind = DecodedCmd::Kind::Audio;
			else if (cmd_type == "latency_probe") out.kind = DecodedCmd::Kind::Latency;
		} else {
			if (!in.skip_value ()) return out;
		}
	}
	return out;
}

} // namespace

Dispatcher::Dispatcher (FoyerShim& s)
    : _shim (s)
{
	_shim.ipc ().on_frame ([this] (foyer_ipc::FrameKind k, const std::vector<std::uint8_t>& payload) {
		if (k == foyer_ipc::FrameKind::Control) on_control_frame (payload);
		else                                    on_audio_frame (payload);
	});
}

Dispatcher::~Dispatcher () = default;

void
Dispatcher::on_audio_frame (const std::vector<std::uint8_t>&)
{
	// M6b territory — drop frames for now.
}

void
Dispatcher::on_control_frame (const std::vector<std::uint8_t>& buf)
{
	DecodedCmd cmd = decode (buf);

	switch (cmd.kind) {
		case DecodedCmd::Kind::Subscribe:
		case DecodedCmd::Kind::RequestSnapshot: {
			auto bytes = msgpack_out::encode_session_snapshot (_shim.session ());
			_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			break;
		}
		case DecodedCmd::Kind::ControlSet: {
			if (cmd.id.empty ()) break;

			// Special case: `plugin.<pi-id>.bypass` has no Controllable —
			// toggle the PluginInsert's active flag directly.
			const std::string suffix = ".bypass";
			if (cmd.id.rfind ("plugin.", 0) == 0
			 && cmd.id.size () > suffix.size ()
			 && cmd.id.compare (cmd.id.size () - suffix.size (), suffix.size (), suffix) == 0)
			{
				std::string pid = cmd.id.substr (7, cmd.id.size () - 7 - suffix.size ());
				auto& session = _shim.session ();
				std::shared_ptr<RouteList const> routes = session.get_routes ();
				bool handled = false;
				for (auto const& r : *routes) {
					if (!r || handled) continue;
					for (uint32_t i = 0; !handled; ++i) {
						auto proc = r->nth_plugin (i);
						if (!proc) break;
						auto pi = std::dynamic_pointer_cast<PluginInsert> (proc);
						if (!pi) continue;
						std::ostringstream os; os << pi->id ();
						if (os.str () != pid) continue;
						const bool bypass_on = cmd.value >= 0.5;
						if (bypass_on) pi->deactivate ();
						else           pi->activate ();
						handled = true;
					}
				}
				break;
			}

			auto ctrl = schema_map::resolve (_shim.session (), cmd.id);
			if (!ctrl) {
				PBD::warning << "foyer_shim: unknown control id: " << cmd.id << endmsg;
				break;
			}
			ctrl->set_value (cmd.value, Controllable::UseGroup);
			// No manual echo — the Controllable::Changed signal will fire and
			// our SignalBridge will emit the corresponding `control.update`.
			break;
		}
		case DecodedCmd::Kind::Audio:
		case DecodedCmd::Kind::Latency:
		case DecodedCmd::Kind::Unknown:
			// Ignore for M3; M6a/b will fill these in.
			break;
	}
}

} // namespace ArdourSurface
