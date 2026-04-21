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
#include <list>
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
// RouteList is a typedef in ardour/types.h — forward-declaring it here
// as the same typedef so our safe_get_routes signature compiles without
// dragging ardour/types.h into every schema_map.h consumer.
typedef std::list<std::shared_ptr<Route>> RouteList;
} // namespace ARDOUR

namespace PBD {
class Controllable;
}

namespace ArdourSurface::schema_map {

/// Safe wrapper around `session.get_routes()` that returns an empty
/// (non-null) RouteList shared_ptr while the session is still loading.
///
/// Rationale: `Session::get_routes()` reaches into `RCUManager::reader()`
/// which `*managed_object.load()` without a null check. During session
/// load (from XML or new-session bootstrap), the RCU's backing
/// shared_ptr is zero-initialized and null-deref crashes the process
/// (SIGSEGV in shared_ptr_base.h). Ardour's `Session::loading()` is
/// true through this entire window, and goes false in `session_loaded()`
/// once state parsing, route instantiation, and AudioEngine connect-up
/// are complete. Using it as a gate makes every call site crash-safe.
///
/// Callers that iterate the returned list handle an empty one as a
/// no-op naturally; nothing to draw / meter / dispatch against means
/// nothing is emitted until the next tick / signal pumps re-runs them.
std::shared_ptr<ARDOUR::RouteList const> safe_get_routes (const ARDOUR::Session&);

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

/// Plugin-preset metadata. Matches `foyer_schema::PluginPreset`.
struct PluginPresetDesc {
	std::string id;          ///< opaque URI (Ardour's PresetRecord::uri)
	std::string name;        ///< PresetRecord::label
	std::string bank;        ///< empty for LV2 (no native bank concept)
	bool        is_factory = true;
};

/// Look up a PluginInsert by its Foyer id (`"plugin.<pi-id>"`).
std::shared_ptr<ARDOUR::PluginInsert> find_plugin_insert_by_foyer_id (
	ARDOUR::Session&, const std::string& plugin_id);

/// List the presets exposed by a plugin (LV2's lilv-backed list +
/// user-saved entries). Returns empty if the id doesn't resolve.
std::vector<PluginPresetDesc> list_plugin_presets (
	ARDOUR::Session&, const std::string& plugin_id);

/// Catalog entry — one installed plugin Ardour's PluginManager
/// knows about. Matches `foyer_schema::PluginCatalogEntry`.
struct PluginCatalogDesc {
	std::string id;          ///< unique opaque id (Ardour PluginInfo::unique_id)
	std::string name;
	std::string format;      ///< "lv2" / "vst3" / "vst2" / "au" / "ladspa" / "lua" / "internal"
	std::string role;        ///< "instrument" / "effect" / "generator" / "analyzer" / "utility"
	std::string vendor;
	std::string uri;         ///< the URI passed to AddPlugin (LV2 URI / VST3 path)
	std::vector<std::string> tags;
};

/// Walk Ardour's PluginManager and build a flat catalog of every
/// plugin it has scanned. This is what powers Foyer's "Insert
/// plugin" picker — we don't replicate Ardour's plugin scan; we
/// just surface what it found.
std::vector<PluginCatalogDesc> list_plugin_catalog ();

/// Apply a preset to a plugin by its URI. Returns `false` if the
/// plugin or preset id can't be resolved or `load_preset` failed.
bool load_plugin_preset (
	ARDOUR::Session&, const std::string& plugin_id, const std::string& preset_id);

/// Per-note payload attached to a MIDI region. Ticks are at the
/// project's PPQN (960 by default). Matches `foyer_schema::MidiNote`.
struct NoteDesc {
	std::string   id;              ///< "note.<region-pbd-id>.<n>"
	std::uint8_t  pitch   = 0;     ///< 0..127
	std::uint8_t  velocity = 0;    ///< 0..127
	std::uint8_t  channel = 0;     ///< 0..15
	std::uint64_t start_ticks  = 0;///< relative to region start
	std::uint64_t length_ticks = 0;
};

/// Beat-sequencer row — matches `foyer_schema::SequencerRow`.
struct SequencerRowDesc {
	std::uint8_t  pitch   = 0;
	std::string   label;
	std::uint8_t  channel = 9;
	std::string   color;    // empty means "no color"
	bool          muted   = false;
	bool          soloed  = false;
};

/// Beat-sequencer cell — matches `foyer_schema::SequencerCell`.
struct SequencerCellDesc {
	std::uint32_t row = 0;
	std::uint32_t step = 0;
	std::uint8_t  velocity = 100;
	/// 0 means "one step" (drum-mode default). Values > 1 mark
	/// pitched-mode long notes spanning that many consecutive
	/// steps. Persisted as an XML attribute on `<Cell>`.
	std::uint32_t length_steps = 0;
};

/// One named pattern. Mirrors `foyer_schema::SequencerPattern`.
struct SequencerPatternDesc {
	std::string id;
	std::string name;
	std::string color;
	std::vector<SequencerCellDesc> cells;
};

/// One arrangement slot. Mirrors `foyer_schema::ArrangementSlot`.
struct SequencerSlotDesc {
	std::string   pattern_id;
	std::uint32_t bar = 0;
	std::uint32_t arrangement_row = 0;
};

/// Beat-sequencer layout — matches `foyer_schema::SequencerLayout`
/// (v2). v1 layouts read with empty `patterns` + populated `cells`
/// and are migrated at expand time.
struct SequencerLayoutDesc {
	std::uint32_t version = 2;
	std::string   mode = "drum";
	std::uint32_t resolution = 4;
	std::uint32_t pattern_steps = 16;
	std::vector<SequencerRowDesc>     rows;
	std::vector<SequencerPatternDesc> patterns;
	std::vector<SequencerSlotDesc>    arrangement;
	// v1 carry-through.
	std::vector<SequencerCellDesc>    cells;
	bool          present = false;   // false = region has no layout
	// When true (default), the server expands this layout into
	// notes on every SetSequencerLayout. When false, the layout
	// is archived alongside authoritative MIDI notes — the piano
	// roll can edit freely and "Restore sequencer" flips the flag
	// back. Persisted as the `active` XML attribute on Sequencer.
	bool          active  = true;
};

/// Program/bank-change event attached to a MIDI region. Matches
/// `foyer_schema::PatchChange`.
struct PatchChangeDesc {
	std::string   id;           ///< "patchchange.<region-pbd-id>.<event_id>"
	std::uint8_t  channel = 0;  ///< 0..15
	std::uint8_t  program = 0;  ///< 0..127
	std::int32_t  bank    = -1; ///< (MSB<<7)|LSB or -1 for "no bank"
	std::uint64_t start_ticks = 0;
};

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
	/// Populated for MIDI regions only. Empty for audio.
	std::vector<NoteDesc> notes;
	/// Program/bank change events for MIDI regions only. Empty for
	/// audio.
	std::vector<PatchChangeDesc> patch_changes;
	/// Foyer beat-sequencer layout, read from the region's
	/// `_extra_xml` under the `Foyer/Sequencer` path. `.present`
	/// is false for regions without a layout.
	SequencerLayoutDesc sequencer;
};

/// Enumerate regions on the playlist of the track identified by `track_id`
/// (which must be in the `"track.<stripable-id>"` form we emit). Returns
/// empty if the id doesn't map to an Audio/MIDI track (buses/masters
/// don't host regions).
std::vector<RegionDesc> enumerate_regions (ARDOUR::Session&, const std::string& track_id);

/// Build a single RegionDesc from a live `ARDOUR::Region`. MIDI regions
/// populate `notes`; audio regions leave it empty. Exported so the
/// `region_updated` emitter can reuse the same extraction logic as
/// `enumerate_regions` instead of duplicating (and drifting from) it.
RegionDesc describe_region_desc (const ARDOUR::Region&, const std::string& track_id);

/// Apply a beat-sequencer layout to a region: write it into the
/// region's `_extra_xml` (creating or replacing the `<Foyer>` node).
/// Returns `false` if the region can't be found.
bool set_sequencer_layout (
	ARDOUR::Session&, const std::string& region_id, const SequencerLayoutDesc& layout);

/// Drop the beat-sequencer metadata from a region's `_extra_xml`.
/// Leaves the region's note list untouched — callers do that
/// separately if they want to start fresh.
bool clear_sequencer_layout (ARDOUR::Session&, const std::string& region_id);

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
