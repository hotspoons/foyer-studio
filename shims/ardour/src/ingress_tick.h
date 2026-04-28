// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: always-on ingress tick processor.
 *
 * Drives `ShimInputPort::tick_all_rt()` once per audio cycle so the
 * browser-mic ingress soft-ports actually deliver samples to the
 * engine. Independent of egress (`MasterTap`) lifecycle: previously
 * the tick was a side effect of `MasterTap::run()` / `silence()`,
 * which meant ingress only worked while a browser was actively
 * listening to the master out. This processor decouples the two —
 * a track armed against a `foyer-ingress-browser-*` port records
 * audio whether or not anyone is monitoring master.
 *
 * Installed as a PostFader processor on `session.master_out()` once
 * per session by `SignalBridge::on_session_loaded`. Pass-through:
 * does not touch `bufs`. State is serialized as `type="capture"` so
 * Ardour's session loader skips it on reload (we re-install on every
 * load).
 */
#ifndef foyer_shim_ingress_tick_h
#define foyer_shim_ingress_tick_h

#include <cstdint>

#include "ardour/processor.h"

namespace ArdourSurface {

class IngressTickProcessor : public ARDOUR::Processor
{
public:
	explicit IngressTickProcessor (ARDOUR::Session& s);

	std::string display_name () const override { return "Foyer Studio Ingress Tick"; }
	// Must be true: `Route::setup_invisible_processors` drops any
	// non-internal processor whose `display_to_user()` is false.
	// Same constraint MasterTap hits — see the long comment there.
	bool display_to_user () const override     { return true; }
	bool does_routing () const override        { return false; }
	bool enabled () const override             { return true; }

	bool can_support_io_configuration (const ARDOUR::ChanCount& in, ARDOUR::ChanCount& out) override;

	/// Override Processor::state() to mark our XML node as `type="capture"`.
	/// Same rationale as MasterTap::state — the base Processor::state()
	/// emits no `type` attribute and Ardour's session loader segfaults
	/// reading the missing prop. `capture` routes to the explicit-skip
	/// branch in route.cc, which is exactly the lifecycle we want: this
	/// processor is re-created from scratch on every `on_session_loaded`,
	/// not restored from XML.
	XMLNode& state () const override;

	/// RT path. Just ticks every registered ingress soft-port. No
	/// allocation, no locks, no logging in the steady state.
	void run (ARDOUR::BufferSet& bufs,
	          ARDOUR::samplepos_t start_sample,
	          ARDOUR::samplepos_t end_sample,
	          double speed,
	          ARDOUR::pframes_t nframes,
	          bool result_required) override;

	/// RT path for cycles where the upstream mix is silent. Still
	/// must tick the ingress drain — the browser keeps pushing audio
	/// regardless of whether the master is rolling.
	void silence (ARDOUR::samplecnt_t nframes, ARDOUR::samplepos_t start_sample) override;
};

} // namespace ArdourSurface

#endif
