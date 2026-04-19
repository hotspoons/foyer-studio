/*
 * Foyer Studio — Ardour shim: exported protocol_descriptor().
 */

#include "ardour/rc_configuration.h"
#include "control_protocol/control_protocol.h"

#include "surface.h"


using namespace ARDOUR;
using namespace ArdourSurface;

static ControlProtocol*
new_foyer_shim (Session* s)
{
	FoyerShim* surface = new FoyerShim (*s);
	surface->set_active (true);
	return surface;
}

static void
delete_foyer_shim (ControlProtocol* cp)
{
	delete cp;
}

static ControlProtocolDescriptor foyer_shim_descriptor = {
	/* name       */ FoyerShim::surface_name,
	/* id         */ FoyerShim::surface_id,
	/* module     */ 0,
	/* available  */ 0,
	/* probe_port */ 0,
	/* match usb  */ 0,
	/* initialize */ new_foyer_shim,
	/* destroy    */ delete_foyer_shim,
};

extern "C" ARDOURSURFACE_API ControlProtocolDescriptor*
protocol_descriptor ()
{
	return &foyer_shim_descriptor;
}
