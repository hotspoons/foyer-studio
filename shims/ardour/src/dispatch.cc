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
#include "signal_bridge.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "ardour/audio_port.h"
#include "ardour/automation_control.h"
#include "ardour/delivery.h"
#include "ardour/gain_control.h"
#include "ardour/internal_send.h"
#include "ardour/midi_model.h"
#include "ardour/midi_region.h"
#include "ardour/midi_source.h"
#include "ardour/monitor_control.h"
#include "ardour/location.h"
#include "ardour/playlist.h"
#include "ardour/region_factory.h"
#include "ardour/plugin.h"
#include "ardour/plugin_insert.h"
#include "ardour/plugin_manager.h"
#include "ardour/presentation_info.h"
#include "ardour/processor.h"
#include "ardour/region.h"
#include "ardour/route.h"
#include "ardour/route_group.h"
#include "ardour/send.h"
#include "ardour/session.h"
#include "ardour/track.h"
#include "evoral/Note.h"
#include "evoral/PatchChange.h"
#include "pbd/controllable.h"
#include "pbd/error.h"
#include "temporal/beats.h"
#include "temporal/timeline.h"

#include "ipc.h"
#include "master_tap.h"
#include "msgpack_out.h"
#include "schema_map.h"
#include "shim_input_port.h"
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
		Audio,            // kept for back-compat; see audio-specific kinds below
		AudioStreamOpen,  // Command::AudioStreamOpen { stream_id, source, format, transport }
		AudioStreamClose, // Command::AudioStreamClose { stream_id }
		Latency,
		ListRegions,
		UpdateRegion,
		DeleteRegion,
		UpdateTrack,
		InvokeAction,
		AddPlugin,
		RemovePlugin,
		SaveSession,
		AddNote,
		UpdateNote,
		DeleteNote,
		AddPatchChange,
		UpdatePatchChange,
		DeletePatchChange,
		Undo,
		Redo,
		ListPluginPresets,
		LoadPluginPreset,
		SetSequencerLayout,
		ClearSequencerLayout,
		AudioIngressOpen,
		AudioIngressClose,
		DuplicateRegion,
		CreateRegion,
		ReplaceRegionNotes,
		ListPlugins,
		SetAutomationMode,
		AddAutomationPoint,
		UpdateAutomationPoint,
		DeleteAutomationPoint,
		ReplaceAutomationLane,
		SetTrackInput,
		ListPorts,
		AddSend,
		RemoveSend,
		SetSendLevel,
		DeleteTrack,
		ReorderTracks,
		SetLoopRange,
		CreateGroup,
		UpdateGroup,
		DeleteGroup,
	};
	Kind kind = Kind::Unknown;
	std::string id;
	std::string track_id;
	std::string plugin_uri;   // Command::AddPlugin
	std::string plugin_id;    // Command::RemovePlugin (= "plugin.<pid>")
	std::string preset_id;    // Command::LoadPluginPreset (preset URI)
	double value = 0.0;

	// Audio stream fields (AudioStreamOpen / Close / IngressOpen).
	std::uint32_t audio_stream_id  = 0;
	std::string   audio_source;       // "master" | "track.<id>" | "monitor" | "virtual_input"
	std::string   audio_source_name;  // name from VirtualInput { name: ... }
	std::uint32_t audio_channels     = 2;
	std::uint32_t audio_sample_rate  = 48000;

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
	bool          has_patch_monitoring = false;
	std::string   patch_monitoring;       // "auto"|"input"|"disk"|"cue"
	bool          has_patch_input_port   = false;
	std::string   patch_input_port;       // port name or "" to clear

	// MIDI note fields — AddNote / UpdateNote / DeleteNote.
	//  * region_id stored in `track_id` (reuse: the sidecar sends
	//    `region_id` but the field is a plain string slot and tracking
	//    a dedicated field doubles ceremony for no benefit).
	//  * note_id stored in `id`.
	// All note-data fields come in via `note` (AddNote) or `patch`
	// (UpdateNote) sub-maps — both reuse this set.
	bool          has_note_pitch        = false;
	std::uint8_t  note_pitch            = 60;
	bool          has_note_velocity     = false;
	std::uint8_t  note_velocity         = 100;
	bool          has_note_channel      = false;
	std::uint8_t  note_channel          = 0;
	bool          has_note_start        = false;
	std::uint64_t note_start_ticks      = 0;
	bool          has_note_length       = false;
	std::uint64_t note_length_ticks     = 0;

	// PatchChange fields — AddPatchChange / UpdatePatchChange /
	// DeletePatchChange. Same reuse strategy as notes: region_id lands
	// in `track_id`, patch_change_id in `id`, program/bank via
	// `patch_change` sub-map.
	bool          has_pc_channel   = false;
	std::uint8_t  pc_channel       = 0;
	bool          has_pc_program   = false;
	std::uint8_t  pc_program       = 0;
	bool          has_pc_bank      = false;
	std::int32_t  pc_bank          = -1;
	bool          has_pc_start     = false;
	std::uint64_t pc_start_ticks   = 0;

	// SequencerLayout payload — decoded during SetSequencerLayout.
	// We only need this on the shim side for the Set handler, so we
	// stash a full SequencerLayoutDesc here to hand straight to
	// schema_map::set_sequencer_layout.
	schema_map::SequencerLayoutDesc seq_layout;

	// DuplicateRegion payload.
	std::string   dup_source_id;
	std::uint64_t dup_at_samples = 0;
	bool          dup_has_length = false;
	std::uint64_t dup_length_samples = 0;

	// CreateRegion payload. Shares at/length/name with DuplicateRegion /
	// RegionPatch; `create_kind` is the region's media type ("midi" is
	// the only wired variant).
	std::string   create_kind;

	// ReplaceRegionNotes payload — parsed into a vector so the
	// handler can feed it straight into a single NoteDiffCommand.
	// We reuse DecodedCmd as the decoder's output type throughout
	// the file, so the vector lives here.
	struct DecodedNote {
		std::uint8_t  pitch = 0;
		std::uint8_t  velocity = 100;
		std::uint8_t  channel = 0;
		std::uint64_t start_ticks = 0;
		std::uint64_t length_ticks = 0;
	};
	std::vector<DecodedNote> replace_notes;

	// Routing / send mutation payloads.
	// ListPorts → direction filter ("source" | "sink" | "" = all).
	std::string   ports_direction;
	// AddSend → track_id in `track_id`, target bus in `bus_assign`.
	std::string   send_target_track;
	bool          send_pre_fader = false;
	// RemoveSend / SetSendLevel → send id in `id`.
	double        send_level = 1.0;
	std::vector<std::string> ordered_track_ids;
	std::uint64_t loop_start_samples = 0;
	std::uint64_t loop_end_samples = 0;
	bool          has_loop_enabled = false;
	bool          loop_enabled = false;

	// Group CRUD payloads.
	std::string   group_name;
	std::string   group_color;
	std::vector<std::string> group_members;
	bool          has_group_patch_name = false;
	std::string   group_patch_name;
	bool          has_group_patch_color = false;
	std::string   group_patch_color;
	bool          has_group_patch_members = false;
	std::vector<std::string> group_patch_members;

	// Automation lane edit payloads (Phase B).
	std::string   lane_id;
	std::string   auto_mode;               // SetAutomationMode
	std::uint64_t auto_orig_time = 0;      // UpdateAutomationPoint
	std::uint64_t auto_new_time  = 0;      // UpdateAutomationPoint
	bool          has_auto_orig_time = false;
	bool          has_auto_new_time  = false;
	struct DecodedAutoPoint {
		std::uint64_t time_samples = 0;
		double        value = 0.0;
	};
	DecodedAutoPoint auto_point;           // AddAutomationPoint / DeleteAutomationPoint
	std::vector<DecodedAutoPoint> auto_points; // ReplaceAutomationLane
};

// Read an int64 that may be positive or negative on the wire —
// msgpack picks the smallest fixed-int form. Returns false if the
// next value isn't an integer.
static bool
read_i64 (In& in, std::int64_t& out)
{
	if (in.p >= in.end) return false;
	std::uint8_t b = *in.p;
	if (b <= 0x7f) { out = b; ++in.p; return true; }
	if (b >= 0xe0) { out = static_cast<std::int8_t> (b); ++in.p; return true; }
	if (b == 0xcc || b == 0xd0) {
		++in.p;
		std::uint8_t v = in.take_u8 ();
		out = (b == 0xcc) ? static_cast<std::int64_t> (v) : static_cast<std::int64_t> (static_cast<std::int8_t> (v));
		return true;
	}
	if (b == 0xcd || b == 0xd1) {
		++in.p;
		std::uint16_t v = in.take_be16 ();
		out = (b == 0xcd) ? static_cast<std::int64_t> (v) : static_cast<std::int64_t> (static_cast<std::int16_t> (v));
		return true;
	}
	if (b == 0xce || b == 0xd2) {
		++in.p;
		std::uint32_t v = in.take_be32 ();
		out = (b == 0xce) ? static_cast<std::int64_t> (v) : static_cast<std::int64_t> (static_cast<std::int32_t> (v));
		return true;
	}
	if (b == 0xcf || b == 0xd3) {
		++in.p;
		std::uint64_t v = in.take_be64 ();
		out = (b == 0xcf) ? static_cast<std::int64_t> (v) : static_cast<std::int64_t> (v);
		return true;
	}
	return false;
}

// Parse a PatchChange / PatchChangePatch sub-map.
static bool
read_pc_fields (In& in, DecodedCmd& out)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "channel") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.pc_channel = static_cast<std::uint8_t> (v & 0x0f);
			out.has_pc_channel = true;
		} else if (k == "program") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.pc_program = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			out.has_pc_program = true;
		} else if (k == "bank") {
			std::int64_t v = 0;
			if (!read_i64 (in, v)) return false;
			out.pc_bank = static_cast<std::int32_t> (v);
			out.has_pc_bank = true;
		} else if (k == "start_ticks") {
			if (!in.read_u64 (out.pc_start_ticks)) return false;
			out.has_pc_start = true;
		} else if (k == "id") {
			if (!in.read_str (out.id)) return false;
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	return true;
}

// Parse one SequencerRow sub-map into an entry on `layout.rows`.
static bool
read_seq_row (In& in, schema_map::SequencerLayoutDesc& layout)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	schema_map::SequencerRowDesc row;
	std::uint64_t v = 0;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "pitch") {
			if (!in.read_u64 (v)) return false;
			row.pitch = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
		} else if (k == "channel") {
			if (!in.read_u64 (v)) return false;
			row.channel = static_cast<std::uint8_t> (v & 0x0f);
		} else if (k == "label") {
			if (!in.read_str (row.label)) return false;
		} else if (k == "color") {
			if (!in.read_str (row.color)) return false;
		} else if (k == "muted") {
			if (!in.read_bool (row.muted)) return false;
		} else if (k == "soloed") {
			if (!in.read_bool (row.soloed)) return false;
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	layout.rows.push_back (std::move (row));
	return true;
}

