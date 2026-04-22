/*
 * Foyer Studio — Ardour shim: soft input port for browser audio ingress.
 */
#ifndef foyer_shim_input_port_h
#define foyer_shim_input_port_h

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "pbd/ringbuffer.h"

namespace ARDOUR {
class AudioPort;
}

namespace ArdourSurface {

class FoyerShim;

/// Virtual audio input port fed by IPC audio frames from the sidecar.
///
/// Mirrors MasterTap in reverse: a non-RT IPC thread pushes interleaved
/// f32 samples into a lock-free ring, and a lightweight drain thread
/// copies them into a soft port registered with Ardour's PortManager.
///
/// RT safety note: `get_audio_buffer()` is called from the drain thread
/// (non-RT). For input ports without external connections Ardour only
/// touches the buffer in `cycle_start()` and then reads it during the
/// session process. The prototype accepts the rare race (click) for
/// simplicity; a production version should use a registered process
/// callback or an async port specialization (see Decision 24).
class ShimInputPort {
public:
	ShimInputPort (FoyerShim& shim,
	               std::uint32_t stream_id,
	               const std::string& name,
	               std::uint32_t channels,
	               std::uint32_t sample_rate,
	               std::uint32_t frame_size);
	~ShimInputPort ();

	std::uint32_t stream_id () const { return _stream_id; }

	/// Push interleaved f32 samples from the IPC audio frame handler.
	void push_audio (const float* samples, std::size_t n_samples);

	/// Stop the drain thread and unregister the port. Safe to call
	/// multiple times.
	void stop ();

private:
	void drain_loop ();

	FoyerShim&           _shim;
	std::uint32_t        _stream_id;
	std::uint32_t        _channels;
	std::uint32_t        _sample_rate;
	std::uint32_t        _frame_size;

	std::shared_ptr<ARDOUR::AudioPort>      _port;
	std::unique_ptr<PBD::RingBuffer<float>> _ring;

	std::thread         _drain_thread;
	std::atomic<bool>   _stop { false };
	std::mutex          _wake_mx;
	std::condition_variable _wake_cv;
};

} // namespace ArdourSurface

#endif
