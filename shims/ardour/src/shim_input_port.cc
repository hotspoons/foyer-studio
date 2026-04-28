// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: soft input port for browser audio ingress.
 *
 * The ingress path:
 *   browser getUserMedia
 *      → WS /ws/ingress/<id>
 *      → sidecar decode to f32
 *      → Unix socket (FrameKind::Audio)
 *      → dispatch.cc::on_audio_frame()
 *      → ShimInputPort::push_audio()  [IPC IO thread]
 *      → RingBuffer<float>
 *      → ShimInputPort::tick_rt()     [Ardour RT thread, driven by MasterTap]
 *      → AudioPort::read_from() + set_written(true)
 *      → backend routes to connected track inputs next cycle
 */
#include "shim_input_port.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

#include "ardour/audio_buffer.h"
#include "ardour/audio_port.h"
#include "ardour/audioengine.h"
#include "ardour/port_engine.h"
#include "ardour/port_manager.h"
#include "pbd/error.h"

#include "surface.h"

namespace ArdourSurface {

using namespace ARDOUR;

// ─── RT-safe ingress registry ──────────────────────────────────────────
//
// File-scope storage. Must have static storage duration so it outlives
// any ShimInputPort; dtor-order matters if the ControlProtocol is torn
// down before the last port's destructor runs.
namespace {
std::array<std::atomic<ShimInputPort*>, ShimInputPort::MAX_SLOTS> g_ingress_slots {};
} // namespace

int
ShimInputPort::register_in_registry ()
{
	for (std::size_t i = 0; i < g_ingress_slots.size (); ++i) {
		ShimInputPort* expected = nullptr;
		if (g_ingress_slots[i].compare_exchange_strong (
		        expected, this,
		        std::memory_order_release,
		        std::memory_order_relaxed)) {
			return static_cast<int> (i);
		}
	}
	return -1;
}

void
ShimInputPort::unregister_from_registry ()
{
	if (_registry_slot < 0) return;
	// Store null with release so a concurrent RT load (acquire) sees
	// either our live pointer or null, never torn.
	g_ingress_slots[_registry_slot].store (nullptr, std::memory_order_release);
	_registry_slot = -1;
}

void
ShimInputPort::tick_all_rt (pframes_t nframes)
{
	// RT THREAD. Iterate the registry with acquire loads. Each slot
	// is either null or a live port (registration writes the pointer
	// before the port is usable, dtor clears it before deleting).
	for (std::size_t i = 0; i < g_ingress_slots.size (); ++i) {
		ShimInputPort* p = g_ingress_slots[i].load (std::memory_order_acquire);
		if (p) {
			p->tick_rt (nframes);
		}
	}
}

// ─── ShimInputPort ─────────────────────────────────────────────────────

ShimInputPort::ShimInputPort (FoyerShim& shim,
                              std::uint32_t stream_id,
                              const std::string& name,
                              std::uint32_t channels,
                              std::uint32_t sample_rate,
                              std::uint32_t frame_size)
    : _shim (shim)
    , _stream_id (stream_id)
    , _channels (channels == 0 ? 1 : channels)
    , _sample_rate (sample_rate)
    , _frame_size (frame_size == 0 ? 128 : frame_size)
{
	// Ring sized for ~400 ms of interleaved audio at the given rate.
	// This is the cushion between push bursts and RT drain; oversized
	// is cheap (<150 kB) and saves us if a browser tab stalls for a
	// few hundred ms.
	std::size_t ring_samples = static_cast<std::size_t> (_sample_rate) * _channels * 2 / 5;
	_ring = std::make_unique<PBD::RingBuffer<float>> (ring_samples);

	// Priming threshold in INTERLEAVED samples (ring units).
	_prime_threshold_samples = static_cast<std::uint32_t> (
	    static_cast<std::uint64_t> (_sample_rate) * PRIME_THRESHOLD_MS * _channels / 1000u);

	// Pre-size the RT scratch buffer. A typical Ardour max block is
	// 8192 samples — size for 16384 * channels to stay safe without
	// triggering allocations inside tick_rt().
	_rt_scratch.resize (16384u * _channels);

	auto engine = AudioEngine::instance ();
	// Port names supplied to `register_output_port` must NOT contain a
	// `:` — Ardour treats a pre-colon portion as a client/backend name
	// and `Port::connect_internal` then forwards the non-relative form
	// to the engine backend. If the prefix doesn't match a registered
	// client, `port_engine.connect()` fails with -1 and no audio flows.
	// We register a bare name (`foyer-ingress-<stream>`) and let
	// Ardour/the backend namespace it under its own client; the full
	// engine-level name is read back from `_port->name()` and sent to
	// the frontend via the AudioIngressOpened ack.
	const std::string bare_name = "foyer-ingress-" + name;
	auto port = engine->register_output_port (DataType::AUDIO, bare_name, false /* async */, PortFlags (0));
	_port = std::dynamic_pointer_cast<AudioPort> (port);

	if (_port) {
		_engine_port_name = _port->name ();
		_registry_slot = register_in_registry ();
		PBD::warning << "foyer_shim: [ingress] port registered (OUTPUT) stream_id=" << _stream_id
		             << " bare_name=" << bare_name
		             << " engine_name=" << _engine_port_name
		             << " channels=" << _channels
		             << " sample_rate=" << _sample_rate
		             << " prime_ms=" << PRIME_THRESHOLD_MS
		             << " slot=" << _registry_slot << endmsg;
		if (_registry_slot < 0) {
			PBD::error << "foyer_shim: [ingress] registry FULL (max "
			           << MAX_SLOTS << "); port will receive audio but RT drain is disabled"
			           << endmsg;
		}
	} else {
		PBD::error << "foyer_shim: [ingress] failed to register audio port " << bare_name << endmsg;
	}
}

ShimInputPort::~ShimInputPort ()
{
	stop ();
	if (_port) {
		AudioEngine::instance ()->unregister_port (_port);
	}
}

void
ShimInputPort::stop ()
{
	if (_stopped.exchange (true, std::memory_order_acq_rel)) return;
	// Pull ourselves out of the RT registry so new tick_all_rt
	// iterations skip our (now-null) slot.
	unregister_from_registry ();
	// Lifetime race: an RT iteration may have loaded our pointer
	// from the slot BEFORE we cleared it and be about to call
	// tick_rt() for this port after we return. Wait one RT cycle to
	// let any such in-flight call complete before the destructor
	// starts freeing `_ring` / `_port`. 50 ms is a conservative
	// upper bound on Ardour's block period (at 2048 samples / 48 kHz
	// it's ~43 ms; larger blocks are vanishingly rare). stop() is
	// only called on ingress-close or session teardown, so the wait
	// is not in the steady-state hot path.
	std::this_thread::sleep_for (std::chrono::milliseconds (50));
}

void
ShimInputPort::push_audio (const float* samples, std::size_t n_samples)
{
	if (!_ring || !_port || _stopped.load (std::memory_order_relaxed)) return;

	std::size_t space = _ring->write_space ();
	std::size_t to_write = std::min (n_samples, space);
	std::size_t dropped = n_samples - to_write;
	if (to_write > 0) {
		_ring->write (samples, to_write);
		_samples_pushed.fetch_add (to_write, std::memory_order_relaxed);
	}
	if (dropped > 0) {
		_overruns.fetch_add (dropped, std::memory_order_relaxed);
	}
	bool first = false;
	if (!_logged_first_push.exchange (true, std::memory_order_relaxed) && to_write > 0) {
		first = true;
	}
	if (first) {
		PBD::warning << "foyer_shim: [ingress] first audio chunk stream_id=" << _stream_id
		             << " n_samples=" << n_samples << " written=" << to_write
		             << " dropped=" << dropped << endmsg;
	}
}

void
ShimInputPort::tick_rt (pframes_t nframes)
{
	// RT THREAD. No locks, no allocations, no logging in the steady
	// state. `AudioPort::get_audio_buffer()` and `AudioBuffer::silence/
	// read_from` are the only Ardour calls we make, and they're the
	// same ones every processor uses in its run() callback.
	if (!_ring || !_port || nframes == 0) return;
	// Acquire-load pairs with the release store in stop() so if we
	// observe _stopped==false here, any subsequent read of _ring /
	// _port below hits the still-live members (stop() sleeps after
	// clearing the slot, so the dtor can't have raced past us yet).
	if (_stopped.load (std::memory_order_acquire)) return;

	// First-tick diagnostic — single warning line confirming the RT
	// hook is firing. After this the per-port is silent unless we
	// log from push_audio (non-RT).
	if (!_logged_first_tick.exchange (true, std::memory_order_relaxed)) {
		PBD::warning << "foyer_shim: [ingress] first tick_rt stream_id=" << _stream_id
		             << " nframes=" << nframes << endmsg;
	}

	AudioBuffer* buf = nullptr;
	try {
		buf = &_port->get_audio_buffer (nframes);
	} catch (...) {
		// get_audio_buffer can assert if the engine is tearing down
		// or the port isn't in the current cycle; absorb rather than
		// crash the RT thread.
		return;
	}

	// Priming: accumulate headroom before we drain anything. While
	// priming, ship silence so downstream sees a clean stream.
	if (_state == DrainState::Priming) {
		if (_ring->read_space () >= _prime_threshold_samples) {
			_state = DrainState::Running;
		} else {
			buf->silence (nframes);
			return;
		}
	}

	// Running: drain nframes * channels interleaved samples. If the
	// ring is short, zero-fill the tail and drop back to priming so
	// the cushion rebuilds.
	const std::size_t want_interleaved = static_cast<std::size_t> (nframes) * _channels;
	const std::size_t avail = _ring->read_space ();
	const std::size_t to_read = std::min (want_interleaved, avail);

	if (to_read < want_interleaved) {
		_underruns.fetch_add (want_interleaved - to_read, std::memory_order_relaxed);
		_state = DrainState::Priming;
	}

	if (to_read == 0) {
		buf->silence (nframes);
		return;
	}

	// De-interleave channel 0 (or copy mono straight through) into
	// the port buffer. Multi-channel ingress would need one soft port
	// per channel — v1 is mono per stream (Ardour's input model).
	float* ring_scratch = _rt_scratch.data ();
	const std::size_t got = _ring->read (ring_scratch, to_read);
	_samples_delivered.fetch_add (got, std::memory_order_relaxed);

	const std::size_t frames_got = got / _channels;
	if (_channels == 1) {
		buf->read_from (ring_scratch, static_cast<samplecnt_t> (frames_got));
	} else {
		float* dst = buf->data (0);
		for (std::size_t i = 0; i < frames_got; ++i) {
			dst[i] = ring_scratch[i * _channels];
		}
		buf->set_written (true);
	}

	// Zero-fill any remainder on underrun (short read). read_from
	// already sets _written=true, but only covered frames_got frames;
	// the rest of the port buffer still holds whatever AudioBuffer
	// has in it, which may be prior cycle data. Silence it.
	if (frames_got < nframes) {
		float* dst = buf->data (0);
		const std::size_t tail = static_cast<std::size_t> (nframes) - frames_got;
		std::memset (dst + frames_got, 0, tail * sizeof (float));
	}
}

} // namespace ArdourSurface