// Forward decl — pre-existing v1 sites still call this. Body
// resolves to the generic helper after `read_one_cell` is defined.
[[maybe_unused]] static bool read_seq_cell (In& in, schema_map::SequencerLayoutDesc& layout);

// Read a msgpack array header. Returns false if the next value
// isn't an array.
static bool
read_array_header (In& in, std::size_t& count)
{
	if (in.p >= in.end) return false;
	std::uint8_t b = in.peek ();
	if ((b & 0xf0) == 0x90) { in.take_u8 (); count = b & 0x0f; return true; }
	if (b == 0xdc)          { in.take_u8 (); count = in.take_be16 (); return true; }
	if (b == 0xdd)          { in.take_u8 (); count = in.take_be32 (); return true; }
	return false;
}

// One cell map → push into `dest`.
static bool
read_one_cell (In& in, std::vector<schema_map::SequencerCellDesc>& dest)
{
	std::size_t m = 0;
	if (!in.read_map_header (m)) return false;
	schema_map::SequencerCellDesc cell;
	std::uint64_t v = 0;
	for (std::size_t j = 0; j < m; ++j) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "row") {
			if (!in.read_u64 (v)) return false;
			cell.row = static_cast<std::uint32_t> (v);
		} else if (k == "step") {
			if (!in.read_u64 (v)) return false;
			cell.step = static_cast<std::uint32_t> (v);
		} else if (k == "velocity") {
			if (!in.read_u64 (v)) return false;
			cell.velocity = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
		} else if (k == "length_steps") {
			if (!in.read_u64 (v)) return false;
			cell.length_steps = static_cast<std::uint32_t> (v);
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	dest.push_back (cell);
	return true;
}

// Definition of the v1-compat forward decl. Just delegates.
static bool
read_seq_cell (In& in, schema_map::SequencerLayoutDesc& layout)
{
	return read_one_cell (in, layout.cells);
}

// One Pattern map (id, name, color, cells, free_notes) → push.
static bool
read_one_pattern (In& in, schema_map::SequencerLayoutDesc& layout)
{
	std::size_t m = 0;
	if (!in.read_map_header (m)) return false;
	schema_map::SequencerPatternDesc pat;
	for (std::size_t j = 0; j < m; ++j) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "id") {
			if (!in.read_str (pat.id)) return false;
		} else if (k == "name") {
			if (!in.read_str (pat.name)) return false;
		} else if (k == "color") {
			if (!in.read_str (pat.color)) return false;
		} else if (k == "cells") {
			std::size_t cn = 0;
			if (!read_array_header (in, cn)) return false;
			for (std::size_t i = 0; i < cn; ++i) {
				if (!read_one_cell (in, pat.cells)) return false;
			}
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	layout.patterns.push_back (std::move (pat));
	return true;
}

// One ArrangementSlot map → push.
static bool
read_one_slot (In& in, schema_map::SequencerLayoutDesc& layout)
{
	std::size_t m = 0;
	if (!in.read_map_header (m)) return false;
	schema_map::SequencerSlotDesc slot;
	for (std::size_t j = 0; j < m; ++j) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "pattern_id") {
			if (!in.read_str (slot.pattern_id)) return false;
		} else if (k == "bar") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			slot.bar = static_cast<std::uint32_t> (v);
		} else if (k == "arrangement_row") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			slot.arrangement_row = static_cast<std::uint32_t> (v);
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	layout.arrangement.push_back (slot);
	return true;
}

// Parse a SequencerLayout sub-map — the `layout` field on
// Command::SetSequencerLayout. Unknown fields are skipped so a
// client on a newer schema won't hang the shim.
static bool
read_sequencer_layout (In& in, schema_map::SequencerLayoutDesc& layout)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	layout.present = true;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "version") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			layout.version = static_cast<std::uint32_t> (v);
		} else if (k == "mode") {
			if (!in.read_str (layout.mode)) return false;
		} else if (k == "resolution") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			layout.resolution = static_cast<std::uint32_t> (v);
		} else if (k == "active") {
			if (!in.read_bool (layout.active)) return false;
		} else if (k == "pattern_steps" || k == "steps") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			layout.pattern_steps = static_cast<std::uint32_t> (v);
		} else if (k == "rows") {
			std::size_t rn = 0;
			if (!read_array_header (in, rn)) return false;
			for (std::size_t j = 0; j < rn; ++j) {
				if (!read_seq_row (in, layout)) return false;
			}
		} else if (k == "cells") {
			std::size_t cn = 0;
			if (!read_array_header (in, cn)) return false;
			for (std::size_t j = 0; j < cn; ++j) {
				if (!read_one_cell (in, layout.cells)) return false;
			}
		} else if (k == "patterns") {
			std::size_t pn = 0;
			if (!read_array_header (in, pn)) return false;
			for (std::size_t j = 0; j < pn; ++j) {
				if (!read_one_pattern (in, layout)) return false;
			}
		} else if (k == "arrangement") {
			std::size_t sn = 0;
			if (!read_array_header (in, sn)) return false;
			for (std::size_t j = 0; j < sn; ++j) {
				if (!read_one_slot (in, layout)) return false;
			}
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	return true;
}

// Parse the `notes` array of a ReplaceRegionNotes command into
// out.replace_notes. Each element is a MidiNote map; we skip `id`
// (the shim assigns fresh Evoral event ids) and `channel` when
// absent (defaults to 0).
static bool
read_replace_notes_array (In& in, DecodedCmd& out)
{
	std::size_t n = 0;
	std::uint8_t b = in.peek ();
	if ((b & 0xf0) == 0x90) { in.take_u8 (); n = b & 0x0f; }
	else if (b == 0xdc)     { in.take_u8 (); n = in.take_be16 (); }
	else if (b == 0xdd)     { in.take_u8 (); n = in.take_be32 (); }
	else return false;
	out.replace_notes.reserve (n);
	for (std::size_t i = 0; i < n; ++i) {
		std::size_t m = 0;
		if (!in.read_map_header (m)) return false;
		DecodedCmd::DecodedNote nd;
		for (std::size_t j = 0; j < m; ++j) {
			std::string k;
			if (!in.read_str (k)) return false;
			std::uint64_t v = 0;
			if (k == "pitch") {
				if (!in.read_u64 (v)) return false;
				nd.pitch = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			} else if (k == "velocity") {
				if (!in.read_u64 (v)) return false;
				nd.velocity = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			} else if (k == "channel") {
				if (!in.read_u64 (v)) return false;
				nd.channel = static_cast<std::uint8_t> (v & 0x0f);
			} else if (k == "start_ticks") {
				if (!in.read_u64 (nd.start_ticks)) return false;
			} else if (k == "length_ticks") {
				if (!in.read_u64 (nd.length_ticks)) return false;
			} else {
				if (!in.skip_value ()) return false;
			}
		}
		out.replace_notes.push_back (nd);
	}
	return true;
}

// Parse a MidiNote / MidiNotePatch sub-map. MidiNote includes `id`
// which we drop into DecodedCmd::id (overwriting whatever was there —
// AddNote uses the server-assigned note id as the source-of-truth).
// MidiNotePatch has the same fields except `id`.
static bool
read_note_fields (In& in, DecodedCmd& out)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "pitch") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_pitch = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			out.has_note_pitch = true;
		} else if (k == "velocity") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_velocity = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			out.has_note_velocity = true;
		} else if (k == "channel") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_channel = static_cast<std::uint8_t> (v & 0x0f);
			out.has_note_channel = true;
		} else if (k == "start_ticks") {
			if (!in.read_u64 (out.note_start_ticks)) return false;
			out.has_note_start = true;
		} else if (k == "length_ticks") {
			if (!in.read_u64 (out.note_length_ticks)) return false;
			out.has_note_length = true;
		} else if (k == "id") {
			// MidiNote.id — treat the incoming id as the note id so
			// AddNote can preserve whatever EntityId the sidecar
			// generated (round-trips cleaner than reassigning).
			if (!in.read_str (out.id)) return false;
		} else {
			if (!in.skip_value ()) return false;
		}
	}
	return true;
}

