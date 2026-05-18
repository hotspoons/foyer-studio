// SPDX-License-Identifier: GPL-2.0-or-later
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

#include <cmath>
#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
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
	/// URI of the preset most recently applied to this plugin instance,
	/// or empty if the plugin is in its native default state. Sourced
	/// from `Plugin::last_preset()`. Lets the UI's preset selector
	/// display the active preset name after a session reload without
	/// the user re-applying.
	std::string current_preset;
	/// True when the plugin advertises a native GUI (LV2 has any
	/// `ui:` extension, VST/VST3/AU report `has_editor()`).
	/// Phase 1: surface the bit through the wire so the web UI can
	/// show a "native GUI available" affordance. Hosting / projection
	/// arrives in a later phase.
	bool        has_native_gui = false;
	/// Plugin format string used as a UI label only — `"lv2"`, `"vst3"`,
	/// `"vst2"`, `"au"`, `"ladspa"`, `"lua"`, or `"internal"`. Empty
	/// when `has_native_gui` is false.
	std::string native_gui_kind;
	/// True when the plugin insert exists but the underlying plugin
	/// binary/library could not be loaded (missing, wrong architecture,
	/// unlicensed, etc.). Web UI should show a warning instead of an
	/// empty parameter panel.
	bool        missing = false;
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

/// Midnam patch-name row (one program entry).
struct MidiPatchProgramDesc {
	std::uint8_t  program = 0;   ///< 0..127
	std::string   name;
};

/// Midnam patch bank + its named programs.
struct MidiPatchBankDesc {
	std::uint16_t bank = 0;      ///< Ardour/Midnam bank number
	std::string   name;
	std::vector<MidiPatchProgramDesc> programs;
};

/// Midnam data resolved for one track/channel request.
struct MidiPatchNamesDesc {
	std::string   track_id;
	std::uint8_t  channel = 0;   ///< 0..15
	std::string   model;         ///< InstrumentInfo::model()
	std::string   mode;          ///< InstrumentInfo::mode()
	std::vector<MidiPatchBankDesc> banks;
};

/// Query Ardour's InstrumentInfo/Midnam stack for the given MIDI track.
/// Returns empty banks when the track has no instrument or no Midnam map.
MidiPatchNamesDesc list_midi_patch_names (
	ARDOUR::Session&, const std::string& track_id, std::uint8_t channel);

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

