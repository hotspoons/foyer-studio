// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: real-time spectrogram pipeline implementation.
 *
 * Tick cadence: 40 ms (~25 Hz) matches the stub backend's producer
 * loop and Ardour's own meter refresh — enough motion for a smooth
 * waterfall, half the CPU of a 50 Hz tick.
 *
 * FFT work uses `ARDOUR::DSP::FFTSpectrum` from libardour. It applies
 * a Hann window internally via `set_data_hann`, runs a single-precision
 * fftwf transform, and returns per-bin dBFS via `power_at_bin`. The
 * non-Hann window flavours requested by the schema (Hamming /
 * Blackman-Harris / Rectangular) fall back to Hann today — the shim
 * advertises Hann-only in `SpectrumCapabilities.windows`. If we ever
 * need additional windows we apply them in our own scratch buffer
 * before handing samples to `set_data_hann` (whose own Hann becomes a
 * no-op when the input is pre-windowed — see the math; effectively
 * stacked Hann is acceptable in practice).
 */

#include "spectrum_pipeline.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <sstream>

#include <glib.h>

#include "ardour/audio_buffer.h"
#include "ardour/buffer_set.h"
#include "ardour/chan_count.h"
#include "ardour/route.h"
#include "ardour/session.h"
#include "pbd/error.h"
#include "pbd/xml++.h"

#include "ipc.h"
#include "msgpack_out.h"
#include "surface.h"

