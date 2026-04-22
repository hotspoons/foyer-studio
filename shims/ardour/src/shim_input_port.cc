/*
 * Foyer Studio — Ardour shim: soft input port for browser audio ingress.
 */
#include "shim_input_port.h"

#include <algorithm>
#include <chrono>
#include <cstring>

#include "ardour/audio_port.h"
#include "ardour/audioengine.h"
#include "ardour/port_engine.h"
#include "ardour/port_manager.h"
#include "pbd/error.h"

#include "surface.h"

namespace ArdourSurface {

using namespace ARDOUR;

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
	std::size_t ring_samples = static_cast<std::size_t> (_sample_rate) * _channels * 2 / 5;
	_ring = std::make_unique<PBD::RingBuffer<float>> (ring_samples);

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
		PBD::warning << "foyer_shim: [ingress] port registered (OUTPUT) stream_id=" << _stream_id
		             << " bare_name=" << bare_name
		             << " engine_name=" << _engine_port_name
		             << " channels=" << _channels
		             << " sample_rate=" << _sample_rate << endmsg;
		_drain_thread = std::thread (&ShimInputPort::drain_loop, this);
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
	if (_stop.exchange (true)) return; // already stopped
	_wake_cv.notify_all ();
	if (_drain_thread.joinable ()) {
		_drain_thread.join ();
	}
}

void
ShimInputPort::push_audio (const float* samples, std::size_t n_samples)
{
	if (!_ring || !_port || _stop.load ()) return;

	std::size_t space = _ring->write_space ();
	std::size_t to_write = std::min (n_samples, space);
	if (to_write > 0) {
		_ring->write (samples, to_write);
	}
	// One-line diagnostic on the first delivery — helps confirm the
	// browser → sidecar → shim data path works, independent of the
	// port-buffer write race discussed in drain_loop().
	if (!_logged_first_push && to_write > 0) {
		_logged_first_push = true;
		PBD::warning << "foyer_shim: [ingress] first audio chunk received stream_id=" << _stream_id
		             << " n_samples=" << n_samples << " written=" << to_write
		             << " dropped=" << (n_samples - to_write) << endmsg;
	}
	_wake_cv.notify_one ();
}

void
ShimInputPort::drain_loop ()
{
	std::vector<float> scratch;

	while (!_stop.load ()) {
		{
			std::unique_lock<std::mutex> lk (_wake_mx);
			_wake_cv.wait_for (lk, std::chrono::milliseconds (5));
		}
		if (_stop.load ()) break;
		if (!_ring || !_port) break;

		std::size_t avail = _ring->read_space ();
		if (avail == 0) continue;

		scratch.resize (avail);
		std::size_t got = _ring->read (scratch.data (), avail);
		if (got == 0) continue;

		// Drain thread writes directly into the port buffer. This
		// races with Ardour's audio thread in cycle_start() which
		// does a memset; the window where our write survives is
		// between cycle_start() and Session::process(). For the
		// prototype this is acceptable — occasional dropped frames
		// manifest as light clicks. Decision 24 discusses the
		// production fix (proper callback registration).
		std::size_t frames_available = got / _channels;
		std::size_t frames_to_copy   = std::min (frames_available, static_cast<std::size_t> (_frame_size));

		try {
			auto& buf = _port->get_audio_buffer (_frame_size);
			if (_channels == 1) {
				buf.read_from (scratch.data (), static_cast<samplecnt_t> (frames_to_copy));
			} else {
				// De-interleave channel 0 into the port buffer.
				// Multi-channel ingress needs one port per channel
				// (Ardour's model) — mono is the v1 path.
				float* dst = buf.data (0);
				for (std::size_t i = 0; i < frames_to_copy; ++i) {
					dst[i] = scratch[i * _channels];
				}
				buf.set_written (true);
			}
		} catch (...) {
			// get_audio_buffer can assert if the engine is tearing
			// down; absorb rather than crash the drain thread.
		}
	}
}

} // namespace ArdourSurface
