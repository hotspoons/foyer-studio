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

#include "ardour/playlist.h"
#include "ardour/plugin_insert.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "ardour/track.h"
#include "pbd/controllable.h"
#include "pbd/error.h"
#include "temporal/timeline.h"

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

	bool read_u64 (std::uint64_t& out)
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		if (b <= 0x7f)  { out = b; return true; }
		if (b == 0xcc)  { out = take_u8 ();  return true; }
		if (b == 0xcd)  { out = take_be16 (); return true; }
		if (b == 0xce)  { out = take_be32 (); return true; }
		if (b == 0xcf)  { out = take_be64 (); return true; }
		// Positive-but-signed forms also show up on the wire when serde picks
		// the smallest representation; accept them.
		if (b == 0xd0)  { std::int8_t v  = static_cast<std::int8_t>  (take_u8 ());  if (v < 0) return false; out = v; return true; }
		if (b == 0xd1)  { std::int16_t v = static_cast<std::int16_t> (take_be16 ()); if (v < 0) return false; out = v; return true; }
		if (b == 0xd2)  { std::int32_t v = static_cast<std::int32_t> (take_be32 ()); if (v < 0) return false; out = v; return true; }
		if (b == 0xd3)  { std::int64_t v = static_cast<std::int64_t> (take_be64 ()); if (v < 0) return false; out = static_cast<std::uint64_t> (v); return true; }
		return false;
	}

	bool read_bool (bool& out)
	{
		if (p >= end) return false;
		std::uint8_t b = take_u8 ();
		if (b == 0xc2) { out = false; return true; }
		if (b == 0xc3) { out = true;  return true; }
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
	enum class Kind {
		Unknown,
		Subscribe,
		RequestSnapshot,
		ControlSet,
		Audio,
		Latency,
		ListRegions,
		UpdateRegion,
		DeleteRegion,
		UpdateTrack,
	};
	Kind kind = Kind::Unknown;
	std::string id;
	std::string track_id;
	double value = 0.0;

	// RegionPatch fields — only read for UpdateRegion. All optional.
	bool          has_patch_start   = false;
	std::uint64_t patch_start       = 0;
	bool          has_patch_length  = false;
	std::uint64_t patch_length      = 0;
	bool          has_patch_name    = false;
	std::string   patch_name;
	bool          has_patch_muted   = false;
	bool          patch_muted       = false;

	// TrackPatch fields — only read for UpdateTrack. All optional; `name`
	// is shared with RegionPatch (both store via has_patch_name / patch_name).
	bool          has_patch_color      = false;
	std::string   patch_color;            // "#rrggbb" or "" to clear
	bool          has_patch_group_id   = false;
	std::string   patch_group_id;
	bool          has_patch_bus_assign = false;
	std::string   patch_bus_assign;
};