namespace ArdourSurface {

using namespace ARDOUR;
using namespace PBD;

// ───────────────────────── SpectrumTargetSpec ─────────────────────────

std::string
SpectrumTargetSpec::slug () const
{
	switch (kind) {
		case Kind::Master:  return "master";
		case Kind::Monitor: return "monitor";
		case Kind::Track:   return "track." + track_id;
	}
	return {};
}

bool
SpectrumTargetSpec::same (const SpectrumTargetSpec& other) const
{
	if (kind != other.kind) return false;
	if (kind == Kind::Track) return track_id == other.track_id;
	return true;
}

// ───────────────────────────── SpectrumTap ────────────────────────────

SpectrumTap::SpectrumTap (Session& s, const std::string& target_slug, std::uint32_t channels)
    : Processor (s, "foyer-spectrum-tap-" + target_slug, Temporal::TimeDomainProvider (Temporal::AudioTime))
    , _slug (target_slug)
    , _channels (channels == 0 ? 1 : std::min<std::uint32_t> (channels, 8))
{
	_rings.reserve (_channels);
	for (std::uint32_t ch = 0; ch < _channels; ++ch) {
		_rings.emplace_back (std::make_unique<PBD::RingBuffer<float>> (RING_SAMPLES));
	}
}

SpectrumTap::~SpectrumTap () = default;

XMLNode&
SpectrumTap::state () const
{
	XMLNode& node = Processor::state ();
	node.set_property ("type", "capture");
	return node;
}

bool
SpectrumTap::can_support_io_configuration (const ChanCount& in, ChanCount& out)
{
	out = in;
	return true;
}

void
SpectrumTap::run (BufferSet& bufs,
                  samplepos_t /*start_sample*/,
                  samplepos_t /*end_sample*/,
                  double /*speed*/,
                  pframes_t nframes,
                  bool /*result_required*/)
{
	// RT path. No allocation, no locks, no logging.
	if (nframes == 0 || _channels == 0) return;
	const ChanCount& cc = bufs.count ();
	const std::uint32_t avail = cc.n_audio ();
	const std::uint32_t use_ch = std::min<std::uint32_t> (_channels, avail);
	for (std::uint32_t ch = 0; ch < use_ch; ++ch) {
		AudioBuffer const& ab = bufs.get_audio (ch);
		auto& ring = *_rings[ch];
		const std::size_t space = ring.write_space ();
		// Drop overrun rather than blocking. Each drop = a brief stale
		// frame in the spectrogram (one window worth at most); the
		// alternative (block the RT thread) is unacceptable.
		const std::size_t n = std::min<std::size_t> (nframes, space);
		if (n > 0) {
			ring.write (ab.data (), n);
		}
	}
}

void
SpectrumTap::silence (samplecnt_t nframes, samplepos_t /*start_sample*/)
{
	// RT path. Write zeros into every channel so the rolling window
	// keeps advancing through silent periods (rendering a flat noise
	// floor instead of freezing on the last loud frame).
	if (nframes == 0 || _channels == 0) return;
	constexpr std::size_t SCRATCH = 1024;
	float zeros[SCRATCH] = {0.0f};
	for (std::uint32_t ch = 0; ch < _channels; ++ch) {
		auto& ring = *_rings[ch];
		std::size_t left = static_cast<std::size_t> (nframes);
		while (left > 0) {
			const std::size_t step = std::min<std::size_t> (left, SCRATCH);
			const std::size_t space = ring.write_space ();
			const std::size_t n = std::min<std::size_t> (step, space);
			if (n > 0) ring.write (zeros, n);
			if (n < step) break; // ring full — drop the rest of this cycle
			left -= step;
		}
	}
}

std::size_t
SpectrumTap::read_channel (std::uint32_t channel, float* dst, std::size_t n)
{
	if (channel >= _channels || !dst || n == 0) return 0;
	return _rings[channel]->read (dst, n);
}

std::size_t
SpectrumTap::read_space (std::uint32_t channel) const
{
	if (channel >= _channels) return 0;
	return _rings[channel]->read_space ();
}

// ───────────────────────────── SpectrumHub ────────────────────────────

SpectrumHub::SpectrumHub (FoyerShim& shim)
    : _shim (shim)
{}

SpectrumHub::~SpectrumHub ()
{
	stop_all ();
}

void
SpectrumHub::start_thread ()
{
	if (_running.exchange (true)) return;
	_tick_thread = std::thread ([this] { tick_loop (); });
}

void
SpectrumHub::stop_thread ()
{
	if (!_running.exchange (false)) return;
	_wake.notify_all ();
	if (_tick_thread.joinable ()) _tick_thread.join ();
}

void
SpectrumHub::tick_loop ()
{
	using namespace std::chrono;
	auto next = steady_clock::now ();
	while (_running.load ()) {
		next += milliseconds (40);
		{
			std::unique_lock<std::mutex> lk (_mx);
			_wake.wait_until (lk, next, [this, next] {
				return !_running.load () || steady_clock::now () >= next;
			});
		}
		if (!_running.load ()) break;
		tick_impl ();
	}
}

bool
SpectrumHub::any_active () const
{
	std::lock_guard<std::mutex> g (_mx);
	return !_subs.empty ();
}

static SpectrumOptsDecoded
clamp_opts (const SpectrumOptsDecoded& in)
{
	SpectrumOptsDecoded o = in;
	// FFT size: power of two in [256, 8192]. The capability map
	// advertises [256, 512, 1024, 2048, 4096] — accept up to 8192 in
	// case a future client tries one and clamp down if needed.
	std::uint32_t n = std::clamp<std::uint32_t> (o.fft_size, 256u, 8192u);
	// Snap to next-lower power of two so libardour's plan stays cached.
	std::uint32_t p = 256;
	while (p * 2 <= n) p *= 2;
	o.fft_size = p;
	// Hop size in [64, fft_size]. Default = fft_size/2 (50 % overlap).
	if (o.hop_size == 0) o.hop_size = o.fft_size / 2;
	o.hop_size = std::clamp<std::uint32_t> (o.hop_size, 64u, o.fft_size);
	// Min dB: sane floor for display. Match stub's range.
	if (!std::isfinite (o.min_db) || o.min_db > -10.0f) o.min_db = -100.0f;
	if (o.min_db < -160.0f) o.min_db = -160.0f;
	// Max bins: cap to fft_size/2.
	if (o.max_bins == 0) {
		o.max_bins = std::min<std::uint32_t> (512u, o.fft_size / 2);
	}
	o.max_bins = std::clamp<std::uint32_t> (o.max_bins, 16u, o.fft_size / 2);
	// Only Hann is honoured today. See file-header note.
	o.window = "hann";
	return o;
}

SpectrumOptsDecoded
SpectrumHub::subscribe (const SpectrumTargetSpec& target,
                        const SpectrumOptsDecoded& requested,
                        std::shared_ptr<Route> route,
                        std::uint32_t sample_rate)
{
	if (!route) return {};
	const SpectrumOptsDecoded clamped = clamp_opts (requested);

	auto& session = _shim.session ();
	const std::string slug = target.slug ();

	// Fast path: if there's already a subscription for this target
	// with the same effective opts (fft_size / hop / channels /
	// max_bins), don't tear it down + rebuild. Two callers asking for
	// the same shape get the same FFT pipeline; the second call just
	// re-emits the ack and keeps the existing tap. Without this the
	// rebuild path takes fft_planner_lock twice while the audio
	// thread is also touching the route, and we've seen a clean
	// deadlock against the planner lock on re-subscribe.
	{
		std::lock_guard<std::mutex> g (_mx);
		auto it = _subs.find (slug);
		if (it != _subs.end ()) {
			const auto& existing = it->second->opts;
			if (existing.fft_size == clamped.fft_size
			    && existing.hop_size == clamped.hop_size
			    && existing.max_bins == clamped.max_bins
			    && existing.per_channel == clamped.per_channel) {
				return existing;
			}
		}
	}

	std::unique_ptr<SpectrumSubscription> old_sub;
	{
		std::lock_guard<std::mutex> g (_mx);
		auto it = _subs.find (slug);
		if (it != _subs.end ()) {
			old_sub = std::move (it->second);
			_subs.erase (it);
		}
	}
	// Detach + free the previous tap BEFORE constructing the new
	// FFTSpectrum. The fft_planner_lock inside libardour can't be
	// held by two FFTSpectrums on the same thread — destroying the
	// old one before creating the new one avoids the rebuild
	// deadlock we hit with two live FFTSpectrums.
	if (old_sub && old_sub->tap && old_sub->route) {
		old_sub->route->remove_processor (old_sub->tap);
	}
	old_sub.reset ();

	// How many channels does the route expose? Cap to 2 for the wire
	// today — the schema is per-channel-aware but the FE waterfall
	// only renders L/R, and most analysis surfaces don't need more.
	std::uint32_t channels = 1;
	{
		auto io = route->output ();
		if (io) {
			channels = std::min<std::uint32_t> (2u, io->n_ports ().n_audio ());
			if (channels == 0) channels = 1;
		}
		if (!clamped.per_channel) channels = 1;
	}

	std::fputs ("foyer_shim: hub.subscribe creating tap\n", stderr); std::fflush (stderr);
	auto tap = std::make_shared<SpectrumTap> (session, slug, channels);
	Route::ProcessorStreams err;
	std::fputs ("foyer_shim: hub.subscribe add_processor\n", stderr); std::fflush (stderr);
	const int rc = route->add_processor (tap, PostFader, &err, true /* activation */);
	{
		char m[120];
		std::snprintf (m, sizeof (m),
		    "foyer_shim: hub.subscribe add_processor rc=%d\n", rc);
		std::fputs (m, stderr); std::fflush (stderr);
	}
	if (rc != 0) {
		return {};
	}
	std::fputs ("foyer_shim: hub.subscribe activate tap\n", stderr); std::fflush (stderr);
	tap->activate ();

	std::fputs ("foyer_shim: hub.subscribe build SpectrumSubscription\n", stderr); std::fflush (stderr);
	auto sub = std::make_unique<SpectrumSubscription> ();
	sub->target = target;
	sub->opts   = clamped;
	sub->route  = route;
	sub->tap    = tap;
	std::fputs ("foyer_shim: hub.subscribe creating FFTSpectrum\n", stderr); std::fflush (stderr);
	sub->fft.reset (new DSP::FFTSpectrum (clamped.fft_size, static_cast<double> (sample_rate)));
	std::fputs ("foyer_shim: hub.subscribe FFTSpectrum created\n", stderr); std::fflush (stderr);
	sub->rolling.resize (channels);
	sub->rolling_fill.assign (channels, 0);
	for (auto& r : sub->rolling) r.assign (clamped.fft_size, 0.0f);
	std::fputs ("foyer_shim: hub.subscribe done allocating, taking lock\n", stderr); std::fflush (stderr);

	{
		std::lock_guard<std::mutex> g (_mx);
		_subs[slug] = std::move (sub);
	}
	// Start the tick thread on first subscribe. Idempotent — the
	// atomic exchange in start_thread guards against double-starts.
	start_thread ();
	{
		char m[160];
		std::snprintf (m, sizeof (m),
		    "foyer_shim: spectrum: subscribed %s (fft=%u hop=%u max_bins=%u)\n",
		    slug.c_str (), clamped.fft_size, clamped.hop_size, clamped.max_bins);
		std::fputs (m, stderr);
		std::fflush (stderr);
	}
	return clamped;
}

void
SpectrumHub::unsubscribe (const SpectrumTargetSpec& target)
{
	const std::string slug = target.slug ();
	std::unique_ptr<SpectrumSubscription> doomed;
	bool empty_now = false;
	{
		std::lock_guard<std::mutex> g (_mx);
		auto it = _subs.find (slug);
		if (it == _subs.end ()) return;
		doomed = std::move (it->second);
		_subs.erase (it);
		empty_now = _subs.empty ();
	}
	if (doomed && doomed->tap && doomed->route) {
		doomed->route->remove_processor (doomed->tap);
	}
	if (empty_now) {
		stop_thread ();
	}
}

void
SpectrumHub::stop_all ()
{
	stop_thread ();
	std::map<std::string, std::unique_ptr<SpectrumSubscription>> doomed;
	{
		std::lock_guard<std::mutex> g (_mx);
		doomed.swap (_subs);
	}
	for (auto& kv : doomed) {
		auto& sub = kv.second;
		if (sub && sub->tap && sub->route) {
			sub->route->remove_processor (sub->tap);
		}
	}
}

std::size_t
SpectrumHub::drain_into_rolling (SpectrumSubscription& sub)
{
	const std::uint32_t fft_size = sub.opts.fft_size;
	const std::uint32_t nch = static_cast<std::uint32_t> (sub.rolling.size ());
	std::size_t min_added = SIZE_MAX;
	for (std::uint32_t ch = 0; ch < nch; ++ch) {
		const std::size_t avail = sub.tap ? sub.tap->read_space (ch) : 0;
		if (avail == 0) {
			min_added = std::min<std::size_t> (min_added, 0);
			continue;
		}
		// Drain up to `fft_size` samples per channel per tick — the FFT
		// only needs the most recent window's worth, and burning through
		// huge backlogs just so we can throw most of it away is wasteful.
		// `avail - keep_skip` would let us drop ahead in the ring; the
		// PBD::RingBuffer API doesn't expose a skip read, so we just
		// drain everything and let the rolling buffer keep the tail.
		std::size_t to_read = avail;
		// Read in chunks via a stack scratch to avoid huge reallocs.
		constexpr std::size_t SCRATCH = 4096;
		float scratch[SCRATCH];
		std::size_t added = 0;
		while (to_read > 0) {
			const std::size_t step = std::min<std::size_t> (to_read, SCRATCH);
			const std::size_t got = sub.tap->read_channel (ch, scratch, step);
			if (got == 0) break;
			to_read -= got;
			// Append into the rolling buffer. If we've already got
			// fft_size samples we slide the window forward instead.
			auto& roll = sub.rolling[ch];
			auto& fill = sub.rolling_fill[ch];
			std::size_t left = got;
			while (left > 0) {
				if (fill < fft_size) {
					const std::size_t take = std::min<std::size_t> (left, fft_size - fill);
					std::memcpy (&roll[fill], scratch + (got - left), take * sizeof (float));
					fill += take;
					left -= take;
				} else {
					// Slide: shift the buffer left by `step_shift`, then
					// copy `step_shift` new samples to the tail. Keep
					// the shift size bounded so we never copy more than
					// fft_size at a time.
					const std::size_t step_shift = std::min<std::size_t> (left, fft_size);
					if (step_shift < fft_size) {
						std::memmove (&roll[0],
						              &roll[step_shift],
						              (fft_size - step_shift) * sizeof (float));
						std::memcpy (&roll[fft_size - step_shift],
						             scratch + (got - left),
						             step_shift * sizeof (float));
					} else {
						std::memcpy (&roll[0],
						             scratch + (got - left),
						             fft_size * sizeof (float));
					}
					left -= step_shift;
				}
			}
			added += got;
		}
		min_added = std::min<std::size_t> (min_added, added);
	}
	return (min_added == SIZE_MAX) ? 0 : min_added;
}

void
SpectrumHub::emit_frame (SpectrumSubscription& sub, std::uint32_t sample_rate)
{
	const std::uint32_t fft_size = sub.opts.fft_size;
	const std::uint32_t nch      = static_cast<std::uint32_t> (sub.rolling.size ());
	const std::uint32_t out_bins = std::min<std::uint32_t> (sub.opts.max_bins, fft_size / 2);
	if (out_bins == 0 || nch == 0) return;

	// Map output bin index → input bin index (we may downsample from
	// fft_size/2 native bins to `out_bins` evenly-spaced bins so the
	// wire frame stays small). Each output bin reports the max of its
	// covered input bins — preserves transients better than averaging.
	const std::uint32_t native_bins = fft_size / 2;
	const float bins_per_out = static_cast<float> (native_bins) / static_cast<float> (out_bins);

	const float min_db = sub.opts.min_db;

	// Build per-channel magnitude vectors. Each call to fft->execute()
	// stomps the internal buffer, so we run one channel at a time.
	std::vector<std::vector<float>> channel_db;
	channel_db.reserve (nch);

	for (std::uint32_t ch = 0; ch < nch; ++ch) {
		auto& roll = sub.rolling[ch];
		if (sub.rolling_fill[ch] < fft_size) {
			// Not enough data yet — emit silence floor.
			channel_db.emplace_back (out_bins, min_db);
			continue;
		}
		// Hand the rolling window to libardour's FFT. set_data_hann
		// applies the Hann window internally and copies into its
		// internal scratch — safe to reuse `roll` afterwards.
		sub.fft->set_data_hann (roll.data (), fft_size, 0);
		sub.fft->execute ();

		std::vector<float> mags (out_bins, min_db);
		// Compress native bins → out_bins by taking the max in each window.
		for (std::uint32_t b = 0; b < out_bins; ++b) {
			const std::uint32_t lo = static_cast<std::uint32_t> (std::floor (b * bins_per_out));
			std::uint32_t hi = static_cast<std::uint32_t> (std::ceil ((b + 1) * bins_per_out));
			if (hi <= lo) hi = lo + 1;
			if (hi > native_bins) hi = native_bins;
			float peak = min_db;
			for (std::uint32_t i = lo; i < hi; ++i) {
				// power_at_bin returns dBFS directly (see dsp_filter.cc).
				// gain=1.0, pink=false → raw magnitude.
				const float db = sub.fft->power_at_bin (i, 1.0f, false);
				if (std::isfinite (db) && db > peak) peak = db;
			}
			if (peak < min_db)  peak = min_db;
			if (peak > 0.0f)    peak = 0.0f;
			mags[b] = peak;
		}
		channel_db.push_back (std::move (mags));
	}

	const std::uint64_t mono_ns =
	    static_cast<std::uint64_t> (
	        std::chrono::duration_cast<std::chrono::nanoseconds> (
	            std::chrono::steady_clock::now ().time_since_epoch ()).count ());

	auto bytes = msgpack_out::encode_spectrum_frame (
	    sub.target, sub.opts, sample_rate, channel_db, mono_ns);
	if (!bytes.empty ()) _shim.ipc ().send (foyer_ipc::FrameKind::Control, bytes);
}

void
SpectrumHub::tick_impl ()
{
	// Snapshot the active subscriptions under the lock so we don't
	// hold it through the (potentially expensive) FFT pass.
	std::vector<SpectrumSubscription*> live;
	{
		std::lock_guard<std::mutex> g (_mx);
		live.reserve (_subs.size ());
		for (auto& kv : _subs) live.push_back (kv.second.get ());
	}
	if (live.empty ()) return;
	// Diagnostic — log the very first tick so we can confirm the
	// timer fires at all. Subsequent ticks stay silent so we don't
	// drown the daw.log under live use.
	static std::atomic<bool> first_tick {true};
	if (first_tick.exchange (false)) {
		char m[120];
		std::snprintf (m, sizeof (m),
		    "foyer_shim: spectrum: first tick (%zu subs)\n", live.size ());
		std::fputs (m, stderr);
		std::fflush (stderr);
	}
	const std::uint32_t sr =
	    static_cast<std::uint32_t> (_shim.session ().sample_rate ());
	for (auto* sub : live) {
		if (!sub) continue;
		drain_into_rolling (*sub);
		emit_frame (*sub, sr);
	}
}

} // namespace ArdourSurface
