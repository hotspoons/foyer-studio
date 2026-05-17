// SPDX-License-Identifier: GPL-2.0-or-later
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
#include <cctype>
#include <csignal>
#include <cstring>
#include <filesystem>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "ardour/async_midi_port.h"
#include "ardour/audio_port.h"
#include "ardour/audioengine.h"
#include "ardour/audioregion.h"
#include "ardour/automation_control.h"
#include "ardour/delivery.h"
#include "ardour/gain_control.h"
#include "ardour/internal_send.h"
#include "ardour/midi_model.h"
#include "ardour/midi_region.h"
#include "ardour/reverse.h"
#include "ardour/strip_silence.h"
#include "ardour/dB.h"
#include "ardour/interthread_info.h"
#include "ardour/rc_configuration.h"

#include <cmath>

#include "pbd/progress.h"
#include <rubberband/RubberBandStretcher.h>
#include "ardour/midi_source.h"
#include "ardour/timefx_request.h"
#include "ardour/midi_stretch.h"
#include "ardour/stretch.h"
#include "ardour/midi_track.h"
#include "ardour/types.h"
#include "ardour/monitor_control.h"
#include "ardour/location.h"
#include "ardour/playlist.h"
#include "ardour/region_factory.h"
#include "ardour/source_factory.h"
#include "ardour/audiofilesource.h"
#include "ardour/file_source.h"
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
#include "evoral/midi_events.h"
#include "ardour/automation_list.h"
#include "pbd/controllable.h"
#include "pbd/error.h"
#include "pbd/memento_command.h"
#include "pbd/stateful_diff_command.h"
#include "temporal/beats.h"
#include "temporal/timeline.h"

#include <sndfile.h>

#include "ipc.h"
#include "master_tap.h"
#include "msgpack_out.h"
#include "schema_map.h"
#include "shim_input_port.h"
#include "shim_midi_input_port.h"
#include "surface.h"

using namespace ARDOUR;
using namespace PBD;

namespace ArdourSurface {

namespace {

/// Playback channel 0..15 for region-embedded patch events, from the track's
/// playback filter (Force / Filter use the first set bit; else 0).
static std::uint8_t
foyer_playback_wire_channel_for_patch (std::shared_ptr<MidiTrack> const& mt)
{
	if (!mt) {
		return 0;
	}
	ChannelMode const  mode = mt->get_playback_channel_mode ();
	std::uint16_t const mask = mt->get_playback_channel_mask ();
	if (mode == ForceChannel || mode == FilterChannels) {
		if (!mask) {
			return 0;
		}
		for (std::uint8_t i = 0; i < 16; ++i) {
			if (mask & (1u << i)) {
				return i;
			}
		}
	}
	return 0;
}

/// RBEffect::run() requires a non-null `Progress*` (it calls
/// `progress->set_progress()` with no guard). The editor passes
/// `TimeFXDialog`; we use this stub on the control-surface thread.
struct FoyerRBProgress final : PBD::Progress {
private:
	void set_overall_progress (float) override {}
};

/// New MIDI regions start with no patch-change rows; playback then never sends
/// bank/program before notes. Seed tick 0 to match live track patch state.
static void
foyer_seed_default_region_patch_change (
    Session&                         session,
    std::shared_ptr<Track> const&   track,
    std::shared_ptr<Region> const&  region)
{
	auto mr = std::dynamic_pointer_cast<MidiRegion> (region);
	if (!mr) {
		return;
	}
	auto model = mr->model ();
	if (!model) {
		return;
	}
	std::uint8_t ch      = 0;
	int          bank    = -1;
	std::uint8_t program = 0;
	if (auto mt = std::dynamic_pointer_cast<MidiTrack> (track)) {
		ch = foyer_playback_wire_channel_for_patch (mt);
		auto bank_msb = mt->automation_control (
		    Evoral::Parameter (MidiCCAutomation, ch, MIDI_CTL_MSB_BANK), true);
		auto bank_lsb = mt->automation_control (
		    Evoral::Parameter (MidiCCAutomation, ch, MIDI_CTL_LSB_BANK), true);
		if (bank_msb && bank_lsb) {
			bank = ((static_cast<int> (bank_msb->get_value ()) & 0x7f) << 7)
			     | (static_cast<int> (bank_lsb->get_value ()) & 0x7f);
		}
		auto program_ctl = mt->automation_control (
		    Evoral::Parameter (MidiPgmChangeAutomation, ch), true);
		if (program_ctl) {
			program = static_cast<std::uint8_t> (std::clamp (
			    static_cast<int> (program_ctl->get_value ()), 0, 127));
		}
	}
	auto pc = std::make_shared<Evoral::PatchChange<Temporal::Beats>> (
	    Temporal::Beats::ticks (0), ch, program, bank);
	auto* diff =
	    model->new_patch_change_diff_command ("foyer default patch on new region");
	diff->add (pc);
	model->apply_diff_command_as_commit (session, diff);
}

/// Wire `fade_*_shape` strings → `ARDOUR::FadeShape` (matches `foyer_schema::FadeShape`).
static FadeShape
parse_fade_shape (std::string const& s)
{
	if (s == "fast") {
		return FadeFast;
	}
	if (s == "slow") {
		return FadeSlow;
	}
	if (s == "constant_power") {
		return FadeConstantPower;
	}
	if (s == "symmetric") {
		return FadeSymmetric;
	}
	return FadeLinear;
}

// ---- tiny msgpack reader (what we need for inbound commands) ----
//
// This only supports the shapes the sidecar actually sends: Envelope with map
// bodies, strs, floats/ints/bools. It deliberately rejects anything else so a
// malformed peer can't trip us into undefined territory.

struct In
{
	const std::uint8_t* p;
	const std::uint8_t* end;
	bool failed { false };
	int depth { 0 };

	// Cap per-message recursion depth and per-array element counts.
	// A malicious peer can pack `0xdd ff ff ff ff` to claim a 4G-element
	// array; without a cap the loop iterates 4G times even though
	// each take_u8 fails fast — that's still a CPU burn primitive.
	// We cap at the bytes remaining (you can't have more elements than
	// bytes once each element is at least 1 byte) and at a sane upper
	// bound so reserve()-callers can't be tricked into huge allocs.
	static constexpr int MaxDepth = 64;
	static constexpr std::size_t MaxArrayCount = 1u << 20; // 1M

	bool ok () const { return !failed && p <= end; }
	std::size_t remaining () const { return failed ? 0 : static_cast<std::size_t> (end - p); }
	bool have (std::size_t n) const { return !failed && n <= remaining (); }
	void fail () { failed = true; }

	// Cap a wire-supplied count to whatever's actually decodable from
	// the remaining bytes (and a hard upper bound). Used everywhere a
	// length comes off the wire and feeds an alloc/reserve/loop.
	std::size_t cap_count (std::size_t n) const
	{
		std::size_t lim = std::min<std::size_t> (MaxArrayCount, remaining ());
		return std::min (n, lim);
	}

	std::uint8_t peek ()
	{
		if (!have (1)) { fail (); return 0; }
		return *p;
	}
	std::uint8_t take_u8 ()
	{
		if (!have (1)) { fail (); return 0; }
		return *p++;
	}
	std::uint16_t take_be16 ()
	{
		if (!have (2)) { fail (); return 0; }
		std::uint16_t v = (std::uint16_t (p[0]) << 8) | p[1];
		p += 2;
		return v;
	}
	std::uint32_t take_be32 ()
	{
		if (!have (4)) { fail (); return 0; }
		std::uint32_t v = (std::uint32_t (p[0]) << 24)
		                | (std::uint32_t (p[1]) << 16)
		                | (std::uint32_t (p[2]) << 8)
		                |  std::uint32_t (p[3]);
		p += 4;
		return v;
	}
	std::uint64_t take_be64 ()
	{
		std::uint64_t hi = take_be32 ();
		std::uint64_t lo = take_be32 ();
		return (hi << 32) | lo;
	}

	bool read_str (std::string& out)
	{
		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		std::size_t n = 0;
		if ((b & 0xe0) == 0xa0) n = b & 0x1f;
		else if (b == 0xd9) n = take_u8 ();
		else if (b == 0xda) n = take_be16 ();
		else if (b == 0xdb) n = take_be32 ();
		else return false;
		if (!have (n)) return false;
		out.assign (reinterpret_cast<const char*> (p), n);
		p += n;
		return ok ();
	}

	/// MessagePack `nil` (save in place) or a string (`save_as` target folder).
	bool read_nil_or_str (std::string& out)
	{
		if (!have (1)) return false;
		if (peek () == 0xc0) {
			take_u8 ();
			out.clear ();
			return ok ();
		}
		return read_str (out);
	}

	bool read_f64 (double& out)
	{
		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		if (b == 0xca) {
			std::uint32_t bits = take_be32 ();
			if (failed) return false;
			float f; std::memcpy (&f, &bits, 4); out = f; return true;
		}
		if (b == 0xcb) {
			std::uint64_t bits = take_be64 ();
			if (failed) return false;
			std::memcpy (&out, &bits, 8); return true;
		}
		if (b <= 0x7f)  { out = static_cast<double> (b); return true; }
		if (b >= 0xe0)  { out = static_cast<double> (static_cast<std::int8_t> (b)); return true; }
		if (b == 0xcc)  { auto v = take_u8 ();  if (failed) return false; out = static_cast<double> (v); return true; }
		if (b == 0xcd)  { auto v = take_be16 (); if (failed) return false; out = static_cast<double> (v); return true; }
		if (b == 0xce)  { auto v = take_be32 (); if (failed) return false; out = static_cast<double> (v); return true; }
		if (b == 0xcf)  { auto v = take_be64 (); if (failed) return false; out = static_cast<double> (v); return true; }
		if (b == 0xd0)  { auto v = take_u8 ();  if (failed) return false; out = static_cast<double> (static_cast<std::int8_t> (v)); return true; }
		if (b == 0xc3)  { out = 1.0; return true; }
		if (b == 0xc2)  { out = 0.0; return true; }
		return false;
	}

	bool read_u64 (std::uint64_t& out)
	{
		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		if (b <= 0x7f)  { out = b; return true; }
		if (b == 0xcc)  { auto v = take_u8 ();  if (failed) return false; out = v; return true; }
		if (b == 0xcd)  { auto v = take_be16 (); if (failed) return false; out = v; return true; }
		if (b == 0xce)  { auto v = take_be32 (); if (failed) return false; out = v; return true; }
		if (b == 0xcf)  { auto v = take_be64 (); if (failed) return false; out = v; return true; }
		// Positive-but-signed forms also show up on the wire when serde picks
		// the smallest representation; accept them.
		if (b == 0xd0)  { std::int8_t v  = static_cast<std::int8_t>  (take_u8 ());  if (failed || v < 0) return false; out = v; return true; }
		if (b == 0xd1)  { std::int16_t v = static_cast<std::int16_t> (take_be16 ()); if (failed || v < 0) return false; out = v; return true; }
		if (b == 0xd2)  { std::int32_t v = static_cast<std::int32_t> (take_be32 ()); if (failed || v < 0) return false; out = v; return true; }
		if (b == 0xd3)  { std::int64_t v = static_cast<std::int64_t> (take_be64 ()); if (failed || v < 0) return false; out = static_cast<std::uint64_t> (v); return true; }
		return false;
	}

	bool read_bool (bool& out)
	{
		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		if (b == 0xc2) { out = false; return true; }
		if (b == 0xc3) { out = true;  return true; }
		return false;
	}

	bool read_map_header (std::size_t& n)
	{
		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		if ((b & 0xf0) == 0x80) { n = b & 0x0f; return true; }
		if (b == 0xde) { n = take_be16 (); return ok (); }
		if (b == 0xdf) { n = take_be32 (); return ok (); }
		return false;
	}

