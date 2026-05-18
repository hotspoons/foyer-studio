// SPDX-License-Identifier: Apache-2.0
//! Track inventory + light edits (rename, color, monitoring).

use async_trait::async_trait;
use foyer_schema::{session::TrackPatch, ControlValue, EntityId};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct TracksTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    List,
    Describe {
        track_id: String,
    },
    /// Batched describe — one call returns full track records for every
    /// id in `track_ids`. Use this instead of N `describe` calls when
    /// the agent is surveying a session (Rich's transcript showed an
    /// agent firing 8 sequential `tracks.describe` calls). Unknown ids
    /// surface as entries with `error: "..."` so the agent can fix the
    /// reference without the whole batch failing.
    DescribeMany {
        track_ids: Vec<String>,
    },
    /// Create a new track. `kind` is one of "audio" | "midi" | "bus"
    /// (master and monitor are auto-created at session boot and can't
    /// be added by the agent). Optional plugin wiring lands in the
    /// same undo group as the track:
    /// - `copy_from_track_id`: clone another track's full plugin chain
    ///   (URIs + params + preset). Use for "another track like X".
    /// - `plugins`: explicit list of URIs to insert in order.
    /// - `instrument_uri`: single-plugin shorthand (typically a synth
    ///   for a MIDI track). The agent should usually PROMPT the user
    ///   ("which synth?") before picking one — see midi-track-setup
    ///   skill. Only the highest-precedence field is honoured
    ///   (copy_from > plugins > instrument_uri).
    Create {
        name: String,
        kind: String,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        after_id: Option<String>,
        #[serde(default)]
        instrument_uri: Option<String>,
        #[serde(default)]
        plugins: Vec<String>,
        #[serde(default)]
        copy_from_track_id: Option<String>,
    },
    /// Patch metadata on an existing track: name, color, group
    /// membership, bus assignment, monitoring mode, input port.
    /// Omitted fields are left alone. Kind cannot be changed — recreate
    /// the track if the user wants a different kind.
    Update {
        track_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<String>,
        /// Assign the track to a group. Pass `""` to unassign.
        #[serde(default)]
        group_id: Option<String>,
        /// Route the track's main output to a bus track. Pass `""` to
        /// reset back to master.
        #[serde(default)]
        bus_assign: Option<String>,
        /// One of "auto" | "input" | "disk" | "cue".
        #[serde(default)]
        monitoring: Option<String>,
        #[serde(default)]
        input_port: Option<String>,
    },
    /// Remove a track from the session. Destructive — confirm with the
    /// user before calling this on tracks holding the user's takes.
    Delete {
        track_id: String,
    },
    /// Reorder tracks. The list MUST contain every existing track id
    /// exactly once; the new ordering takes effect atomically. Use
    /// `list` first to learn the current ids.
    Reorder {
        ordered_track_ids: Vec<String>,
    },
    /// Configure MIDI channel filtering on a MIDI track. `direction`
    /// is `"capture"` or `"playback"`; `mode` is `"all"` | `"filter"`
    /// | `"force"`; `mask` is a 16-bit channel bitmask (bit 0 = ch 1).
    /// Used when the user says "only listen to drum channel" or
    /// "force all output to channel 9" (for GM drums on gmsynth).
    SetMidiChannelMode {
        track_id: String,
        direction: String,
        mode: String,
        mask: u16,
    },
    /// Toggle record-arm on a track. Required step before recording —
    /// the transport's global `record(armed=true)` only writes to
    /// tracks that are themselves armed. Buses + master have no
    /// record_arm and will return an error. Pair with
    /// `tracks.update(input_port=…)` to choose the source and
    /// `tracks.update(monitoring="input")` if the user wants live
    /// monitoring while tracking.
    SetArm {
        track_id: String,
        armed: bool,
    },
    /// Arm a track to receive browser-sourced audio — the server-side
    /// half of what the "I" / Take chip in the UI runs. Sets the
    /// track→browser-source claim and forces `monitoring=off` (the
    /// 100–300 ms browser round trip is audible as slap-back if a
    /// user hears it live). After this call, the actual mic capture
    /// still has to happen browser-side: a connected user clicks the
    /// Take chip on their tab and the mic stream is auto-routed. With
    /// no browser connected the track sits armed and ready.
    /// `peer_id` (optional): bind to a specific peer; omit to leave
    /// open ("first browser to claim wins").
    ArmForBrowserAudio {
        track_id: String,
        #[serde(default)]
        peer_id: Option<String>,
    },
    /// Release a previous browser-audio claim — strips the source-user
    /// binding and any pending track→ingress mapping. Doesn't re-enable
    /// monitoring (use `tracks.update(monitoring="auto")` if desired).
    ReleaseBrowserAudio {
        track_id: String,
    },
}