struct AudioSourceSegmentDesc {
	std::string   path;
	std::uint64_t offset_samples = 0;
	std::uint64_t length_samples = 0;
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
	std::int64_t  start_samples   = 0;    ///< position on the timeline (signed; can be negative when the region is dragged before zero)
	std::uint64_t length_samples  = 0;
	std::string   color;                  ///< "#rrggbb" or ""
	bool          muted           = false;
	std::string   source_path;            ///< "" if no file source
	std::uint64_t source_offset_samples = 0;
	bool          has_source_offset = false;
	std::vector<AudioSourceSegmentDesc> source_segments;
	/// Populated for MIDI regions only. Empty for audio.
	std::vector<NoteDesc> notes;
	/// Program/bank change events for MIDI regions only. Empty for
	/// audio.
	std::vector<PatchChangeDesc> patch_changes;
	/// Foyer beat-sequencer layout, read from the region's
	/// `_extra_xml` under the `Foyer/Sequencer` path. `.present`
	/// is false for regions without a layout.
	SequencerLayoutDesc sequencer;
	/// True when this row comes from an `AudioRegion` — emitted gain +
	/// fade lengths for `Region` wire decoding.
	bool          emit_audio_envelope = false;
	double        gain_linear         = 1.0;
	std::uint64_t fade_in_samples     = 0;
	std::uint64_t fade_out_samples    = 0;
	/// Render layer within the owning playlist. Pulled from
	/// `Region::layer()`. We always emit so the FE's `(layer,
	/// source-order)` sort lines up with what Ardour paints.
	std::int64_t  layer               = 0;
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

/// Resolve a Foyer `track.<pbd-id>` to the owning playlist. Returns
/// `nullptr` when the id doesn't map to a track that hosts regions
/// (busses / master), or when no matching route exists. Used by the
/// dispatcher's cross-track move / paste handlers to find the
/// destination playlist before relocating regions.
std::shared_ptr<ARDOUR::Playlist> playlist_for_track_id (
	ARDOUR::Session&, const std::string& track_id);

/// Given a Foyer control id like `track.<pbd>.gain`, find the owning
/// AutomationControl so automation-lane edits can call `alist()`.
std::shared_ptr<PBD::Controllable> resolve_automation_control (ARDOUR::Session&, const std::string& control_id);

/// Recover the track id (`track.<pbd>`) from a control id. Used to
/// re-emit `track_updated` after automation edits.
std::string track_id_for_control (ARDOUR::Session&, const std::string& control_id);

/// Pan range conversion. Ardour's `pan_azimuth_control` uses
/// [0.0, 1.0] (0 = full left, 0.5 = center, 1 = full right) but
/// foyer's wire format and UI sliders use [-1.0, 1.0] (-1 = full
/// left, 0 = center, 1 = full right). Apply these helpers at every
/// shim emit/write site so the wire format is consistent.
inline double pan_ardour_to_wire (double v) { return v * 2.0 - 1.0; }
inline double pan_wire_to_ardour (double v) { return (v + 1.0) * 0.5; }

/// Whether a control id refers to a track pan control. Pan ids
/// match `track.<pbd-id>.pan` and need the [-1, 1] ↔ [0, 1]
/// conversion; nothing else does.
inline bool is_pan_id (const std::string& id) {
    return id.size () >= 4
        && id.compare (id.size () - 4, 4, ".pan") == 0;
}

/// Gain conversion. Ardour's `GainControl::get_value()` /
/// `set_value()` operate on the LINEAR amplitude coefficient
/// (1.0 = unity, 0.5 ≈ -6 dB, 2.0 ≈ +6 dB, 0.0 = silence). The
/// foyer wire format declares track/bus gain as **dB** (see
/// `fader()` in foyer-backend-stub/src/fixtures.rs — `unit: "dB"`,
/// `scale: ScaleCurve::Decibels`, `range: [-60, 6]`), and the web
/// faders read/write dB via `normToDb`/`dbToNorm`.
///
/// Without conversion at the shim, two symptoms reported as bugs:
///   * Defaults look "blown out" — Ardour's unity (1.0 linear)
///     surfaces on the wire as the value 1.0 which the UI labels
///     "1.0 dB" (~+1 dB above unity, visually +6 dB-ish on the
///     log curve).
///   * Attenuation feels broken — the user pulls the fader to
///     "-6 dB", we send -6, the shim writes that as a LINEAR
///     coefficient. Ardour clamps negative coefficients to 0
///     (silence). Anything below 0 dB collapses to mute.
///
/// Apply `gain_ardour_to_wire` at every shim emit site that pulls
/// from `GainControl::get_value()`, and `gain_wire_to_ardour` at
/// every dispatch path that writes to a gain control.
///
/// `kSilenceDb` is the floor we surface for the linear-zero case;
/// must round-trip cleanly (a `dB → linear → dB` round trip with
/// linear=0 would otherwise yield `-inf`, which serializes ugly
/// and breaks numeric comparisons in JS).
inline constexpr double kSilenceDb = -120.0;
inline double gain_ardour_to_wire (double linear) {
    if (linear <= 1e-9) return kSilenceDb;
    return 20.0 * std::log10 (linear);
}
inline double gain_wire_to_ardour (double db) {
    if (db <= kSilenceDb + 1e-3) return 0.0;
    return std::pow (10.0, db / 20.0);
}

/// Whether a control id refers to a track or bus gain control.
/// Track gain matches `track.<pbd-id>.gain`, send level matches
/// `send.<id>.gain` (see ControlSet::SetSendLevel handling). Plugin
/// parameters that happen to end in `.gain` are NOT covered — they
/// have their own per-plugin scaling and shouldn't be touched here.
/// Conservative match: only `track.<x>.gain` and `bus.<x>.gain`
/// triggers conversion.
inline bool is_gain_id (const std::string& id) {
    if (id.size () < 6) return false;
    if (id.compare (id.size () - 5, 5, ".gain") != 0) return false;
    return id.compare (0, 6, "track.") == 0
        || id.compare (0, 4, "bus.") == 0;
}

// ── Scripting bridge to Ardour's Lua VM ─────────────────────────────
//
// The shim caches script records (name, body, type, language, args,
// hook) keyed by id. The wire schema's `id` is exactly the registered
// Lua function name — Ardour's `Session::register_lua_function`
// enforces uniqueness by name and `unregister_lua_function(name)`
// undoes the same. We could allocate a separate slug but routing
// through the function name keeps the shim cache and the Lua VM's
// registration table in 1:1 lock-step.

struct ScriptRecord {
    std::string id;                       // Lua function name == wire id
    std::string name;                     // Display name (may differ from id)
    std::string description;
    std::string script_type;              // "snippet" | "editor_action" | ...
    std::string language;                 // "lua"
    bool        enabled = true;
    std::string body;                     // Lua source
    std::map<std::string, std::string> args;
    std::string hook;                     // empty when type isn't hookable
    bool        disabled_on_upload = false;
    std::uint64_t updated_at_ms = 0;
};

/// Process-wide cache of Foyer-authored scripts. Persists across
/// `register_lua_function` / `unregister_lua_function` calls because
/// Ardour's session-side bookkeeping only stores names; the body /
/// args / metadata Foyer needs to round-trip the UI lives here.
/// Repopulated from `<Script>` XML on session load via the
/// `recover_disabled_scripts` path.
class ScriptStore {
public:
    static ScriptStore& instance ();
    /// Returns a copy so callers can iterate without holding the lock.
    std::vector<ScriptRecord> list () const;
    std::optional<ScriptRecord> get (const std::string& id) const;
    /// Insert-or-update by id. Stamps `updated_at_ms` to the current
    /// wall clock so the FE can sort recent edits to the top.
    void put (ScriptRecord rec);
    /// Returns true when an entry existed.
    bool remove (const std::string& id);
    /// Drop everything — used when the active session changes.
    void clear ();
    /// Replace the whole set in one shot (used by the
    /// `recover_disabled_scripts` path after reading `<Script>` XML).
    void replace_all (std::vector<ScriptRecord> rec);

private:
    ScriptStore () = default;
    mutable std::mutex _m;
    std::map<std::string, ScriptRecord> _by_id;
};

/// Save a script into Ardour's Lua VM AND the shim cache. Returns
/// the canonical post-save record (with `updated_at_ms` stamped).
/// `id` may be empty on create — a deterministic slug is derived
/// from `name` so the cache and Lua registration agree.
///
/// `out_error` (optional, nullable for back-compat) receives the
/// Lua VM / file-write exception message when one fires. The body
/// is STILL cached so the user doesn't lose their work; the error
/// is for callers (e.g. the WS dispatcher) to surface as a typed
/// `Event::Error` so the agent sees "your DSP body has a syntax
/// error on line 12" instead of a silent success.
ScriptRecord save_script (ARDOUR::Session& session, ScriptRecord rec,
                          std::string* out_error = nullptr);

/// Unregister + drop. No-op when the id is unknown.
void delete_script (ARDOUR::Session& session, const std::string& id);

/// Run a registered script. Captures Lua's print() output and any
/// raised error; returns elapsed wall-clock ms. Only meaningful for
/// types whose descriptor sets `runnable = true`.
struct ScriptRunOutcome {
    bool ok = true;
    std::string stdout_text;
    std::string error_text;
    std::uint32_t elapsed_ms = 0;
};
ScriptRunOutcome run_script (
    ARDOUR::Session& session, const std::string& id,
    const std::map<std::string, std::string>& args_override);

/// Scan the session XML for `<Script lua="VERSION">` and decode its
/// base64 payload into individual script records. Records discovered
/// this way are flagged `disabled_on_upload = true`; the user must
/// re-enable each one (after review) before re-registering with Lua.
std::vector<ScriptRecord> recover_disabled_scripts (ARDOUR::Session& session);

} // namespace ArdourSurface::schema_map

#endif