// Parse either a RegionPatch or TrackPatch sub-map. Keys the current
// command doesn't care about stay `has_patch_*` = false on the output;
// the dispatcher only reads the fields that match its command kind.
static bool
read_region_patch (In& in, DecodedCmd& out)
{
	std::size_t pm = 0;
	if (!in.read_map_header (pm)) return false;
	for (std::size_t k = 0; k < pm; ++k) {
		std::string pk;
		if (!in.read_str (pk)) return false;
		if (pk == "start_samples") {
			if (!in.read_u64 (out.patch_start)) return false;
			out.has_patch_start = true;
		} else if (pk == "length_samples") {
			if (!in.read_u64 (out.patch_length)) return false;
			out.has_patch_length = true;
		} else if (pk == "name") {
			if (!in.read_str (out.patch_name)) return false;
			out.has_patch_name = true;
		} else if (pk == "muted") {
			if (!in.read_bool (out.patch_muted)) return false;
			out.has_patch_muted = true;
		} else if (pk == "color") {
			if (!in.read_str (out.patch_color)) return false;
			out.has_patch_color = true;
		} else if (pk == "group_id") {
			if (!in.read_str (out.patch_group_id)) return false;
			out.has_patch_group_id = true;
		} else if (pk == "bus_assign") {
			if (!in.read_str (out.patch_bus_assign)) return false;
			out.has_patch_bus_assign = true;
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	return true;
}

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
				} else if (k == "track_id") {
					if (!in.read_str (out.track_id)) return out;
				} else if (k == "value") {
					if (!in.read_f64 (out.value)) return out;
				} else if (k == "patch") {
					if (!read_region_patch (in, out)) return out;
				} else {
					if (!in.skip_value ()) return out;
				}
			}
			if (cmd_type == "subscribe")               out.kind = DecodedCmd::Kind::Subscribe;
			else if (cmd_type == "request_snapshot")   out.kind = DecodedCmd::Kind::RequestSnapshot;
			else if (cmd_type == "control_set")        out.kind = DecodedCmd::Kind::ControlSet;
			else if (cmd_type == "list_regions")       out.kind = DecodedCmd::Kind::ListRegions;
			else if (cmd_type == "update_region")      out.kind = DecodedCmd::Kind::UpdateRegion;
			else if (cmd_type == "delete_region")      out.kind = DecodedCmd::Kind::DeleteRegion;
			else if (cmd_type == "update_track")       out.kind = DecodedCmd::Kind::UpdateTrack;
			else if (cmd_type.rfind ("audio_", 0) == 0) out.kind = DecodedCmd::Kind::Audio;
			else if (cmd_type == "latency_probe")      out.kind = DecodedCmd::Kind::Latency;
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

			// Special case: `transport.*` IDs don't correspond to any
			// AutomationControl — they're backed by `Session::request_*`
			// methods. These allocate SessionEvents from a per-thread
			// pool, so they must run on the shim's event-loop thread
			// (where `thread_init` registered us).
			if (cmd.id.rfind ("transport.", 0) == 0) {
				PBD::warning << "foyer_shim: ControlSet recv id=" << cmd.id << " value=" << cmd.value << endmsg;
				DecodedCmd snap = cmd;
				FoyerShim* shim = &_shim;
				_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
					auto& session = shim->session ();
					PBD::warning << "foyer_shim: transport slot BEGIN id=" << snap.id
					             << " value=" << snap.value << " "
					             << "state{sample=" << session.transport_sample ()
					             << " rolling=" << session.transport_rolling ()
					             << " state_rolling=" << session.transport_state_rolling ()
					             << " stopped=" << session.transport_stopped ()
					             << " stopped_or_stopping=" << session.transport_stopped_or_stopping ()
					             << "}" << endmsg;
					const bool on = snap.value >= 0.5;
					if (snap.id == "transport.playing") {
						if (on) {
							PBD::warning << "foyer_shim: calling transport_play(false)" << endmsg;
							shim->transport_play (false);
						} else {
							PBD::warning << "foyer_shim: calling transport_stop()" << endmsg;
							shim->transport_stop ();
						}
					} else if (snap.id == "transport.recording") {
						const bool recording = session.actively_recording ();
						if (on != recording) {
							PBD::warning << "foyer_shim: calling rec_enable_toggle() (current=" << recording << ")" << endmsg;
							shim->rec_enable_toggle ();
						}
					} else if (snap.id == "transport.looping") {
						const bool looping = session.get_play_loop ();
						if (on != looping) {
							PBD::warning << "foyer_shim: calling loop_toggle() (current=" << looping << ")" << endmsg;
							shim->loop_toggle ();
						}
					} else if (snap.id == "transport.position") {
						PBD::warning << "foyer_shim: calling request_locate(" << snap.value << ")" << endmsg;
						session.request_locate (static_cast<Temporal::samplepos_t> (snap.value));
					} else if (snap.id == "transport.tempo") {
						PBD::warning << "foyer_shim: transport.tempo set_control deferred (use TempoMap API)" << endmsg;
					} else {
						PBD::warning << "foyer_shim: transport id not handled: " << snap.id << endmsg;
					}
					PBD::warning << "foyer_shim: transport slot END id=" << snap.id
					             << " post_state{sample=" << session.transport_sample ()
					             << " rolling=" << session.transport_rolling ()
					             << " state_rolling=" << session.transport_state_rolling ()
					             << " stopped=" << session.transport_stopped ()
					             << "}" << endmsg;
				});
				break;
			}

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
		case DecodedCmd::Kind::ListRegions: {
			if (cmd.track_id.empty ()) break;
			// Synchronous on the IPC reader thread. `Playlist::region_list`
			// is a read that locks internally; the previous working session
			// confirmed this path is safe from unregistered threads.
			// (Mutations — UpdateRegion / UpdateTrack / DeleteRegion —
			// still hop to the event loop where PBD's per-thread pool is
			// properly registered.)
			auto bytes = msgpack_out::encode_regions_list (_shim.session (), cmd.track_id);
			_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			break;
		}
		case DecodedCmd::Kind::UpdateRegion: {
			if (cmd.id.empty ()) break;
			// Post to the shim event loop — libardour region mutations
			// touch SequenceProperty / per-thread allocation pools that
			// are only valid on registered threads.
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: update_region: unknown region id: " << snap.id << endmsg;
					return;
				}
				if (snap.has_patch_start) {
					hit.region->set_position (Temporal::timepos_t (static_cast<Temporal::samplepos_t> (snap.patch_start)));
				}
				if (snap.has_patch_length) {
					hit.region->set_length (Temporal::timecnt_t::from_samples (static_cast<Temporal::samplepos_t> (snap.patch_length)));
				}
				if (snap.has_patch_name) {
					hit.region->set_name (snap.patch_name);
				}
				if (snap.has_patch_muted) {
					hit.region->set_muted (snap.patch_muted);
				}
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::DeleteRegion: {
			if (cmd.id.empty ()) break;
			std::string region_id = cmd.id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, region_id] () {
				auto hit = schema_map::find_region (shim->session (), region_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: delete_region: unknown region id: " << region_id << endmsg;
					return;
				}
				// `RegionRemoved` signal will fire on the playlist and our
				// signal bridge relays it; we don't re-emit here.
				std::shared_ptr<RouteList const> routes = shim->session ().get_routes ();
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (!pl) continue;
					if (pl->region_by_id (hit.region->id ())) {
						pl->remove_region (hit.region);
						break;
					}
				}
			});
			break;
		}
		case DecodedCmd::Kind::UpdateTrack: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				// Locate the route by foyer id.
				if (snap.id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.id.substr (6);
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = shim->session ().get_routes ();
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					if (tmp.str () == sid) { route = r; break; }
				}
				if (!route) {
					PBD::warning << "foyer_shim: update_track: unknown track id: " << snap.id << endmsg;
					return;
				}
				if (snap.has_patch_name) {
					route->set_name (snap.patch_name);
				}
				if (snap.has_patch_color) {
					// Empty string or clear sentinel → reset the color.
					const std::uint32_t packed = schema_map::color_from_hex (snap.patch_color);
					route->presentation_info ().set_color (packed);
				}
				// group_id / bus_assign deferred — Ardour's RouteGroup API
				// is stable but wiring it belongs with the group commands.

				auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
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
