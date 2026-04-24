// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: soft input port for browser audio ingress.
 */
#ifndef foyer_shim_input_port_h
#define foyer_shim_input_port_h

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "ardour/types.h"
#include "pbd/ringbuffer.h"

namespace ARDOUR {
class AudioPort;
}

namespace ArdourSurface {

class FoyerShim;

/// Virtual audio input port fed by IPC audio frames from the sidecar.
///
/// Mirrors MasterTap in reverse: a non-RT IPC thread pushes interleaved
/// f32 samples into a lock-free ring, and Ardour's RT audio thread
/// (driven by MasterTap's process callback each cycle) drains a
/// block-sized chunk into the soft port's buffer. See Decision 24.
///
/// **Why RT-driven drain matters.** An earlier prototype used a
/// non-RT worker thread polling every ~5 ms and writing directly to
/// `port->get_audio_buffer()`. That races with Ardour's
/// `PortManager::cycle_start()` memset: writes landing before the
/// memset are wiped, writes landing after `Session::process()` reads
/// are never observed. Statistically, most writes fell outside the
/// useful window and were lost — manifesting as clicks and pops on
/// every ingress stream. Ticking from the RT thread guarantees our
/// write lives in the valid cycle window.
///
/// **Jitter buffer.** Browser→sidecar delivery is bursty (WS packets,
/// decode jitter, GC pauses). We prime the ring to
/// `PRIME_THRESHOLD_MS` of audio before emitting anything, then drain
/// `nframes` per cycle. If the ring underruns, we zero-fill the
/// current block and re-enter priming so we build a cushion before
/// resuming. Users hear a brief silence instead of a pop.
class ShimInputPort {
public:
	// Priming cushion before we start draining. Absorbs browser→sidecar
	// jitter (decode bursts, GC pauses, WS backpressure). Balanced
	// against recording latency — higher is more robust but the user
	// hears their captured audio N ms later.
	static constexpr std::uint32_t PRIME_THRESHOLD_MS = 80;

	ShimInputPort (FoyerShim& shim,
	               std::uint32_t stream_id,
	               const std::string& name,
	               std::uint32_t channels,
	               std::uint32_t sample_rate,
	               std::uint32_t frame_size);
	~ShimInputPort ();

	std::uint32_t stream_id () const { return _stream_id; }
	/// Engine-level port name after registration (what IO::connect
	/// wants). Empty string if registration failed.
	const std::string& engine_port_name () const { return _engine_port_name; }

	/// Push interleaved f32 samples from the IPC audio frame handler.
	/// Non-RT. If the ring is full, excess samples are dropped and
	/// accounted in `_overruns`.
	void push_audio (const float* samples, std::size_t n_samples);

	/// Drain one process block into the soft port's buffer. Called
	/// from Ardour's RT audio thread each cycle (via MasterTap's
	/// process callback — see `master_tap.cc`). RT-safe: no locks,
	/// no allocations.
	void tick_rt (ARDOUR::pframes_t nframes);

	/// Unregister the port. Safe to call multiple times.
	void stop ();

	// ─── RT-safe ingress registry ────────────────────────────────────
	//
	// MasterTap's `run()` / `silence()` fire on the RT audio thread
	// and must iterate active ingress ports without taking locks. The
	// map in `Dispatcher::_ingress_ports` is protected by a mutex
	// (`_ingress_mx`) that the IPC thread holds during add/remove; we
	// can't touch it from RT. Instead, each port registers a pointer
	// into this fixed-size lock-free slot array on construction and
	// clears it on destruction. Slot acquisition is a CAS, slot load
	// is a relaxed atomic read — wait-free.
	//
	// MAX_SLOTS=32 is plenty for the "remote engineer + a few clients"
	// use case; open one stream per participant.
	static constexpr std::size_t MAX_SLOTS = 32;

	/// RT-safe: drain every registered ingress port. Called once per
	/// cycle from MasterTap.
	static void tick_all_rt (ARDOUR::pframes_t nframes);

private:
	/// Non-RT: claim a slot in the global registry. Returns slot
	/// index or -1 if the table is full.
	int register_in_registry ();
	/// Non-RT: release our slot. Idempotent.
	void unregister_from_registry ();

	FoyerShim&           _shim;
	std::uint32_t        _stream_id;
	std::uint32_t        _channels;
	std::uint32_t        _sample_rate;
	std::uint32_t        _frame_size;
	std::uint32_t        _prime_threshold_samples;

	std::shared_ptr<ARDOUR::AudioPort>      _port;
	std::string                             _engine_port_name;
	std::unique_ptr<PBD::RingBuffer<float>> _ring;

	/// Scratch buffer reused by tick_rt (pre-allocated; RT-safe).
	std::vector<float>   _rt_scratch;

	/// State machine — priming accumulates headroom before the first
	/// drain; running drains every cycle. We flip back to priming on
	/// underrun. Accessed only from the RT thread, no atomic needed.
	enum class DrainState : std::uint8_t { Priming, Running };
	DrainState _state = DrainState::Priming;

	// Registry slot we occupy (-1 if not registered).
	int _registry_slot = -1;

	// Diagnostics. Updated with relaxed atomics so push (non-RT) and
	// tick_rt (RT) can both touch them without heavy ordering.
	std::atomic<std::uint64_t> _samples_pushed    { 0 };
	std::atomic<std::uint64_t> _samples_delivered { 0 };
	std::atomic<std::uint64_t> _overruns          { 0 };
	std::atomic<std::uint64_t> _underruns         { 0 };
	std::atomic<bool>          _logged_first_push { false };
	std::atomic<bool>          _logged_first_tick { false };
	std::atomic<bool>          _stopped           { false };
};

} // namespace ArdourSurface

#endif
