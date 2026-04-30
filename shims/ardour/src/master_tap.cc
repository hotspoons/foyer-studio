// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: master-bus audio tap implementation.
 */

// Set to false to silence the 2 Hz steady-state stats log.
static constexpr bool LOG_STEADY_STATE_STATS = false;

#include "master_tap.h"

#include <chrono>
#include <climits>
#include <cmath>
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
	// Cycle-timing instrumentation. RT-safe: just an atomic timestamp
	// load + store + a few atomic counter updates per call. The drain
	// loop (non-RT) reads the running stats every 2 s and logs them
	// when the spread suggests timer drift. Critical for diagnosing
	// pops on the Dummy backend where the audio thread runs
	// SCHED_OTHER and can drift cycle-to-cycle under CPU contention.
	{
		using clock = std::chrono::steady_clock;
		const auto now_ns =
		    std::chrono::duration_cast<std::chrono::nanoseconds> (
		        clock::now ().time_since_epoch ()).count ();
		const std::int64_t prev = _last_run_ns.exchange (
		    now_ns, std::memory_order_relaxed);
		if (prev != 0) {
			const std::int64_t delta_ns = now_ns - prev;
			_cycle_count.fetch_add (1, std::memory_order_relaxed);
			_cycle_delta_sum_ns.fetch_add (delta_ns, std::memory_order_relaxed);
			// Track running min/max via CAS — typical contention is
			// zero (single-writer per audio thread) so the loops
			// usually go around once.
			std::int64_t cur_min = _cycle_delta_min_ns.load (std::memory_order_relaxed);
			while (delta_ns < cur_min &&
			       !_cycle_delta_min_ns.compare_exchange_weak (cur_min, delta_ns,
			                                                  std::memory_order_relaxed)) {}
			std::int64_t cur_max = _cycle_delta_max_ns.load (std::memory_order_relaxed);
			while (delta_ns > cur_max &&
			       !_cycle_delta_max_ns.compare_exchange_weak (cur_max, delta_ns,
			                                                  std::memory_order_relaxed)) {}
		}
		_cycle_nframes_last.store (nframes, std::memory_order_relaxed);
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
		} else {
			// Drain thread fell behind — drop the block. Each drop is
			// directly audible as a pop on the listener side. The
			// counter bubbles up via the periodic stats log so a
			// non-zero rate is the first thing to look for when
			// chasing playback artifacts (especially on the Dummy
			// backend in container deploys where the drain thread
			// runs SCHED_OTHER).
			_samples_dropped.fetch_add (n, std::memory_order_relaxed);
		}
		written += this_block;
	}

	// Nudge the drain thread. Condvar wake is allocation-free; the
	// lock contention is brief. If this ever shows up on an RT
	// profile, swap to an eventfd or atomic counter.
	_wake_cv.notify_one ();

	// NOTE: ingress soft-port drain is now driven by
	// `IngressTickProcessor` (always installed on master_out at
	// session load), NOT by MasterTap. Calling tick_all_rt here too
	// would double-drain each port's ring buffer per cycle, causing
	// underruns and choppy audio. Egress copy (above) is independent
	// and stays here.
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

	// Ingress drain is owned by `IngressTickProcessor` — see the
	// matching note in `run()`. Don't tick here.
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
	std::uint64_t _last_logged_dropped = 0;

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
			const auto d = _samples_dropped.load ();
			// Always surface dropped-samples even when the steady-state
			// stats are off: the counter is the canonical signal for
			// "user hears pops on playback". Only log when it grew, so
			// a healthy session doesn't spam the log with zeros.
			if (d > _last_logged_dropped) {
				const auto delta = d - _last_logged_dropped;
				_last_logged_dropped = d;
				PBD::warning << "foyer_shim: [audio] stream_id=" << _stream_id
				             << " ring overflow — dropped " << delta
				             << " samples (" << d << " total) in last 2 s; "
				             << "playback will have audible pops"
				             << endmsg;
			}

			// Cycle-timing report. Reads + RESETS the counters so each
			// 2 s window is independent. We log when:
			//   * jitter window (max - min) > 5 ms — a healthy RT
			//     audio loop is sub-millisecond; even non-RT JACK is
			//     usually <1 ms. >5 ms means cycles are bursting,
			//     which IS the audible pop on the Dummy backend.
			//   * average cycle delta deviates >10 % from expected
			//     (nframes / sample_rate) — means the timer is
			//     systematically slow/fast, separate from jitter.
			// Always logs the steady-state numbers when LOG_STEADY_STATE_STATS
			// is on; loud-warns only when the spread is bad.
			const auto cycles = _cycle_count.exchange (0, std::memory_order_relaxed);
			if (cycles > 0) {
				const auto sum_ns = _cycle_delta_sum_ns.exchange (0, std::memory_order_relaxed);
				const auto min_ns = _cycle_delta_min_ns.exchange (INT64_MAX, std::memory_order_relaxed);
				const auto max_ns = _cycle_delta_max_ns.exchange (0, std::memory_order_relaxed);
				const auto nfr    = _cycle_nframes_last.load (std::memory_order_relaxed);
				const double avg_ms = (sum_ns / static_cast<double> (cycles)) / 1.0e6;
				const double min_ms = min_ns / 1.0e6;
				const double max_ms = max_ns / 1.0e6;
				const double jitter_ms = max_ms - min_ms;
				const double expected_ms = (nfr > 0)
				    ? (static_cast<double> (nfr) * 1000.0 / 48000.0)  // 48k assumption
				    : 0.0;
				const double dev_pct = (expected_ms > 0.0)
				    ? std::abs (avg_ms - expected_ms) / expected_ms * 100.0
				    : 0.0;
				if (jitter_ms > 5.0 || dev_pct > 10.0) {
					PBD::warning << "foyer_shim: [audio] cycle timing JITTER — "
					             << "avg=" << avg_ms << " ms "
					             << "min=" << min_ms << " ms "
					             << "max=" << max_ms << " ms "
					             << "spread=" << jitter_ms << " ms "
					             << "expected=" << expected_ms << " ms "
					             << "dev=" << dev_pct << " % "
					             << "nframes=" << nfr << " "
					             << "cycles=" << cycles
					             << endmsg;
				}
			}
			if constexpr (LOG_STEADY_STATE_STATS) {
				const auto r = _run_calls.load ();
				const auto s = _silence_calls.load ();
				const auto w = _samples_written.load ();
				const auto t = _samples_sent.load ();
				PBD::warning << "foyer_shim: [audio] stream_id=" << _stream_id
				             << " run=" << r << " silence=" << s
				             << " written=" << w << " sent=" << t
				             << " dropped=" << d
				             << endmsg;
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
