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
	bool display_to_user () const override     { return false; }
	bool does_routing () const override        { return false; }

	bool can_support_io_configuration (const ARDOUR::ChanCount& in, ARDOUR::ChanCount& out) override;

	/// RT path. Copy samples into the ring. No allocations. No locks.
	void run (ARDOUR::BufferSet& bufs,
	          ARDOUR::samplepos_t start_sample,
	          ARDOUR::samplepos_t end_sample,
	          double speed,
	          ARDOUR::pframes_t nframes,
	          bool result_required) override;

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

	void drain_loop ();
};

} // namespace ArdourSurface

#endif
