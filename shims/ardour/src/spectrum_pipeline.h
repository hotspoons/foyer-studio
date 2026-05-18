// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: real-time spectrogram pipeline.
 *
 * Owns one `SpectrumTap` ARDOUR::Processor per active subscription
 * (master / monitor / per-track), copies audio out of the RT thread
 * into per-channel ring buffers, and runs Hann-windowed FFTs from a
 * low-priority idle slot at ~25 Hz. Emits `Event::SpectrumFrame` over
 * the existing IPC.
 *
 * Thread discipline mirrors `MasterTap`:
 *   - `SpectrumTap::run()` is RT-only: memcpy into PBD::RingBuffer.
 *   - The Glib timeout tick consumes from the rings, runs FFTs via
 *     ARDOUR::DSP::FFTSpectrum, builds + emits the frame.
 *
 * Subscriptions are keyed by `SpectrumTarget` slug (matches the
 * sidecar's broadcast key). A second subscribe on the same target
 * replaces the previous one's opts — matches the stub backend's
 * `subscribe` semantics.
 */
#ifndef foyer_shim_spectrum_pipeline_h
#define foyer_shim_spectrum_pipeline_h

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ardour/dsp_filter.h"
#include "ardour/processor.h"
#include "pbd/ringbuffer.h"

namespace ARDOUR {
class Route;
class Session;
}

namespace ArdourSurface {

class FoyerShim;

/// Wire shape for `SpectrumTarget` decoded off the command frame.
struct SpectrumTargetSpec {
	enum class Kind { Master, Monitor, Track };
	Kind kind = Kind::Master;
	/// Set when `kind == Track`.
	std::string track_id;

	/// Slug for logging / event tagging. Matches the schema's
	/// `SpectrumTarget::slug()` so the sidecar's broadcast keys line up.
	std::string slug () const;
	/// Stable equality — used to replace an existing subscription on
	/// the same scope.
	bool same (const SpectrumTargetSpec& other) const;
};

/// Decoded `SpectrumOpts` after clamping. Matches `foyer_schema::SpectrumOpts`.
struct SpectrumOptsDecoded {
	std::uint32_t fft_size      = 2048;
	std::uint32_t hop_size      = 1024;   // half of fft_size by default
	std::string   window        = "hann";
	float         min_db        = -100.0f;
	std::uint32_t max_bins      = 512;
	bool          per_channel   = true;
};

/// RT-safe audio observer for one spectrum subscription. Identical
/// shape to MasterTap but writes into N per-channel ring buffers and
/// does no IPC of its own — the SpectrumHub's idle-tick is responsible
/// for draining the rings + emitting frames.
class SpectrumTap : public ARDOUR::Processor
{
public:
	SpectrumTap (ARDOUR::Session& s, const std::string& target_slug, std::uint32_t channels);
	~SpectrumTap () override;

	std::string display_name () const override { return "Foyer Studio Spectrum Tap (" + _slug + ")"; }
	// Must be true — same constraint as MasterTap (see its comment).
	bool display_to_user () const override { return true; }
	bool does_routing ()   const override { return false; }
	bool enabled ()        const override { return true; }

	bool can_support_io_configuration (const ARDOUR::ChanCount& in, ARDOUR::ChanCount& out) override;

	/// Tag the saved-state node `type="capture"` so Ardour skips it on
	/// session reload (we re-install on every subscribe). Same rationale
	/// as MasterTap::state ().
	XMLNode& state () const override;

	/// RT path: copy samples into each channel's ring buffer. No locks.
	void run (ARDOUR::BufferSet& bufs,
	          ARDOUR::samplepos_t start_sample,
	          ARDOUR::samplepos_t end_sample,
	          double speed,
	          ARDOUR::pframes_t nframes,
	          bool result_required) override;

	/// Mirror MasterTap: feed zeros into the ring on silent cycles so
	/// the FFT keeps showing a flat noise floor rather than going stale.
	void silence (ARDOUR::samplecnt_t nframes, ARDOUR::samplepos_t start_sample) override;

	/// Non-RT readers. Pull up to `n` samples from `channel`'s ring,
	/// return how many were actually read. Returns 0 if the channel is
	/// out of range. Safe to call from any non-RT thread.
	std::size_t read_channel (std::uint32_t channel, float* dst, std::size_t n);
	/// How many samples sit in `channel`'s ring right now.
	std::size_t read_space (std::uint32_t channel) const;

	std::uint32_t channels () const { return _channels; }

private:
	const std::string  _slug;
	const std::uint32_t _channels;

	// One ring per channel. Sized for ~1 s of mono audio at 48 kHz —
	// the idle-thread tick consumes at 25 Hz so we only need ~20 k
	// samples of headroom, but the master_tap precedent picked 1 s and
	// we follow it for parity (cost is 192 KB per stereo tap).
	static constexpr std::size_t RING_SAMPLES = 48000u * 1u; // per channel
	std::vector<std::unique_ptr<PBD::RingBuffer<float>>> _rings;
};

/// One active subscription. The hub holds these by slug; the tick
/// iterates them. Members are owned by the hub thread except for
/// `tap` which is shared with the route's processor list.
struct SpectrumSubscription {
	SpectrumTargetSpec target;
	SpectrumOptsDecoded opts;
	std::shared_ptr<ARDOUR::Route> route;
	std::shared_ptr<SpectrumTap> tap;
	std::unique_ptr<ARDOUR::DSP::FFTSpectrum> fft;
	/// Most-recent rolling window of samples per channel. Sized to fft_size.
	/// Filled by `drain_into_rolling`; consumed by `emit_frame`.
	std::vector<std::vector<float>> rolling;
	/// How many samples are currently valid in `rolling[ch]`. Tops out
	/// at `opts.fft_size` once the window is full and stays there.
	std::vector<std::size_t> rolling_fill;
};

class SpectrumHub
{
public:
	explicit SpectrumHub (FoyerShim& shim);
	~SpectrumHub ();

	/// Open a subscription. Returns the clamped opts so the dispatcher
	/// can echo them in `Event::SpectrumSubscribed`. If `route` is null
	/// the call is a no-op and the returned opts are zeroed — caller
	/// should emit an error event in that case.
	///
	/// Replaces any existing subscription on the same target.
	SpectrumOptsDecoded subscribe (const SpectrumTargetSpec& target,
	                               const SpectrumOptsDecoded& requested,
	                               std::shared_ptr<ARDOUR::Route> route,
	                               std::uint32_t sample_rate);

	/// Tear down a subscription on `target`. No-op if not active.
	void unsubscribe (const SpectrumTargetSpec& target);

	/// Tear down every active subscription. Called on shim shutdown.
	void stop_all ();

	/// Returns true if the hub has at least one active subscription.
	bool any_active () const;

private:
	void tick_impl ();
	void tick_loop ();
	void start_thread ();
	void stop_thread ();

	/// Build + emit one frame for a subscription. Pulls samples,
	/// windows, FFTs, packs `Event::SpectrumFrame`, hands to IPC.
	void emit_frame (SpectrumSubscription& sub, std::uint32_t sample_rate);

	/// Drain new samples from a tap's ring buffers into the rolling
	/// per-channel windows. Returns the smallest number of samples
	/// added across all channels (so the caller knows whether a hop's
	/// worth of new data is available).
	std::size_t drain_into_rolling (SpectrumSubscription& sub);

	FoyerShim& _shim;
	mutable std::mutex _mx;
	std::map<std::string /* slug */, std::unique_ptr<SpectrumSubscription>> _subs;
	/// Dedicated background thread that ticks at ~25 Hz. We use a
	/// plain std::thread rather than g_timeout_add because the Glib
	/// timer Glib::Threads::Mutex setup inside libardour's FFTSpectrum
	/// constructor doesn't play nicely with our shim's BaseUI
	/// thread-default context (the timer source attaches to a context
	/// that isn't actually iterated). The dedicated thread also keeps
	/// the FFT work entirely off Ardour's GUI / audio threads.
	std::atomic<bool> _running { false };
	std::thread _tick_thread;
	std::condition_variable _wake;
};

} // namespace ArdourSurface

#endif