// Unified patch reader that handles both `RegionPatch` (UpdateRegion /
// UpdateTrack) and `MidiNotePatch` (UpdateNote). The key sets are
// disjoint so we can just try both — unknown keys skip, known keys
// flip their `has_*` flag, and the dispatcher only reads the fields
// that match its command kind.
static bool
read_region_patch_or_note (In& in, DecodedCmd& out)
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
		} else if (pk == "monitoring") {
			if (!in.read_str (out.patch_monitoring)) return false;
			out.has_patch_monitoring = true;
		} else if (pk == "input_port") {
			if (!in.read_str (out.patch_input_port)) return false;
			out.has_patch_input_port = true;
		} else if (pk == "pitch") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_pitch = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			out.has_note_pitch = true;
		} else if (pk == "velocity") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_velocity = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
			out.has_note_velocity = true;
		} else if (pk == "channel") {
			std::uint64_t v = 0;
			if (!in.read_u64 (v)) return false;
			out.note_channel = static_cast<std::uint8_t> (v & 0x0f);
			out.has_note_channel = true;
		} else if (pk == "start_ticks") {
			if (!in.read_u64 (out.note_start_ticks)) return false;
			out.has_note_start = true;
		} else if (pk == "length_ticks") {
			if (!in.read_u64 (out.note_length_ticks)) return false;
			out.has_note_length = true;
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
				} else if (k == "region_id") {
					// MIDI note commands target a region; stash it in
					// track_id (free string slot; dispatch disambiguates
					// by cmd kind).
					if (!in.read_str (out.track_id)) return out;
				} else if (k == "note_id") {
					if (!in.read_str (out.id)) return out;
				} else if (k == "note") {
					if (!read_note_fields (in, out)) return out;
				} else if (k == "patch_change") {
					if (!read_pc_fields (in, out)) return out;
				} else if (k == "patch_change_id") {
					if (!in.read_str (out.id)) return out;
				} else if (k == "source_region_id") {
					if (!in.read_str (out.dup_source_id)) return out;
			} else if (k == "name") {
				// CreateRegion, SavePluginPreset, CreateGroup, etc.
				std::string v;
				if (!in.read_str (v)) return out;
				out.group_name = v;
				out.patch_name = v;
				out.has_patch_name = true;
				} else if (k == "kind") {
					// CreateRegion's media-type selector ("midi" | "audio").
					if (!in.read_str (out.create_kind)) return out;
				} else if (k == "at_samples") {
					if (!in.read_u64 (out.dup_at_samples)) return out;
				} else if (k == "length_samples") {
					// Top-level length_samples is DuplicateRegion's
					// optional length override. UpdateRegion sends
					// `length_samples` inside a nested `patch` map
					// which goes through read_region_patch_or_note,
					// so there's no collision here.
					if (!in.read_u64 (out.dup_length_samples)) return out;
					out.dup_has_length = true;
				} else if (k == "notes") {
					// Top-level `notes` array → ReplaceRegionNotes
					// payload. (MidiNote inside AddNote arrives
					// under `note`, not `notes`, so there's no
					// collision.)
					if (!read_replace_notes_array (in, out)) return out;
				} else if (k == "layout") {
					if (!read_sequencer_layout (in, out.seq_layout)) return out;
				} else if (k == "value") {
					if (!in.read_f64 (out.value)) return out;
				} else if (k == "patch") {
					// RegionPatch and MidiNotePatch have disjoint keys,
					// so a single reader is safe — unknown keys fall
					// through the opposite path. But structurally: try
					// MIDI-note fields first if the current command kind
					// is a note cmd. For simplicity we read both: the
					// decoder is a forward-only walk and unknown-key
					// skipping is cheap.
					if (!read_region_patch_or_note (in, out)) return out;
				} else if (k == "plugin_uri") {
					if (!in.read_str (out.plugin_uri)) return out;
				} else if (k == "plugin_id") {
					if (!in.read_str (out.plugin_id)) return out;
				} else if (k == "preset_id") {
					if (!in.read_str (out.preset_id)) return out;
				} else if (k == "port_name") {
					// SetTrackInput { track_id, port_name }: stash in
					// the same slot UpdateTrack's patch_input_port uses
					// so the handler logic is shared.
					if (!in.read_str (out.patch_input_port)) return out;
					out.has_patch_input_port = true;
				} else if (k == "direction") {
					// ListPorts { direction: Option<String> }
					if (!in.read_str (out.ports_direction)) return out;
				} else if (k == "target_track_id") {
					// AddSend { track_id, target_track_id, pre_fader }
					if (!in.read_str (out.send_target_track)) return out;
				} else if (k == "send_id") {
					// RemoveSend / SetSendLevel — send id goes in `id`.
					if (!in.read_str (out.id)) return out;
				} else if (k == "pre_fader") {
					// Bool tag for AddSend. msgpack bools are 0xc2/0xc3.
					std::uint8_t b = in.take_u8 ();
					out.send_pre_fader = (b == 0xc3);
				} else if (k == "level") {
					// SetSendLevel { send_id, level: f64 }
					if (!in.read_f64 (out.send_level)) return out;
				} else if (k == "ordered_ids") {
					std::size_t n = 0;
					std::uint8_t b = in.peek ();
					if ((b & 0xf0) == 0x90) { in.take_u8 (); n = b & 0x0f; }
					else if (b == 0xdc)     { in.take_u8 (); n = in.take_be16 (); }
					else if (b == 0xdd)     { in.take_u8 (); n = in.take_be32 (); }
					else return out;
					out.ordered_track_ids.clear ();
					out.ordered_track_ids.reserve (n);
					for (std::size_t i = 0; i < n; ++i) {
						std::string tid;
						if (!in.read_str (tid)) return out;
						out.ordered_track_ids.push_back (tid);
					}
				} else if (k == "start_samples") {
					if (!in.read_u64 (out.loop_start_samples)) return out;
				} else if (k == "end_samples") {
					if (!in.read_u64 (out.loop_end_samples)) return out;
				} else if (k == "enabled") {
					if (!in.read_bool (out.loop_enabled)) return out;
					out.has_loop_enabled = true;
				} else if (k == "stream_id") {
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.audio_stream_id = static_cast<std::uint32_t> (v);
				} else if (k == "source") {
					// foyer-schema::AudioSource is a serde-tagged enum
					// (tag="kind", rename_all="snake_case") — so the
					// on-the-wire shape is:
					//
					//   { "kind": "master" }
					//   { "kind": "track",   "id":   "track.abc" }
					//   { "kind": "monitor" }
					//   { "kind": "port",    "id":   "port.x" }
					//   { "kind": "virtual_input", "name": "foo" }
					//
					// We need the VALUE of "kind", not its key. Walk
					// the map and pick up both `kind` + `id` so we can
					// target a specific track when the time comes.
					std::size_t inner = 0;
					if (in.read_map_header (inner)) {
						for (std::size_t q = 0; q < inner; ++q) {
							std::string kk;
							if (!in.read_str (kk)) return out;
							if (kk == "kind") {
								std::string v;
								if (!in.read_str (v)) return out;
								out.audio_source = v;
							} else if (kk == "id") {
								if (!in.read_str (out.track_id)) return out;
							} else if (kk == "name") {
								if (!in.read_str (out.audio_source_name)) return out;
							} else {
								if (!in.skip_value ()) return out;
							}
						}
					} else if (!in.read_str (out.audio_source)) {
						return out;
					}
				} else if (k == "format") {
					std::size_t nf = 0;
					if (!in.read_map_header (nf)) return out;
					for (std::size_t q = 0; q < nf; ++q) {
						std::string kk;
						if (!in.read_str (kk)) return out;
						if (kk == "channels") {
							std::uint64_t v = 0;
							if (!in.read_u64 (v)) return out;
							out.audio_channels = static_cast<std::uint32_t> (v);
						} else if (kk == "sample_rate") {
							std::uint64_t v = 0;
							if (!in.read_u64 (v)) return out;
							out.audio_sample_rate = static_cast<std::uint32_t> (v);
						} else {
							if (!in.skip_value ()) return out;
						}
					}
				} else if (k == "as_path") {
					// Command::SaveSession { as_path: Option<String> }
					// — decoded into `out.id` since we already have a
					// free string slot. MessagePack can carry nil or
					// the string; we accept either.
					std::string p;
					if (!in.read_str (p)) return out;
					out.id = p;
				} else if (k == "lane_id") {
					if (!in.read_str (out.lane_id)) return out;
				} else if (k == "mode") {
					if (!in.read_str (out.auto_mode)) return out;
				} else if (k == "point") {
					// AddAutomationPoint { lane_id, point: { time_samples, value } }
					std::size_t pm = 0;
					if (!in.read_map_header (pm)) return out;
					for (std::size_t pi = 0; pi < pm; ++pi) {
						std::string pk;
						if (!in.read_str (pk)) return out;
						if (pk == "time_samples") {
							if (!in.read_u64 (out.auto_point.time_samples)) return out;
						} else if (pk == "value") {
							if (!in.read_f64 (out.auto_point.value)) return out;
						} else {
							if (!in.skip_value ()) return out;
						}
					}
				} else if (k == "original_time_samples") {
					if (!in.read_u64 (out.auto_orig_time)) return out;
					out.has_auto_orig_time = true;
				} else if (k == "new_time_samples") {
					if (!in.read_u64 (out.auto_new_time)) return out;
					out.has_auto_new_time = true;
				} else if (k == "time_samples") {
					if (!in.read_u64 (out.auto_point.time_samples)) return out;
				} else if (k == "points") {
					// ReplaceAutomationLane { lane_id, points: [ { time_samples, value } ... ] }
					std::size_t pn = 0;
					std::uint8_t b = in.peek ();
					if ((b & 0xf0) == 0x90) { in.take_u8 (); pn = b & 0x0f; }
					else if (b == 0xdc)     { in.take_u8 (); pn = in.take_be16 (); }
					else if (b == 0xdd)     { in.take_u8 (); pn = in.take_be32 (); }
					else return out;
					out.auto_points.reserve (pn);
					for (std::size_t qi = 0; qi < pn; ++qi) {
						std::size_t m = 0;
						if (!in.read_map_header (m)) return out;
						DecodedCmd::DecodedAutoPoint pt;
						for (std::size_t j = 0; j < m; ++j) {
							std::string ptk;
							if (!in.read_str (ptk)) return out;
							if (ptk == "time_samples") {
								if (!in.read_u64 (pt.time_samples)) return out;
							} else if (ptk == "value") {
								if (!in.read_f64 (pt.value)) return out;
							} else {
								if (!in.skip_value ()) return out;
							}
						}
						out.auto_points.push_back (pt);
					}
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
			else if (cmd_type == "invoke_action")      out.kind = DecodedCmd::Kind::InvokeAction;
			else if (cmd_type == "add_plugin")         out.kind = DecodedCmd::Kind::AddPlugin;
			else if (cmd_type == "remove_plugin")      out.kind = DecodedCmd::Kind::RemovePlugin;
			else if (cmd_type == "save_session")       out.kind = DecodedCmd::Kind::SaveSession;
			else if (cmd_type == "add_note")           out.kind = DecodedCmd::Kind::AddNote;
			else if (cmd_type == "update_note")        out.kind = DecodedCmd::Kind::UpdateNote;
			else if (cmd_type == "delete_note")        out.kind = DecodedCmd::Kind::DeleteNote;
			else if (cmd_type == "add_patch_change")    out.kind = DecodedCmd::Kind::AddPatchChange;
			else if (cmd_type == "update_patch_change") out.kind = DecodedCmd::Kind::UpdatePatchChange;
			else if (cmd_type == "delete_patch_change") out.kind = DecodedCmd::Kind::DeletePatchChange;
			else if (cmd_type == "undo")               out.kind = DecodedCmd::Kind::Undo;
			else if (cmd_type == "redo")               out.kind = DecodedCmd::Kind::Redo;
			else if (cmd_type == "list_plugin_presets") out.kind = DecodedCmd::Kind::ListPluginPresets;
			else if (cmd_type == "load_plugin_preset") out.kind = DecodedCmd::Kind::LoadPluginPreset;
			else if (cmd_type == "set_sequencer_layout")   out.kind = DecodedCmd::Kind::SetSequencerLayout;
			else if (cmd_type == "clear_sequencer_layout") out.kind = DecodedCmd::Kind::ClearSequencerLayout;
			else if (cmd_type == "audio_ingress_open")  out.kind = DecodedCmd::Kind::AudioIngressOpen;
			else if (cmd_type == "audio_ingress_close") out.kind = DecodedCmd::Kind::AudioIngressClose;
			else if (cmd_type == "duplicate_region")    out.kind = DecodedCmd::Kind::DuplicateRegion;
			else if (cmd_type == "create_region")       out.kind = DecodedCmd::Kind::CreateRegion;
			else if (cmd_type == "replace_region_notes") out.kind = DecodedCmd::Kind::ReplaceRegionNotes;
            else if (cmd_type == "list_plugins")        out.kind = DecodedCmd::Kind::ListPlugins;
            else if (cmd_type == "set_automation_mode")   out.kind = DecodedCmd::Kind::SetAutomationMode;
            else if (cmd_type == "add_automation_point")  out.kind = DecodedCmd::Kind::AddAutomationPoint;
            else if (cmd_type == "update_automation_point") out.kind = DecodedCmd::Kind::UpdateAutomationPoint;
            else if (cmd_type == "delete_automation_point") out.kind = DecodedCmd::Kind::DeleteAutomationPoint;
            else if (cmd_type == "replace_automation_lane") out.kind = DecodedCmd::Kind::ReplaceAutomationLane;
            else if (cmd_type == "set_track_input")      out.kind = DecodedCmd::Kind::SetTrackInput;
            else if (cmd_type == "list_ports")           out.kind = DecodedCmd::Kind::ListPorts;
            else if (cmd_type == "add_send")             out.kind = DecodedCmd::Kind::AddSend;
            else if (cmd_type == "remove_send")          out.kind = DecodedCmd::Kind::RemoveSend;
            else if (cmd_type == "set_send_level")       out.kind = DecodedCmd::Kind::SetSendLevel;
            else if (cmd_type == "delete_track")         out.kind = DecodedCmd::Kind::DeleteTrack;
            else if (cmd_type == "reorder_tracks")       out.kind = DecodedCmd::Kind::ReorderTracks;
            else if (cmd_type == "set_loop_range")       out.kind = DecodedCmd::Kind::SetLoopRange;
            else if (cmd_type == "create_group")         out.kind = DecodedCmd::Kind::CreateGroup;
            else if (cmd_type == "update_group")         out.kind = DecodedCmd::Kind::UpdateGroup;
            else if (cmd_type == "delete_group")         out.kind = DecodedCmd::Kind::DeleteGroup;
            else if (cmd_type == "audio_stream_open"
                ||   cmd_type == "audio_egress_start")  out.kind = DecodedCmd::Kind::AudioStreamOpen;
			else if (cmd_type == "audio_stream_close"
			    ||   cmd_type == "audio_egress_stop")   out.kind = DecodedCmd::Kind::AudioStreamClose;
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
Dispatcher::on_audio_frame (const std::vector<std::uint8_t>& payload)
{
	// Unpack stream_id (u32 LE) + interleaved f32 PCM.
	if (payload.size () < 4) return;
	const std::uint32_t stream_id =
	      (static_cast<std::uint32_t> (payload[0]))
	    | (static_cast<std::uint32_t> (payload[1]) << 8)
	    | (static_cast<std::uint32_t> (payload[2]) << 16)
	    | (static_cast<std::uint32_t> (payload[3]) << 24);

	std::lock_guard<std::mutex> lk (_ingress_mx);
	auto it = _ingress_ports.find (stream_id);
	if (it != _ingress_ports.end () && it->second) {
		const float* samples = reinterpret_cast<const float*> (payload.data () + 4);
		const std::size_t n_floats = (payload.size () - 4) / sizeof (float);
		it->second->push_audio (samples, n_floats);
	}
}

void
Dispatcher::on_control_frame (const std::vector<std::uint8_t>& buf)
{
	DecodedCmd cmd = decode (buf);

	switch (cmd.kind) {
		case DecodedCmd::Kind::Subscribe:
		case DecodedCmd::Kind::RequestSnapshot: {
			// Source routes from the SignalBridge's weak_ptr cache
			// instead of `session.get_routes()` — the RCU teardown
			// race that used to SIGSEGV this code path can't happen
			// when lifting through weak_ptr.lock().
			auto routes = _shim.signal_bridge ().snapshot_tracked_routes ();
			auto bytes = msgpack_out::encode_session_snapshot (_shim.session (), routes);
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
							// Record user intent BEFORE calling transport_play —
							// Ardour's TransportStateChange fires synchronously
							// inside request_roll on this thread (event loop)
							// in some cases, so the SignalBridge grace-window
							// check needs the timestamp already set.
							shim->signal_bridge ().note_user_play_request ();
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
						const double bpm = std::max (20.0, std::min (300.0, snap.value));
						Temporal::TempoMap::WritableSharedPtr tmap (Temporal::TempoMap::write_copy ());
						const Temporal::timepos_t pos (session.transport_sample ());
						const Temporal::TempoMetric metric (tmap->metric_at (pos));
						tmap->change_tempo (
						    metric.get_editable_tempo (),
						    Temporal::Tempo (bpm, bpm, 4.0));
						Temporal::TempoMap::update (tmap);
						PBD::warning << "foyer_shim: updated transport tempo to " << bpm << endmsg;
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
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
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

			// Everything else (track mute/solo/gain/pan/rec, plugin params)
			// resolves to an AutomationControl. `set_value` on those
			// allocates a `SessionEvent` from the per-thread pool for
			// some subclasses (notably MuteControllable/SoloControllable)
			// — so the call MUST run on the event-loop thread where
			// `thread_init` registered a pool. Running it on the IPC
			// reader thread (which has no pool) crashed the shim with
			// `programming error: no per-thread pool "" for thread`
			// after a few rapid mute/solo toggles. Hop to call_slot.
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto& session = shim->session ();
				auto ctrl = schema_map::resolve (session, snap.id);
				if (!ctrl) {
					PBD::warning << "foyer_shim: unknown control id: " << snap.id << endmsg;
					return;
				}
				// Wrap each ControlSet in a reversible command so it
				// becomes a single undo step. Without this,
				// AutomationControl::set_value may silently drop its
				// internal undo registration because there is no active
				// UndoTransaction.
				session.begin_reversible_command ("Foyer control change");
				ctrl->set_value (snap.value, Controllable::UseGroup);
				session.commit_reversible_command ();
				// No manual echo — the Controllable::Changed signal will
				// fire and our SignalBridge will emit the corresponding
				// `control.update`.
			});
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
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
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
		case DecodedCmd::Kind::AddNote: {
			// cmd.track_id holds the region id (decoder reuse); cmd.id
			// is ignored on add — Ardour assigns its own event_id.
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: add_note: unknown region id: " << snap.track_id << endmsg;
					return;
				}
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) {
					PBD::warning << "foyer_shim: add_note: region is not MIDI: " << snap.track_id << endmsg;
					return;
				}
				auto model = mr->model ();
				if (!model) return;
				auto note = std::make_shared<Evoral::Note<Temporal::Beats>> (
					snap.has_note_channel  ? snap.note_channel  : 0,
					Temporal::Beats::ticks (static_cast<std::int64_t> (snap.has_note_start  ? snap.note_start_ticks  : 0)),
					Temporal::Beats::ticks (static_cast<std::int64_t> (snap.has_note_length ? snap.note_length_ticks : 480)),
					snap.has_note_pitch    ? snap.note_pitch    : 60,
					snap.has_note_velocity ? snap.note_velocity : 100);
				auto* diff = model->new_note_diff_command ("foyer add note");
				diff->add (note);
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::UpdateNote: {
			if (cmd.track_id.empty () || cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;

				// Decode the note id back into an Evoral event_id. Our
				// wire form is "note.<region-pbd>.<event_id>"; take the
				// substring after the last '.'.
				auto pos = snap.id.find_last_of ('.');
				if (pos == std::string::npos) return;
				Evoral::event_id_t target_id = 0;
				try {
					target_id = static_cast<Evoral::event_id_t> (std::stoi (snap.id.substr (pos + 1)));
				} catch (...) { return; }

				auto note = model->find_note (target_id);
				if (!note) {
					PBD::warning << "foyer_shim: update_note: note not found: " << snap.id << endmsg;
					return;
				}
				auto* diff = model->new_note_diff_command ("foyer edit note");
				if (snap.has_note_pitch) {
					diff->change (note, ARDOUR::MidiModel::NoteDiffCommand::NoteNumber, snap.note_pitch);
				}
				if (snap.has_note_velocity) {
					diff->change (note, ARDOUR::MidiModel::NoteDiffCommand::Velocity, snap.note_velocity);
				}
				if (snap.has_note_channel) {
					diff->change (note, ARDOUR::MidiModel::NoteDiffCommand::Channel, snap.note_channel);
				}
				if (snap.has_note_start) {
					diff->change (note, ARDOUR::MidiModel::NoteDiffCommand::StartTime,
					              Temporal::Beats::ticks (static_cast<std::int64_t> (snap.note_start_ticks)));
				}
				if (snap.has_note_length) {
					diff->change (note, ARDOUR::MidiModel::NoteDiffCommand::Length,
					              Temporal::Beats::ticks (static_cast<std::int64_t> (snap.note_length_ticks)));
				}
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::DeleteNote: {
			if (cmd.track_id.empty () || cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;

				auto pos = snap.id.find_last_of ('.');
				if (pos == std::string::npos) return;
				Evoral::event_id_t target_id = 0;
				try {
					target_id = static_cast<Evoral::event_id_t> (std::stoi (snap.id.substr (pos + 1)));
				} catch (...) { return; }

				auto note = model->find_note (target_id);
				if (!note) {
					PBD::warning << "foyer_shim: delete_note: note not found: " << snap.id << endmsg;
					return;
				}
				auto* diff = model->new_note_diff_command ("foyer delete note");
				diff->remove (note);
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::AddPatchChange: {
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;
				auto pc = std::make_shared<Evoral::PatchChange<Temporal::Beats>> (
					Temporal::Beats::ticks (static_cast<std::int64_t> (snap.has_pc_start ? snap.pc_start_ticks : 0)),
					snap.has_pc_channel ? snap.pc_channel : 0,
					snap.has_pc_program ? snap.pc_program : 0,
					snap.has_pc_bank    ? snap.pc_bank    : -1);
				auto* diff = model->new_patch_change_diff_command ("foyer add patch change");
				diff->add (pc);
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::UpdatePatchChange: {
			if (cmd.track_id.empty () || cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;
				auto dot = snap.id.find_last_of ('.');
				if (dot == std::string::npos) return;
				Evoral::event_id_t target = 0;
				try { target = static_cast<Evoral::event_id_t> (std::stoi (snap.id.substr (dot + 1))); }
				catch (...) { return; }
				auto pc = model->find_patch_change (target);
				if (!pc) return;
				auto* diff = model->new_patch_change_diff_command ("foyer edit patch change");
				if (snap.has_pc_channel) diff->change_channel (pc, snap.pc_channel);
				if (snap.has_pc_program) diff->change_program (pc, snap.pc_program);
				if (snap.has_pc_bank)    diff->change_bank    (pc, snap.pc_bank);
				if (snap.has_pc_start)   diff->change_time    (pc,
					Temporal::Beats::ticks (static_cast<std::int64_t> (snap.pc_start_ticks)));
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::DeletePatchChange: {
			if (cmd.track_id.empty () || cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;
				auto dot = snap.id.find_last_of ('.');
				if (dot == std::string::npos) return;
				Evoral::event_id_t target = 0;
				try { target = static_cast<Evoral::event_id_t> (std::stoi (snap.id.substr (dot + 1))); }
				catch (...) { return; }
				auto pc = model->find_patch_change (target);
				if (!pc) return;
				auto* diff = model->new_patch_change_diff_command ("foyer delete patch change");
				diff->remove (pc);
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ListPlugins: {
			// PluginManager scans may still be empty if Ardour hasn't
			// finished its startup scan — force a refresh if so.
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				auto bytes = msgpack_out::encode_plugins_list ();
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ReplaceRegionNotes: {
			// `track_id` holds the region id (decoder reuse).
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.track_id);
				if (!hit.region) return;
				auto mr = std::dynamic_pointer_cast<ARDOUR::MidiRegion> (hit.region);
				if (!mr) return;
				auto model = mr->model ();
				if (!model) return;
				// Build a single NoteDiffCommand that removes every
				// existing note then adds the new list. Ardour
				// bundles this into one undo entry — the whole
				// sequencer regeneration is reversible as a unit.
				auto* diff = model->new_note_diff_command ("foyer replace notes");
				{
					auto lock = model->read_lock ();
					for (auto const& existing : model->notes ()) {
						if (existing) diff->remove (existing);
					}
				}
				for (auto const& nd : snap.replace_notes) {
					auto note = std::make_shared<Evoral::Note<Temporal::Beats>> (
						nd.channel,
						Temporal::Beats::ticks (static_cast<std::int64_t> (nd.start_ticks)),
						Temporal::Beats::ticks (static_cast<std::int64_t> (nd.length_ticks > 0 ? nd.length_ticks : 240)),
						nd.pitch,
						nd.velocity);
					diff->add (note);
				}
				model->apply_diff_command_as_commit (shim->session (), diff);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::DuplicateRegion: {
			if (cmd.dup_source_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.dup_source_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: duplicate_region: unknown source: "
					             << snap.dup_source_id << endmsg;
					return;
				}
				// Find the owning playlist so we can add the clone.
				std::shared_ptr<ARDOUR::Playlist> playlist;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (pl && pl->region_by_id (hit.region->id ())) {
						playlist = pl; break;
					}
				}
				if (!playlist) {
					PBD::warning << "foyer_shim: duplicate_region: source not on any playlist" << endmsg;
					return;
				}
				// `RegionFactory::create(shared<const Region>, announce)`
				// clones the region AND copies `_extra_xml` (the copy
				// ctor in region.cc:474-477 does `new XMLNode(*other)` on
				// the extra_xml tree). That's why duplicating a beat-
				// sequencer region carries the layout across for free.
				PBD::PropertyList plist;
				auto clone = ARDOUR::RegionFactory::create (
					std::shared_ptr<const ARDOUR::Region> (hit.region),
					true /* announce */, false /* fork */);
				if (!clone) {
					PBD::warning << "foyer_shim: duplicate_region: RegionFactory returned null" << endmsg;
					return;
				}
				if (snap.dup_has_length) {
					clone->set_length (Temporal::timecnt_t::from_samples (
						static_cast<Temporal::samplepos_t> (snap.dup_length_samples)));
				}
				playlist->add_region (clone, Temporal::timepos_t (
					static_cast<Temporal::samplepos_t> (snap.dup_at_samples)));
				shim->session ().set_dirty ();
				// Playlist's RegionAdded signal fires an echo; we
				// don't emit one manually here.
			});
			break;
		}
		case DecodedCmd::Kind::CreateRegion: {
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				// Find the target track by matching `track.<pbd-id>`
				// against each Route's PBD id.
				if (snap.track_id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.track_id.substr (6);
				std::shared_ptr<ARDOUR::Track> track;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp; tmp << r->id ();
					if (tmp.str () == sid) {
						track = std::dynamic_pointer_cast<ARDOUR::Track> (r);
						break;
					}
				}
				if (!track) {
					PBD::warning << "foyer_shim: create_region: unknown track "
					             << snap.track_id << endmsg;
					return;
				}
				auto playlist = track->playlist ();
				if (!playlist) {
					PBD::warning << "foyer_shim: create_region: track has no playlist" << endmsg;
					return;
				}
				// Media-type gate. Audio regions need a source file
				// (we don't have a picker for that yet). MIDI creates
				// a fresh empty source on the session.
				const std::string kind = snap.create_kind.empty () ? "midi" : snap.create_kind;
				if (kind != "midi") {
					PBD::warning << "foyer_shim: create_region: kind '"
					             << kind << "' not yet wired (midi only)" << endmsg;
					return;
				}
				const std::string region_name =
					snap.has_patch_name && !snap.patch_name.empty ()
						? snap.patch_name
						: std::string ("Region");
				// Length defaults: 1 bar @ the session's tempo map.
				// When the client doesn't send a length, compute a
				// sample count that matches "1 bar" at 4/4 using the
				// current tempo. This keeps new regions visually
				// meaningful instead of zero-width.
				Temporal::samplepos_t length_samples;
				if (snap.dup_has_length && snap.dup_length_samples > 0) {
					length_samples = static_cast<Temporal::samplepos_t> (snap.dup_length_samples);
				} else {
					const double spl_rate = shim->session ().sample_rate ();
					// 1 bar at 120 bpm 4/4 = 2 seconds. Good enough
					// default — the user can resize.
					length_samples = static_cast<Temporal::samplepos_t> (spl_rate * 2.0);
				}
				std::shared_ptr<ARDOUR::MidiSource> src =
					shim->session ().create_midi_source_for_session (region_name);
				if (!src) {
					PBD::warning << "foyer_shim: create_region: create_midi_source_for_session returned null" << endmsg;
					return;
				}
				PBD::PropertyList plist;
				plist.add (ARDOUR::Properties::name, region_name);
				plist.add (ARDOUR::Properties::start,
					Temporal::timepos_t (Temporal::Beats ()));
				plist.add (ARDOUR::Properties::length,
					Temporal::timecnt_t::from_samples (length_samples));
				plist.add (ARDOUR::Properties::whole_file, false);
				auto region = ARDOUR::RegionFactory::create (src, plist, true /* announce */);
				if (!region) {
					PBD::warning << "foyer_shim: create_region: RegionFactory::create returned null" << endmsg;
					return;
				}
				playlist->add_region (region, Temporal::timepos_t (
					static_cast<Temporal::samplepos_t> (snap.dup_at_samples)));
				shim->session ().set_dirty ();
				// Playlist's RegionAdded signal fires an echo back
				// to the sidecar, which forwards RegionsList.
			});
			break;
		}
		case DecodedCmd::Kind::AudioIngressOpen: {
			const std::uint32_t sid   = cmd.audio_stream_id;
			const std::uint32_t ch    = cmd.audio_channels;
			const std::uint32_t sr    = cmd.audio_sample_rate;
			std::string         name  = cmd.audio_source_name.empty ()
			                            ? std::to_string (sid) : cmd.audio_source_name;
			// Use a conservative frame size if the command didn't carry one.
			const std::uint32_t fsize = 960; // ~20 ms @ 48 kHz

			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, sid, name, ch, sr, fsize, this] () {
				try {
					auto port = std::make_unique<ShimInputPort> (
					    *shim, sid, name, ch, sr, fsize);
					std::string engine_port_name;
					{
						std::lock_guard<std::mutex> lk (this->_ingress_mx);
						this->_ingress_ports[sid] = std::move (port);
						engine_port_name = this->_ingress_ports.at (sid)->engine_port_name ();
					}
					auto ack = msgpack_out::encode_audio_ingress_opened (sid, sr, ch, name, engine_port_name);
					shim->ipc ().send (foyer_ipc::FrameKind::Control, ack);
				} catch (const std::exception& e) {
					PBD::error << "foyer_shim: [ingress] open failed: " << e.what () << endmsg;
				}
			});
			break;
		}
		case DecodedCmd::Kind::AudioIngressClose: {
			const std::uint32_t sid = cmd.audio_stream_id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, sid, this] () {
				{
					std::lock_guard<std::mutex> lk (this->_ingress_mx);
					this->_ingress_ports.erase (sid);
				}
				auto ack = msgpack_out::encode_audio_ingress_closed (sid);
				shim->ipc ().send (foyer_ipc::FrameKind::Control, ack);
			});
			break;
		}
		case DecodedCmd::Kind::SetSequencerLayout: {
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				bool ok = schema_map::set_sequencer_layout (
					shim->session (), snap.track_id, snap.seq_layout);
				if (!ok) return;
				auto bytes = msgpack_out::encode_region_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ClearSequencerLayout: {
			if (cmd.track_id.empty ()) break;
			std::string region_id = cmd.track_id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, region_id] () {
				schema_map::clear_sequencer_layout (shim->session (), region_id);
				auto bytes = msgpack_out::encode_region_updated (shim->session (), region_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ListPluginPresets: {
			if (cmd.plugin_id.empty ()) break;
			std::string plugin_id = cmd.plugin_id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, plugin_id] () {
				auto bytes = msgpack_out::encode_plugin_presets_listed (shim->session (), plugin_id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::LoadPluginPreset: {
			if (cmd.plugin_id.empty () || cmd.preset_id.empty ()) break;
			std::string plugin_id = cmd.plugin_id;
			std::string preset_id = cmd.preset_id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, plugin_id, preset_id] () {
				bool ok = schema_map::load_plugin_preset (shim->session (), plugin_id, preset_id);
				if (!ok) {
					PBD::warning << "foyer_shim: load_plugin_preset: failed for "
					             << plugin_id << " / " << preset_id << endmsg;
				}
				// Preset load re-writes parameter values on the plugin;
				// Ardour's parameter-changed signals already re-emit each
				// controllable so clients will see the new values drift
				// in via the normal control-update stream.
			});
			break;
		}
		case DecodedCmd::Kind::Undo: {
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				shim->session ().undo (1);
			});
			break;
		}
		case DecodedCmd::Kind::Redo: {
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				shim->session ().redo (1);
			});
			break;
		}
		case DecodedCmd::Kind::SetTrackInput: {
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				if (snap.track_id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.track_id.substr (6);
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					if (tmp.str () == sid) { route = r; break; }
				}
				if (!route) {
					PBD::warning << "foyer_shim: set_track_input: unknown track id: " << snap.track_id << endmsg;
					return;
				}
				auto io = route->input ();
				if (io && io->n_ports ().n_audio () > 0) {
					auto port = io->audio (0);
					if (port) {
						port->disconnect_all ();
						if (!snap.patch_input_port.empty ()) {
							const int rv = io->connect (port, snap.patch_input_port);
							if (rv != 0) {
								PBD::error << "foyer_shim: set_track_input: connect("
								           << port->name () << " → " << snap.patch_input_port
								           << ") failed with rv=" << rv << endmsg;
							} else {
								PBD::warning << "foyer_shim: set_track_input: connected "
								          << port->name () << " → " << snap.patch_input_port << endmsg;
							}
						}
					}
				}
				auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::ListPorts: {
			// Port enumeration hits the AudioEngine directly; it's safe
			// off the event loop, but keep it on the slot for consistency
			// with the other shim→session reads.
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto bytes = msgpack_out::encode_ports_listed (snap.ports_direction);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::AddSend: {
			if (cmd.track_id.empty () || cmd.send_target_track.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto find_route = [&] (const std::string& foyer_id) -> std::shared_ptr<Route> {
					if (foyer_id.rfind ("track.", 0) != 0) return {};
					const std::string sid = foyer_id.substr (6);
					std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
					for (auto const& r : *routes) {
						if (!r) continue;
						std::ostringstream tmp;
						tmp << r->id ();
						if (tmp.str () == sid) return r;
					}
					return {};
				};
				auto src    = find_route (snap.track_id);
				auto target = find_route (snap.send_target_track);
				if (!src || !target) {
					PBD::warning << "foyer_shim: add_send: missing src/target: "
					             << snap.track_id << " → " << snap.send_target_track << endmsg;
					return;
				}
				// `before = nullptr` appends the send to the end of the
				// processor chain; Ardour inserts it before the main outs.
				int rv = src->add_aux_send (target, std::shared_ptr<Processor> ());
				if (rv != 0) {
					PBD::warning << "foyer_shim: add_send: add_aux_send returned " << rv << endmsg;
				}
				auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::RemoveSend: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				// Send id is "send.<processor-pbd-id>". Find the owning
				// route by walking every processor list.
				if (snap.id.rfind ("send.", 0) != 0) return;
				const std::string pid = snap.id.substr (5);
				std::shared_ptr<Route> owner;
				std::shared_ptr<Processor> victim;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					r->foreach_processor ([&] (std::weak_ptr<Processor> wp) {
						if (owner) return;
						auto p = wp.lock ();
						if (!p) return;
						std::ostringstream tmp;
						tmp << p->id ();
						if (tmp.str () == pid) { owner = r; victim = p; }
					});
					if (owner) break;
				}
				if (!owner || !victim) {
					PBD::warning << "foyer_shim: remove_send: unknown send id: " << snap.id << endmsg;
					return;
				}
				std::ostringstream owner_id;
				owner_id << "track." << owner->id ();
				owner->remove_processor (victim);
				auto bytes = msgpack_out::encode_track_updated (shim->session (), owner_id.str ());
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::SetSendLevel: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				if (snap.id.rfind ("send.", 0) != 0) return;
				const std::string pid = snap.id.substr (5);
				std::shared_ptr<Route> owner;
				std::shared_ptr<Processor> found;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					r->foreach_processor ([&] (std::weak_ptr<Processor> wp) {
						if (found) return;
						auto p = wp.lock ();
						if (!p) return;
						std::ostringstream tmp;
						tmp << p->id ();
						if (tmp.str () == pid) { owner = r; found = p; }
					});
					if (found) break;
				}
				if (!found) {
					PBD::warning << "foyer_shim: set_send_level: unknown send id: " << snap.id << endmsg;
					return;
				}
				auto snd = std::dynamic_pointer_cast<Send> (found);
				if (!snd) {
					auto isnd = std::dynamic_pointer_cast<InternalSend> (found);
					snd = isnd;
				}
				if (!snd) {
					PBD::warning << "foyer_shim: set_send_level: processor is not a Send" << endmsg;
					return;
				}
				auto gc = snd->gain_control ();
				if (gc) {
					gc->set_value (snap.send_level, PBD::Controllable::NoGroup);
				}
				if (owner) {
					std::ostringstream owner_id;
					owner_id << "track." << owner->id ();
					auto bytes = msgpack_out::encode_track_updated (shim->session (), owner_id.str ());
					if (!bytes.empty ()) {
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
				}
			});
			break;
		}
		case DecodedCmd::Kind::DeleteTrack: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				if (snap.id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.id.substr (6);
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					if (tmp.str () == sid) { route = r; break; }
				}
				if (!route) {
					PBD::warning << "foyer_shim: delete_track: unknown track id: " << snap.id << endmsg;
					return;
				}
				shim->session ().remove_route (route);
				auto bytes = msgpack_out::encode_patch_reload ();
				shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ReorderTracks: {
			if (cmd.ordered_track_ids.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				std::map<std::string, std::shared_ptr<Route>> by_sid;
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					by_sid[tmp.str ()] = r;
				}
				PBD::warning << "foyer_shim: reorder_tracks: ids=";
				for (auto const& x : snap.ordered_track_ids) PBD::warning << x << " ";
				PBD::warning << endmsg;
				ARDOUR::PresentationInfo::ChangeSuspender cs;
				ARDOUR::PresentationInfo::order_t order = 0;
				for (auto const& tid : snap.ordered_track_ids) {
					const std::string sid = tid.rfind ("track.", 0) == 0 ? tid.substr (6) : tid;
					auto it = by_sid.find (sid);
					if (it == by_sid.end () || !it->second) {
						PBD::warning << "foyer_shim: reorder: missing route for sid=" << sid << endmsg;
						continue;
					}
					it->second->set_presentation_order (order++);
				}
				// Keep any routes not listed in their existing relative order.
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					const std::string track_id = "track." + tmp.str ();
					if (std::find (snap.ordered_track_ids.begin (), snap.ordered_track_ids.end (), track_id)
					    != snap.ordered_track_ids.end ()) {
						continue;
					}
					r->set_presentation_order (order++);
				}
				// NOTE: resort_routes() is for the processing graph, not
				// presentation order. It does not need to be called here.
				// The snapshot will be built from snapshot_tracked_routes()
				// which sorts by presentation_info().order().
				PBD::warning << "foyer_shim: reorder_tracks done"
				             << " n_routes=" << by_sid.size ()
				             << endmsg;
				auto bytes = msgpack_out::encode_patch_reload ();
				shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::SetLoopRange: {
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto& session = shim->session ();
				auto* loc = session.locations () ? session.locations ()->auto_loop_location () : nullptr;
				const Temporal::timepos_t start_pos (static_cast<Temporal::samplepos_t> (snap.loop_start_samples));
				const Temporal::timepos_t end_pos   (static_cast<Temporal::samplepos_t> (snap.loop_end_samples));
				if (!loc) {
					auto flags = ARDOUR::Location::Flags (
					    ARDOUR::Location::IsAutoLoop | ARDOUR::Location::IsHidden);
					loc = new ARDOUR::Location (session, start_pos, end_pos, "Loop", flags);
					session.locations ()->add (loc);
					session.set_auto_loop_location (loc);
				} else {
					loc->set_start (start_pos, true);
					loc->set_end (end_pos, true);
				}
				if (snap.has_loop_enabled) {
					const bool looping = session.get_play_loop ();
					if (looping != snap.loop_enabled) {
						shim->loop_toggle ();
					}
				}
				auto bytes = msgpack_out::encode_transport_state (session);
				shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
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
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
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
				if (snap.has_patch_monitoring) {
					// Map the string → ARDOUR::MonitorChoice. Unknown
					// values fall back to MonitorAuto so a typo doesn't
					// strand a track with no monitoring policy.
					ARDOUR::MonitorChoice mc = ARDOUR::MonitorAuto;
					if      (snap.patch_monitoring == "input") mc = ARDOUR::MonitorInput;
					else if (snap.patch_monitoring == "disk")  mc = ARDOUR::MonitorDisk;
					else if (snap.patch_monitoring == "cue")   mc = ARDOUR::MonitorCue;
					auto mon = route->monitoring_control ();
					if (mon) {
						mon->set_value (static_cast<double> (mc),
						                PBD::Controllable::NoGroup);
					}
				}
				if (snap.has_patch_input_port) {
					auto io = route->input ();
					if (io && io->n_ports ().n_audio () > 0) {
						auto port = io->audio (0);
						if (port) {
							port->disconnect_all ();
							if (!snap.patch_input_port.empty ()) {
								const int rv = io->connect (port, snap.patch_input_port);
								if (rv != 0) {
									PBD::error << "foyer_shim: update_track: connect("
									           << port->name () << " → " << snap.patch_input_port
									           << ") failed with rv=" << rv << endmsg;
								} else {
									PBD::warning << "foyer_shim: update_track: connected "
									          << port->name () << " → " << snap.patch_input_port << endmsg;
								}
							}
						}
					}
				}
				if (snap.has_patch_bus_assign) {
					// Re-route the track's main outputs: disconnect first
					// audio output, then connect to the target bus's first
					// audio input. Empty string restores default (no
					// explicit connection, leaving whatever Ardour had).
					auto out_io = route->output ();
					if (out_io && out_io->n_ports ().n_audio () > 0) {
						auto out_port = out_io->audio (0);
						if (out_port) {
							out_port->disconnect_all ();
							if (!snap.patch_bus_assign.empty ()) {
								// Resolve the bus route by foyer id
								// ("track.<pbd-id>") and connect to its
								// first audio input port name.
								const std::string bsid =
									snap.patch_bus_assign.rfind ("track.", 0) == 0
									    ? snap.patch_bus_assign.substr (6)
									    : snap.patch_bus_assign;
								std::shared_ptr<Route> bus;
								for (auto const& r : *routes) {
									if (!r) continue;
									std::ostringstream tmp;
									tmp << r->id ();
									if (tmp.str () == bsid) { bus = r; break; }
								}
								if (bus) {
									auto bus_in = bus->input ();
									if (bus_in && bus_in->n_ports ().n_audio () > 0) {
										auto bus_port = bus_in->audio (0);
										if (bus_port) {
											out_io->connect (out_port, bus_port->name ());
										}
									}
								} else {
									PBD::warning << "foyer_shim: update_track: unknown bus id: "
									             << snap.patch_bus_assign << endmsg;
								}
							}
						}
					}
				}
				bool group_changed = false;
				if (snap.has_patch_group_id) {
					// Accept either "group.<id>" (preferred schema id) or raw
					// Ardour RouteGroup id for backward compatibility.
					std::string gid = snap.patch_group_id;
					if (gid.rfind ("group.", 0) == 0) gid = gid.substr (6);
					std::shared_ptr<RouteGroup> target_group;
					if (!gid.empty ()) {
						for (auto const& rg : shim->session ().route_groups ()) {
							if (!rg) continue;
							std::ostringstream tmp;
							tmp << rg->id ();
							if (tmp.str () == gid) { target_group = rg; break; }
						}
						if (!target_group) {
							PBD::warning << "foyer_shim: update_track: unknown group id: "
							             << snap.patch_group_id << endmsg;
						}
					}
					auto current_group = route->route_group ();
					if (current_group && current_group != target_group) {
						current_group->remove (route);
						group_changed = true;
					}
					if (target_group && target_group != current_group) {
						target_group->add (route);
						group_changed = true;
					}
				}

				if (group_changed) {
					auto bytes = msgpack_out::encode_patch_reload ();
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				} else {
					auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.id);
					if (!bytes.empty ()) {
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
				}
            });
            break;
        }
        case DecodedCmd::Kind::CreateGroup: {
            DecodedCmd snap = cmd;
            FoyerShim* shim = &_shim;
            _shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
                auto& session = shim->session ();
                auto rg = session.new_route_group (snap.group_name);
                if (!rg) {
                    PBD::warning << "foyer_shim: create_group failed for '" << snap.group_name << "'" << endmsg;
                    return;
                }
                if (!snap.group_color.empty ()) {
                    // Convert #RRGGBB[AA] hex string to uint32_t rgba.
                    uint32_t rgba = 0;
                    const std::string& h = snap.group_color;
                    if (h.size () >= 7 && h[0] == '#') {
                        rgba = std::stoul (h.substr (1, 6), nullptr, 16) << 8 | 0xff;
                        if (h.size () >= 9) {
                            rgba = std::stoul (h.substr (1, 8), nullptr, 16);
                        }
                    }
                    if (rgba != 0) rg->set_rgba (rgba);
                }
                for (auto const& tid : snap.group_members) {
                    if (tid.rfind ("track.", 0) != 0) continue;
                    const std::string sid = tid.substr (6);
                    auto routes = schema_map::safe_get_routes (session);
                    for (auto const& r : *routes) {
                        if (!r) continue;
                        std::ostringstream tmp; tmp << r->id ();
                        if (tmp.str () == sid) { rg->add (r); break; }
                    }
                }
                auto bytes = msgpack_out::encode_patch_reload ();
                shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
            });
            break;
        }
        case DecodedCmd::Kind::UpdateGroup: {
            DecodedCmd snap = cmd;
            FoyerShim* shim = &_shim;
            _shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
                auto& session = shim->session ();
                if (snap.id.rfind ("group.", 0) != 0) return;
                const std::string gid = snap.id.substr (6);
                std::shared_ptr<RouteGroup> rg;
                for (auto const& g : session.route_groups ()) {
                    std::ostringstream tmp; tmp << g->id ();
                    if (tmp.str () == gid) { rg = g; break; }
                }
                if (!rg) {
                    PBD::warning << "foyer_shim: update_group: unknown id " << snap.id << endmsg;
                    return;
                }
                if (snap.has_group_patch_name) rg->set_name (snap.group_patch_name);
                if (snap.has_group_patch_color) {
                    uint32_t rgba = 0;
                    const std::string& h = snap.group_patch_color;
                    if (h.size () >= 7 && h[0] == '#') {
                        rgba = std::stoul (h.substr (1, 6), nullptr, 16) << 8 | 0xff;
                        if (h.size () >= 9) {
                            rgba = std::stoul (h.substr (1, 8), nullptr, 16);
                        }
                    }
                    if (rgba != 0) rg->set_rgba (rgba);
                }
                if (snap.has_group_patch_members) {
                    // Rebuild membership: remove all then add listed.
                    for (auto const& r : schema_map::safe_get_routes (session).operator*()) {
                        if (r && r->route_group () == rg) rg->remove (r);
                    }
                    for (auto const& tid : snap.group_patch_members) {
                        if (tid.rfind ("track.", 0) != 0) continue;
                        const std::string sid = tid.substr (6);
                        for (auto const& r : schema_map::safe_get_routes (session).operator*()) {
                            if (!r) continue;
                            std::ostringstream tmp; tmp << r->id ();
                            if (tmp.str () == sid) { rg->add (r); break; }
                        }
                    }
                }
                auto bytes = msgpack_out::encode_patch_reload ();
                shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
            });
            break;
        }
        case DecodedCmd::Kind::DeleteGroup: {
            if (cmd.id.empty ()) break;
            DecodedCmd snap = cmd;
            FoyerShim* shim = &_shim;
            _shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
                auto& session = shim->session ();
                if (snap.id.rfind ("group.", 0) != 0) return;
                const std::string gid = snap.id.substr (6);
                for (auto const& g : session.route_groups ()) {
                    std::ostringstream tmp; tmp << g->id ();
                    if (tmp.str () == gid) {
                        session.remove_route_group (g);
                        break;
                    }
                }
                auto bytes = msgpack_out::encode_patch_reload ();
                shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
            });
            break;
        }
        case DecodedCmd::Kind::InvokeAction: {
			if (cmd.id.empty ()) break;
			// Action verbs live in the Session — they allocate SessionEvents
			// and walk routes, so (like UpdateTrack) we post onto the shim
			// event loop where PBD's per-thread pool is registered.
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto& session = shim->session ();
				const std::string& id = snap.id;

				// Transport verbs: delegate to the BasicUI helpers the
				// ControlSet branch already uses so we get identical
				// semantics whether the user clicks Play or triggers
				// `transport.play` from the command palette.
				if (id == "transport.play")        { shim->signal_bridge ().note_user_play_request (); shim->transport_play (false); }
				else if (id == "transport.stop")   { shim->transport_stop (); }
				else if (id == "transport.record") { shim->rec_enable_toggle (); }
				else if (id == "transport.loop")   { shim->loop_toggle (); }
				else if (id == "transport.goto_start") { session.request_locate (0); }
				else if (id == "transport.goto_end")   { session.request_locate (session.current_end_sample ()); }

				// Edit — Session has these directly, no GUI needed.
				else if (id == "edit.undo")        { session.undo (1); }
				else if (id == "edit.redo")        { session.redo (1); }
				// cut/copy/paste live in the GUI `Editor` action
				// manager and aren't reachable from headless hardour;
				// surface that as a user-visible error so the toast
				// tells them why the click did nothing.
				else if (id == "edit.cut" || id == "edit.copy" || id == "edit.paste") {
					PBD::warning << "foyer_shim: " << id << " only available in GUI Ardour (editor action manager)" << endmsg;
				}

				// Session — save goes through Session directly. Export
				// normally goes through a dialog; for now surface as
				// deferred.
				else if (id == "session.save") {
					session.save_state ("");
				}
				else if (id == "session.export") {
					PBD::warning << "foyer_shim: session.export deferred (template-save not wired)" << endmsg;
				}

				// Track — session.new_audio_track / session.new_audio_route.
				// Mono in, stereo out is the sane default most DAWs ship.
				else if (id == "track.add_audio") {
					session.new_audio_track (
					    1, 2,                           // in/out channels
					    std::shared_ptr<ARDOUR::RouteGroup> (),
					    1,                              // how_many
					    std::string (),                 // name_template (empty = default)
					    ARDOUR::PresentationInfo::max_order);
				}
				else if (id == "track.add_bus") {
					session.new_audio_route (
					    2, 2,
					    std::shared_ptr<ARDOUR::RouteGroup> (),
					    1,
					    std::string (),
					    ARDOUR::PresentationInfo::AudioBus,
					    ARDOUR::PresentationInfo::max_order);
				}
				else if (id == "track.add_midi") {
					// 1-channel MIDI track, no instrument plugin yet
					// (user picks one via the MIDI manager). strict_io
					// off so the user can chain effects post-instrument.
					session.new_midi_track (
					    ARDOUR::ChanCount (ARDOUR::DataType::MIDI, 1),
					    ARDOUR::ChanCount (ARDOUR::DataType::AUDIO, 2),
					    false /* strict_io */,
					    std::shared_ptr<ARDOUR::PluginInfo> () /* instrument */,
					    nullptr /* preset */,
					    std::shared_ptr<ARDOUR::RouteGroup> (),
					    1, std::string (),
					    ARDOUR::PresentationInfo::max_order,
					    ARDOUR::Normal,
					    true  /* input_auto_connect */);
				}
				else if (id == "track.freeze") {
					PBD::warning << "foyer_shim: track.freeze not yet wired" << endmsg;
				}

				// Plugin: ask Ardour's PluginManager to rescan its
				// search paths. The rescan runs on whatever thread
				// PluginManager schedules; we just kick it off. Clients
				// re-issue `list_plugins` after a short delay (the
				// picker modal does this automatically).
				else if (id == "plugin.rescan") {
					ARDOUR::PluginManager::instance ().refresh ();
				}

				// Settings / view actions are client-side — log so the
				// gap is visible if one leaks through.
				else {
					PBD::warning << "foyer_shim: invoke_action not handled: " << id << endmsg;
				}
			});
			break;
		}
		case DecodedCmd::Kind::AddPlugin: {
			if (cmd.track_id.empty () || cmd.plugin_uri.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				// Find the target track.
				if (snap.track_id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.track_id.substr (6);
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					if (tmp.str () == sid) { route = r; break; }
				}
				if (!route) {
					PBD::warning << "foyer_shim: add_plugin: unknown track " << snap.track_id << endmsg;
					return;
				}

				// Try each plugin type in turn. LV2 first (most common
				// on Linux), then LADSPA, VST3, Lua. find_plugin does
				// a straight unique_id match so it's cheap to miss.
				static const ARDOUR::PluginType order[] = {
					ARDOUR::LV2, ARDOUR::LADSPA, ARDOUR::VST3, ARDOUR::Lua,
				};
				std::shared_ptr<ARDOUR::Plugin> plug;
				for (auto t : order) {
					plug = ARDOUR::find_plugin (shim->session (), snap.plugin_uri, t);
					if (plug) break;
				}
				if (!plug) {
					PBD::warning << "foyer_shim: add_plugin: no plugin with unique_id '" << snap.plugin_uri << "'" << endmsg;
					return;
				}

				auto pi = std::make_shared<ARDOUR::PluginInsert> (shim->session (), shim->session (), plug);
				if (route->add_processor (pi, ARDOUR::PreFader, nullptr, true) != 0) {
					PBD::warning << "foyer_shim: add_plugin: Route::add_processor failed for " << snap.plugin_uri << endmsg;
					return;
				}
				// Success — ask the signal bridge to re-emit the route's
				// snapshot so clients see the new plugin instance.
				auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::RemovePlugin: {
			if (cmd.plugin_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				// plugin_id format is "plugin.<pbd-id>" — reuse the
				// same resolution pattern ControlSet uses for the
				// bypass toggle.
				if (snap.plugin_id.rfind ("plugin.", 0) != 0) return;
				const std::string pid = snap.plugin_id.substr (7);
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				std::string affected_track;
				for (auto const& r : *routes) {
					if (!r) continue;
					for (uint32_t i = 0; ; ++i) {
						auto proc = r->nth_plugin (i);
						if (!proc) break;
						auto pi = std::dynamic_pointer_cast<PluginInsert> (proc);
						if (!pi) continue;
						std::ostringstream os; os << pi->id ();
						if (os.str () != pid) continue;
						if (r->remove_processor (proc) == 0) {
							std::ostringstream tid;
							tid << r->id ();
							affected_track = "track." + tid.str ();
						} else {
							PBD::warning << "foyer_shim: remove_plugin: Route::remove_processor failed" << endmsg;
						}
						break;
					}
					if (!affected_track.empty ()) break;
				}
				if (affected_track.empty ()) {
					PBD::warning << "foyer_shim: remove_plugin: plugin_id not found: " << snap.plugin_id << endmsg;
					return;
				}
				auto bytes = msgpack_out::encode_track_updated (shim->session (), affected_track);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::SaveSession: {
			// `out.id` holds `as_path` (possibly empty = save in place).
			std::string as_path = cmd.id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, as_path] () {
				PBD::warning << "foyer_shim: save_session as_path='" << as_path << "'" << endmsg;
				shim->session ().save_state (as_path);
			});
			break;
		}
		case DecodedCmd::Kind::AudioStreamOpen: {
			// M6a: install a MasterTap processor on the master route
			// so audio samples flow into our ring buffer. Today we
			// only support `source="master"`; track-level taps land
			// alongside the per-track preview feature.
			if (cmd.audio_source != "master") {
				PBD::warning << "foyer_shim: audio_stream_open: only source=master wired "
				             << "today (got '" << cmd.audio_source << "') — ignoring"
				             << endmsg;
				break;
			}
			const std::uint32_t stream_id = cmd.audio_stream_id;
			const std::uint32_t channels  = cmd.audio_channels;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, stream_id, channels] () {
				auto& session = shim->session ();
				// Prefer master_out() — it's a single-pointer read, no RCU.
				// If it's null we fall back to walking our own tracked
				// weak_ptr cache (safe against RCU teardown races) and
				// picking out the master there. Calling
				// `schema_map::safe_get_routes` here would reach into
				// Ardour's RCU and has crashed in the past.
				auto master = session.master_out ();
				if (!master) {
					auto tracked = shim->signal_bridge ().snapshot_tracked_routes ();
					for (auto const& r : tracked) {
						if (r && r->is_master ()) { master = r; break; }
					}
				}
				if (!master) {
					auto tracked = shim->signal_bridge ().snapshot_tracked_routes ();
					PBD::warning << "foyer_shim: audio_stream_open: no master route. "
					             << "tracked_routes=" << tracked.size ()
					             << " (session.master_out() null AND no is_master in cache — "
					             << "session probably not done loading; sidecar should retry)"
					             << endmsg;
					return;
				}
				auto tap = std::make_shared<MasterTap> (*shim, shim->session (), stream_id, channels);
				// Log the master's pre-insert processor names so we
				// can correlate with whether our tap actually lands
				// in the chain after `add_processor`.
				{
					std::ostringstream pre;
					master->foreach_processor (
					    [&pre] (std::weak_ptr<ARDOUR::Processor> wp) {
					        auto p = wp.lock ();
					        if (p) pre << " [" << p->display_name () << " active=" << p->active () << "]";
					    });
					PBD::warning << "foyer_shim: [audio] master BEFORE add:" << pre.str ()
					             << " n_inputs.audio=" << master->n_inputs ().n_audio ()
					             << " n_outputs.audio=" << master->n_outputs ().n_audio ()
					             << endmsg;
				}
				// Capture err so we can see WHY insertion might silently
				// fail even when add_processor returns 0 (observed:
				// tap_found_in_chain=0 with rc=0, so something inside
				// add_processors is either rolling back via pstate
				// without returning -1, or silently adding us to the
				// skip-list).
				ARDOUR::Route::ProcessorStreams err;
				const int add_rc = master->add_processor (tap, ARDOUR::PostFader, &err, true /* activation */);
				PBD::warning << "foyer_shim: [audio] add_processor rc=" << add_rc
				             << " err.index=" << err.index
				             << " err.count.audio=" << err.count.n_audio ()
				             << " err.count.midi=" << err.count.n_midi ()
				             << endmsg;
				if (add_rc != 0) {
					PBD::warning << "foyer_shim: audio_stream_open: add_processor failed" << endmsg;
					return;
				}
				{
					std::ostringstream post;
					bool tap_found = false;
					void* tap_addr = tap.get ();
					master->foreach_processor (
					    [&post, &tap_found, tap_addr] (std::weak_ptr<ARDOUR::Processor> wp) {
					        auto p = wp.lock ();
					        if (p) {
					            post << " [" << p->display_name ()
					                 << " active=" << p->active ()
					                 << " addr=" << (void*) p.get () << "]";
					            if ((void*) p.get () == tap_addr) tap_found = true;
					        }
					    });
					PBD::warning << "foyer_shim: [audio] master AFTER add:" << post.str ()
					             << " tap_addr=" << tap_addr
					             << " tap_found_in_chain=" << tap_found << endmsg;
				}
				// `add_processor` allows activation but doesn't
				// itself flip the active flag — the base Processor
				// starts `_pending_active = false`, so without this
				// call Ardour's process loop skips our `run()`
				// entirely (observed live: `run=0 silence=0` in the
				// drain-loop diagnostic). Calling `activate()` both
				// sets `_pending_active = true` AND fires the
				// `ActiveChanged` signal the process thread watches.
				tap->activate ();
				PBD::warning << "foyer_shim: [audio] stream_id=" << stream_id
				             << " post-activate: active=" << tap->active ()
				             << " enabled=" << tap->enabled () << endmsg;
				tap->start_drain ();
				{
					std::lock_guard<std::mutex> g (self->_taps_mx);
					self->_taps[stream_id] = tap;
				}
				PBD::warning << "foyer_shim: [audio] stream_id=" << stream_id
				             << " attached master tap + drain" << endmsg;
				// ACK so the sidecar's HostBackend::open_egress oneshot
				// resolves; without this the Rust side times out.
				auto ack = msgpack_out::encode_audio_egress_started (stream_id);
				shim->ipc ().send (foyer_ipc::FrameKind::Control, ack);
			});
			break;
		}
		case DecodedCmd::Kind::AudioStreamClose: {
			const std::uint32_t stream_id = cmd.audio_stream_id;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, stream_id] () {
				std::shared_ptr<MasterTap> tap;
				{
					std::lock_guard<std::mutex> g (self->_taps_mx);
					auto it = self->_taps.find (stream_id);
					if (it != self->_taps.end ()) {
						tap = it->second;
						self->_taps.erase (it);
					}
				}
				if (!tap) {
					PBD::warning << "foyer_shim: [audio] close: no tap for stream_id="
					             << stream_id << endmsg;
					return;
				}
				auto master = shim->session ().master_out ();
				if (master) {
					master->remove_processor (tap);
				}
				tap->stop_drain ();
				PBD::warning << "foyer_shim: [audio] stream_id=" << stream_id
				             << " tap removed" << endmsg;
				auto ack = msgpack_out::encode_audio_egress_stopped (stream_id);
				shim->ipc ().send (foyer_ipc::FrameKind::Control, ack);
			});
			break;
		}
		case DecodedCmd::Kind::SetAutomationMode: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (shim->session (), snap.lane_id));
				if (!ac) {
					PBD::warning << "foyer_shim: set_automation_mode: unknown lane " << snap.lane_id << endmsg;
					return;
				}
				auto alist = ac->alist ();
				if (!alist) return;
				ARDOUR::AutoState st = ARDOUR::Off;
				if      (snap.auto_mode == "play")   st = ARDOUR::Play;
				else if (snap.auto_mode == "write")  st = ARDOUR::Write;
				else if (snap.auto_mode == "touch")  st = ARDOUR::Touch;
				else if (snap.auto_mode == "latch")  st = ARDOUR::Latch;
				else if (snap.auto_mode == "manual") st = ARDOUR::Off; // UI calls Off "manual"
				alist->set_automation_state (st);
				auto bytes = msgpack_out::encode_track_updated (shim->session (), schema_map::track_id_for_control (shim->session (), snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::AddAutomationPoint: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (shim->session (), snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				alist->add (Temporal::timepos_t (static_cast<Temporal::samplepos_t> (snap.auto_point.time_samples)), snap.auto_point.value);
				auto bytes = msgpack_out::encode_track_updated (shim->session (), schema_map::track_id_for_control (shim->session (), snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::UpdateAutomationPoint: {
			if (cmd.lane_id.empty () || !cmd.has_auto_orig_time) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (shim->session (), snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				// Rebuild the lane around the point at `auto_orig_time`.
				// Matching on (time,value) is fragile because the UI sends
				// the *new* value; using nearest-time replacement avoids
				// value-mismatch snap-back when dragging.
				std::vector<std::pair<Temporal::samplepos_t, double>> pts;
				{
					PBD::RWLock::ReaderLock lm (alist->lock ());
					pts.reserve (alist->events ().size ());
					for (auto const* ev : alist->events ()) {
						if (!ev) continue;
						pts.emplace_back (ev->when.samples (), ev->value);
					}
				}
				const Temporal::samplepos_t target =
				    static_cast<Temporal::samplepos_t> (snap.auto_orig_time);
				std::size_t best_idx = static_cast<std::size_t> (-1);
				Temporal::samplepos_t best_dist = std::numeric_limits<Temporal::samplepos_t>::max ();
				for (std::size_t i = 0; i < pts.size (); ++i) {
					const auto cur = pts[i].first;
					const auto dist = cur > target ? (cur - target) : (target - cur);
					if (dist < best_dist) {
						best_dist = dist;
						best_idx = i;
					}
				}
				const Temporal::samplepos_t new_time = static_cast<Temporal::samplepos_t> (
				    snap.has_auto_new_time ? snap.auto_new_time : snap.auto_orig_time);
				if (best_idx != static_cast<std::size_t> (-1)) {
					pts[best_idx] = { new_time, snap.auto_point.value };
				} else {
					pts.push_back ({ new_time, snap.auto_point.value });
				}
				alist->clear ();
				for (auto const& pt : pts) {
					alist->add (Temporal::timepos_t (pt.first), pt.second);
				}
				auto bytes = msgpack_out::encode_track_updated (shim->session (), schema_map::track_id_for_control (shim->session (), snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::DeleteAutomationPoint: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (shim->session (), snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				alist->erase (
					Temporal::timepos_t (static_cast<Temporal::samplepos_t> (snap.auto_point.time_samples)),
					snap.auto_point.value);
				auto bytes = msgpack_out::encode_track_updated (shim->session (), schema_map::track_id_for_control (shim->session (), snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ReplaceAutomationLane: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (shim->session (), snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				// Avoid fast_simple_add under a manually-held writer lock; using
				// public mutators here has been markedly safer across Ardour
				// builds when replacing the entire lane.
				alist->clear ();
				for (auto const& pt : snap.auto_points) {
					alist->add (Temporal::timepos_t (static_cast<Temporal::samplepos_t> (pt.time_samples)), pt.value);
				}
				alist->mark_dirty ();
				auto bytes = msgpack_out::encode_track_updated (shim->session (), schema_map::track_id_for_control (shim->session (), snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
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
