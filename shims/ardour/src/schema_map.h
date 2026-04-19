/*
 * Foyer Studio — Ardour shim: Ardour → Foyer neutral-schema translation.
 *
 * ID convention (assigned by this shim; stable across session saves via
 * Stripable IDs):
 *
 *   track.<stripable-id>.{gain,pan,mute,solo,rec}
 *   plugin.<insert-id>.param.<index>
 *   transport.{playing,recording,looping,tempo,ts.num,ts.den,position}
 *
 * Stripable IDs are Ardour's PBD::ID (uint64 wrapped in GUIDs), serialized as
 * their hex string form.
 */
#ifndef foyer_shim_schema_map_h
#define foyer_shim_schema_map_h

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ARDOUR {
class Session;
class Stripable;
class Route;
class Playlist;
class Plugin;
class PluginInsert;
class Region;
struct ParameterDescriptor;
} // namespace ARDOUR

namespace PBD {
class Controllable;
}

namespace ArdourSurface::schema_map {

/// Foyer stable ID for a route/bus/master's gain / pan / etc.
std::string id_gain  (const ARDOUR::Stripable&);
std::string id_pan   (const ARDOUR::Stripable&);
std::string id_mute  (const ARDOUR::Stripable&);
std::string id_solo  (const ARDOUR::Stripable&);
std::string id_rec   (const ARDOUR::Stripable&);
std::string id_meter (const ARDOUR::Stripable&);

/// Best-effort resolution from an Ardour controllable to its Foyer ID; returns
/// empty string if we don't recognize the controllable.
std::string id_for_controllable (const ARDOUR::Session&, const PBD::Controllable&);

/// Parse a CSS-style hex color (`#rrggbb` or `rrggbb`) into an Ardour
/// ARGB color_t (alpha = 0xff). Returns 0 on malformed input, which
/// also doubles as Ardour's "no color assigned" sentinel.
std::uint32_t color_from_hex (const std::string& s);

/// Given a Foyer stable ID, locate the matching AutomationControl on the
/// session. Used by the dispatcher for `control.set`.
std::shared_ptr<PBD::Controllable> resolve (ARDOUR::Session&, const std::string& id);

/// Enumerate the session into a flat list of (id, initial-value) pairs — used
/// to emit the initial `session.snapshot`. For now this is a forward-declared
/// hand-off; the actual snapshot shape is assembled in `msgpack_out`.
struct StripableIds {
	std::string self_id;
	std::string name;
	std::string kind;   // "audio" | "midi" | "bus" | "master" | "monitor"
	std::string color;  // "#rrggbb" or ""
};
std::vector<StripableIds> enumerate_stripables (ARDOUR::Session&);

/// Description of a single plugin parameter lifted from
/// `ARDOUR::ParameterDescriptor` into Foyer's neutral shape.
struct ParamDesc {
	std::string id;         ///< plugin.<pi-id>.param.<index>  or  plugin.<pi-id>.bypass
	std::string label;
	std::string kind;       ///< "continuous" | "discrete" | "enum" | "trigger" | "meter" | "text"
	std::string scale;      ///< "linear" | "logarithmic" | "decibels" | "hertz"
	std::string unit;       ///< "" if none
	bool        has_range;
	float       lower;
	float       upper;
	/// Ordered enum labels (present when scale_points are attached).
	std::vector<std::string> enum_labels;
	/// Numeric values corresponding to each enum label, used to resolve a
	/// `ControlValue::Int(n)` back to the Ardour control-value when
	/// applying `ControlSet`.
	std::vector<float>       enum_values;
	double      value;      ///< current value, coerced to double
};

/// Description of one plugin instance on a route.
struct PluginDesc {
	std::string id;             ///< plugin.<pi-id>
	std::string name;
	std::string uri;
	bool        bypassed;
	std::vector<ParamDesc> params;
};

/// Build Foyer-schema plugin descriptions for every `PluginInsert` on `route`.
/// Bypass is included as the first entry in `params` (id ends with `.bypass`)
/// so the generic client UI can render it like any other parameter.
std::vector<PluginDesc> enumerate_plugins (std::shared_ptr<ARDOUR::Route> route);

/// Description of a single region on a track playlist, translated into
/// Foyer's schema shape. Samples are at the session's sample rate.
///
/// Empty `source_path` means the source isn't a filesystem-backed file —
/// either MIDI, a silent/tape source, or something the shim couldn't
/// resolve. The sidecar treats that as "fall back to synthesized peaks".
struct RegionDesc {
	std::string   id;                     ///< "region.<region-pbd-id>"
	std::string   track_id;               ///< "track.<stripable-id>"
	std::string   name;
	std::uint64_t start_samples   = 0;    ///< position on the timeline
	std::uint64_t length_samples  = 0;
	std::string   color;                  ///< "#rrggbb" or ""
	bool          muted           = false;
	std::string   source_path;            ///< "" if no file source
	std::uint64_t source_offset_samples = 0;
	bool          has_source_offset = false;
};

/// Enumerate regions on the playlist of the track identified by `track_id`
/// (which must be in the `"track.<stripable-id>"` form we emit). Returns
/// empty if the id doesn't map to an Audio/MIDI track (buses/masters
/// don't host regions).
std::vector<RegionDesc> enumerate_regions (ARDOUR::Session&, const std::string& track_id);

/// Look up a region across every track's playlist by its Foyer id
/// (`"region.<pbd-id>"`). Returns both the region and the owning track id
/// so the sidecar can emit a targeted `RegionUpdated` / `RegionRemoved`.
struct RegionHit {
	std::shared_ptr<ARDOUR::Region> region;
	std::string                     track_id;   ///< "track.<stripable-id>"
};
RegionHit find_region (ARDOUR::Session&, const std::string& region_id);

} // namespace ArdourSurface::schema_map

#endif