#[async_trait]
impl Tool for TracksTool {
    fn name(&self) -> &'static str {
        "tracks"
    }

    fn description(&self) -> &'static str {
        "Inspect, create, AND edit tracks in the current session. \
         Subcommands: \
         list (id/name/kind/solo/mute/gain_db for every track + \
         `any_soloed`), \
         describe(track_id) (full record + plugin chain + \
         `instrument_summary`: instrument name+URI, active GM patches, \
         drum-channel hint — ALWAYS read this on MIDI tracks before \
         writing notes / cells), \
         describe_many(track_ids:[…]) — batched in one round-trip, \
         create(name, kind, color?, after_id?, \
         instrument_uri? OR plugins?[] OR copy_from_track_id?) — kind \
         is 'audio' | 'midi' | 'bus' (master + monitor are immutable). \
         The plugin-wiring fields are atomic with the create (one \
         undo unwinds everything). For MIDI tracks PROMPT THE USER \
         which instrument unless they said 'synth' generically (then \
         default to Ardour's built-in gmsynth); the choice changes \
         the sound dramatically. Use `copy_from_track_id` when the \
         user asks for 'another track like X'. \
         update(track_id, name?, color?, group_id?, bus_assign?, \
         monitoring?, input_port?) — pass `\"\"` to unassign a group / \
         restore master, \
         delete(track_id), \
         reorder(ordered_track_ids:[…]) — must list every existing id, \
         set_midi_channel_mode(track_id, direction, mode, mask) for \
         per-track MIDI channel filtering (Direction='capture'|'playback', \
         Mode='all'|'filter'|'force'), \
         set_arm(track_id, armed) — toggle record-arm on an audio/MIDI \
         track. Required before recording. Pair with \
         `io.list_ports` → `update(input_port)` to pick the source and \
         `transport.record(armed=true)` to actually start tracking, \
         arm_for_browser_audio(track_id, peer_id?) — server-side half of \
         the UI's \"I\" / Take chip. Marks the track as browser-fed and \
         forces monitoring=off (browser round-trip would be audible). \
         A connected browser tab still has to fulfil the actual mic \
         capture — getUserMedia needs a user gesture. \
         release_browser_audio(track_id) — clear the browser-fed claim."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string",
                    "enum": ["list", "describe", "describe_many",
                             "create", "update", "delete", "reorder",
                             "set_midi_channel_mode", "set_arm",
                             "arm_for_browser_audio", "release_browser_audio"] },
                "kind": { "type": "string", "enum": ["audio", "midi", "bus"] },
                "after_id": { "type": "string" },
                "instrument_uri": { "type": "string",
                    "description": "Single-plugin shorthand. PROMPT the user before defaulting this — the synth choice dramatically changes the sound." },
                "plugins": { "type": "array", "items": { "type": "string" },
                    "description": "Plugin URIs to insert in order on the new track." },
                "copy_from_track_id": { "type": "string",
                    "description": "Clone another track's plugin chain (URIs + params + preset)." },
                "track_id":          { "type": "string" },
                "track_ids":         { "type": "array", "items": { "type": "string" } },
                "ordered_track_ids": { "type": "array", "items": { "type": "string" } },
                "name":              { "type": "string" },
                "color":             { "type": "string" },
                "group_id":          { "type": "string" },
                "bus_assign":        { "type": "string" },
                "monitoring":        { "type": "string",
                    "enum": ["auto", "input", "disk", "cue"] },
                "input_port":        { "type": "string" },
                "direction":         { "type": "string",
                    "enum": ["capture", "playback"] },
                "mode":              { "type": "string",
                    "enum": ["all", "filter", "force"] },
                "mask":              { "type": "integer", "minimum": 0, "maximum": 65535 },
                "armed":             { "type": "boolean",
                    "description": "set_arm: true to arm the track for recording, false to disarm." },
                "peer_id":           { "type": "string",
                    "description": "arm_for_browser_audio: peer id to bind. Omit to leave the claim open." }
            }
        })
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let backend = ctx.backend()?;
        let snap = backend
            .snapshot()
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        match op {
            Op::List => {
                // Include muted/soloed/gain_db so the agent can honour
                // the "respect solo state" rule from the system prompt
                // without round-tripping through mixer.get per track.
                let any_soloed = snap
                    .tracks
                    .iter()
                    .any(|t| matches!(t.solo.value, ControlValue::Bool(true)));
                let summary: Vec<Value> = snap
                    .tracks
                    .iter()
                    .map(|t| {
                        let linear = t.gain.value.as_f64().unwrap_or(1.0);
                        let gain_db = if linear > 1.0e-6 {
                            20.0 * linear.log10()
                        } else {
                            -120.0
                        };
                        let muted = matches!(t.mute.value, ControlValue::Bool(true));
                        let soloed = matches!(t.solo.value, ControlValue::Bool(true));
                        json!({
                            "id": t.id.as_str(),
                            "name": t.name,
                            "kind": format!("{:?}", t.kind),
                            "plugin_count": t.plugins.len(),
                            "group_id": t.group_id.as_ref().map(|g| g.as_str().to_string()),
                            "muted": muted,
                            "soloed": soloed,
                            "gain_db": (gain_db * 100.0).round() / 100.0,
                        })
                    })
                    .collect();
                Ok(ToolResult::ok(format!(
                    "{} tracks{}",
                    summary.len(),
                    if any_soloed { " (solo active)" } else { "" }
                ))
                .with_data(json!({ "tracks": summary, "any_soloed": any_soloed })))
            }
            Op::Describe { track_id } => {
                let t = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| ToolError::InvalidArgs(format!("unknown track: {track_id}")))?;
                let mut data =
                    serde_json::to_value(t).map_err(|e| ToolError::Execution(e.to_string()))?;
                let summary = instrument_summary(t);
                if let Some(obj) = data.as_object_mut() {
                    obj.insert("instrument_summary".into(), summary.clone());
                }
                let line = format!(
                    "track {} \u{2014} {}",
                    t.name,
                    summary
                        .get("one_line")
                        .and_then(|v| v.as_str())
                        .unwrap_or("no instrument context")
                );
                Ok(ToolResult::ok(line).with_data(data))
            }
            Op::DescribeMany { track_ids } => {
                let mut out = Vec::with_capacity(track_ids.len());
                let mut hits = 0;
                for id in &track_ids {
                    if let Some(t) = snap.tracks.iter().find(|t| t.id.as_str() == id) {
                        let mut v = serde_json::to_value(t)
                            .map_err(|e| ToolError::Execution(e.to_string()))?;
                        let summary = instrument_summary(t);
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("instrument_summary".into(), summary);
                        }
                        out.push(json!({ "track_id": id, "track": v }));
                        hits += 1;
                    } else {
                        out.push(json!({ "track_id": id, "error": "unknown track id" }));
                    }
                }
                Ok(
                    ToolResult::ok(format!("{hits}/{} tracks described", track_ids.len()))
                        .with_data(json!({ "tracks": out })),
                )
            }
            Op::Create {
                name,
                kind,
                color,
                after_id,
                instrument_uri,
                plugins,
                copy_from_track_id,
            } => {
                let kind = match kind.as_str() {
                    "audio" => foyer_schema::TrackKind::Audio,
                    "midi" => foyer_schema::TrackKind::Midi,
                    "bus" => foyer_schema::TrackKind::Bus,
                    other => {
                        return Err(ToolError::InvalidArgs(format!(
                            "kind must be 'audio' | 'midi' | 'bus', got '{other}'"
                        )));
                    }
                };
                let plugin_count = plugins.len();
                let copy_from = copy_from_track_id.clone();
                let track = backend
                    .create_track_full(
                        name,
                        kind,
                        color,
                        after_id.map(EntityId::new),
                        instrument_uri.clone(),
                        plugins,
                        copy_from.map(EntityId::new),
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let setup_note = if let Some(src) = copy_from_track_id {
                    format!(", plugin chain cloned from {src}")
                } else if plugin_count > 0 {
                    format!(", {plugin_count} plugin(s) inserted")
                } else if let Some(uri) = instrument_uri.as_ref() {
                    format!(", instrument '{uri}' inserted")
                } else {
                    String::new()
                };
                Ok(ToolResult::ok(format!(
                    "created {:?} track '{}' (id: {}){setup_note}",
                    track.kind, track.name, track.id
                ))
                .with_data(
                    serde_json::to_value(track).map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::Update {
                track_id,
                name,
                color,
                group_id,
                bus_assign,
                monitoring,
                input_port,
            } => {
                let patch = TrackPatch {
                    name,
                    color,
                    group_id: group_id.map(EntityId::new),
                    bus_assign: bus_assign.map(EntityId::new),
                    monitoring,
                    input_port,
                };
                let updated = backend
                    .update_track(EntityId::new(track_id.clone()), patch)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(
                    ToolResult::ok(format!("updated track {} ({})", updated.name, track_id))
                        .with_data(
                            serde_json::to_value(updated)
                                .map_err(|e| ToolError::Execution(e.to_string()))?,
                        ),
                )
            }
            Op::Delete { track_id } => {
                backend
                    .delete_track(EntityId::new(track_id.clone()))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("deleted track {track_id}")))
            }
            Op::Reorder { ordered_track_ids } => {
                let ids: Vec<EntityId> = ordered_track_ids.into_iter().map(EntityId::new).collect();
                let count = ids.len();
                backend
                    .reorder_tracks(ids)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!("reordered {count} track(s)")))
            }
            Op::SetMidiChannelMode {
                track_id,
                direction,
                mode,
                mask,
            } => {
                let t = backend
                    .set_track_midi_channel_mode(
                        EntityId::new(track_id.clone()),
                        direction.clone(),
                        mode.clone(),
                        mask,
                    )
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} {direction} channels: {mode} (mask 0x{:04x})",
                    t.name, mask
                ))
                .with_data(
                    serde_json::to_value(t).map_err(|e| ToolError::Execution(e.to_string()))?,
                ))
            }
            Op::SetArm { track_id, armed } => {
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let track = snap
                    .tracks
                    .iter()
                    .find(|t| t.id.as_str() == track_id)
                    .ok_or_else(|| {
                        ToolError::InvalidArgs(format!("unknown track_id: {track_id}"))
                    })?;
                let rec_param = track.record_arm.as_ref().ok_or_else(|| {
                    ToolError::InvalidArgs(format!(
                        "track {} ({track_id}) has no record_arm — buses and master/monitor \
                         can't be armed",
                        track.name
                    ))
                })?;
                backend
                    .set_control(rec_param.id.clone(), ControlValue::Bool(armed))
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "track {} ({track_id}) {}",
                    track.name,
                    if armed { "armed" } else { "disarmed" }
                ))
                .with_data(json!({
                    "track_id": track_id,
                    "armed": armed,
                })))
            }
            Op::ArmForBrowserAudio { track_id, peer_id } => {
                // Route through the SessionDirector so we hit the same
                // server-state path the WS `Command::SetTrackBrowserSource`
                // handler uses (records the claim, forces monitoring=off,
                // emits the TrackBrowserSourceChanged event). Browser-side
                // mic capture still needs a user gesture; this just preps
                // the slot.
                let director = ctx.session_director.as_ref().ok_or_else(|| {
                    ToolError::Execution(
                        "arm_for_browser_audio needs a session director — not available in this \
                         dispatch context"
                            .into(),
                    )
                })?;
                let outcome = director
                    .arm_track_for_browser_audio(&track_id, peer_id.as_deref())
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let next_step = if outcome.connected_peer_count == 0 {
                    "no browser tabs connected — open Foyer in a browser and click Take on this track"
                        .to_string()
                } else if outcome.peer_id.is_empty() {
                    format!(
                        "{} browser tab(s) connected — ask the user to click Take on this track",
                        outcome.connected_peer_count
                    )
                } else {
                    format!(
                        "bound to peer {} — they should click Take to feed mic audio",
                        outcome.peer_id
                    )
                };
                Ok(ToolResult::ok(format!(
                    "track {track_id} armed for browser audio · {next_step}"
                ))
                .with_data(json!({
                    "track_id": outcome.track_id,
                    "peer_id": outcome.peer_id,
                    "connected_peer_count": outcome.connected_peer_count,
                    "next_step": next_step,
                })))
            }
            Op::ReleaseBrowserAudio { track_id } => {
                let director = ctx.session_director.as_ref().ok_or_else(|| {
                    ToolError::Execution(
                        "release_browser_audio needs a session director — not available in this \
                         dispatch context"
                            .into(),
                    )
                })?;
                director
                    .release_track_browser_audio(&track_id)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok(ToolResult::ok(format!(
                    "browser-audio claim released on track {track_id}"
                )))
            }
        }
    }
}

