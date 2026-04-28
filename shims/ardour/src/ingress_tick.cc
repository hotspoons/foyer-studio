// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: always-on ingress tick processor impl.
 */

#include "ingress_tick.h"

#include "pbd/xml++.h"

#include "shim_input_port.h"

namespace ArdourSurface {

using namespace ARDOUR;

IngressTickProcessor::IngressTickProcessor (Session& s)
    : Processor (s, "foyer-ingress-tick", Temporal::TimeDomainProvider (Temporal::AudioTime))
{
}

XMLNode&
IngressTickProcessor::state () const
{
	XMLNode& node = Processor::state ();
	node.set_property ("type", "capture");
	return node;
}

bool
IngressTickProcessor::can_support_io_configuration (const ChanCount& in, ChanCount& out)
{
	// Pass-through: we don't touch `bufs`. Whatever shape comes in
	// is what goes out.
	out = in;
	return true;
}

void
IngressTickProcessor::run (BufferSet& /*bufs*/,
                           samplepos_t /*start_sample*/,
                           samplepos_t /*end_sample*/,
                           double /*speed*/,
                           pframes_t nframes,
                           bool /*result_required*/)
{
	// RT THREAD. Allocation- and lock-free. The drain itself is
	// implemented inside `ShimInputPort::tick_rt` per port; this
	// just iterates the slot registry and calls each port's tick.
	ShimInputPort::tick_all_rt (nframes);
}

void
IngressTickProcessor::silence (samplecnt_t nframes, samplepos_t /*start_sample*/)
{
	// Same constraint as run(): drain the ingress every cycle, even
	// when the upstream mix is silent. Browser keeps pushing audio
	// whether or not transport is rolling.
	ShimInputPort::tick_all_rt (static_cast<pframes_t> (nframes));
}

} // namespace ArdourSurface
