// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: per-track soft input port for browser MIDI.
 *
 * Companion to ShimInputPort (audio). The data path:
 *   browser keyboard / device
 *      → Web MIDI API in the page
 *      → WS control-plane envelope (Command::MidiInput { data, track_id, echo_ns })
 *      → sidecar measures echo round-trip, drives `set_midi_capture_latency`
 *      → IPC frame (FrameKind::Control)
 *      → dispatch.cc::Command::MidiInput case
 *      → ShimMidiInputPort::write_event(data, n)         [non-RT IPC thread]
 *      → AsyncMIDIPort internal queue
 *      → Ardour RT thread drains on the next process cycle
 *      → connected track receives the event with `_capture_offset` applied
 */
#include "shim_midi_input_port.h"

#include "ardour/async_midi_port.h"
#include "ardour/audioengine.h"
#include "ardour/midi_port.h"
#include "ardour/midi_track.h"
#include "ardour/port_engine.h"
#include "ardour/port_manager.h"
#include "pbd/error.h"

#include "shim_input_port.h"
#include "surface.h"

namespace ArdourSurface {

using namespace ARDOUR;

namespace {
/// Build the bare port name the engine sees. Avoids `:` so Ardour
/// doesn't try to route on a `client:port` prefix (same constraint
/// the audio ingress port hit, see `ShimInputPort` ctor).
std::string bare_port_name (const std::string& track_id)
{
	// Substitute any colon in the track id so the port name stays
	// safe to feed into `register_output_port` / engine connect.
	std::string s = "foyer-midi-ingress-" + track_id;
	for (auto& c : s) {
		if (c == ':') c = '_';
	}
	return s;
}
} // namespace

ShimMidiInputPort::ShimMidiInputPort (FoyerShim& shim, const std::string& track_id)
    : _shim (shim)
    , _track_id (track_id)
{
	auto engine = AudioEngine::instance ();
	const std::string name = bare_port_name (track_id);
	try {
		auto p = engine->register_output_port (
		    DataType::MIDI, name, true /* async */, PortFlags (0));
		_port = std::dynamic_pointer_cast<AsyncMIDIPort> (p);
		if (_port) {
			// AsyncMIDIPort inherits ::name() from both ARDOUR::Port
			// (std::string) and MIDI::Port (const char*); the call is
			// ambiguous without a scope. ARDOUR::Port::name is the
			// engine-canonical one (`foyer_shim:foyer-midi-ingress-…`).
			_engine_port_name = _port->ARDOUR::Port::name ();
			PBD::warning << "foyer_shim: [midi-ingress] port registered for "
			             << track_id << " name=" << _engine_port_name << endmsg;
		} else {
			PBD::error << "foyer_shim: [midi-ingress] register_output_port returned non-Async port for "
			           << name << endmsg;
		}
	} catch (...) {
		PBD::error << "foyer_shim: [midi-ingress] register_output_port threw for "
		           << name << endmsg;
	}
}

ShimMidiInputPort::~ShimMidiInputPort ()
{
	_stopped.store (true, std::memory_order_release);
	if (_port) {
		try {
			AudioEngine::instance ()->unregister_port (_port);
		} catch (...) {
			// Engine may be tearing down on shim quit; ignore.
		}
		_port.reset ();
	}
}

bool
ShimMidiInputPort::connect_to_track (MidiTrack& track)
{
	if (!_port || _engine_port_name.empty ()) return false;

	// Find the track's first MIDI input port. `IO::midi(n)` returns
	// the nth MIDI port on the input side; n=0 is enough for the
	// common case (mono MIDI). If the track was just created and
	// has no MIDI input ports yet, bail — the user's UI flow will
	// retry on the next event.
	std::shared_ptr<MidiPort> dst_midi;
	try {
		auto io = track.input ();
		if (!io) return false;
		dst_midi = io->midi (0);
	} catch (...) {
		return false;
	}
	if (!dst_midi) return false;
	std::shared_ptr<Port> dst = std::static_pointer_cast<Port> (dst_midi);

	// `Port::connect` on our output side; idempotent if already
	// connected (Ardour's PortEngine no-ops a duplicate connection).
	int rc = -1;
	try {
		rc = _port->connect (dst->name ());
	} catch (...) {
		rc = -1;
	}
	if (rc != 0) {
		PBD::warning << "foyer_shim: [midi-ingress] connect "
		             << _engine_port_name << " → " << dst->name ()
		             << " rc=" << rc << endmsg;
	} else {
		PBD::warning << "foyer_shim: [midi-ingress] connected "
		             << _engine_port_name << " → " << dst->name () << endmsg;
	}
	return rc == 0;
}

void
ShimMidiInputPort::write_event (const std::uint8_t* bytes, std::size_t n)
{
	if (_stopped.load (std::memory_order_acquire)) return;
	if (!_port || !bytes || n == 0 || n > 3) return;
	// `AsyncMIDIPort::write` takes (data, size, sample_offset). We
	// pass 0 so the event lands at the start of the next cycle; the
	// `_capture_offset` we set via `set_private_latency_range` is
	// what shifts it backward into "user-perceived" time on the
	// disk write side.
	try {
		_port->write (bytes, n, 0);
	} catch (...) {
		// AsyncMIDIPort can occasionally throw on engine teardown;
		// dropping the event is preferable to crashing the IPC reader.
	}
}

void
ShimMidiInputPort::set_capture_latency (std::uint32_t samples)
{
	if (!_port) return;
	if (ShimInputPort::capture_latency_locked ()) {
		// Recording in progress — same gate audio uses.
		return;
	}
	// One engine cycle covers the non-RT-to-RT handoff inside
	// AsyncMIDIPort; we add it on top of the server's empirical
	// roundtrip so the total reflects what Ardour actually needs to
	// backdate by. No additional ring-prime contribution because
	// AsyncMIDIPort's internal queue is shallow and the WS control
	// plane is reliable and ordered (no browser-side jitter buffer
	// needed for sparse MIDI events the way audio frames need one).
	const auto cycle = AudioEngine::instance ()->samples_per_cycle ();
	const std::uint32_t total = samples + static_cast<std::uint32_t> (cycle);
	_capture_latency_samples = total;
	LatencyRange r;
	r.min = total;
	r.max = total;
	_port->set_private_latency_range (r, false);
}

} // namespace ArdourSurface
