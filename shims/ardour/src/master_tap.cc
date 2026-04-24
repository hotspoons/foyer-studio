// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: master-bus audio tap implementation.
 */

// Set to false to silence the 2 Hz steady-state stats log.
static constexpr bool LOG_STEADY_STATE_STATS = false;

#include "master_tap.h"

#include <chrono>
#include <cstdint>
#include <cstring>

#include "ardour/audio_buffer.h"
#include "ardour/buffer_set.h"
#include "ardour/chan_count.h"
#include "ardour/data_type.h"
#include "pbd/error.h"
#include "pbd/xml++.h"

#include "ipc.h"
#include "surface.h"

namespace ArdourSurface {

using namespace ARDOUR;
using namespace PBD;

MasterTap::MasterTap (FoyerShim& shim, Session& s, std::uint32_t stream_id, std::uint32_t channels)
    : Processor (s, "foyer-master-tap", Temporal::TimeDomainProvider (Temporal::AudioTime))
    , _shim (shim)
    , _stream_id (stream_id)
    , _channels (channels == 0 ? 2 : channels)
{
	// Ring sized for ~200 ms of stereo audio at 48 kHz. Using a
	// power-of-two aware ctor in PBD::RingBuffer; it'll round up
	// internally. Plenty of headroom for a 5 ms drain cadence.
	_ring = std::make_unique<PBD::RingBuffer<float>> (RING_SAMPLES);
	PBD::warning << "foyer_shim: [audio] MasterTap constructed stream_id="
	             << _stream_id << " channels=" << _channels << endmsg;
}

MasterTap::~MasterTap ()
{
	stop_drain ();
}

XMLNode&
MasterTap::state () const
{
	// Build the standard Processor node, then tag it `type="capture"`
	// so Ardour's session loader routes it through the "skip — must
	// be re-added explicitly" branch (route.cc:3531-3533) instead of
	// segfaulting on a missing type. See the comment in master_tap.h.
	XMLNode& node = Processor::state ();
	node.set_property ("type", "capture");
	return node;
}

bool
MasterTap::can_support_io_configuration (const ChanCount& in, ChanCount& out)
{
	// Pass-through: whatever comes in is what goes out. We only
	// OBSERVE the buffer; we don't rewrite it.
	out = in;
	return true;
}

void
MasterTap::run (BufferSet& bufs,
                samplepos_t /*start_sample*/,
                samplepos_t /*end_sample*/,
                double /*speed*/,
                pframes_t nframes,
                bool /*result_required*/)
{
	// RT THREAD. Do NOT allocate, lock, log at anything beyond debug
	// level, or take any system call heavier than memcpy-equivalent.
	// The audio thread has a hard deadline; anything non-trivial here
	// costs dropouts.
	const std::uint64_t n = _run_calls.fetch_add (1, std::memory_order_relaxed);
	// First-call diagnostic ONLY — tells us whether Ardour's
	// process chain is even invoking our run() method. Gated to
	// one emission because PBD::warning allocates + locks and
	// must not run on the RT thread in the steady state.
	if (n == 0) {
		PBD::warning << "foyer_shim: [audio] stream_id=" << _stream_id
		             << " FIRST run() fire — nframes=" << nframes
		             << " bufs.audio=" << bufs.count ().n_audio ()
		             << endmsg;
	}
	if (!_ring || nframes == 0) return;

	const std::uint32_t cc = _channels;
	const ChanCount& chans = bufs.count ();
	const std::uint32_t avail = chans.n_audio ();
	const std::uint32_t use_ch = (cc <= avail) ? cc : avail;
	if (use_ch == 0) return;

	// Interleave into a small stack scratch buffer (nframes * cc <=
	// max_block * 8 channels ≈ 16 kB for max 512-sample blocks). We
	// choose 1024 samples × 8 channels as an upper bound — tuned for
	// Ardour's typical max block; anything over that we split.
	constexpr std::size_t SCRATCH = 8192;
	float scratch[SCRATCH];

	std::size_t written = 0;
	while (written < nframes) {
		const std::size_t this_block = std::min<std::size_t> (nframes - written, SCRATCH / cc);
		for (std::uint32_t ch = 0; ch < use_ch; ++ch) {
			AudioBuffer const& ab = bufs.get_audio (ch);
			const float* src = ab.data () + written;
			for (std::size_t i = 0; i < this_block; ++i) {
				scratch[i * cc + ch] = src[i];
			}
		}
		// Zero-pad any under-filled channels (shim promised cc
		// channels; master might be mono).
		for (std::uint32_t ch = use_ch; ch < cc; ++ch) {
			for (std::size_t i = 0; i < this_block; ++i) {
				scratch[i * cc + ch] = 0.0f;
			}
		}
		const std::size_t n = this_block * cc;
		// Ring is single-producer single-consumer. If the consumer
		// is falling behind the write_space shrinks; we drop
		// new samples rather than block. Dropped frames would
		// show as clicks in the listener's output, but the
		// alternative (block the RT thread) is worse. Counter for
		// user-visible underrun reporting is a future polish.
		const std::size_t space = _ring->write_space ();
		if (n <= space) {
			_ring->write (scratch, n);
			_samples_written.fetch_add (n, std::memory_order_relaxed);
		}
		written += this_block;
	}

	// Nudge the drain thread. Condvar wake is allocation-free; the
	// lock contention is brief. If this ever shows up on an RT
	// profile, swap to an eventfd or atomic counter.
	_wake_cv.notify_one ();
}

void
MasterTap::silence (samplecnt_t nframes, samplepos_t /*start_sample*/)
{
	// RT THREAD. Same constraints as run(): memcpy-only, no locks,
	// no logging. Ardour dispatches into silence() instead of run()
	// whenever the upstream mix has no signal — transport stopped,
	// no monitoring, no audio sources playing. Emit zero-samples so
	// the listener's WebSocket keeps receiving packets. Without
	// this, the drain thread starves for the whole silent period
	// and the browser's opus decoder + AudioContext fall out of
	// sync (or the WS server side times out on lag).
	const std::uint64_t n = _silence_calls.fetch_add (1, std::memory_order_relaxed);
	if (n == 0) {
		PBD::warning << "foyer_shim: [audio] stream_id=" << _stream_id
		             << " FIRST silence() fire — nframes=" << nframes << endmsg;
	}
	if (!_ring || nframes == 0) return;

	const std::uint32_t cc = _channels;
	const std::size_t total = static_cast<std::size_t> (nframes) * cc;

	// Zero-fill a small scratch buffer in blocks (same upper-bound
	// logic as run(), same reason: avoid overflowing the stack for
	// unusually big process cycles).
	constexpr std::size_t SCRATCH = 8192;
	float scratch[SCRATCH] = {0.0f};

	std::size_t written = 0;
	while (written < total) {
		const std::size_t n = std::min<std::size_t> (total - written, SCRATCH);
		if (_ring->write_space () >= n) {
			_ring->write (scratch, n);
			_samples_written.fetch_add (n, std::memory_order_relaxed);
		}
		written += n;
	}
	_wake_cv.notify_one ();
}

void
MasterTap::start_drain ()
{
	if (_drain_thread.joinable ()) return;
	_drain_stop.store (false);
	_drain_thread = std::thread (&MasterTap::drain_loop, this);
}

void
MasterTap::stop_drain ()
{
	if (!_drain_thread.joinable ()) return;
	_drain_stop.store (true);
	_wake_cv.notify_all ();
	_drain_thread.join ();
}

void
MasterTap::drain_loop ()
{
	// Non-RT worker. Wakes on condvar (posted by run()) or after a
	// 10 ms timeout — either way, it drains whatever's in the ring
	// and packs it into IPC audio frames. Frame format (matches
	// foyer_ipc::pack_audio):
	//   [ stream_id u32 LE ][ pcm bytes … ]
	// The ipc layer wraps with the framekind header.
	std::vector<float> scratch;
	scratch.reserve (RING_SAMPLES);

	auto last_log = std::chrono::steady_clock::now ();

	while (!_drain_stop.load ()) {
		{
			std::unique_lock<std::mutex> lk (_wake_mx);
			_wake_cv.wait_for (lk, std::chrono::milliseconds (10));
		}
		if (_drain_stop.load ()) break;
		if (!_ring) break;

		// Periodic diagnostic. Tells us whether run() / silence() is
		// actually firing and whether samples are flowing end-to-end.
		// If Rich hears nothing, compare:
		//   · run_calls high, silence_calls ~zero → master bus is
		//     processing real audio. Samples_written should track.
		//   · silence_calls high, run_calls zero → Ardour is calling
		//     our silent path; zero-samples ship but no music.
		//   · both zero → tap is attached but the processor chain
		//     isn't invoking us (feature-flag or config issue).
		//   · samples_written > samples_sent by a lot → drain is
		//     falling behind (IPC throughput or the ring is full).
		const auto now = std::chrono::steady_clock::now ();
		if (now - last_log >= std::chrono::seconds (2)) {
			last_log = now;
			if constexpr (LOG_STEADY_STATE_STATS) {
				const auto r = _run_calls.load ();
				const auto s = _silence_calls.load ();
				const auto w = _samples_written.load ();
				const auto t = _samples_sent.load ();
				PBD::warning << "foyer_shim: [audio] stream_id=" << _stream_id
				             << " run=" << r << endmsg;
			}
		}

		const std::size_t avail = _ring->read_space ();
		if (avail == 0) continue;

		scratch.resize (avail);
		const std::size_t got = _ring->read (scratch.data (), avail);
		if (got == 0) continue;

		// Pack stream_id (u32 LE) + f32 PCM bytes. Matches the
		// format the Rust side's `foyer_ipc::unpack_audio` expects.
		const std::size_t pcm_bytes = got * sizeof (float);
		std::vector<std::uint8_t> payload;
		payload.resize (4 + pcm_bytes);
		payload[0] = (_stream_id      ) & 0xff;
		payload[1] = (_stream_id >> 8 ) & 0xff;
		payload[2] = (_stream_id >> 16) & 0xff;
		payload[3] = (_stream_id >> 24) & 0xff;
		std::memcpy (payload.data () + 4, scratch.data (), pcm_bytes);

		_shim.ipc ().send (foyer_ipc::FrameKind::Audio, payload);
		_samples_sent.fetch_add (got, std::memory_order_relaxed);
	}
}

} // namespace ArdourSurface