	bool skip_value ()
	{
		if (depth >= MaxDepth) { fail (); return false; }
		++depth;
		struct DepthGuard { int& d; ~DepthGuard () { --d; } } guard { depth };

		if (!have (1)) return false;
		std::uint8_t b = take_u8 ();
		if ((b & 0xe0) == 0xa0) { std::size_t n = b & 0x1f; if (!have (n)) return false; p += n; return true; }
		if (b == 0xd9) { std::size_t n = take_u8 ();  if (!have (n)) return false; p += n; return true; }
		if (b == 0xda) { std::size_t n = take_be16 (); if (!have (n)) return false; p += n; return true; }
		if (b == 0xdb) { std::size_t n = take_be32 (); if (!have (n)) return false; p += n; return true; }
		if (b <= 0x7f || b >= 0xe0 || b == 0xc0 || b == 0xc2 || b == 0xc3) return true;
		if (b == 0xcc || b == 0xd0) { if (!have (1)) return false; p += 1; return true; }
		if (b == 0xcd || b == 0xd1) { if (!have (2)) return false; p += 2; return true; }
		if (b == 0xca || b == 0xce || b == 0xd2) { if (!have (4)) return false; p += 4; return true; }
		if (b == 0xcb || b == 0xcf || b == 0xd3) { if (!have (8)) return false; p += 8; return true; }
		if ((b & 0xf0) == 0x90) {
			std::size_t n = cap_count (b & 0x0f);
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xdc) {
			std::size_t n = cap_count (take_be16 ());
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return ok ();
		}
		if (b == 0xdd) {
			std::size_t n = cap_count (take_be32 ());
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return ok ();
		}
		if ((b & 0xf0) == 0x80) {
			std::size_t pairs = b & 0x0f;
			std::size_t n = cap_count (pairs * 2);
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return true;
		}
		if (b == 0xde) {
			std::size_t pairs = take_be16 ();
			std::size_t n = cap_count (pairs * 2);
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return ok ();
		}
		if (b == 0xdf) {
			std::size_t pairs = take_be32 ();
			std::size_t n = cap_count (pairs * 2);
			for (std::size_t i = 0; i < n; ++i) { if (!skip_value ()) return false; }
			return ok ();
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
		ListAudioPool,
		ImportAudio,
		UpdateRegion,
		DeleteRegion,
		UpdateTrack,
		InvokeAction,
		AddPlugin,
		RemovePlugin,
		MovePlugin,
		OpenPluginGui,
		ClosePluginGui,
		SaveSession,
		AddNote,
		UpdateNote,
		DeleteNote,
		AddPatchChange,
		UpdatePatchChange,
		DeletePatchChange,
		SetTrackMidiPatch,
		Undo,
		Redo,
		ListPluginPresets,
		ListMidiPatchNames,
		LoadPluginPreset,
		SetSequencerLayout,
		ClearSequencerLayout,
		MidiInput,
		AudioIngressOpen,
		AudioIngressClose,
		SetIngressCaptureLatency,
		SetIngressRingPrimeMs,
		SetMidiCaptureLatency,
		DuplicateRegion,
		DuplicateRegionRange,
		StretchRegion,
		SplitRegion,
		ReverseRegion,
		CombineRegions,
		StripSilenceRegion,
		PitchShiftRegion,
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
		SetTrackMidiChannelMode,
		ShimQuit,
		SetLoopRange,
		CreateGroup,
		UpdateGroup,
		DeleteGroup,
		UndoGroupBegin,
		UndoGroupEnd,
		ListScripts,
		SaveScript,
		DeleteScript,
		EnableScript,
		RunScript,
		RecoverDisabledScripts,
		// Real-time spectrogram pipeline (instant + temporal, per-
		// channel + main mix). The wire surface lives on the Rust
		// side today; the shim's FFT path is the remaining bit of
		// work — see the dispatch arm below + the `spectrum` field
		// in `encode_session_snapshot`. Subscribing emits a polite
		// "not yet wired" error so the FE can fall back to the stub
		// backend for demos.
		SubscribeSpectrum,
		UnsubscribeSpectrum,
	};
	Kind kind = Kind::Unknown;
	std::string id;
	std::string track_id;
	std::string plugin_uri;   // Command::AddPlugin
	std::string plugin_id;    // Command::RemovePlugin / MovePlugin (= "plugin.<pid>")
	std::string preset_id;    // Command::LoadPluginPreset (preset URI)
	std::uint32_t move_new_index = 0;  // Command::MovePlugin {new_index}
	std::string clone_from;   // Command::AddPlugin {clone_from?} (= "plugin.<pid>")
	double value = 0.0;

	// Audio stream fields (AudioStreamOpen / Close / IngressOpen).
	std::uint32_t audio_stream_id  = 0;
	std::string   audio_source;       // "master" | "track.<id>" | "monitor" | "virtual_input"
	std::string   audio_source_name;  // name from VirtualInput { name: ... }
	std::uint32_t audio_channels     = 2;
	std::uint32_t audio_sample_rate  = 48000;
	std::uint32_t audio_frame_size   = 0;

	// RegionPatch fields — only read for UpdateRegion. All optional.
	bool          has_patch_start   = false;
	std::int64_t  patch_start       = 0;
	bool          has_patch_length  = false;
	std::uint64_t patch_length      = 0;
	// Source-media offset (Ardour's `Region::start`). Carried in a
	// RegionPatch so a left-edge trim drag advances the source
	// offset atomically with the new timeline position + length.
	bool          has_patch_source_offset = false;
	std::uint64_t patch_source_offset     = 0;
	bool          has_patch_name    = false;
	std::string   patch_name;
	bool          has_patch_muted   = false;
	bool          patch_muted       = false;
	// Audio fades / region gain (`RegionPatch` — audio regions only).
	bool          has_patch_fade_in = false;
	std::uint64_t patch_fade_in     = 0;
	bool          has_patch_fade_out = false;
	std::uint64_t patch_fade_out    = 0;
	bool          has_patch_fade_in_shape = false;
	std::string   patch_fade_in_shape;
	bool          has_patch_fade_out_shape = false;
	std::string   patch_fade_out_shape;
	bool          has_patch_gain_linear = false;
	double        patch_gain_linear = 1.0;
	// Render layer (bring-to-front / send-to-back). Maps onto
	// `Playlist::set_layer (region, double)`. Optional — when absent
	// we leave Ardour's auto-layer logic alone.
	bool          has_patch_layer = false;
	std::int64_t  patch_layer = 0;
	// Cross-track move target. When set, the region is removed
	// from its source playlist and re-added on the destination
	// playlist (looked up by Foyer track id) at the patched
	// position. Kind compatibility is the sidecar's job; by the
	// time this lands in the shim we trust the move is legal.
	bool          has_patch_track_id = false;
	std::string   patch_track_id;

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

	// DuplicateRegion / CreateRegion / SplitRegion `at_samples` (signed on
	// the wire so regions left of the timeline zero still decode).
	bool          has_cmd_at_samples   = false;
	std::int64_t  cmd_at_samples_i64   = 0;

	// DuplicateRegion payload (reuses cmd_at_samples_i64 via has_cmd_at_samples).
	std::string   dup_source_id;
	bool          dup_has_length = false;
	std::uint64_t dup_length_samples = 0;
	// Cross-track paste destination. When set on DuplicateRegion /
	// DuplicateRegionRange, the clone is placed on the destination
	// playlist instead of the source's. Empty = paste onto source
	// track (back-compat).
	bool          dup_has_target_track_id = false;
	std::string   dup_target_track_id;
	// DuplicateRegionRange payload — same source_id + at_samples as
	// DuplicateRegion plus a slice carve-out. `dup_source_offset_samples`
	// is the offset INTO the source region's content, not into the
	// underlying media; the handler adds it to the source's own start
	// offset to get the absolute source-media position.
	std::uint64_t dup_source_offset_samples = 0;

	// CreateRegion payload. Shares at/length/name with DuplicateRegion /
	// RegionPatch; `create_kind` is the region's media type ("midi"
	// or "audio"). Audio regions require `create_source_path` to
	// resolve to a pool entry.
	std::string   create_kind;
	std::string   create_source_path;

	// StretchRegion payload.
	bool          has_stretch_new_start   = false;
	std::int64_t  stretch_new_start_i64 = 0;
	bool          has_stretch_new_length = false;
	std::uint64_t stretch_new_length_u64 = 0;
	std::string   stretch_anchor;
	bool          stretch_preserve_pitch = true;

	// CombineRegions — region id list (same track).
	std::vector<std::string> combine_region_ids;

	// StripSilenceRegion — optional analysis parameters (Ardour strip-silence dialog).
	double       strip_threshold_db = -48.0;
	bool         has_strip_threshold = false;
	std::uint64_t strip_minimum_length_samples = 2048;
	bool         has_strip_minimum_length = false;
	std::uint64_t strip_fade_length_samples = 64;
	bool         has_strip_fade_length = false;

	// PitchShiftRegion
	double       pitch_semitones = 0.0;
	bool         has_pitch_semitones = false;

	// ImportAudio payload — absolute path on the host.
	std::string   import_audio_path;

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
	bool          has_group_patch_active = false;
	bool          group_patch_active = true;
	bool          has_group_patch_link_gain = false;
	bool          group_patch_link_gain = true;
	bool          has_group_patch_link_mute = false;
	bool          group_patch_link_mute = true;
	bool          has_group_patch_link_solo = false;
	bool          group_patch_link_solo = true;
	bool          has_group_patch_link_record = false;
	bool          group_patch_link_record = true;

	// SetTrackMidiChannelMode { track_id, direction, mode, mask }.
	// `direction` is "capture" | "playback" (reuses `ports_direction`);
	// `mode` is "all" | "filter" | "force" (reuses `auto_mode`); `mask`
	// is a 16-bit channel bitmask (bit 0 = ch 1) — its own field since
	// no other command carries a u16 mask.
	std::uint16_t midi_chan_mask = 0;
	// ListMidiPatchNames { track_id, channel } and
	// SetTrackMidiPatch { track_id, channel, bank, program }.
	std::uint8_t  midi_channel = 0;

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

	// MidiInput payload — raw 1–3 byte MIDI message off the wire,
	// destined for the shim's `Foyer Web MIDI` virtual port. Capped
	// at 8 bytes so a misbehaving client can't OOM us; channel-voice
	// messages never exceed 3.
	std::uint8_t  midi_bytes[8] = {0};
	std::uint8_t  midi_byte_count = 0;

	// SetIngressCaptureLatency { stream_id, samples } — samples are
	// in engine frames; the shim writes them into the matching
	// ingress port's `Port::set_private_latency_range` and triggers
	// `Session::update_latency_compensation` so future recordings
	// land at the visually-correct position.
	std::uint32_t set_latency_samples = 0;

	// Script payload — decoded during SaveScript / RunScript /
	// EnableScript / DeleteScript. Field set mirrors the
	// `foyer-schema::scripting::Script` wire shape.
	std::string   script_id;
	std::string   script_name;
	std::string   script_description;
	std::string   script_type;       // "snippet" | "editor_action" | ...
	std::string   script_language;   // "lua" today
	bool          script_enabled = true;
	bool          has_script_enabled = false;
	std::string   script_body;
	std::map<std::string, std::string> script_args;
	std::string   script_hook;
	bool          script_has_args_override = false;
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

// Parse a `BTreeMap<String, String>` (args / args_override) into the
// out parameter. msgpack maps come through fixmap or map16 so the
// header reader handles both.
static bool
read_string_string_map (In& in, std::map<std::string, std::string>& out)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k, v;
		if (!in.read_str (k)) return false;
		if (!in.read_str (v)) return false;
		out[std::move (k)] = std::move (v);
	}
	return true;
}

// Parse a Script sub-map — the `script` field on Command::SaveScript.
// Unknown fields are skipped so a client on a newer schema doesn't
// hang the shim.
static bool
read_script_payload (In& in, DecodedCmd& out)
{
	std::size_t n = 0;
	if (!in.read_map_header (n)) return false;
	for (std::size_t i = 0; i < n; ++i) {
		std::string k;
		if (!in.read_str (k)) return false;
		if (k == "id") {
			if (!in.read_str (out.script_id)) return false;
		} else if (k == "name") {
			if (!in.read_str (out.script_name)) return false;
		} else if (k == "description") {
			if (!in.read_str (out.script_description)) return false;
		} else if (k == "script_type") {
			if (!in.read_str (out.script_type)) return false;
		} else if (k == "language") {
			if (!in.read_str (out.script_language)) return false;
		} else if (k == "enabled") {
			if (!in.read_bool (out.script_enabled)) return false;
			out.has_script_enabled = true;
		} else if (k == "body") {
			if (!in.read_str (out.script_body)) return false;
		} else if (k == "args") {
			if (!read_string_string_map (in, out.script_args)) return false;
		} else if (k == "hook") {
			// Nullable string. `read_str` skips nil cleanly via the
			// existing nil handling — we leave `script_hook` empty
			// when nil arrives.
			std::string h;
			if (in.read_str (h)) out.script_hook = std::move (h);
			else if (!in.skip_value ()) return false;
		} else {
			// disabled_on_upload / updated_at are server-stamped;
			// `description` already consumed. Anything else: skip.
			if (!in.skip_value ()) return false;
		}
	}
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
	if (!in.ok ()) return false;
	// Cap the wire-supplied count before reserve so a malicious peer
	// can't claim a 4G-element array and force a multi-GB allocation.
	n = in.cap_count (n);
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
			// Signed wire format — region positions can be negative
			// when the user has dragged the lozenge before zero.
			if (!read_i64 (in, out.patch_start)) return false;
			out.has_patch_start = true;
		} else if (pk == "length_samples") {
			if (!in.read_u64 (out.patch_length)) return false;
			out.has_patch_length = true;
		} else if (pk == "source_offset_samples") {
			if (!in.read_u64 (out.patch_source_offset)) return false;
			out.has_patch_source_offset = true;
		} else if (pk == "name") {
			if (!in.read_str (out.patch_name)) return false;
			out.has_patch_name = true;
			out.group_patch_name = out.patch_name;
			out.has_group_patch_name = true;
		} else if (pk == "muted") {
			if (!in.read_bool (out.patch_muted)) return false;
			out.has_patch_muted = true;
		} else if (pk == "fade_in_samples") {
			if (!in.read_u64 (out.patch_fade_in)) return false;
			out.has_patch_fade_in = true;
		} else if (pk == "fade_out_samples") {
			if (!in.read_u64 (out.patch_fade_out)) return false;
			out.has_patch_fade_out = true;
		} else if (pk == "fade_in_shape") {
			if (!in.read_str (out.patch_fade_in_shape)) return false;
			out.has_patch_fade_in_shape = true;
		} else if (pk == "fade_out_shape") {
			if (!in.read_str (out.patch_fade_out_shape)) return false;
			out.has_patch_fade_out_shape = true;
		} else if (pk == "gain_linear") {
			if (!in.read_f64 (out.patch_gain_linear)) return false;
			out.has_patch_gain_linear = true;
		} else if (pk == "color") {
			if (!in.read_str (out.patch_color)) return false;
			out.has_patch_color = true;
			out.group_patch_color = out.patch_color;
			out.has_group_patch_color = true;
		} else if (pk == "members") {
			std::size_t n = 0;
			std::uint8_t b = in.peek ();
			if ((b & 0xf0) == 0x90) { in.take_u8 (); n = b & 0x0f; }
			else if (b == 0xdc)     { in.take_u8 (); n = in.take_be16 (); }
			else if (b == 0xdd)     { in.take_u8 (); n = in.take_be32 (); }
			else return false;
			if (!in.ok ()) return false;
			n = in.cap_count (n);
			out.group_patch_members.clear ();
			out.group_patch_members.reserve (n);
			for (std::size_t i = 0; i < n; ++i) {
				std::string tid;
				if (!in.read_str (tid)) return false;
				out.group_patch_members.push_back (tid);
			}
			out.has_group_patch_members = true;
		} else if (pk == "active") {
			if (!in.read_bool (out.group_patch_active)) return false;
			out.has_group_patch_active = true;
		} else if (pk == "link_gain") {
			if (!in.read_bool (out.group_patch_link_gain)) return false;
			out.has_group_patch_link_gain = true;
		} else if (pk == "link_mute") {
			if (!in.read_bool (out.group_patch_link_mute)) return false;
			out.has_group_patch_link_mute = true;
		} else if (pk == "link_solo") {
			if (!in.read_bool (out.group_patch_link_solo)) return false;
			out.has_group_patch_link_solo = true;
		} else if (pk == "link_record") {
			if (!in.read_bool (out.group_patch_link_record)) return false;
			out.has_group_patch_link_record = true;
		} else if (pk == "group_id") {
			if (!in.read_str (out.patch_group_id)) return false;
			out.has_patch_group_id = true;
		} else if (pk == "layer") {
			// `RegionPatch.layer` (Option<i32>) → Playlist::set_layer.
			// Wire emits as signed i64; we keep the signed view here
			// so a negative "send to back" value round-trips intact.
			std::int64_t v = 0;
			if (!read_i64 (in, v)) return false;
			out.patch_layer = v;
			out.has_patch_layer = true;
		} else if (pk == "track_id") {
			// `RegionPatch.track_id` — cross-track move. Sidecar emits
			// the target track's Foyer id; we look up the destination
			// playlist inside UpdateRegion below.
			if (!in.read_str (out.patch_track_id)) return false;
			out.has_patch_track_id = true;
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

static std::uint64_t
cmd_at_u64 (DecodedCmd const& snap)
{
	if (!snap.has_cmd_at_samples || snap.cmd_at_samples_i64 < 0) {
		return 0;
	}
	return static_cast<std::uint64_t> (snap.cmd_at_samples_i64);
}

static Temporal::samplepos_t
cmd_at_samplepos (DecodedCmd const& snap)
{
	if (!snap.has_cmd_at_samples) {
		return static_cast<Temporal::samplepos_t> (0);
	}
	return static_cast<Temporal::samplepos_t> (snap.cmd_at_samples_i64);
}

DecodedCmd
decode (const std::vector<std::uint8_t>& buf)
{
	DecodedCmd out;
	In in { buf.data (), buf.data () + buf.size () };

	// Envelope { schema, api_version, seq, origin, body } — we only decode `body`
	// in depth, but we read api_version for forward compatibility.
	std::string wire_api_version;
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
					// AddPatchChange — nested bank/program/start_ticks map.
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
				out.group_patch_name = v;
				out.has_group_patch_name = true;
				} else if (k == "color") {
					if (!in.read_str (out.group_color)) return out;
				} else if (k == "members") {
					std::size_t n = 0;
					std::uint8_t b = in.peek ();
					if ((b & 0xf0) == 0x90) { in.take_u8 (); n = b & 0x0f; }
					else if (b == 0xdc)     { in.take_u8 (); n = in.take_be16 (); }
					else if (b == 0xdd)     { in.take_u8 (); n = in.take_be32 (); }
					else return out;
					if (!in.ok ()) return out;
					n = in.cap_count (n);
					out.group_members.clear ();
					out.group_members.reserve (n);
					for (std::size_t i = 0; i < n; ++i) {
						std::string tid;
						if (!in.read_str (tid)) return out;
						out.group_members.push_back (tid);
					}
				} else if (k == "kind") {
					// CreateRegion's media-type selector ("midi" | "audio").
					if (!in.read_str (out.create_kind)) return out;
				} else if (k == "source_path") {
					// CreateRegion (audio): path to an existing pool source.
					if (!in.read_str (out.create_source_path)) return out;
				} else if (k == "at_samples") {
					if (!read_i64 (in, out.cmd_at_samples_i64)) return out;
					out.has_cmd_at_samples = true;
				} else if (k == "new_start_samples") {
					if (!read_i64 (in, out.stretch_new_start_i64)) return out;
					out.has_stretch_new_start = true;
				} else if (k == "new_length_samples") {
					if (!in.read_u64 (out.stretch_new_length_u64)) return out;
					out.has_stretch_new_length = true;
				} else if (k == "anchor") {
					if (!in.read_str (out.stretch_anchor)) return out;
				} else if (k == "preserve_pitch") {
					if (!in.read_bool (out.stretch_preserve_pitch)) return out;
				} else if (k == "region_ids") {
					std::size_t n = 0;
					std::uint8_t b = in.peek ();
					if ((b & 0xf0) == 0x90) { in.take_u8 (); n = b & 0x0f; }
					else if (b == 0xdc)     { in.take_u8 (); n = in.take_be16 (); }
					else if (b == 0xdd)     { in.take_u8 (); n = in.take_be32 (); }
					else return out;
					if (!in.ok ()) return out;
					n = in.cap_count (n);
					out.combine_region_ids.clear ();
					out.combine_region_ids.reserve (n);
					for (std::size_t i = 0; i < n; ++i) {
						std::string rid;
						if (!in.read_str (rid)) return out;
						out.combine_region_ids.push_back (rid);
					}
				} else if (k == "threshold_db") {
					if (!in.read_f64 (out.strip_threshold_db)) return out;
					out.has_strip_threshold = true;
				} else if (k == "minimum_length_samples") {
					if (!in.read_u64 (out.strip_minimum_length_samples)) return out;
					out.has_strip_minimum_length = true;
				} else if (k == "fade_length_samples") {
					if (!in.read_u64 (out.strip_fade_length_samples)) return out;
					out.has_strip_fade_length = true;
				} else if (k == "semitones") {
					if (!in.read_f64 (out.pitch_semitones)) return out;
					out.has_pitch_semitones = true;
				} else if (k == "path") {
					if (!in.read_str (out.import_audio_path)) return out;
				} else if (k == "source_offset_samples") {
					// DuplicateRegionRange's slice anchor — offset
					// INTO the source region's content.
					if (!in.read_u64 (out.dup_source_offset_samples)) return out;
				} else if (k == "length_samples") {
					// Top-level length_samples is DuplicateRegion's
					// optional length override. UpdateRegion sends
					// `length_samples` inside a nested `patch` map
					// which goes through read_region_patch_or_note,
					// so there's no collision here.
					// For DuplicateRegionRange the length is
					// REQUIRED; the handler treats has_length=false
					// as a 0-length error.
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
				} else if (k == "script") {
					// Command::SaveScript { script: Script }. Nested
					// map carries every Script field.
					if (!read_script_payload (in, out)) return out;
				} else if (k == "args_override") {
					// Command::RunScript { args_override: Option<BTreeMap> }.
					// Nullable on the wire — skip nil cleanly.
					if (!read_string_string_map (in, out.script_args)) {
						return out;
					}
					out.script_has_args_override = true;
				} else if (k == "enabled" && (cmd_type == "enable_script")) {
					// Command::EnableScript { id, enabled }. The
					// region-edit `enabled` flag is handled elsewhere
					// (read_region_patch_or_note), so this branch is
					// only taken for the script command.
					if (!in.read_bool (out.script_enabled)) return out;
					out.has_script_enabled = true;
				} else if (k == "value") {
					if (!in.read_f64 (out.value)) return out;
				} else if (k == "patch") {
					// Overloaded key: UpdateRegion / UpdateTrack / UpdateNote /
					// UpdateGroup share `read_region_patch_or_note`; only
					// UpdatePatchChange uses PatchChangePatch keys parsed by
					// `read_pc_fields`.  Do NOT route every `patch` through
					// read_pc_fields — it skips `start_samples` / length and
					// made UpdateRegion a silent no-op (regions "snapped back").
					// serde's tag="type" normally emits `type` before `patch`.
					if (cmd_type == "update_patch_change") {
						if (!read_pc_fields (in, out)) return out;
					} else {
						if (!read_region_patch_or_note (in, out)) return out;
					}
				} else if (k == "plugin_uri") {
					if (!in.read_str (out.plugin_uri)) return out;
				} else if (k == "plugin_id") {
					if (!in.read_str (out.plugin_id)) return out;
				} else if (k == "preset_id") {
					if (!in.read_str (out.preset_id)) return out;
				} else if (k == "clone_from") {
					if (!in.read_str (out.clone_from)) return out;
				} else if (k == "new_index") {
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.move_new_index = static_cast<std::uint32_t> (v);
				} else if (k == "port_name") {
					// SetTrackInput { track_id, port_name }: stash in
					// the same slot UpdateTrack's patch_input_port uses
					// so the handler logic is shared.
					if (!in.read_str (out.patch_input_port)) return out;
					out.has_patch_input_port = true;
				} else if (k == "direction") {
					// ListPorts { direction: Option<String> }
					if (!in.read_str (out.ports_direction)) return out;
				} else if (k == "channel") {
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.midi_channel = static_cast<std::uint8_t> (std::min<std::uint64_t> (15, v));
				} else if (k == "bank") {
					std::int64_t v = 0;
					if (!read_i64 (in, v)) return out;
					out.pc_bank = static_cast<std::int32_t> (v);
					out.has_pc_bank = true;
				} else if (k == "program") {
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.pc_program = static_cast<std::uint8_t> (std::min<std::uint64_t> (v, 127));
					out.has_pc_program = true;
				} else if (k == "target_track_id") {
					// Overloaded: `AddSend { track_id, target_track_id,
					// pre_fader }` AND `DuplicateRegion / DuplicateRegionRange
					// { source_region_id, target_track_id }`. The wire key is
					// the same; the command kind discriminates at dispatch
					// time, so populate both slots and let the per-kind
					// handler pick.
					std::string v;
					if (!in.read_str (v)) return out;
					out.send_target_track = v;
					out.dup_target_track_id = v;
					out.dup_has_target_track_id = !v.empty ();
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
					if (!in.ok ()) return out;
					n = in.cap_count (n);
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
				} else if (k == "samples") {
					// SetIngressCaptureLatency { stream_id, samples }
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.set_latency_samples = static_cast<std::uint32_t> (v);
				} else if (k == "ms") {
					// SetIngressRingPrimeMs { ms } — reuses
					// `set_latency_samples` as the destination slot
					// since the two commands carry a single u32
					// payload each and never co-occur.
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.set_latency_samples = static_cast<std::uint32_t> (v);
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
						} else if (kk == "frame_size") {
							std::uint64_t v = 0;
							if (!in.read_u64 (v)) return out;
							out.audio_frame_size = static_cast<std::uint32_t> (v);
						} else {
							if (!in.skip_value ()) return out;
						}
					}
				} else if (k == "as_path") {
					// Command::SaveSession { as_path: Option<String> }
					// — decoded into `out.id`. `nil` or absent key → empty
					// string (save in place). Non-empty → absolute path to
					// the new session *folder* (parent + final dirname).
					if (!in.read_nil_or_str (out.id)) return out;
				} else if (k == "data") {
					// Command::MidiInput { data: Vec<u8> } — rmp-serde
					// emits Vec<u8> as a msgpack ARRAY (not bin) so each
					// byte arrives as a positive fixint (0..127) or
					// `0xcc` prefixed u8 (128..255). Cap at sizeof
					// midi_bytes; anything longer is dropped on the
					// floor (server already rejects >3 byte payloads,
					// the cap here is belt-and-braces against a wedged
					// peer that bypasses the server check).
					std::size_t n = 0;
					if (!read_array_header (in, n)) return out;
					std::size_t take = std::min<std::size_t> (n, sizeof (out.midi_bytes));
					for (std::size_t i = 0; i < take; ++i) {
						std::uint64_t v = 0;
						if (!in.read_u64 (v)) return out;
						out.midi_bytes[i] = static_cast<std::uint8_t> (v & 0xff);
					}
					out.midi_byte_count = static_cast<std::uint8_t> (take);
					for (std::size_t i = take; i < n; ++i) {
						if (!in.skip_value ()) return out;
					}
				} else if (k == "lane_id") {
					if (!in.read_str (out.lane_id)) return out;
				} else if (k == "mask") {
					// SetTrackMidiChannelMode { ..., mask: u16 } — msgpack
					// encodes small u16s as positive fixints / u8 / u16.
					std::uint64_t v = 0;
					if (!in.read_u64 (v)) return out;
					out.midi_chan_mask = static_cast<std::uint16_t> (v & 0xffff);
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
					if (!in.ok ()) return out;
					pn = in.cap_count (pn);
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
			else if (cmd_type == "list_audio_pool")    out.kind = DecodedCmd::Kind::ListAudioPool;
			else if (cmd_type == "import_audio")        out.kind = DecodedCmd::Kind::ImportAudio;
			else if (cmd_type == "update_region")      out.kind = DecodedCmd::Kind::UpdateRegion;
			else if (cmd_type == "delete_region")      out.kind = DecodedCmd::Kind::DeleteRegion;
			else if (cmd_type == "update_track")       out.kind = DecodedCmd::Kind::UpdateTrack;
			else if (cmd_type == "invoke_action")      out.kind = DecodedCmd::Kind::InvokeAction;
			else if (cmd_type == "add_plugin")         out.kind = DecodedCmd::Kind::AddPlugin;
			else if (cmd_type == "remove_plugin")      out.kind = DecodedCmd::Kind::RemovePlugin;
			else if (cmd_type == "move_plugin")        out.kind = DecodedCmd::Kind::MovePlugin;
			else if (cmd_type == "open_plugin_gui")    out.kind = DecodedCmd::Kind::OpenPluginGui;
			else if (cmd_type == "close_plugin_gui")   out.kind = DecodedCmd::Kind::ClosePluginGui;
			else if (cmd_type == "save_session")       out.kind = DecodedCmd::Kind::SaveSession;
			else if (cmd_type == "add_note")           out.kind = DecodedCmd::Kind::AddNote;
			else if (cmd_type == "update_note")        out.kind = DecodedCmd::Kind::UpdateNote;
			else if (cmd_type == "delete_note")        out.kind = DecodedCmd::Kind::DeleteNote;
			else if (cmd_type == "add_patch_change")    out.kind = DecodedCmd::Kind::AddPatchChange;
			else if (cmd_type == "update_patch_change") out.kind = DecodedCmd::Kind::UpdatePatchChange;
			else if (cmd_type == "delete_patch_change") out.kind = DecodedCmd::Kind::DeletePatchChange;
			else if (cmd_type == "set_track_midi_patch") out.kind = DecodedCmd::Kind::SetTrackMidiPatch;
			else if (cmd_type == "undo")               out.kind = DecodedCmd::Kind::Undo;
			else if (cmd_type == "redo")               out.kind = DecodedCmd::Kind::Redo;
			else if (cmd_type == "list_plugin_presets") out.kind = DecodedCmd::Kind::ListPluginPresets;
			else if (cmd_type == "list_midi_patch_names") out.kind = DecodedCmd::Kind::ListMidiPatchNames;
			else if (cmd_type == "load_plugin_preset") out.kind = DecodedCmd::Kind::LoadPluginPreset;
			else if (cmd_type == "set_sequencer_layout")   out.kind = DecodedCmd::Kind::SetSequencerLayout;
			else if (cmd_type == "clear_sequencer_layout") out.kind = DecodedCmd::Kind::ClearSequencerLayout;
			else if (cmd_type == "midi_input")             out.kind = DecodedCmd::Kind::MidiInput;
			else if (cmd_type == "audio_ingress_open")  out.kind = DecodedCmd::Kind::AudioIngressOpen;
			else if (cmd_type == "set_ingress_capture_latency") out.kind = DecodedCmd::Kind::SetIngressCaptureLatency;
			else if (cmd_type == "set_ingress_ring_prime_ms")   out.kind = DecodedCmd::Kind::SetIngressRingPrimeMs;
			else if (cmd_type == "set_midi_capture_latency")    out.kind = DecodedCmd::Kind::SetMidiCaptureLatency;
			else if (cmd_type == "audio_ingress_close") out.kind = DecodedCmd::Kind::AudioIngressClose;
			else if (cmd_type == "duplicate_region")    out.kind = DecodedCmd::Kind::DuplicateRegion;
			else if (cmd_type == "duplicate_region_range") out.kind = DecodedCmd::Kind::DuplicateRegionRange;
			else if (cmd_type == "stretch_region")       out.kind = DecodedCmd::Kind::StretchRegion;
			else if (cmd_type == "split_region")         out.kind = DecodedCmd::Kind::SplitRegion;
			else if (cmd_type == "reverse_region")       out.kind = DecodedCmd::Kind::ReverseRegion;
			else if (cmd_type == "combine_regions")      out.kind = DecodedCmd::Kind::CombineRegions;
			else if (cmd_type == "strip_silence_region") out.kind = DecodedCmd::Kind::StripSilenceRegion;
			else if (cmd_type == "pitch_shift_region")    out.kind = DecodedCmd::Kind::PitchShiftRegion;
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
            else if (cmd_type == "set_track_midi_channel_mode") out.kind = DecodedCmd::Kind::SetTrackMidiChannelMode;
            else if (cmd_type == "shim_quit")            out.kind = DecodedCmd::Kind::ShimQuit;
            else if (cmd_type == "set_loop_range")       out.kind = DecodedCmd::Kind::SetLoopRange;
            else if (cmd_type == "create_group")         out.kind = DecodedCmd::Kind::CreateGroup;
            else if (cmd_type == "update_group")         out.kind = DecodedCmd::Kind::UpdateGroup;
            else if (cmd_type == "delete_group")         out.kind = DecodedCmd::Kind::DeleteGroup;
            else if (cmd_type == "undo_group_begin")     out.kind = DecodedCmd::Kind::UndoGroupBegin;
            else if (cmd_type == "undo_group_end")       out.kind = DecodedCmd::Kind::UndoGroupEnd;
            else if (cmd_type == "list_scripts")             out.kind = DecodedCmd::Kind::ListScripts;
            else if (cmd_type == "save_script")              out.kind = DecodedCmd::Kind::SaveScript;
            else if (cmd_type == "delete_script")            out.kind = DecodedCmd::Kind::DeleteScript;
            else if (cmd_type == "enable_script")            out.kind = DecodedCmd::Kind::EnableScript;
            else if (cmd_type == "run_script")               out.kind = DecodedCmd::Kind::RunScript;
            else if (cmd_type == "recover_disabled_scripts") out.kind = DecodedCmd::Kind::RecoverDisabledScripts;
            else if (cmd_type == "subscribe_spectrum")       out.kind = DecodedCmd::Kind::SubscribeSpectrum;
            else if (cmd_type == "unsubscribe_spectrum")     out.kind = DecodedCmd::Kind::UnsubscribeSpectrum;
            else if (cmd_type == "audio_stream_open"
                ||   cmd_type == "audio_egress_start")  out.kind = DecodedCmd::Kind::AudioStreamOpen;
			else if (cmd_type == "audio_stream_close"
			    ||   cmd_type == "audio_egress_stop")   out.kind = DecodedCmd::Kind::AudioStreamClose;
			else if (cmd_type.rfind ("audio_", 0) == 0) out.kind = DecodedCmd::Kind::Audio;
			else if (cmd_type == "latency_probe")      out.kind = DecodedCmd::Kind::Latency;
		} else if (key == "api_version") {
			if (!in.read_str (wire_api_version)) return out;
		} else {
			if (!in.skip_value ()) return out;
		}
	}
	if (!wire_api_version.empty () &&
	    wire_api_version != msgpack_out::CONTROL_PLANE_API_VERSION) {
		PBD::warning << "foyer_shim: unsupported control plane api_version "
		             << wire_api_version << " (only "
		             << msgpack_out::CONTROL_PLANE_API_VERSION
		             << " is supported)" << endmsg;
		return DecodedCmd ();
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
	// Unpack `[stream_id u32 LE][transport_pos i64 LE][interleaved f32 PCM]`.
	// Wire format matches foyer_ipc::pack_audio (formerly just stream_id
	// + PCM, changed in 2026-05-06 to 12-byte header). If we read from
	// byte 4 we'd interpret the transport_pos as the first two PCM
	// samples; for ingress frames that's -1 (0xFF) which decodes as NaN
	// and maxes out the channel gain.
	if (payload.size () < 12) return;
	const std::uint32_t stream_id =
	      (static_cast<std::uint32_t> (payload[0]))
	    | (static_cast<std::uint32_t> (payload[1]) << 8)
	    | (static_cast<std::uint32_t> (payload[2]) << 16)
	    | (static_cast<std::uint32_t> (payload[3]) << 24);

	std::lock_guard<std::mutex> lk (_ingress_mx);
	auto it = _ingress_ports.find (stream_id);
	if (it != _ingress_ports.end () && it->second) {
		const float* samples = reinterpret_cast<const float*> (payload.data () + 12);
		const std::size_t n_floats = (payload.size () - 12) / sizeof (float);
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
					} else if (snap.id == "transport.metronome") {
						// `Config::clicking` is the engine-level click
						// switch; ParameterChanged fires from inside
						// `set_clicking`, which signal_bridge subscribes
						// to so the UI sees the new value when the
						// toggle is flipped from Ardour's own GUI.
						if (ARDOUR::Config) {
							ARDOUR::Config->set_clicking (on);
							PBD::warning << "foyer_shim: set clicking=" << on << endmsg;
						}
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

			// Special case: `metronome.gain` is held on the global
			// RCConfiguration as a linear coefficient. Convert dB →
			// coefficient and stash it; ParameterChanged will fire and
			// signal_bridge re-emits the value to peers.
			if (cmd.id == "metronome.gain") {
				const double db = std::max (-60.0, std::min (6.0, cmd.value));
				const float coeff = static_cast<float> (dB_to_coefficient (db));
				if (ARDOUR::Config) {
					ARDOUR::Config->set_click_gain (coeff);
					PBD::warning << "foyer_shim: set click_gain=" << db << " dB" << endmsg;
				}
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
				// becomes a single undo step. `set_value()` doesn't
				// auto-record into the open transaction — for an
				// AutomationControl we capture the underlying
				// AutomationList state before + after and add a
				// `MementoCommand<AutomationList>` so undo actually has
				// a diff to roll back. Plain Controllables (rare here —
				// fader/pan/mute/solo are all AutomationControl) get
				// the wrap without a memento; the empty txn is silently
				// dropped by Ardour on commit.
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (ctrl);
				std::shared_ptr<ARDOUR::AutomationList> alist = ac ? ac->alist () : nullptr;
				XMLNode* before = alist ? &alist->get_state () : nullptr;
				session.begin_reversible_command ("Foyer control change");
				// Wire pan format is [-1, 1]; Ardour's
				// pan_azimuth_control wants [0, 1]. Convert
				// before set_value (no-op for non-pan ids).
				// Gain controls round-trip through dB ↔ linear —
				// the wire schema is dB but Ardour's GainControl
				// stores the linear coefficient. Without this the
				// "-6 dB" the user requested ends up as a -6
				// linear coefficient (clamped to 0 = silence).
				double write_value = snap.value;
				if (schema_map::is_pan_id (snap.id)) {
					write_value = schema_map::pan_wire_to_ardour (write_value);
				} else if (schema_map::is_gain_id (snap.id)) {
					write_value = schema_map::gain_wire_to_ardour (write_value);
				}
				ctrl->set_value (write_value, Controllable::UseGroup);
				if (alist && before) {
					session.add_command (new MementoCommand<ARDOUR::AutomationList> (
					    *alist, before, &alist->get_state ()));
				}
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
		case DecodedCmd::Kind::ListAudioPool: {
			std::vector<msgpack_out::AudioPoolListRow> rows;
			auto& session = _shim.session ();
			session.foreach_source ([&] (std::shared_ptr<Source> s) {
				auto afs = std::dynamic_pointer_cast<AudioFileSource> (s);
				if (!afs) {
					return;
				}
				auto fs = std::dynamic_pointer_cast<FileSource> (afs);
				msgpack_out::AudioPoolListRow row;
				{
					std::ostringstream oid;
					oid << "source." << afs->id ();
					row.id = oid.str ();
				}
				row.name = afs->name ();
				row.path = fs ? fs->path () : std::string ();
				row.channel = static_cast<std::uint16_t> (afs->channel ());
				row.length_samples =
				    static_cast<std::uint64_t> (afs->readable_length_samples ());
				row.sample_rate =
				    static_cast<std::uint32_t> (afs->sample_rate ());
				rows.push_back (std::move (row));
			});
			auto bytes = msgpack_out::encode_audio_pool_listed (rows);
			_shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			break;
		}
		case DecodedCmd::Kind::ImportAudio: {
			if (cmd.import_audio_path.empty ()) {
				break;
			}
			const std::string path = cmd.import_audio_path;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, path] () {
				SF_INFO info;
				std::memset (&info, 0, sizeof (info));
				SNDFILE* f = sf_open (path.c_str (), SFM_READ, &info);
				if (!f) {
					PBD::warning << "foyer_shim: import_audio: sf_open failed for "
					             << path << endmsg;
					return;
				}
				const int nch = std::max (0, info.channels);
				sf_close (f);
				auto& session = shim->session ();
				for (int ch = 0; ch < nch; ++ch) {
					try {
						(void)SourceFactory::createExternal (
						    DataType::AUDIO, session, path, ch,
						    Source::Flag (0), true, false);
					} catch (...) {
						PBD::warning << "foyer_shim: import_audio: createExternal failed ch="
						             << ch << " path=" << path << endmsg;
						return;
					}
				}
				session.set_dirty ();
				// Emit a fresh pool listing now that the new sources
				// have been registered. The FE used to chase this
				// with its own list_audio_pool right after dispatching
				// the import, but that races the slot system —
				// SourceFactory runs HERE, after the import command
				// already returned to the sidecar. Push the listing
				// from inside the slot so the FE always sees the new
				// rows without a refresh round-trip. Enumeration
				// mirrors the ListAudioPool handler below — duplicated
				// inline (small) rather than factored, to avoid
				// pulling msgpack_out.h into schema_map.
				std::vector<msgpack_out::AudioPoolListRow> rows;
				session.foreach_source ([&] (std::shared_ptr<Source> s) {
					auto afs = std::dynamic_pointer_cast<AudioFileSource> (s);
					if (!afs) return;
					auto fs = std::dynamic_pointer_cast<FileSource> (afs);
					msgpack_out::AudioPoolListRow row;
					{
						std::ostringstream oid;
						oid << "source." << afs->id ();
						row.id = oid.str ();
					}
					row.name = afs->name ();
					row.path = fs ? fs->path () : std::string ();
					row.channel = static_cast<std::uint16_t> (afs->channel ());
					row.length_samples =
					    static_cast<std::uint64_t> (afs->readable_length_samples ());
					row.sample_rate =
					    static_cast<std::uint32_t> (afs->sample_rate ());
					rows.push_back (std::move (row));
				});
				auto bytes = msgpack_out::encode_audio_pool_listed (rows);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::UpdateRegion: {
			if (cmd.id.empty ()) break;
			// Post to the shim event loop — libardour region mutations
			// touch SequenceProperty / per-thread allocation pools that
			// are only valid on registered threads.
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: update_region: unknown region id: " << snap.id << endmsg;
					return;
				}
				// Ardour-canonical pattern for region property edits:
				// `clear_changes()` snapshots the before-state into the
				// region's PropertyList, do the mutations, then add a
				// `StatefulDiffCommand` that captures the diff into the
				// open undo transaction. Without the diff capture the
				// undo entry is empty and Ctrl+Z is a no-op. See
				// editor_ops.cc nudge_regions for the same idiom.
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer update region");
				hit.region->clear_changes ();
				// Apply length BEFORE source offset: `Region::set_start`
				// runs `verify_start(pos > source_length - _length)` and
				// rejects any offset that would push the slice past the
				// source's tail given the CURRENT length. For a left-
				// trim drag the new length is shorter — applying it
				// first widens the verify window so the new offset
				// passes. (region.cc:1999-2012; learned the hard way
				// in DuplicateRegionRange.)
				//
				// Pre-convert all three timecnt_t/timepos_t inputs to
				// the region's own time domain. MIDI playlists run on
				// `BeatTime` while the wire format always carries
				// samples — `Temporal::timecnt_t::from_samples()` and
				// `Temporal::timepos_t(samplepos_t)` both produce
				// `AudioTime` values. `Region::set_length_internal`
				// (region.cc:589-611) hits an early-return when the
				// input timecnt's time_domain doesn't match the
				// playlist's: it retags the OLD length and discards
				// the new one, with no error. So MIDI region resize
				// drag was a silent no-op — the shim "applied" a
				// length the model never accepted, then encoded the
				// unchanged length back to the UI, which snapped the
				// optimistic preview back to its original size.
				// `timecnt_t::set_time_domain` runs the value through
				// `TempoMap::use()` so the samples land as the right
				// number of beats. Same idiom as
				// `Region::trim_to_internal` (region.cc:1128-1131).
				const Temporal::TimeDomain region_td = hit.region->time_domain ();
				if (snap.has_patch_length) {
					auto length = Temporal::timecnt_t::from_samples (
						static_cast<Temporal::samplepos_t> (snap.patch_length));
					length.set_time_domain (region_td);
					hit.region->set_length (length);
				}
				if (snap.has_patch_source_offset) {
					auto offset = Temporal::timepos_t (
						static_cast<Temporal::samplepos_t> (snap.patch_source_offset));
					offset.set_time_domain (region_td);
					hit.region->set_start (offset);
				}
				if (snap.has_patch_start) {
					auto pos = Temporal::timepos_t (
						static_cast<Temporal::samplepos_t> (snap.patch_start));
					pos.set_time_domain (region_td);
					hit.region->set_position (pos);
				}
				if (snap.has_patch_name) {
					hit.region->set_name (snap.patch_name);
				}
				if (snap.has_patch_muted) {
					hit.region->set_muted (snap.patch_muted);
				}
				if (auto ar = std::dynamic_pointer_cast<AudioRegion> (hit.region)) {
					if (snap.has_patch_gain_linear) {
						ar->set_scale_amplitude (static_cast<gain_t> (snap.patch_gain_linear));
					}
					if (snap.has_patch_fade_in) {
						if (snap.patch_fade_in == 0) {
							ar->set_fade_in_active (false);
						} else {
							FadeShape sh_in = FadeLinear;
							if (snap.has_patch_fade_in_shape) {
								sh_in = parse_fade_shape (snap.patch_fade_in_shape);
							}
							ar->set_fade_in_active (true);
							ar->set_fade_in (sh_in, static_cast<samplecnt_t> (snap.patch_fade_in));
						}
					} else if (snap.has_patch_fade_in_shape) {
						ar->set_fade_in_shape (parse_fade_shape (snap.patch_fade_in_shape));
					}
					if (snap.has_patch_fade_out) {
						if (snap.patch_fade_out == 0) {
							ar->set_fade_out_active (false);
						} else {
							FadeShape sh_out = FadeLinear;
							if (snap.has_patch_fade_out_shape) {
								sh_out = parse_fade_shape (snap.patch_fade_out_shape);
							}
							ar->set_fade_out_active (true);
							ar->set_fade_out (sh_out, static_cast<samplecnt_t> (snap.patch_fade_out));
						}
					} else if (snap.has_patch_fade_out_shape) {
						ar->set_fade_out_shape (parse_fade_shape (snap.patch_fade_out_shape));
					}
				}
				session.add_command (new PBD::StatefulDiffCommand (hit.region));
				if (snap.has_patch_track_id
				    && !snap.patch_track_id.empty ()
				    && snap.patch_track_id != hit.track_id) {
					// Cross-track move. Look up the source playlist
					// (scan routes — `find_region` already gave us
					// the track id, but we need the actual playlist
					// pointer), and the destination playlist via the
					// schema_map helper. Mutation pattern matches
					// DuplicateRegion: clear_changes() + remove/add +
					// StatefulDiffCommand on each touched playlist
					// so Ctrl+Z reverses both ends as one entry.
					std::shared_ptr<ARDOUR::Playlist> src_pl;
					std::shared_ptr<RouteList const> routes2 =
						schema_map::safe_get_routes (session);
					for (auto const& r2 : *routes2) {
						if (!r2) continue;
						auto t2 = std::dynamic_pointer_cast<Track> (r2);
						if (!t2) continue;
						auto pl2 = t2->playlist ();
						if (pl2 && pl2->region_by_id (hit.region->id ())) {
							src_pl = pl2;
							break;
						}
					}
					auto dst_pl = schema_map::playlist_for_track_id (
						session, snap.patch_track_id);
					if (src_pl && dst_pl && src_pl != dst_pl) {
						// Stash the region's current position; remove
						// from source can clear it depending on the
						// playlist implementation, so we capture
						// before any mutation.
						auto pos = hit.region->position ();
						// Bump the region's reference count via shared_ptr
						// before removing — `remove_region` may drop the
						// playlist's only reference and we still need to
						// add it to the dest.
						auto region_ref = hit.region;
						src_pl->clear_changes ();
						src_pl->remove_region (region_ref);
						dst_pl->clear_changes ();
						dst_pl->add_region (region_ref, pos);
						session.add_command (new PBD::StatefulDiffCommand (src_pl));
						session.add_command (new PBD::StatefulDiffCommand (dst_pl));
					}
				}
				if (snap.has_patch_layer) {
					// `set_layer` is on `Playlist`; relayer recomputes
					// other regions on the same playlist to keep the
					// stack consistent, so a single call is enough for
					// bring-to-front / send-to-back semantics.
					if (auto pl = hit.region->playlist ()) {
						pl->clear_changes ();
						pl->set_layer (hit.region,
						               static_cast<double> (snap.patch_layer));
						session.add_command (new PBD::StatefulDiffCommand (pl));
					}
				}
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_region_updated (session, snap.id);
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, region_id] () {
				auto hit = schema_map::find_region (shim->session (), region_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: delete_region: unknown region id: " << region_id << endmsg;
					return;
				}
				// `RegionRemoved` signal will fire on the playlist and our
				// signal bridge relays it; we don't re-emit here.
				//
				// Wrap the playlist mutation in a reversible-command
				// transaction with a `StatefulDiffCommand` capturing
				// the playlist's before/after diff — without that, the
				// undo entry is empty and Ctrl+Z does nothing.
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer delete region");
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
				std::shared_ptr<ARDOUR::Playlist> hit_pl;
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (!pl) continue;
					if (pl->region_by_id (hit.region->id ())) {
						pl->clear_changes ();
						pl->remove_region (hit.region);
						hit_pl = pl;
						break;
					}
				}
				if (hit_pl) {
					session.add_command (new PBD::StatefulDiffCommand (hit_pl));
				}
				if (own_txn) session.commit_reversible_command ();
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.dup_source_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: duplicate_region: unknown source: "
					             << snap.dup_source_id << endmsg;
					return;
				}
				// Find the owning playlist so we can add the clone.
				// Cross-track paste: when `target_track_id` is set
				// and resolves, redirect to that playlist instead.
				// Sidecar already validated kind compatibility so we
				// trust the destination here.
				std::shared_ptr<ARDOUR::Playlist> playlist;
				if (snap.dup_has_target_track_id) {
					playlist = schema_map::playlist_for_track_id (
						shim->session (), snap.dup_target_track_id);
					if (!playlist) {
						PBD::warning << "foyer_shim: duplicate_region: unknown target track: "
						             << snap.dup_target_track_id << endmsg;
						return;
					}
				} else {
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
				}
				// `RegionFactory::create(shared<const Region>, announce)`
				// clones the region AND copies `_extra_xml` (the copy
				// ctor in region.cc:474-477 does `new XMLNode(*other)` on
				// the extra_xml tree). That's why duplicating a beat-
				// sequencer region carries the layout across for free.
				//
				// Wrap the playlist mutation in a reversible-command
				// transaction with a `StatefulDiffCommand` capturing
				// the playlist's before/after diff — without that, the
				// undo entry is empty and Ctrl+Z does nothing. When
				// already inside a Foyer undo group (cut+paste batch),
				// participate in that transaction instead so the entire
				// group commits as one entry. WITHOUT this fix, paste
				// regions weren't reversible AT ALL — Ardour's undo
				// stack got confused state from concurrent unwrapped
				// adds and the symptom was random ghost regions
				// reappearing on undo (Rich's morning bug report).
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer duplicate region");
				PBD::PropertyList plist;
				auto clone = ARDOUR::RegionFactory::create (
					std::shared_ptr<const ARDOUR::Region> (hit.region),
					true /* announce */, false /* fork */);
				if (!clone) {
					PBD::warning << "foyer_shim: duplicate_region: RegionFactory returned null" << endmsg;
					if (own_txn) session.commit_reversible_command ();
					return;
				}
				if (snap.dup_has_length) {
					// Same time-domain trap as UpdateRegion above:
					// `Region::set_length_internal` silently discards the
					// new length when the timecnt's domain doesn't match
					// the playlist's. Pre-convert into the clone's own
					// domain so MIDI duplicate-with-length actually
					// resizes the clone.
					auto length = Temporal::timecnt_t::from_samples (
						static_cast<Temporal::samplepos_t> (snap.dup_length_samples));
					length.set_time_domain (clone->time_domain ());
					clone->set_length (length);
				}
				playlist->clear_changes ();
				playlist->add_region (clone, Temporal::timepos_t (
					static_cast<Temporal::samplepos_t> (cmd_at_u64 (snap))));
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
				// Playlist's RegionAdded signal fires an echo; we
				// don't emit one manually here.
			});
			break;
		}
		case DecodedCmd::Kind::DuplicateRegionRange: {
			if (cmd.dup_source_id.empty ()) break;
			if (!cmd.dup_has_length || cmd.dup_length_samples == 0) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.dup_source_id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: duplicate_region_range: unknown source: "
					             << snap.dup_source_id << endmsg;
					return;
				}
				// Cross-track paste: redirect to target playlist when
				// the patch carries one. See DuplicateRegion handler
				// above for the same dance.
				std::shared_ptr<ARDOUR::Playlist> playlist;
				if (snap.dup_has_target_track_id) {
					playlist = schema_map::playlist_for_track_id (
						shim->session (), snap.dup_target_track_id);
					if (!playlist) {
						PBD::warning << "foyer_shim: duplicate_region_range: unknown target track: "
						             << snap.dup_target_track_id << endmsg;
						return;
					}
				} else {
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
						PBD::warning << "foyer_shim: duplicate_region_range: source not on any playlist" << endmsg;
						return;
					}
				}
				// Use the offset-based RegionFactory overload so the
				// clone is constructed with `_start = source._start +
				// offset` and `_length` set atomically (region.cc:428-
				// 429). The earlier "create plain copy, then
				// set_start()/set_length()" path silently no-op'd
				// set_start when called BEFORE shrinking the length:
				// `Region::verify_start` rejects positions where
				// `pos > source_length - _length` and aborts the
				// change (region.cc:1999-2012). The freshly-cloned
				// region still has the source's full length, so
				// any non-zero offset for a region covering most of
				// its source got silently dropped — leaving the
				// clone showing source[0..len] instead of
				// source[off..off+len]. The factory's offset ctor
				// applies the shift before _length is finalized, so
				// it doesn't trip the verify check.
				auto& session = shim->session ();
				const Temporal::samplecnt_t src_len_samples =
					hit.region->length ().samples ();
				Temporal::samplepos_t off = static_cast<Temporal::samplepos_t> (
					std::min<std::uint64_t> (snap.dup_source_offset_samples,
					                         static_cast<std::uint64_t> (src_len_samples)));
				Temporal::samplecnt_t max_len =
					src_len_samples - off;
				Temporal::samplecnt_t len = static_cast<Temporal::samplecnt_t> (
					std::min<std::uint64_t> (snap.dup_length_samples,
					                         static_cast<std::uint64_t> (max_len)));
				if (len <= 0) {
					PBD::warning << "foyer_shim: duplicate_region_range: zero-length slice after clamp" << endmsg;
					return;
				}
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer duplicate region range");
				PBD::PropertyList plist;
				plist.add (ARDOUR::Properties::length,
					Temporal::timecnt_t::from_samples (len));
				auto clone = ARDOUR::RegionFactory::create (
					hit.region,
					Temporal::timecnt_t::from_samples (off),
					plist,
					true /* announce */);
				if (!clone) {
					PBD::warning << "foyer_shim: duplicate_region_range: RegionFactory returned null" << endmsg;
					if (own_txn) session.commit_reversible_command ();
					return;
				}
				playlist->clear_changes ();
				playlist->add_region (clone, Temporal::timepos_t (
					static_cast<Temporal::samplepos_t> (cmd_at_u64 (snap))));
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::SplitRegion: {
			if (cmd.id.empty ()) break;
			if (!cmd.has_cmd_at_samples) {
				PBD::warning << "foyer_shim: split_region: missing at_samples" << endmsg;
				break;
			}
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: split_region: unknown region: " << snap.id << endmsg;
					return;
				}
				std::shared_ptr<ARDOUR::Playlist> playlist;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (pl && pl->region_by_id (hit.region->id ())) {
						playlist = pl;
						break;
					}
				}
				if (!playlist) {
					PBD::warning << "foyer_shim: split_region: region not on any playlist" << endmsg;
					return;
				}
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer split region");
				playlist->clear_changes ();
				playlist->split_region (
					hit.region,
					Temporal::timepos_t (cmd_at_samplepos (snap)));
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::StretchRegion: {
			if (cmd.id.empty ()) break;
			if (!cmd.has_stretch_new_start || !cmd.has_stretch_new_length ||
			    cmd.stretch_new_length_u64 == 0) {
				PBD::warning << "foyer_shim: stretch_region: incomplete geometry" << endmsg;
				break;
			}
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: stretch_region: unknown region: " << snap.id << endmsg;
					return;
				}
				const DataType rdt = hit.region->data_type ();
				if (rdt != DataType::MIDI && rdt != DataType::AUDIO) {
					PBD::warning << "foyer_shim: stretch_region: unsupported region type" << endmsg;
					return;
				}
				std::shared_ptr<ARDOUR::Playlist> playlist;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (pl && pl->region_by_id (hit.region->id ())) {
						playlist = pl;
						break;
					}
				}
				if (!playlist) {
					PBD::warning << "foyer_shim: stretch_region: region not on any playlist" << endmsg;
					return;
				}
				const Temporal::samplecnt_t old_len_samples = hit.region->length ().samples ();
				if (old_len_samples == 0) {
					return;
				}
				std::string anchor = snap.stretch_anchor.empty () ? "start" : snap.stretch_anchor;
				for (char& c : anchor) {
					c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
				}
				const Temporal::samplepos_t old_pos_samples = hit.region->position ().samples ();
				const Temporal::samplepos_t old_end_samples =
					old_pos_samples + static_cast<Temporal::samplepos_t> (old_len_samples);
				const Temporal::samplepos_t new_start_sp =
					static_cast<Temporal::samplepos_t> (snap.stretch_new_start_i64);
				const Temporal::samplecnt_t new_len_u =
					static_cast<Temporal::samplecnt_t> (snap.stretch_new_length_u64);
				if (anchor == "start") {
					if (new_start_sp != old_pos_samples) {
						PBD::warning << "foyer_shim: stretch_region: start anchor mismatch" << endmsg;
						return;
					}
				} else if (anchor == "end") {
					const Temporal::samplepos_t expect_start =
						old_end_samples - static_cast<Temporal::samplepos_t> (new_len_u);
					if (new_start_sp != expect_start) {
						PBD::warning << "foyer_shim: stretch_region: end anchor mismatch" << endmsg;
						return;
					}
				} else {
					PBD::warning << "foyer_shim: stretch_region: bad anchor" << endmsg;
					return;
				}
				const Temporal::ratio_t ratio (
					static_cast<std::int64_t> (new_len_u),
					static_cast<std::int64_t> (old_len_samples));
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer stretch region");
				playlist->clear_changes ();
				ARDOUR::TimeFXRequest request;
				request.time_fraction = ratio;
				std::shared_ptr<Region> stretched;
				if (rdt == DataType::MIDI) {
					request.pitch_fraction = 1.0f;
					MidiStretch ms (session, request);
					if (ms.run (hit.region) != 0 ||
					    ms.results.empty () ||
					    !ms.results[0]) {
						PBD::warning << "foyer_shim: stretch_region: MidiStretch failed" << endmsg;
						if (own_txn) session.commit_reversible_command ();
						return;
					}
					stretched = ms.results[0];
				} else {
					if (snap.stretch_preserve_pitch) {
						/* Editor Time Stretch dialog: pitch-preserving elastic stretch. */
						request.pitch_fraction = 1.0f;
					} else {
						/* editor_timefx.cc mode 6: duration changes, pitch tracks
						 * inversely (varispeed / “no pitch preserve”). */
						const double tf = ratio.to_double ();
						request.pitch_fraction = tf > 0.0
						    ? static_cast<float> (1.0 / tf)
						    : 1.0f;
					}
					if (request.pitch_fraction <= 0.f) {
						request.pitch_fraction = 1.0f;
					}
					/* Match gtk2_ardour/editor_timefx.cc default Rubber Band mode
					 * (OptionTransientsCrisp is 0; R3 builds add OptionEngineFiner). */
					request.opts = static_cast<int> (
					    RubberBand::RubberBandStretcher::OptionEngineFiner);
					FoyerRBProgress rb_progress;
					RBStretch rb (session, request);
					if (rb.run (hit.region, &rb_progress) != 0 ||
					    rb.results.empty () ||
					    !rb.results[0]) {
						PBD::warning << "foyer_shim: stretch_region: RBStretch failed" << endmsg;
						if (own_txn) session.commit_reversible_command ();
						return;
					}
					stretched = rb.results[0];
				}
				timepos_t newpos;
				if (anchor == "end") {
					newpos = hit.region->end ().earlier (stretched->length ());
				} else {
					newpos = hit.region->position ();
				}
				playlist->replace_region (hit.region, stretched, newpos);
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::ReverseRegion: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: reverse_region: unknown region: " << snap.id << endmsg;
					return;
				}
				auto ar = std::dynamic_pointer_cast<AudioRegion> (hit.region);
				if (!ar) {
					PBD::warning << "foyer_shim: reverse_region: not an audio region" << endmsg;
					return;
				}
				auto playlist = hit.region->playlist ();
				if (!playlist) {
					return;
				}
				auto& session = shim->session ();
				Reverse rev (session);
				FoyerRBProgress rbprog;
				if (hit.region->apply (rev, &rbprog) != 0 || rev.results.empty ()) {
					return;
				}
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer reverse region");
				playlist->clear_changes ();
				playlist->clear_owned_changes ();
				playlist->freeze ();
				auto ri = rev.results.begin ();
				playlist->replace_region (hit.region, *ri, (*ri)->position ());
				++ri;
				while (ri != rev.results.end ()) {
					playlist->add_region (*ri, (*ri)->position ());
					++ri;
				}
				playlist->thaw ();
				std::vector<PBD::Command*> pcmds;
				playlist->rdiff (pcmds);
				session.add_commands (pcmds);
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::CombineRegions: {
			if (cmd.combine_region_ids.size () < 2) {
				PBD::warning << "foyer_shim: combine_regions: need >= 2 region ids" << endmsg;
				break;
			}
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				RegionList rl;
				std::shared_ptr<Playlist> playlist;
				for (std::string const& rid : snap.combine_region_ids) {
					auto hit = schema_map::find_region (shim->session (), rid);
					if (!hit.region) {
						PBD::warning << "foyer_shim: combine_regions: unknown region: " << rid << endmsg;
						return;
					}
					auto pl = hit.region->playlist ();
					if (!pl) {
						return;
					}
					if (!playlist) {
						playlist = pl;
					} else if (pl.get () != playlist.get ()) {
						PBD::warning << "foyer_shim: combine_regions: regions must share one playlist" << endmsg;
						return;
					}
					rl.push_back (hit.region);
				}
				std::shared_ptr<Track> owner_track;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					auto tr = std::dynamic_pointer_cast<Track> (r);
					if (!tr) continue;
					if (tr->playlist () == playlist) {
						owner_track = tr;
						break;
					}
				}
				if (!owner_track) {
					PBD::warning << "foyer_shim: combine_regions: could not resolve track" << endmsg;
					return;
				}
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer combine regions");
				playlist->clear_changes ();
				playlist->combine (rl, owner_track);
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::StripSilenceRegion: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: strip_silence_region: unknown region: " << snap.id << endmsg;
					return;
				}
				auto ar = std::dynamic_pointer_cast<AudioRegion> (hit.region);
				if (!ar) {
					PBD::warning << "foyer_shim: strip_silence_region: not audio" << endmsg;
					return;
				}
				auto playlist = hit.region->playlist ();
				if (!playlist) {
					return;
				}
				const float th_db =
				    snap.has_strip_threshold ? static_cast<float> (snap.strip_threshold_db) : -48.f;
				const samplecnt_t min_len = std::max (
				    static_cast<samplecnt_t> (1),
				    static_cast<samplecnt_t> (
				        snap.has_strip_minimum_length ? snap.strip_minimum_length_samples : 2048));
				const samplecnt_t fade_len = static_cast<samplecnt_t> (
				    snap.has_strip_fade_length ? snap.strip_fade_length_samples : 64);
				InterThreadInfo itt;
				AudioIntervalResult intervals = ar->find_silence (
				    dB_to_coefficient (th_db), min_len, fade_len, itt);
				AudioIntervalMap smap;
				smap[hit.region] = intervals;
				StripSilence ss (shim->session (), smap, fade_len);
				FoyerRBProgress rbprog;
				if (hit.region->apply (ss, &rbprog) != 0 || ss.results.empty ()) {
					return;
				}
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer strip silence");
				playlist->clear_changes ();
				playlist->clear_owned_changes ();
				playlist->freeze ();
				auto si = ss.results.begin ();
				playlist->replace_region (hit.region, *si, (*si)->position ());
				++si;
				while (si != ss.results.end ()) {
					playlist->add_region (*si, (*si)->position ());
					++si;
				}
				playlist->thaw ();
				std::vector<PBD::Command*> pcmds;
				playlist->rdiff (pcmds);
				session.add_commands (pcmds);
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
			});
			break;
		}
		case DecodedCmd::Kind::PitchShiftRegion: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto hit = schema_map::find_region (shim->session (), snap.id);
				if (!hit.region) {
					PBD::warning << "foyer_shim: pitch_shift_region: unknown region: " << snap.id << endmsg;
					return;
				}
				const double st = snap.has_pitch_semitones ? snap.pitch_semitones : 0.0;
				if (std::fabs (st) < 1e-9) {
					return;
				}
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				const DataType rdt = hit.region->data_type ();
				if (rdt == DataType::MIDI) {
					auto mr = std::dynamic_pointer_cast<MidiRegion> (hit.region);
					if (!mr) return;
					auto model = mr->model ();
					if (!model) return;
					auto* diff =
					    model->new_note_diff_command ("Foyer pitch shift");
					const int ist = static_cast<int> (std::lround (st));
					for (auto const& nptr : model->notes ()) {
						model->transpose (diff, nptr, ist);
					}
					model->apply_diff_command_as_commit (session, diff);
					auto bytes = msgpack_out::encode_region_updated (session, snap.id);
					if (!bytes.empty ()) {
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
					(void)own_txn;
					return;
				}
				if (rdt != DataType::AUDIO) {
					PBD::warning << "foyer_shim: pitch_shift_region: unsupported type" << endmsg;
					return;
				}
				std::shared_ptr<ARDOUR::Playlist> playlist;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (shim->session ());
				for (auto const& r : *routes) {
					if (!r) continue;
					auto track = std::dynamic_pointer_cast<Track> (r);
					if (!track) continue;
					auto pl = track->playlist ();
					if (pl && pl->region_by_id (hit.region->id ())) {
						playlist = pl;
						break;
					}
				}
				if (!playlist) {
					PBD::warning << "foyer_shim: pitch_shift_region: region not on playlist" << endmsg;
					return;
				}
				if (own_txn) session.begin_reversible_command ("Foyer pitch shift");
				playlist->clear_changes ();
				ARDOUR::TimeFXRequest request;
				request.time_fraction = Temporal::ratio_t (1, 1);
				request.pitch_fraction =
				    static_cast<float> (std::pow (2.0, st / 12.0));
				if (request.pitch_fraction <= 0.f) {
					request.pitch_fraction = 1.0f;
				}
				request.opts = static_cast<int> (
				    RubberBand::RubberBandStretcher::OptionEngineFiner);
				FoyerRBProgress rb_progress;
				RBStretch rb (session, request);
				if (rb.run (hit.region, &rb_progress) != 0 ||
				    rb.results.empty () ||
				    !rb.results[0]) {
					PBD::warning << "foyer_shim: pitch_shift_region: RBStretch failed" << endmsg;
					if (own_txn) session.commit_reversible_command ();
					return;
				}
				auto stretched = rb.results[0];
				timepos_t newpos = hit.region->position ();
				playlist->replace_region (hit.region, stretched, newpos);
				session.add_command (new PBD::StatefulDiffCommand (playlist));
				if (own_txn) session.commit_reversible_command ();
				session.set_dirty ();
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
				// Media-type gate. MIDI creates a fresh empty source.
				// AUDIO looks up an existing pool source by path
				// (drag-drop from the audio pool modal) and creates
				// a region referencing every channel of that source.
				const std::string kind = snap.create_kind.empty () ? "midi" : snap.create_kind;
				if (kind != "midi" && kind != "audio") {
					PBD::warning << "foyer_shim: create_region: kind '"
					             << kind << "' not supported" << endmsg;
					return;
				}
				if (kind == "audio" && snap.create_source_path.empty ()) {
					PBD::warning << "foyer_shim: create_region: audio region needs source_path" << endmsg;
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
				if (kind == "audio") {
					// Resolve every AudioFileSource in the session
					// whose path matches the requested source. Audio
					// regions in Ardour reference a vector of sources
					// (one per channel); collecting all matching
					// channels here lets a stereo pool entry create
					// a stereo region in one shot.
					ARDOUR::SourceList sources;
					shim->session ().foreach_source (
					    [&] (std::shared_ptr<ARDOUR::Source> s) {
						auto afs = std::dynamic_pointer_cast<ARDOUR::AudioFileSource> (s);
						if (!afs) return;
						auto fs = std::dynamic_pointer_cast<ARDOUR::FileSource> (afs);
						if (!fs) return;
						if (fs->path () != snap.create_source_path) return;
						sources.push_back (afs);
					});
					if (sources.empty ()) {
						PBD::warning << "foyer_shim: create_region: no pool source matches '"
						             << snap.create_source_path << "'" << endmsg;
						return;
					}
					// Sort by channel index so a stereo source ends
					// up with L on channel 0, R on channel 1 (matters
					// for pan/output routing).
					std::sort (sources.begin (), sources.end (), [] (
					    std::shared_ptr<ARDOUR::Source> a,
					    std::shared_ptr<ARDOUR::Source> b) {
						auto aa = std::dynamic_pointer_cast<ARDOUR::AudioFileSource> (a);
						auto bb = std::dynamic_pointer_cast<ARDOUR::AudioFileSource> (b);
						return aa->channel () < bb->channel ();
					});
					PBD::PropertyList plist;
					plist.add (ARDOUR::Properties::name, region_name);
					plist.add (ARDOUR::Properties::start,
						Temporal::timepos_t (
							static_cast<Temporal::samplepos_t> (0)));
					plist.add (ARDOUR::Properties::length,
						Temporal::timecnt_t::from_samples (length_samples));
					plist.add (ARDOUR::Properties::whole_file, false);
					auto region = ARDOUR::RegionFactory::create (sources, plist, true /* announce */);
					if (!region) {
						PBD::warning << "foyer_shim: create_region: RegionFactory::create (audio) returned null" << endmsg;
						return;
					}
					playlist->add_region (region, Temporal::timepos_t (
						static_cast<Temporal::samplepos_t> (cmd_at_u64 (snap))));
					shim->session ().set_dirty ();
					return;
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
					static_cast<Temporal::samplepos_t> (cmd_at_u64 (snap))));
				foyer_seed_default_region_patch_change (shim->session (), track, region);
				shim->session ().set_dirty ();
				// Playlist's RegionAdded signal fires an echo back
				// to the sidecar, which forwards RegionsList.
			});
			break;
		}
		case DecodedCmd::Kind::AudioIngressOpen: {
			const std::uint32_t sid   = cmd.audio_stream_id;
			const std::uint32_t ch    = cmd.audio_channels;
			const std::uint32_t engine_sr =
			    static_cast<std::uint32_t> (_shim.session ().sample_rate ());
			std::string         name  = cmd.audio_source_name.empty ()
			                            ? std::to_string (sid) : cmd.audio_source_name;
			std::uint32_t fsize = cmd.audio_frame_size;
			if (fsize == 0) {
				fsize = std::max (32u, engine_sr * 20u / 1000u);
			}

			// Honour any `SetIngressRingPrimeMs` the client has
			// already pushed; 0 means "use the default" (the
			// constructor falls back to PRIME_THRESHOLD_MS).
			const std::uint32_t prime_ms =
			    this->_ingress_ring_prime_ms.load (std::memory_order_relaxed);
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, sid, name, ch, engine_sr, fsize, prime_ms, this] () {
				try {
					auto port = std::make_unique<ShimInputPort> (
					    *shim, sid, name, ch, engine_sr, fsize, prime_ms);
					std::string engine_port_name;
					{
						std::lock_guard<std::mutex> lk (this->_ingress_mx);
						this->_ingress_ports[sid] = std::move (port);
						engine_port_name = this->_ingress_ports.at (sid)->engine_port_name ();
					}
					auto ack = msgpack_out::encode_audio_ingress_opened (
					    sid, engine_sr, ch, fsize, name, engine_port_name);
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
		case DecodedCmd::Kind::SetIngressRingPrimeMs: {
			// Cache for the NEXT `AudioIngressOpen` to apply at port
			// construction. Existing ports aren't resized live — the
			// ring is allocated once and the priming threshold can't
			// shrink safely while audio is in flight. Browser resends
			// this on every reconnect, so a UI change reaches the
			// shim before the user opens their next ingress.
			this->_ingress_ring_prime_ms.store (
			    cmd.set_latency_samples, std::memory_order_relaxed);
			break;
		}
		case DecodedCmd::Kind::SetMidiCaptureLatency: {
			// MIDI sibling of SetIngressCaptureLatency. Looks up (or
			// lazy-creates) the per-track soft MIDI port and sets
			// its capture-side latency. Triggers
			// `AudioEngine::latency_callback` so the
			// `_capture_offset` change propagates to the connected
			// track's MidiDiskWriter immediately (otherwise it
			// lands on the next port-change recompute).
			if (cmd.track_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap, this] () {
				ShimMidiInputPort* port = nullptr;
				{
					std::lock_guard<std::mutex> lk (this->_midi_ports_mx);
					auto it = this->_midi_ingress_ports.find (snap.track_id);
					if (it == this->_midi_ingress_ports.end ()) {
						// Eager create: the value matters at record-
						// engage time but we don't know which track
						// the user will hit first, so make the port
						// now and connect lazily on the next write
						// that actually has a route to lock onto.
						auto p = std::make_unique<ShimMidiInputPort> (
						    *shim, snap.track_id);
						port = p.get ();
						this->_midi_ingress_ports.emplace (
						    snap.track_id, std::move (p));
					} else {
						port = it->second.get ();
					}
				}
				if (!port) return;
				port->set_capture_latency (snap.set_latency_samples);
				try {
					AudioEngine::instance ()->latency_callback (false);
				} catch (...) {
					PBD::warning << "foyer_shim: latency_callback threw (midi)"
					             << endmsg;
				}
			});
			break;
		}
		case DecodedCmd::Kind::SetIngressCaptureLatency: {
			// Sets the capture-side latency on the matching soft
			// ingress port so Ardour's `Route::update_signal_latency()`
			// → `DiskWriter::_capture_offset` chain shifts recorded
			// regions earlier by exactly this many samples. Without
			// this the take lands LATE on the timeline by the full
			// browser→shim transport latency (browser capture buffer +
			// WS one-way + IPC + shim ingestion), which the user sees
			// as "I sang on the playhead but the waveform is offset
			// to the right of where I expected it".
			const std::uint32_t sid     = cmd.audio_stream_id;
			const std::uint32_t samples = cmd.set_latency_samples;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, sid, samples, this] () {
				ShimInputPort* port = nullptr;
				{
					std::lock_guard<std::mutex> lk (this->_ingress_mx);
					auto it = this->_ingress_ports.find (sid);
					if (it != this->_ingress_ports.end ()) port = it->second.get ();
				}
				if (!port) {
					PBD::warning << "foyer_shim: set_ingress_capture_latency: "
					             << "unknown stream_id " << sid << endmsg;
					return;
				}
				port->set_capture_latency (samples);
				// Force-propagate so the DiskWriter for any track
				// already wired to this port picks up the new
				// `_capture_offset` immediately. `Session::update_
				// latency_compensation` is protected — the public
				// equivalent is `AudioEngine::latency_callback
				// (for_playback=false)`, which is exactly the path
				// the dummy / JACK backends use after a port's
				// latency range changes. It schedules the session's
				// internal update_latency() pass on the next event
				// pump.
				try {
					(void) shim;
					AudioEngine::instance ()->latency_callback (false);
				} catch (...) {
					PBD::warning << "foyer_shim: latency_callback threw"
					             << endmsg;
				}
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
		case DecodedCmd::Kind::ListMidiPatchNames: {
			if (cmd.track_id.empty ()) break;
			const std::string track_id = cmd.track_id;
			const std::uint8_t channel = static_cast<std::uint8_t> (std::min<int> (15, cmd.midi_channel));
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, track_id, channel] () {
				auto bytes = msgpack_out::encode_midi_patch_names_listed (shim->session (), track_id, channel);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::SetTrackMidiPatch: {
			if (cmd.track_id.empty () || !cmd.has_pc_program) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				if (snap.track_id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.track_id.substr (6);
				auto& session = shim->session ();
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
				for (auto const& r : *routes) {
					if (!r) continue;
					std::ostringstream tmp;
					tmp << r->id ();
					if (tmp.str () == sid) { route = r; break; }
				}
				if (!route) return;
				const std::uint8_t chn = static_cast<std::uint8_t> (std::min<int> (15, snap.midi_channel));
				const std::uint8_t pgm = snap.pc_program;
				const int bank = snap.has_pc_bank ? snap.pc_bank : -1;

				if (std::shared_ptr<MidiTrack> mt = std::dynamic_pointer_cast<MidiTrack> (route)) {
					if (bank >= 0) {
						auto bank_msb = mt->automation_control (
							Evoral::Parameter (MidiCCAutomation, chn, MIDI_CTL_MSB_BANK), true);
						auto bank_lsb = mt->automation_control (
							Evoral::Parameter (MidiCCAutomation, chn, MIDI_CTL_LSB_BANK), true);
						if (bank_msb) bank_msb->set_value ((bank >> 7) & 0x7f, PBD::Controllable::NoGroup);
						if (bank_lsb) bank_lsb->set_value (bank & 0x7f, PBD::Controllable::NoGroup);
					}
					auto program = mt->automation_control (
						Evoral::Parameter (MidiPgmChangeAutomation, chn), true);
					if (program) program->set_value (pgm, PBD::Controllable::NoGroup);
				} else if (std::shared_ptr<PluginInsert> pi =
				           std::dynamic_pointer_cast<PluginInsert> (route->the_instrument ())) {
					if (bank >= 0) {
						uint8_t event[3];
						event[0] = (MIDI_CMD_CONTROL | chn);
						event[1] = MIDI_CTL_MSB_BANK;
						event[2] = (bank >> 7) & 0x7f;
						pi->write_immediate_event (Evoral::MIDI_EVENT, 3, event);
						event[1] = MIDI_CTL_LSB_BANK;
						event[2] = bank & 0x7f;
						pi->write_immediate_event (Evoral::MIDI_EVENT, 3, event);
					}
					uint8_t event[2];
					event[0] = (MIDI_CMD_PGM_CHANGE | chn);
					event[1] = pgm;
					pi->write_immediate_event (Evoral::MIDI_EVENT, 2, event);
				}
				auto bytes = msgpack_out::encode_track_updated (session, snap.track_id);
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
				PBD::warning << "foyer_shim: [preset] load_plugin_preset plugin_id="
				             << plugin_id << " preset_id=" << preset_id
				             << " ok=" << ok << endmsg;
				// Some plugin hosts (notably the LV2 host) don't fire
				// per-parameter `Controllable::Changed` after a preset
				// applies — the values DO change but the UI never hears
				// about it. Push a `track_updated` so the browser
				// re-snapshots the plugin's params with their new
				// values from a single round-trip.
				if (ok) {
					if (auto pi = schema_map::find_plugin_insert_by_foyer_id (shim->session (), plugin_id)) {
						std::ostringstream tid;
						auto routes = schema_map::safe_get_routes (shim->session ());
						for (auto const& r : *routes) {
							if (!r) continue;
							for (uint32_t i = 0;; ++i) {
								auto p = r->nth_plugin (i);
								if (!p) break;
								if (p.get () == static_cast<ARDOUR::Processor*> (pi.get ())) {
									tid << "track." << r->id ();
									break;
								}
							}
							if (!tid.str ().empty ()) break;
						}
						if (!tid.str ().empty ()) {
							auto bytes = msgpack_out::encode_track_updated (shim->session (), tid.str ());
							if (!bytes.empty ()) {
								shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
							}
						}
					}
				}
			});
			break;
		}
		case DecodedCmd::Kind::MidiInput: {
			// Live MIDI from a browser device. Two routing modes:
			//
			// 1. `track_id` set → write to a per-track virtual MIDI
			//    ingress port (`foyer-midi-ingress-<track_id>`) that
			//    we lazy-create and auto-connect to the track's MIDI
			//    in. Going through a real port (vs the older
			//    `write_user_immediate_event` path) is what lets
			//    Ardour apply the empirical `_capture_offset` we set
			//    via `Port::set_private_latency_range` — recorded
			//    events get backdated to the engine frame the user
			//    was actually hearing.
			//
			// 2. `track_id` empty → write to the shared `Foyer Web
			//    MIDI` virtual source port. Users can then connect
			//    track inputs from it the way they'd cable a hardware
			//    controller. No latency comp (no specific recipient
			//    to backdate); suitable for the always-on virtual
			//    keyboard / no-track-armed case.
			if (cmd.midi_byte_count == 0) break;
			if (!cmd.track_id.empty ()) {
				DecodedCmd snap = cmd;
				FoyerShim* shim = &_shim;
				_shim.call_slot (MISSING_INVALIDATOR, [shim, snap, this] () {
					if (snap.track_id.rfind ("track.", 0) != 0) return;
					const std::string sid = snap.track_id.substr (6);
					std::shared_ptr<RouteList const> routes =
					    schema_map::safe_get_routes (shim->session ());
					std::shared_ptr<MidiTrack> mt;
					for (auto const& r : *routes) {
						if (!r) continue;
						std::ostringstream tmp;
						tmp << r->id ();
						if (tmp.str () != sid) continue;
						mt = std::dynamic_pointer_cast<MidiTrack> (r);
						break;
					}
					if (!mt) return;
					ShimMidiInputPort* port = nullptr;
					{
						std::lock_guard<std::mutex> lk (this->_midi_ports_mx);
						auto it = this->_midi_ingress_ports.find (snap.track_id);
						if (it == this->_midi_ingress_ports.end ()) {
							auto p = std::make_unique<ShimMidiInputPort> (
							    *shim, snap.track_id);
							port = p.get ();
							this->_midi_ingress_ports.emplace (
							    snap.track_id, std::move (p));
						} else {
							port = it->second.get ();
						}
					}
					if (!port) return;
					// Idempotent connect — first call wires the port
					// into the track's MIDI in; subsequent calls
					// no-op via PortEngine de-dup.
					port->connect_to_track (*mt);
					port->write_event (snap.midi_bytes, snap.midi_byte_count);
				});
				break;
			}
			auto port = _shim.web_midi_port ();
			if (!port) break;
			port->write (
			    reinterpret_cast<const MIDI::byte*> (cmd.midi_bytes),
			    cmd.midi_byte_count,
			    0);
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
		case DecodedCmd::Kind::UndoGroupBegin: {
			// Opens a reversible-command transaction that remains
			// open across subsequent mutation dispatches until
			// UndoGroupEnd closes it. Mutation handlers inspect
			// `_undo_group_depth` and skip their own per-op begin/
			// commit pair when a group is active — the whole batch
			// becomes one undo step. Label from cmd.id (client
			// passes the group's `name` as the id field).
			std::string label = cmd.id.empty () ? std::string ("Foyer batch") : cmd.id;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, label] () {
				if (self->_undo_group_depth == 0) {
					shim->session ().begin_reversible_command (label);
				}
				self->_undo_group_depth++;
			});
			break;
		}
		case DecodedCmd::Kind::UndoGroupEnd: {
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self] () {
				if (self->_undo_group_depth == 0) return;
				self->_undo_group_depth--;
				if (self->_undo_group_depth == 0) {
					shim->session ().commit_reversible_command ();
				}
			});
			break;
		}
		// ── Scripts ───────────────────────────────────────────────
		case DecodedCmd::Kind::ListScripts: {
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				auto scripts = schema_map::ScriptStore::instance ().list ();
				auto bytes = msgpack_out::encode_script_list (scripts);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::SaveScript: {
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				schema_map::ScriptRecord rec;
				rec.id = snap.script_id;
				rec.name = snap.script_name;
				rec.description = snap.script_description;
				rec.script_type = snap.script_type;
				rec.language = snap.script_language.empty () ? std::string ("lua") : snap.script_language;
				rec.enabled = snap.has_script_enabled ? snap.script_enabled : true;
				rec.body = snap.script_body;
				rec.args = snap.script_args;
				rec.hook = snap.script_hook;
				std::string save_err;
				auto saved = schema_map::save_script (shim->session (), std::move (rec), &save_err);
				// Always emit script_saved so the FE caches what the user
				// typed (don't lose their work on a syntax error). When the
				// Lua VM rejected the body, ALSO emit a typed
				// `save_script_failed` Event::Error so the agent sees the
				// failure instead of believing the script is installed.
				auto bytes = msgpack_out::encode_script_saved (saved);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				if (!save_err.empty ()) {
					auto err = msgpack_out::encode_error (
						"save_script_failed",
						"script '" + saved.id + "': " + save_err);
					if (!err.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, err);
				}
			});
			break;
		}
		case DecodedCmd::Kind::DeleteScript: {
			if (cmd.id.empty ()) break;
			std::string id = cmd.id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, id] () {
				schema_map::delete_script (shim->session (), id);
				auto bytes = msgpack_out::encode_script_removed (id);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::EnableScript: {
			if (cmd.id.empty () || !cmd.has_script_enabled) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto& store = schema_map::ScriptStore::instance ();
				auto cur = store.get (snap.id);
				if (!cur) {
					auto err = msgpack_out::encode_error (
						"enable_script_failed", "unknown script: " + snap.id);
					if (!err.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, err);
					return;
				}
				cur->enabled = snap.script_enabled;
				if (snap.script_enabled) cur->disabled_on_upload = false;
				std::string save_err;
				schema_map::ScriptRecord saved = schema_map::save_script (shim->session (), *cur, &save_err);
				auto bytes = msgpack_out::encode_script_saved (saved);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				if (!save_err.empty ()) {
					auto err = msgpack_out::encode_error (
						"save_script_failed",
						"script '" + saved.id + "': " + save_err);
					if (!err.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, err);
				}
			});
			break;
		}
		case DecodedCmd::Kind::RunScript: {
			if (cmd.id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap] () {
				auto outcome = schema_map::run_script (
					shim->session (), snap.id,
					snap.script_has_args_override ? snap.script_args
					                              : std::map<std::string, std::string> {});
				auto bytes = msgpack_out::encode_script_run_result (
					snap.id, outcome.ok, outcome.stdout_text,
					outcome.error_text, outcome.elapsed_ms);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::RecoverDisabledScripts: {
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim] () {
				schema_map::recover_disabled_scripts (shim->session ());
				// After recovery the cache is the source of truth;
				// echo a fresh ScriptList so every client picks it up.
				auto scripts = schema_map::ScriptStore::instance ().list ();
				auto bytes = msgpack_out::encode_script_list (scripts);
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::SubscribeSpectrum:
		case DecodedCmd::Kind::UnsubscribeSpectrum: {
			// The Ardour shim hasn't shipped its FFT pipeline yet — see
			// the encode_session_snapshot's `spectrum.available = false`
			// advertisement, which the FE keys off to hide the analyser
			// surfaces on this backend. Subscribers that get here
			// despite the cap flag receive a clear error event so MCP
			// agents don't sit idle waiting for frames that never
			// arrive. Implementing the real path means: tap the
			// destination Route's outputs through a per-subscription
			// disk-thread analyser, run a Hann-windowed FFT every hop,
			// and emit `encode_spectrum_frame` from a low-priority
			// idle slot.
			FoyerShim* shim = &_shim;
			auto bytes = msgpack_out::encode_error (
				"spectrum_not_supported",
				"This Ardour shim build hasn't shipped the FFT pipeline yet — "
				"switch to the stub backend for a working spectrum analyser, "
				"or wait for a shim with `spectrum.available=true` advertised "
				"in the session snapshot.");
			if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
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
							const int rv = io->connect (port, snap.patch_input_port, nullptr);
							if (rv != 0) {
								PBD::error << "foyer_shim: set_track_input: connect("
								           << port->name () << " → " << snap.patch_input_port
								           << ") failed with rv=" << rv << endmsg;
							} else {
								PBD::warning << "foyer_shim: set_track_input: connected "
								          << port->name () << " → " << snap.patch_input_port << endmsg;
							}
						}
						// Force `ExistingMaterial` alignment so the port's
						// `_capture_offset` actually moves recordings.
						// See the parallel call in the `UpdateTrack` handler
						// for the full rationale.
						if (auto trk = std::dynamic_pointer_cast<ARDOUR::Track> (route)) {
							trk->set_align_choice (UseExistingMaterial, true);
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
		case DecodedCmd::Kind::SetTrackMidiChannelMode: {
			if (cmd.track_id.empty () || cmd.ports_direction.empty ()
			    || cmd.auto_mode.empty ()) break;
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
				auto mt = std::dynamic_pointer_cast<ARDOUR::MidiTrack> (route);
				if (!mt) {
					PBD::warning << "foyer_shim: set_track_midi_channel_mode: not a MIDI track: "
					             << snap.track_id << endmsg;
					return;
				}
				ARDOUR::ChannelMode m;
				if      (snap.auto_mode == "all")    m = ARDOUR::AllChannels;
				else if (snap.auto_mode == "filter") m = ARDOUR::FilterChannels;
				else if (snap.auto_mode == "force")  m = ARDOUR::ForceChannel;
				else {
					PBD::warning << "foyer_shim: set_track_midi_channel_mode: bad mode: "
					             << snap.auto_mode << endmsg;
					return;
				}
				if (snap.ports_direction == "capture") {
					mt->set_capture_channel_mode (m, snap.midi_chan_mask);
				} else if (snap.ports_direction == "playback") {
					mt->set_playback_channel_mode (m, snap.midi_chan_mask);
				} else {
					PBD::warning << "foyer_shim: set_track_midi_channel_mode: bad direction: "
					             << snap.ports_direction << endmsg;
					return;
				}
				auto bytes = msgpack_out::encode_track_updated (shim->session (), snap.track_id);
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::ShimQuit: {
			// Sidecar asked us to exit. Raise SIGTERM on our own pid
			// so Ardour's own signal handler runs the normal save-
			// and-exit path (with the user's "save before quit"
			// preferences honored). The sidecar follows up with a
			// SIGTERM/SIGKILL escalation against the child PID if we
			// don't exit within ~5s, so we don't need a wait loop
			// here. Raised from the dispatcher thread; Ardour's
			// signal handlers are async-signal-safe and route the
			// shutdown through the GUI mainloop.
			PBD::warning << "foyer_shim: shim_quit received — raising SIGTERM" << endmsg;
			std::raise (SIGTERM);
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
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
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				// Track delete is not reversible at the session level
				// from outside the GUI — `Session::remove_route` does
				// not capture an undo memento, and reconstructing a
				// removed Route from XML is non-trivial. We still open
				// a transaction so a parent undo group can keep its
				// shape, but don't add a command — the empty txn is
				// dropped on commit.
				if (own_txn) session.begin_reversible_command ("Foyer delete track");
				session.remove_route (route);
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_patch_reload ();
				shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ReorderTracks: {
			if (cmd.ordered_track_ids.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				const bool own_txn = (self->_undo_group_depth == 0);
				// Reorder writes PresentationInfo::order on each route.
				// PresentationInfo is its own Stateful object reachable
				// per-route; an undo memento would need to capture each
				// affected route's PI state. Deferring — the current
				// txn is opened but no command is added, so undo is a
				// no-op for reorder. Tracked as a follow-up.
				if (own_txn) session.begin_reversible_command ("Foyer reorder tracks");
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
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
				if (own_txn) session.commit_reversible_command ();
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				// Locate the route by foyer id. Begin the reversible
				// command only after validation so early-returns
				// don't leave dangling open transactions.
				if (snap.id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.id.substr (6);
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
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
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer update track");
				route->clear_changes ();
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
								const int rv = io->connect (port, snap.patch_input_port, nullptr);
								if (rv != 0) {
									PBD::error << "foyer_shim: update_track: connect("
									           << port->name () << " → " << snap.patch_input_port
									           << ") failed with rv=" << rv << endmsg;
								} else {
									PBD::warning << "foyer_shim: update_track: connected "
									          << port->name () << " → " << snap.patch_input_port << endmsg;
								}
							}
							// CRITICAL: force `ExistingMaterial` alignment on
							// the track. By default Ardour picks `CaptureTime`
							// for any track whose input isn't physically /
							// externally connected (see
							// `Track::set_align_choice_from_io`). For a
							// `CaptureTime` track Ardour IGNORES the input
							// port's `_capture_offset` — the latency value
							// we set via `Port::set_private_latency_range`
							// has zero effect, recordings land late by the
							// full browser→shim transport. `ExistingMaterial`
							// is what makes `DiskWriter::_first_recordable_sample
							// += _capture_offset` actually fire.
							//
							// We do this unconditionally on every input-port
							// change. Browser-ingress is the only path that
							// drives this handler in Foyer today; if a future
							// path connects a track input to something where
							// `CaptureTime` is actually wanted (e.g. an
							// external sequence with its own latency already
							// baked in), we'll need a switch.
							if (auto trk = std::dynamic_pointer_cast<ARDOUR::Track> (route)) {
								trk->set_align_choice (UseExistingMaterial, true);
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
											out_io->connect (out_port, bus_port->name (), nullptr);
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

				// Capture the route's property-bag diff (covers name +
				// any other Stateful properties touched above). Port
				// connections + RouteGroup membership are not in the
				// property bag — those mutations don't yet round-trip
				// through undo.
				session.add_command (new PBD::StatefulDiffCommand (route));
				if (group_changed) {
					if (own_txn) session.commit_reversible_command ();
					auto bytes = msgpack_out::encode_patch_reload ();
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				} else {
					if (own_txn) session.commit_reversible_command ();
					auto bytes = msgpack_out::encode_track_updated (session, snap.id);
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
				bool already_added = false;
				for (auto const& existing : session.route_groups ()) {
					if (existing == rg) {
						already_added = true;
						break;
					}
				}
				if (!already_added) {
					session.add_route_group (rg);
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
				if (snap.has_group_patch_active) {
					rg->set_active (snap.group_patch_active, nullptr);
				}
				if (snap.has_group_patch_link_gain) {
					rg->set_gain (snap.group_patch_link_gain);
				}
				if (snap.has_group_patch_link_mute) {
					rg->set_mute (snap.group_patch_link_mute);
				}
				if (snap.has_group_patch_link_solo) {
					rg->set_solo (snap.group_patch_link_solo);
				}
				if (snap.has_group_patch_link_record) {
					rg->set_recenable (snap.group_patch_link_record);
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
				// After undo/redo, the rollback flips object state via
				// `set_state()` calls. Those don't reliably re-fire the
				// per-property signals our SignalBridge subscribes to —
				// the browser would keep showing the pre-undo state
				// even though the session has rolled back. We push a
				// `patch_reload` event so the client refetches a clean
				// snapshot. Heavier than per-property echoes but
				// bulletproof: any object touched by undo gets surfaced.
				else if (id == "edit.undo") {
					const auto before = session.undo_redo ().undo_depth ();
					session.undo (1);
					if (session.undo_redo ().undo_depth () < before) {
						auto bytes = msgpack_out::encode_patch_reload ();
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
				}
				else if (id == "edit.redo") {
					const auto before = session.undo_redo ().redo_depth ();
					session.redo (1);
					if (session.undo_redo ().redo_depth () < before) {
						auto bytes = msgpack_out::encode_patch_reload ();
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
				}
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
					auto added = session.new_midi_track (
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
					// Default to ForceChannel @ ch 1 on both capture and
					// playback. Ardour's stock default is AllChannels,
					// which makes the channel selector permanently
					// relevant; the Foyer UX is "single-channel by
					// default, surface the selector only when the user
					// has opted into multi-channel" — see TODO #270 +
					// Decision: defaulting to ForceChannel keeps new
					// tracks compatible with single-channel synths and
					// hides the selector unless the user changes it.
					for (auto const& mt : added) {
						if (!mt) continue;
						mt->set_capture_channel_mode  (ARDOUR::ForceChannel, 0x0001);
						mt->set_playback_channel_mode (ARDOUR::ForceChannel, 0x0001);
					}
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				// Find the target track.
				if (snap.track_id.rfind ("track.", 0) != 0) return;
				const std::string sid = snap.track_id.substr (6);
				auto& session = shim->session ();
				std::shared_ptr<Route> route;
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
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
					plug = ARDOUR::find_plugin (session, snap.plugin_uri, t);
					if (plug) break;
				}
				if (!plug) {
					PBD::warning << "foyer_shim: add_plugin: no plugin with unique_id '" << snap.plugin_uri << "'" << endmsg;
					// Surface to the client as a typed error event so
					// the agent / FE see the failure instead of a
					// silent "command accepted". The previous behavior
					// returned 0 to the WS layer and the agent thought
					// the insert worked. Frequent root cause: a
					// just-saved Lua DSP script whose lua_refresh has
					// not yet repopulated `PluginManager::_lua_plugin_info`,
					// so `find_plugin(Lua)` misses by unique_id.
					auto bytes = msgpack_out::encode_error (
						"add_plugin_unknown",
						"no plugin with unique_id '" + snap.plugin_uri + "'");
					if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					return;
				}

				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer add plugin");
				// Route::add_processor / remove_processor don't auto-
				// record undo — the GUI captures it via a
				// MementoCommand<Route> snapshotting full route XML
				// before/after. We mirror that pattern.
				XMLNode& before = route->get_state ();
				auto pi = std::make_shared<ARDOUR::PluginInsert> (session, session, plug);
				if (route->add_processor (pi, ARDOUR::PreFader, nullptr, true) != 0) {
					delete &before;
					if (own_txn) session.commit_reversible_command ();
					PBD::warning << "foyer_shim: add_plugin: Route::add_processor failed for " << snap.plugin_uri << endmsg;
					return;
				}
				// Clone params from source plugin when the duplicate
				// gesture asked for it. We do this AFTER add_processor
				// so the new PluginInsert is fully initialized — its
				// `_shadow_data` (LV2) / parameter cache exists for
				// `set_parameter` to write into. The route's get_state()
				// after the copy then captures the new plugin already
				// populated, so the MementoCommand+TrackUpdated below
				// see the cloned values without a second pass.
				if (!snap.clone_from.empty ()) {
					auto src_pi = schema_map::find_plugin_insert_by_foyer_id (session, snap.clone_from);
					if (src_pi && src_pi->plugin () && pi->plugin ()) {
						auto src_plug = src_pi->plugin ();
						// Bypass mirror — `active()` is "not bypassed".
						if (src_pi->active ()) pi->activate ();
						else                   pi->deactivate ();
						// Plugin::set_parameter is protected; the public
						// path is the per-param AutomationControl on the
						// PluginInsert. Walk source params, read the
						// current value via Plugin::get_parameter (public),
						// write via dst's AutomationControl::set_value.
						const std::uint32_t pcount = src_plug->parameter_count ();
						for (std::uint32_t p = 0; p < pcount; ++p) {
							if (!src_plug->parameter_is_control (p)) continue;
							if (!src_plug->parameter_is_input (p)) continue;
							const float val = src_plug->get_parameter (p);
							auto dst_ac = pi->automation_control (
							    Evoral::Parameter (ARDOUR::PluginAutomation, 0, p));
							if (dst_ac) {
								dst_ac->set_value (val, PBD::Controllable::NoGroup);
							}
						}
					} else if (!src_pi) {
						PBD::warning << "foyer_shim: add_plugin: clone_from id not found: "
						             << snap.clone_from
						             << " (proceeding with default-state plugin)" << endmsg;
					}
				}
				session.add_command (new MementoCommand<ARDOUR::Route> (
				    *route, &before, &route->get_state ()));
				if (own_txn) session.commit_reversible_command ();
				// Success — ask the signal bridge to re-emit the route's
				// snapshot so clients see the new plugin instance.
				auto bytes = msgpack_out::encode_track_updated (session, snap.track_id);
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				// plugin_id format is "plugin.<pbd-id>" — reuse the
				// same resolution pattern ControlSet uses for the
				// bypass toggle.
				if (snap.plugin_id.rfind ("plugin.", 0) != 0) return;
				const std::string pid = snap.plugin_id.substr (7);
				auto& session = shim->session ();
				std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
				// Locate first so we can skip begin/commit when the
				// plugin id doesn't resolve — keeps dangling txn out
				// of the way.
				std::shared_ptr<Route> target_route;
				std::shared_ptr<Processor> target_proc;
				for (auto const& r : *routes) {
					if (!r) continue;
					r->foreach_processor ([&] (std::weak_ptr<Processor> wp) {
						if (target_proc) return;
						auto proc = wp.lock ();
						if (!proc) return;
						std::ostringstream os;
						os << proc->id ();
						if (os.str () != pid) return;
						target_route = r;
						target_proc = proc;
					});
					if (target_proc) break;
				}
				if (!target_route || !target_proc) {
					PBD::warning << "foyer_shim: remove_plugin: plugin_id not found: " << snap.plugin_id << endmsg;
					return;
				}
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer remove plugin");
				XMLNode& before = target_route->get_state ();
				std::string affected_track;
				if (target_route->remove_processor (target_proc) == 0) {
					session.add_command (new MementoCommand<ARDOUR::Route> (
					    *target_route, &before, &target_route->get_state ()));
					std::ostringstream tid;
					tid << target_route->id ();
					affected_track = "track." + tid.str ();
				} else {
					delete &before;
					PBD::warning << "foyer_shim: remove_plugin: Route::remove_processor failed" << endmsg;
				}
				if (own_txn) session.commit_reversible_command ();
				if (!affected_track.empty ()) {
					auto bytes = msgpack_out::encode_track_updated (session, affected_track);
					if (!bytes.empty ()) {
						shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
					}
				}
			});
			break;
		}
		case DecodedCmd::Kind::MovePlugin: {
			if (cmd.plugin_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				auto target_pi = schema_map::find_plugin_insert_by_foyer_id (session, snap.plugin_id);
				if (!target_pi) {
					PBD::warning << "foyer_shim: move_plugin: plugin not found: "
					             << snap.plugin_id << endmsg;
					return;
				}
				// Find the route that hosts this PluginInsert.
				std::shared_ptr<ARDOUR::Route> route;
				{
					std::shared_ptr<RouteList const> routes = schema_map::safe_get_routes (session);
					for (auto const& r : *routes) {
						if (!r) continue;
						for (uint32_t i = 0;; ++i) {
							auto p = r->nth_plugin (i);
							if (!p) break;
							if (p.get () == static_cast<ARDOUR::Processor*> (target_pi.get ())) {
								route = r; break;
							}
						}
						if (route) break;
					}
				}
				if (!route) {
					PBD::warning << "foyer_shim: move_plugin: host route not located for "
					             << snap.plugin_id << endmsg;
					return;
				}

				// Build the new visible-processor order. `Route::reorder_processors`
				// expects the full list of `display_to_user()` processors in the
				// new order; missing ones are treated as deleted (route.cc:2178)
				// so we MUST include every visible processor, not just plugins.
				// `new_index` is the 0-based slot the moved plugin should occupy
				// among PluginInserts after the move — translate to the visible
				// list's position by counting non-target plugins as we walk.
				ARDOUR::Route::ProcessorList visible;
				route->foreach_processor (
				    [&visible] (std::weak_ptr<ARDOUR::Processor> wp) {
				        auto p = wp.lock ();
				        if (p && p->display_to_user ()) visible.push_back (p);
				    });

				ARDOUR::Route::ProcessorList new_order;
				bool inserted = false;
				std::uint32_t plugin_seen = 0;
				for (auto const& p : visible) {
					if (p.get () == static_cast<ARDOUR::Processor*> (target_pi.get ())) {
						continue; // remove from current slot
					}
					const bool is_plugin =
					    static_cast<bool> (std::dynamic_pointer_cast<ARDOUR::PluginInsert> (p));
					if (is_plugin && plugin_seen == snap.move_new_index && !inserted) {
						new_order.push_back (target_pi);
						inserted = true;
					}
					new_order.push_back (p);
					if (is_plugin) ++plugin_seen;
				}
				if (!inserted) new_order.push_back (target_pi);

				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer move plugin");
				XMLNode& before = route->get_state ();
				if (route->reorder_processors (new_order, nullptr) != 0) {
					delete &before;
					if (own_txn) session.commit_reversible_command ();
					PBD::warning << "foyer_shim: move_plugin: reorder_processors failed for "
					             << snap.plugin_id << " new_index=" << snap.move_new_index << endmsg;
					return;
				}
				session.add_command (new MementoCommand<ARDOUR::Route> (
				    *route, &before, &route->get_state ()));
				if (own_txn) session.commit_reversible_command ();

				std::ostringstream tid;
				tid << "track." << route->id ();
				auto bytes = msgpack_out::encode_track_updated (session, tid.str ());
				if (!bytes.empty ()) {
					shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
				}
			});
			break;
		}
		case DecodedCmd::Kind::OpenPluginGui:
		case DecodedCmd::Kind::ClosePluginGui: {
			// Plugin window open/close. `Processor` (libardour, line
			// processor.h:158-160) declares three cross-thread signals
			// — `ShowUI`, `HideUI`, `ToggleUI` — that gtk2_ardour's
			// ProcessorBox auto-connects when a processor lands on a
			// route. Emitting them from the shim is the canonical
			// pattern (Mackie surface does the same in subview.cc:1198).
			//
			// The signal is delivered to the gtk2_ardour main loop, so
			// when we're loaded into the GUI Ardour binary running
			// against an X display (Xvfb in container deployments),
			// the editor window appears on that display — captureable
			// by xpra and embeddable in the Foyer web UI.
			//
			// In headless `hardour` mode there's no GUI thread to
			// receive the signal, so this is a no-op there. The web
			// UI's "Native GUI" toggle is gated client-side on the
			// `has_native_gui` capability bit, which is only set when
			// the plugin actually has an editor.
			if (cmd.plugin_id.empty ()) break;
			const bool show = (cmd.kind == DecodedCmd::Kind::OpenPluginGui);
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, snap, show] () {
				auto& session = shim->session ();
				auto pi = schema_map::find_plugin_insert_by_foyer_id (session, snap.plugin_id);
				if (!pi) {
					PBD::warning << "foyer_shim: " << (show ? "open" : "close")
					             << "_plugin_gui: plugin not found: "
					             << snap.plugin_id << endmsg;
					return;
				}
				// Upcast to Processor — that's where the signal lives.
				std::shared_ptr<ARDOUR::Processor> proc = pi;
				if (show) {
					proc->ShowUI (); /* EMIT SIGNAL */
				} else {
					proc->HideUI (); /* EMIT SIGNAL */
				}
			});
			break;
		}
		case DecodedCmd::Kind::SaveSession: {
			// Empty `as_path` → save in place. Non-empty → absolute path to
			// the new session directory; must use Session::save_as(), not
			// save_state() (the latter's string arg is a *snapshot* name).
			std::string as_path = cmd.id;
			FoyerShim* shim = &_shim;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, as_path] () {
				Session& session = shim->session ();
				if (as_path.empty ()) {
					session.save_state ("");
					return;
				}
				namespace fs = std::filesystem;
				fs::path target = fs::path (as_path).lexically_normal ();
				fs::path parent  = target.parent_path ();
				fs::path name    = target.filename ();
				if (name.empty ()) {
					PBD::warning << "foyer_shim: save_session: invalid as_path (no folder name): '"
					             << as_path << "'" << endmsg;
					auto err = msgpack_out::encode_error (
					    "save_session_failed",
					    std::string ("invalid save path (no folder name): ") + as_path);
					shim->ipc ().send (foyer_ipc::FrameKind::Control, err);
					return;
				}
				Session::SaveAs sa;
				sa.new_parent_folder = parent.empty () ? std::string (".") : parent.generic_string ();
				sa.new_name          = name.generic_string ();
				sa.switch_to         = true;
				sa.include_media     = true;
				sa.copy_media        = true;
				// `copy_external` runs `bring_all_sources_into_session`; it often fails on
				// normal projects (outside paths, permissions) and returns -1 with only
				// `failure_message` — leave media paths as references unless we add a
				// dedicated "consolidate" UX.
				sa.copy_external     = false;
				int const r = session.save_as (sa);
				if (r != 0) {
					PBD::warning << "foyer_shim: save_as failed (" << r << "): " << sa.failure_message
					             << endmsg;
					std::string const& fm = sa.failure_message;
					std::string msg       = fm.empty ()
					                            ? (std::string ("save_as failed (code ") + std::to_string (r) + ")")
					                            : fm;
					auto err = msgpack_out::encode_error ("save_session_failed", msg);
					shim->ipc ().send (foyer_ipc::FrameKind::Control, err);
					return;
				}
				PBD::info << "foyer_shim: save_as completed → " << sa.final_session_folder_name << endmsg;
				auto bytes = msgpack_out::encode_patch_reload ();
				shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
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
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (session, snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer add automation point");
				XMLNode& before = alist->get_state ();
				// Wire → internal unit conversion. Same contract as
				// the live ControlSet path in this file (line ~1935):
				// the wire ships gain in dB and pan in [-1, 1], but
				// Ardour's AutomationList stores raw INTERNAL values
				// (linear amplitude for gain, [0, 1] for pan). Without
				// this conversion, a -10 dB point in the UI ended up
				// as a -10 linear coefficient in the lane and got
				// clamped to silence on playback — the "automation
				// looks flat at -140 dB" bug Rich reported 2026-05-15.
				double write_value = snap.auto_point.value;
				if (schema_map::is_gain_id (snap.lane_id)) {
					write_value = schema_map::gain_wire_to_ardour (write_value);
				} else if (schema_map::is_pan_id (snap.lane_id)) {
					write_value = schema_map::pan_wire_to_ardour (write_value);
				}
				alist->add (Temporal::timepos_t (static_cast<Temporal::samplepos_t> (snap.auto_point.time_samples)), write_value);
				session.add_command (new MementoCommand<ARDOUR::AutomationList> (
				    *alist, &before, &alist->get_state ()));
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_track_updated (session, schema_map::track_id_for_control (session, snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::UpdateAutomationPoint: {
			if (cmd.lane_id.empty () || !cmd.has_auto_orig_time) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (session, snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer move automation point");
				XMLNode& before = alist->get_state ();
				// Rebuild the lane around the point at `auto_orig_time`.
				// Matching on (time,value) is fragile because the UI sends
				// the *new* value; using nearest-time replacement avoids
				// value-mismatch snap-back when dragging.
				std::vector<std::pair<Temporal::samplepos_t, double>> pts;
				{
					Glib::Threads::RWLock::ReaderLock lm (alist->lock ());
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
				// Convert the incoming wire value into Ardour's
				// internal units (see AddAutomationPoint above for
				// the rationale).
				double write_value = snap.auto_point.value;
				if (schema_map::is_gain_id (snap.lane_id)) {
					write_value = schema_map::gain_wire_to_ardour (write_value);
				} else if (schema_map::is_pan_id (snap.lane_id)) {
					write_value = schema_map::pan_wire_to_ardour (write_value);
				}
				if (best_idx != static_cast<std::size_t> (-1)) {
					pts[best_idx] = { new_time, write_value };
				} else {
					pts.push_back ({ new_time, write_value });
				}
				alist->clear ();
				for (auto const& pt : pts) {
					alist->add (Temporal::timepos_t (pt.first), pt.second);
				}
				session.add_command (new MementoCommand<ARDOUR::AutomationList> (
				    *alist, &before, &alist->get_state ()));
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_track_updated (session, schema_map::track_id_for_control (session, snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::DeleteAutomationPoint: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (session, snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer delete automation point");
				XMLNode& before = alist->get_state ();
				// The (time, value) pair we use to identify which
				// point to erase has to match what's actually stored
				// in the lane — i.e. the internal-unit value, not
				// the wire-unit value the UI sent. Apply the same
				// dB→linear / pan→[0,1] conversion as the add /
				// update paths.
				double erase_value = snap.auto_point.value;
				if (schema_map::is_gain_id (snap.lane_id)) {
					erase_value = schema_map::gain_wire_to_ardour (erase_value);
				} else if (schema_map::is_pan_id (snap.lane_id)) {
					erase_value = schema_map::pan_wire_to_ardour (erase_value);
				}
				alist->erase (
					Temporal::timepos_t (static_cast<Temporal::samplepos_t> (snap.auto_point.time_samples)),
					erase_value);
				session.add_command (new MementoCommand<ARDOUR::AutomationList> (
				    *alist, &before, &alist->get_state ()));
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_track_updated (session, schema_map::track_id_for_control (session, snap.lane_id));
				if (!bytes.empty ()) shim->ipc ().send (foyer_ipc::FrameKind::Control, bytes);
			});
			break;
		}
		case DecodedCmd::Kind::ReplaceAutomationLane: {
			if (cmd.lane_id.empty ()) break;
			DecodedCmd snap = cmd;
			FoyerShim* shim = &_shim;
			Dispatcher* self = this;
			_shim.call_slot (MISSING_INVALIDATOR, [shim, self, snap] () {
				auto& session = shim->session ();
				auto ac = std::dynamic_pointer_cast<ARDOUR::AutomationControl> (
				    schema_map::resolve_automation_control (session, snap.lane_id));
				if (!ac) return;
				auto alist = ac->alist ();
				if (!alist) return;
				// Avoid fast_simple_add under a manually-held writer lock; using
				// public mutators here has been markedly safer across Ardour
				// builds when replacing the entire lane.
				const bool own_txn = (self->_undo_group_depth == 0);
				if (own_txn) session.begin_reversible_command ("Foyer replace automation lane");
				XMLNode& before = alist->get_state ();
				alist->clear ();
				// Pre-bind the converter for this lane id so we don't
				// re-check the suffix on every point. Most lanes
				// don't need conversion (pass-through identity), the
				// gain + pan ones do.
				const bool is_gain = schema_map::is_gain_id (snap.lane_id);
				const bool is_pan  = schema_map::is_pan_id  (snap.lane_id);
				for (auto const& pt : snap.auto_points) {
					double v = pt.value;
					if (is_gain) v = schema_map::gain_wire_to_ardour (v);
					else if (is_pan) v = schema_map::pan_wire_to_ardour (v);
					alist->add (Temporal::timepos_t (static_cast<Temporal::samplepos_t> (pt.time_samples)), v);
				}
				alist->mark_dirty ();
				session.add_command (new MementoCommand<ARDOUR::AutomationList> (
				    *alist, &before, &alist->get_state ()));
				if (own_txn) session.commit_reversible_command ();
				auto bytes = msgpack_out::encode_track_updated (session, schema_map::track_id_for_control (session, snap.lane_id));
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
