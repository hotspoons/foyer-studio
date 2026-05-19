// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: dispatcher.
 *
 * Decodes inbound Envelope<Control::Command> frames and applies them to the
 * session via Ardour APIs. Runs on the shim's AbstractUI request queue to keep
 * writes off the IO thread.
 */
#ifndef foyer_shim_dispatch_h
#define foyer_shim_dispatch_h

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

namespace ARDOUR {
class Session;
}

namespace ArdourSurface {

class FoyerShim;
class MasterTap;
class ShimInputPort;
class ShimMidiInputPort;
class SpectrumHub;

class Dispatcher
{
public:
	explicit Dispatcher (FoyerShim&);
	~Dispatcher ();

	/// Called from the IPC thread for each inbound Control frame. Decodes and
	/// marshals the command onto the shim's event loop.
	void on_control_frame (const std::vector<std::uint8_t>&);

	/// Called from the IPC thread for each inbound Audio frame.
	/// Routes ingress audio into the matching ShimInputPort ring buffer.
	void on_audio_frame (const std::vector<std::uint8_t>&);

private:
	FoyerShim& _shim;

	// Active audio egress taps keyed by stream_id. The processor is
	// owned by the route once `add_processor` succeeds — we keep a
	// shared_ptr here so we can find it to remove on close. Guarded
	// by `_taps_mx` because the IPC reader thread and the event-loop
	// thread both touch it.
	std::mutex _taps_mx;
	std::map<std::uint32_t, std::shared_ptr<MasterTap>> _taps;

	// Active ingress ports keyed by stream_id. Guarded by _ingress_mx
	// because IPC reader and event-loop threads both touch it.
	std::mutex _ingress_mx;
	std::map<std::uint32_t, std::unique_ptr<ShimInputPort>> _ingress_ports;

	// Per-track virtual MIDI input ports keyed by track id. Lazy-
	// created on the first `Command::MidiInput { track_id }` for a
	// given track; auto-connected into the track's MIDI in on
	// creation. Stay alive for the lifetime of the shim — cleaning
	// up on every armed/disarm transition would churn engine port
	// registrations, and an idle port costs nothing. The IPC reader
	// and the event-loop thread both touch the map (write_event vs.
	// connect / set_capture_latency), guarded by `_midi_ports_mx`.
	std::mutex _midi_ports_mx;
	std::map<std::string, std::unique_ptr<ShimMidiInputPort>> _midi_ingress_ports;

	// Nesting depth for `undo_group_begin` / `undo_group_end`. Only
	// touched from the event-loop thread (the call_slot lambdas).
	// Individual mutation handlers that wrap themselves in begin/
	// commit pairs check this and skip their own transaction pair
	// when it's > 0 so the outer group owns the whole batch.
	// PLAN 177.
	std::uint32_t _undo_group_depth = 0;

	// Session-wide override for `ShimInputPort::PRIME_THRESHOLD_MS`,
	// settable via `Command::SetIngressRingPrimeMs`. Read by the
	// AudioIngressOpen handler when constructing new ports. `0`
	// (the initial value) means "use the constructor default";
	// any positive value overrides. Atomic so the IPC reader
	// thread can update it without locking against the event-loop
	// thread that reads it.
	std::atomic<std::uint32_t> _ingress_ring_prime_ms { 0 };

	// Spectrogram pipeline. Owns one ARDOUR::Processor + ring buffer
	// per active SpectrumTarget; the SubscribeSpectrum / UnsubscribeSpectrum
	// arms talk to it. Initialised in the dispatcher constructor.
	std::unique_ptr<SpectrumHub> _spectrum_hub;

	// Mixdown / render-to-file pipeline. Drives
	// `ARDOUR::ExportHandler` against a one-off
	// `ExportFormatSpecification` built from the caller's
	// `RenderOptions`. Synchronous from the event-loop thread —
	// `_handler->do_export()` kicks the export off on Ardour's
	// internal threads, and we poll `ExportStatus` until it settles.
	// Progress events are coalesced server-side (≤4 Hz on the wire);
	// the polling loop just emits raw % values as they change.
	void run_render_export (
	    ARDOUR::Session& session,
	    const std::string& handle,
	    const std::string& format_id,
	    std::uint32_t sample_rate_hz,
	    const std::string& bit_depth,
	    std::uint8_t quality,
	    bool has_quality,
	    const std::string& range_kind,
	    std::uint64_t range_start,
	    std::uint64_t range_end,
	    const std::string& target_path_rel,
	    bool inline_bytes);
};

} // namespace ArdourSurface

#endif
