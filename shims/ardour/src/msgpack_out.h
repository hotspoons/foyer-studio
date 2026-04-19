/*
 * Foyer Studio — Ardour shim: MessagePack encoding helpers for outbound
 * Envelope<Control> frames.
 *
 * This is a small, hand-rolled encoder that writes only the msgpack forms we
 * need — keeps the shim's external deps to zero beyond the Ardour tree itself.
 * If this becomes fiddly we swap in `msgpack-c` and eat the system dep.
 *
 * Wire parity with the Rust side is verified via the integration test that
 * runs `foyer-cli --backend=host` against this shim (landing once Ardour is
 * actually built in the dev container).
 */
#ifndef foyer_shim_msgpack_out_h
#define foyer_shim_msgpack_out_h

#include <cstdint>
#include <vector>

namespace ARDOUR {
class Session;
}
namespace PBD {
class Controllable;
}

namespace ArdourSurface::msgpack_out {

/// Encode `session.snapshot` from the current session state.
std::vector<std::uint8_t> encode_session_snapshot (ARDOUR::Session&);

/// Encode a `control.update` event for a single controllable.
std::vector<std::uint8_t> encode_control_update (ARDOUR::Session&, const PBD::Controllable&);

/// Encode the transport subtree as a batch of `control.update` messages (one
/// envelope, bundled in a meter_batch-style `Event::MeterBatch` shape).
std::vector<std::uint8_t> encode_transport_state (ARDOUR::Session&);

/// Encode a `session.patch` op=reload. Used when we don't want to compute
/// per-op patches for a structural change.
std::vector<std::uint8_t> encode_patch_reload ();

} // namespace ArdourSurface::msgpack_out

#endif
