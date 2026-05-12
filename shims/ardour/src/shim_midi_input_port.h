// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: soft input port for per-track browser MIDI.
 */
#ifndef foyer_shim_midi_input_port_h
#define foyer_shim_midi_input_port_h

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

#include "ardour/types.h"

namespace ARDOUR {
class AsyncMIDIPort;
class MidiTrack;
}

namespace ArdourSurface {

class FoyerShim;

/// Virtual MIDI input port fed by Web MIDI events arriving over the
/// control-plane envelope. Lives per-track: when the dispatcher sees
/// the first `MidiInput { track_id }` for a track it lazy-creates
/// one of these, registers `foyer-midi-ingress-<track_id>` with the
/// engine, and connects it into the matching track's MIDI in. All
/// subsequent events for that track flow through this port instead
/// of `MidiTrack::write_user_immediate_event` (which bypasses port
/// latency, so the older path couldn't backdate recorded events).
///
/// Why per-track instead of one shared port:
///   * Routing — a shared port fanning out to multiple armed MIDI
///     tracks would duplicate every event onto every connected
///     track. Per-track means events land only where intended.
///   * Latency comp — `Port::set_private_latency_range` is per-port
///     and propagates into the connected sinks' `_capture_offset`.
///     A shared port would force every armed track to share a
///     single empirical-roundtrip number; per-track lets each
///     track's port carry its own number (helpful when devices
///     with different USB latencies feed different tracks).
///
/// Backed by `AsyncMIDIPort` (same as the surface's shared
/// `Foyer Web MIDI` output). The async port internally handles the
/// non-RT-to-RT handoff so we don't need our own event ring + RT
/// drain like `ShimInputPort` does for audio.
class ShimMidiInputPort {
public:
	ShimMidiInputPort (FoyerShim& shim, const std::string& track_id);
	~ShimMidiInputPort ();

	/// Engine-level name of the registered port (e.g.
	/// `foyer_shim:foyer-midi-ingress-track.0123`). Empty string if
	/// registration failed. The track-input picker resolver looks
	/// this up when auto-connecting.
	const std::string& engine_port_name () const { return _engine_port_name; }
	const std::string& track_id () const { return _track_id; }

	/// Connect this port into `track`'s MIDI input. Idempotent — a
	/// re-connect call after a port-graph refresh is harmless.
	/// Returns true on success.
	bool connect_to_track (ARDOUR::MidiTrack& track);

	/// Write a raw MIDI message onto the port. Non-RT; the underlying
	/// `AsyncMIDIPort` queues internally and the RT thread drains on
	/// the next cycle.
	void write_event (const std::uint8_t* bytes, std::size_t n);

	/// Set the port's capture-side private latency range (samples at
	/// engine sample rate). Honours the global capture-latency lock
	/// from `ShimInputPort` so audio and MIDI freeze together at
	/// `RecordStateChanged` rising edge. Adds the engine's current
	/// cycle samples on top of `samples` because the `AsyncMIDIPort`
	/// non-RT → RT handoff adds exactly one cycle of latency before
	/// the event becomes visible at the connected track's MIDI in.
	void set_capture_latency (std::uint32_t samples);
	std::uint32_t capture_latency_samples () const { return _capture_latency_samples; }

private:
	FoyerShim&                                _shim;
	std::string                               _track_id;
	std::shared_ptr<ARDOUR::AsyncMIDIPort>    _port;
	std::string                               _engine_port_name;
	std::uint32_t                             _capture_latency_samples = 0;
	std::atomic<bool>                         _stopped { false };
};

} // namespace ArdourSurface

#endif
