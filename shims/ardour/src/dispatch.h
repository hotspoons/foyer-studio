/*
 * Foyer Studio — Ardour shim: dispatcher.
 *
 * Decodes inbound Envelope<Control::Command> frames and applies them to the
 * session via Ardour APIs. Runs on the shim's AbstractUI request queue to keep
 * writes off the IO thread.
 */
#ifndef foyer_shim_dispatch_h
#define foyer_shim_dispatch_h

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

namespace ArdourSurface {

class FoyerShim;
class MasterTap;

class Dispatcher
{
public:
	explicit Dispatcher (FoyerShim&);
	~Dispatcher ();

	/// Called from the IPC thread for each inbound Control frame. Decodes and
	/// marshals the command onto the shim's event loop.
	void on_control_frame (const std::vector<std::uint8_t>&);

	/// Called from the IPC thread for each inbound Audio frame. For M3 this
	/// is a no-op (ingress routing lands in M6b).
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
};

} // namespace ArdourSurface

#endif