/// Synthesize a small "what plays through this track" summary that
/// surfaces:
///   - the first plugin's name + URI (the instrument, for MIDI tracks)
///   - the per-channel patch table (GM program names where possible)
///   - whether the GM drum channel (9) has a non-zero program
///
/// This surfaces context the LLM otherwise has to infer by walking
/// `plugins[*]` + `midi_patches[*]` by hand — a real failure mode
/// (Rich's drum pattern landed on piano because gmsynth's region
/// routed through channel 0 / program 0).
fn instrument_summary(t: &foyer_schema::Track) -> Value {
    let instrument = t.plugins.first().map(|p| {
        json!({
            "name": p.name,
            "uri": p.uri,
            "id": p.id.as_str(),
        })
    });
    let active_patches: Vec<Value> = t
        .midi_patches
        .iter()
        .filter(|p| p.program != 0 || p.bank != 0 || p.channel == 9)
        .map(|p| {
            json!({
                "channel": p.channel,
                "bank": p.bank,
                "program": p.program,
                "gm_program_name": gm_program_name(p.program),
                "is_gm_drum_channel": p.channel == 9,
            })
        })
        .collect();
    let one_line = match &instrument {
        Some(inst) => {
            let name = inst.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            if active_patches.is_empty() {
                format!("{name} (default patch \u{2014} channel 0, program 0)")
            } else {
                format!("{name} ({} channel patch(es) set)", active_patches.len())
            }
        }
        None if matches!(t.kind, foyer_schema::TrackKind::Midi) => {
            "MIDI track with NO instrument plugin — will be silent until one is inserted".into()
        }
        None => "audio track".into(),
    };
    json!({
        "one_line": one_line,
        "instrument": instrument,
        "active_patches": active_patches,
    })
}

