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

#include <memory>
#include <string>
#include <vector>

namespace ARDOUR {
class Session;
class Stripable;
class Route;
class Plugin;
class PluginInsert;
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

} // namespace ArdourSurface::schema_map

#endif
