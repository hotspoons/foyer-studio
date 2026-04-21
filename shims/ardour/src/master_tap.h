/*
 * Foyer Studio — Ardour shim: master-bus audio tap.
 *
 * A minimal `ARDOUR::Processor` subclass that copies audio samples
 * out of the master route in the RT audio callback and into a
 * lock-free ring buffer. A non-RT drain thread reads from the ring
 * and hands the samples to the shim's IPC so they land at the
 * sidecar as `FrameKind::Audio` frames (interleaved f32 LE,
 * stream-id-prefixed).
 *
 * Thread discipline:
 *
 *   - `Processor::run()` runs on Ardour's audio thread. It MUST NOT
 *     allocate, lock, or block. Implementation: memcpy samples from
 *     `bufs` into `_ring`, bump a seq counter, return. Anything
 *     heavier is a bug.
 *   - The drain thread runs plain `std::thread`. It wakes at ~5 ms
 *     cadence, pulls whatever's in the ring, and calls
 *     `IpcServer::send(FrameKind::Audio, …)`.
 */
#ifndef foyer_shim_master_tap_h
#define foyer_shim_master_tap_h

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "ardour/processor.h"
#include "pbd/ringbuffer.h"

namespace ArdourSurface {

class FoyerShim;

/// RT-safe audio tap on the master bus. Copies samples in-place
/// (does not modify `bufs` — Ardour's mix stream passes through
/// intact), so it's safe to insert anywhere on the route.
class MasterTap : public ARDOUR::Processor
{
public:
	MasterTap (FoyerShim& shim, ARDOUR::Session& s, std::uint32_t stream_id, std::uint32_t channels);
	~MasterTap () override;

	std::string display_name () const override { return "Foyer Studio Master Tap"; }
	// MUST be true even though we'd prefer to hide from Ardour's GUI.
	// Route::setup_invisible_processors() (route.cc:5591-5610) rebuilds
	// _processors on every configure_io cycle and only keeps processors
	// that either display_to_user() == true OR are one of Ardour's
	// hardcoded internal types (amp / meter / main_outs / trim /
	// monitor_send / surround_send / foldback_sends / beatbox). Any
	// other display_to_user()==false processor gets silently dropped
	// from _processors — Route::add_processor returns 0 (success)
	// but the tap vanishes before run()/silence() ever fires. Setting
	// this to true keeps the tap in the chain. Cost: it shows up in
	// Ardour's GUI mixer as "Foyer Studio Master Tap". Worth it.
	bool display_to_user () const override     { return true; }
	bool does_routing () const override        { return false; }

	// Force "always on" — Ardour's process loop checks `active()` /
	// `enabled()` on each processor per cycle; a false return means
	// skip run() and treat the processor as if it weren't there.
	// The base Processor starts with `_pending_active = false`
	// until `activate()` is called, so without these overrides our
	// tap sits in the chain but never actually executes. Overriding
	// ensures we're always invoked regardless of chain state.
	bool enabled () const override     { return true; }

	bool can_support_io_configuration (const ARDOUR::ChanCount& in, ARDOUR::ChanCount& out) override;

	/// Override Processor::state() to mark our XML node as `type="capture"`.
	///
	/// MUST persist this opt-out: the base Processor::state() emits
	/// the node WITHOUT a `type` attribute, and Ardour's
	/// `Route::set_processor_state` (route.cc:3478-3550) does
	/// `prop->value()` on that nullptr property → SIGSEGV during
	/// session load. Symptom: session save by us, then any reopen
	/// of that .ardour file silently kills Ardour during early
	/// init (no SNAPSHOT, no on_session_loaded, no error message,
	/// no "caught signal" — just plugin scan output then nothing).
	///
	/// The `capture` type maps to a switch case Ardour explicitly
	/// skips ("CapturingProcessor should never be restored, it's
	/// always added explicitly when needed" — route.cc:3531-3533).
	/// Our master tap fits the same shape exactly: a runtime helper
	/// that the surface re-installs on every audio_stream_open, so
	/// it should never be restored from session state. Reusing
	/// `capture` lets stock Ardour load Foyer-saved sessions
	/// without knowing anything about our shim.
	XMLNode& state () const override;

	/// RT path. Copy samples into the ring. No allocations. No locks.
	void run (ARDOUR::BufferSet& bufs,
	          ARDOUR::samplepos_t start_sample,
	          ARDOUR::samplepos_t end_sample,
	          double speed,
	          ARDOUR::pframes_t nframes,
	          bool result_required) override;

	/// Called by Ardour on RT cycles where the route's mix is
	/// silent (transport stopped + no monitoring). Still emit
	/// zero-samples into the ring so the listener's WebSocket
	/// keeps receiving packets — otherwise the stream starves
	/// and the browser's decoder shuts down. Same RT discipline
	/// as run(): no allocations, no locks.
	void silence (ARDOUR::samplecnt_t nframes, ARDOUR::samplepos_t start_sample) override;

	/// Start the non-RT drain thread. Idempotent.
	void start_drain ();

	/// Stop the drain thread and release IPC resources. Safe to call
	/// from the event loop or the destructor.
	void stop_drain ();

	std::uint32_t stream_id () const { return _stream_id; }

private:
	FoyerShim&           _shim;
	const std::uint32_t  _stream_id;
	const std::uint32_t  _channels;

	// Ring sized for ~200 ms @ 48 kHz stereo (f32 interleaved).
	// Chosen so a slow drain thread has plenty of headroom; a fast
	// drain thread never sees the ring fill above ~10 ms.
	static constexpr std::size_t RING_SAMPLES = 48000u * 2u /* ch */ * 1 /* sec */ / 5; // 200 ms
	std::unique_ptr<PBD::RingBuffer<float>> _ring;

	std::thread         _drain_thread;
	std::atomic<bool>   _drain_stop { false };
	std::mutex          _wake_mx;
	std::condition_variable _wake_cv;

	// Diagnostic counters — incremented from the RT callbacks,
	// read from the drain loop for periodic logging. Confirms
	// whether Ardour is calling our processor at all.
	std::atomic<std::uint64_t> _run_calls      { 0 };
	std::atomic<std::uint64_t> _silence_calls  { 0 };
	std::atomic<std::uint64_t> _samples_written { 0 };
	std::atomic<std::uint64_t> _samples_sent    { 0 };

	void drain_loop ();
};

} // namespace ArdourSurface

#endif