/// Best-effort General MIDI program → human label. Returns `None`
/// for non-GM-recognised programs (e.g. a custom SoundFont's
/// program 17). The label is informational only; the canonical
/// numeric program / bank lives in `active_patches`.
fn gm_program_name(p: u8) -> Option<&'static str> {
    const NAMES: &[&str] = &[
        "Acoustic Grand Piano",
        "Bright Acoustic Piano",
        "Electric Grand Piano",
        "Honky-Tonk Piano",
        "Electric Piano 1",
        "Electric Piano 2",
        "Harpsichord",
        "Clavinet",
        "Celesta",
        "Glockenspiel",
        "Music Box",
        "Vibraphone",
        "Marimba",
        "Xylophone",
        "Tubular Bells",
        "Dulcimer",
        "Drawbar Organ",
        "Percussive Organ",
        "Rock Organ",
        "Church Organ",
        "Reed Organ",
        "Accordion",
        "Harmonica",
        "Tango Accordion",
        "Acoustic Guitar (nylon)",
        "Acoustic Guitar (steel)",
        "Electric Guitar (jazz)",
        "Electric Guitar (clean)",
        "Electric Guitar (muted)",
        "Overdriven Guitar",
        "Distortion Guitar",
        "Guitar Harmonics",
        "Acoustic Bass",
        "Electric Bass (finger)",
        "Electric Bass (pick)",
        "Fretless Bass",
        "Slap Bass 1",
        "Slap Bass 2",
        "Synth Bass 1",
        "Synth Bass 2",
        "Violin",
        "Viola",
        "Cello",
        "Contrabass",
        "Tremolo Strings",
        "Pizzicato Strings",
        "Orchestral Harp",
        "Timpani",
        "String Ensemble 1",
        "String Ensemble 2",
        "Synth Strings 1",
        "Synth Strings 2",
        "Choir Aahs",
        "Voice Oohs",
        "Synth Voice",
        "Orchestra Hit",
        "Trumpet",
        "Trombone",
        "Tuba",
        "Muted Trumpet",
        "French Horn",
        "Brass Section",
        "Synth Brass 1",
        "Synth Brass 2",
        "Soprano Sax",
        "Alto Sax",
        "Tenor Sax",
        "Baritone Sax",
        "Oboe",
        "English Horn",
        "Bassoon",
        "Clarinet",
        "Piccolo",
        "Flute",
        "Recorder",
        "Pan Flute",
        "Blown Bottle",
        "Shakuhachi",
        "Whistle",
        "Ocarina",
        "Lead 1 (square)",
        "Lead 2 (sawtooth)",
        "Lead 3 (calliope)",
        "Lead 4 (chiff)",
        "Lead 5 (charang)",
        "Lead 6 (voice)",
        "Lead 7 (fifths)",
        "Lead 8 (bass + lead)",
        "Pad 1 (new age)",
        "Pad 2 (warm)",
        "Pad 3 (polysynth)",
        "Pad 4 (choir)",
        "Pad 5 (bowed)",
        "Pad 6 (metallic)",
        "Pad 7 (halo)",
        "Pad 8 (sweep)",
        "FX 1 (rain)",
        "FX 2 (soundtrack)",
        "FX 3 (crystal)",
        "FX 4 (atmosphere)",
        "FX 5 (brightness)",
        "FX 6 (goblins)",
        "FX 7 (echoes)",
        "FX 8 (sci-fi)",
        "Sitar",
        "Banjo",
        "Shamisen",
        "Koto",
        "Kalimba",
        "Bagpipe",
        "Fiddle",
        "Shanai",
        "Tinkle Bell",
        "Agogo",
        "Steel Drums",
        "Woodblock",
        "Taiko Drum",
        "Melodic Tom",
        "Synth Drum",
        "Reverse Cymbal",
        "Guitar Fret Noise",
        "Breath Noise",
        "Seashore",
        "Bird Tweet",
        "Telephone Ring",
        "Helicopter",
        "Applause",
        "Gunshot",
    ];
    NAMES.get(p as usize).copied()
}
