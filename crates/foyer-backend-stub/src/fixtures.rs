//! Canned fixture data so the stub session looks like a small real project.
//!
//! Plugin params are modeled after realistic LV2/VST3 shapes so the generic
//! parameter UI on the web side has meaningful ranges, scales, units, enum
//! choices, and groupings to render. The data is deliberately a tiny subset of
//! what a real plugin exposes — just enough to make the plugin panel look
//! plausibly alive in demo mode.

use foyer_schema::{
    ControlKind, ControlValue, EntityId, Parameter, PluginInstance, ScaleCurve, Session, Track,
    TrackKind, Transport, SCHEMA_VERSION,
};

pub(crate) fn fader(id: &str, db: f64) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Continuous,
        label: "Gain".into(),
        range: Some([-60.0, 6.0]),
        scale: ScaleCurve::Decibels,
        unit: Some("dB".into()),
        enum_labels: vec![],
        group: None,
        value: ControlValue::Float(db),
    }
}

pub(crate) fn pan(id: &str) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Continuous,
        label: "Pan".into(),
        range: Some([-1.0, 1.0]),
        scale: ScaleCurve::Linear,
        unit: None,
        enum_labels: vec![],
        group: None,
        value: ControlValue::Float(0.0),
    }
}

pub(crate) fn toggle(id: &str, label: &str) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Trigger,
        label: label.into(),
        range: None,
        scale: ScaleCurve::Linear,
        unit: None,
        enum_labels: vec![],
        group: None,
        value: ControlValue::Bool(false),
    }
}

pub(crate) fn meter(id: &str) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Meter,
        label: "Peak".into(),
        range: Some([-80.0, 6.0]),
        scale: ScaleCurve::Decibels,
        unit: Some("dB".into()),
        enum_labels: vec![],
        group: None,
        value: ControlValue::Float(-60.0),
    }
}

pub(crate) fn track(slug: &str, name: &str, kind: TrackKind, color: Option<&str>) -> Track {
    Track {
        id: EntityId::new(format!("track.{slug}")),
        name: name.into(),
        kind,
        color: color.map(str::to_string),
        gain: fader(&format!("track.{slug}.gain"), 0.0),
        pan: pan(&format!("track.{slug}.pan")),
        mute: toggle(&format!("track.{slug}.mute"), "Mute"),
        solo: toggle(&format!("track.{slug}.solo"), "Solo"),
        record_arm: Some(toggle(&format!("track.{slug}.rec"), "Rec")),
        sends: vec![],
        plugins: default_inserts_for(slug),
        peak_meter: Some(EntityId::new(format!("track.{slug}.meter"))),
    }
}

// ── plugin parameter templates ────────────────────────────────────────────

fn p_continuous(
    id: &str,
    label: &str,
    range: [f64; 2],
    scale: ScaleCurve,
    unit: Option<&str>,
    group: Option<&str>,
    v: f64,
) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Continuous,
        label: label.into(),
        range: Some(range),
        scale,
        unit: unit.map(str::to_string),
        enum_labels: vec![],
        group: group.map(str::to_string),
        value: ControlValue::Float(v),
    }
}

fn p_enum(
    id: &str,
    label: &str,
    choices: &[&str],
    group: Option<&str>,
    selected: i64,
) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Enum,
        label: label.into(),
        range: None,
        scale: ScaleCurve::Linear,
        unit: None,
        enum_labels: choices.iter().map(|s| s.to_string()).collect(),
        group: group.map(str::to_string),
        value: ControlValue::Int(selected),
    }
}

fn p_toggle(id: &str, label: &str, group: Option<&str>, on: bool) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Trigger,
        label: label.into(),
        range: None,
        scale: ScaleCurve::Linear,
        unit: None,
        enum_labels: vec![],
        group: group.map(str::to_string),
        value: ControlValue::Bool(on),
    }
}

/// Every plugin instance exposes a `bypass` parameter as the first entry in
/// `params`. The stub keeps this in sync with the denormalized
/// `PluginInstance.bypassed` bool on `set_control`.
fn bypass_param(pid: &str, on: bool) -> Parameter {
    p_toggle(&format!("{pid}.bypass"), "Bypass", Some("Header"), on)
}

fn eq_params(pid: &str) -> Vec<Parameter> {
    // Three-band parametric with a lowcut.
    let mut v = vec![bypass_param(pid, false)];
    v.push(p_toggle(
        &format!("{pid}.lowcut.on"),
        "LowCut",
        Some("Low Cut"),
        true,
    ));
    v.push(p_continuous(
        &format!("{pid}.lowcut.freq"),
        "Freq",
        [20.0, 500.0],
        ScaleCurve::Hertz,
        Some("Hz"),
        Some("Low Cut"),
        80.0,
    ));
    for (i, (f_default, g)) in [(120.0, 1.0), (800.0, -1.5), (6000.0, 2.0)]
        .iter()
        .enumerate()
    {
        let band = format!("Band {}", i + 1);
        v.push(p_continuous(
            &format!("{pid}.band{}.freq", i + 1),
            "Freq",
            [20.0, 20_000.0],
            ScaleCurve::Hertz,
            Some("Hz"),
            Some(&band),
            *f_default,
        ));
        v.push(p_continuous(
            &format!("{pid}.band{}.gain", i + 1),
            "Gain",
            [-18.0, 18.0],
            ScaleCurve::Linear,
            Some("dB"),
            Some(&band),
            *g,
        ));
        v.push(p_continuous(
            &format!("{pid}.band{}.q", i + 1),
            "Q",
            [0.1, 10.0],
            ScaleCurve::Logarithmic,
            None,
            Some(&band),
            0.9,
        ));
    }
    v.push(p_continuous(
        &format!("{pid}.output"),
        "Out",
        [-24.0, 24.0],
        ScaleCurve::Decibels,
        Some("dB"),
        Some("Output"),
        0.0,
    ));
    v
}

fn comp_params(pid: &str) -> Vec<Parameter> {
    vec![
        bypass_param(pid, false),
        p_continuous(
            &format!("{pid}.threshold"),
            "Threshold",
            [-60.0, 0.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Dynamics"),
            -18.0,
        ),
        p_continuous(
            &format!("{pid}.ratio"),
            "Ratio",
            [1.0, 20.0],
            ScaleCurve::Logarithmic,
            Some(":1"),
            Some("Dynamics"),
            4.0,
        ),
        p_continuous(
            &format!("{pid}.knee"),
            "Knee",
            [0.0, 18.0],
            ScaleCurve::Linear,
            Some("dB"),
            Some("Dynamics"),
            6.0,
        ),
        p_continuous(
            &format!("{pid}.attack"),
            "Attack",
            [0.05, 100.0],
            ScaleCurve::Logarithmic,
            Some("ms"),
            Some("Envelope"),
            5.0,
        ),
        p_continuous(
            &format!("{pid}.release"),
            "Release",
            [5.0, 2000.0],
            ScaleCurve::Logarithmic,
            Some("ms"),
            Some("Envelope"),
            120.0,
        ),
        p_continuous(
            &format!("{pid}.makeup"),
            "Makeup",
            [-12.0, 24.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Output"),
            0.0,
        ),
        p_enum(
            &format!("{pid}.detection"),
            "Mode",
            &["Peak", "RMS", "Auto"],
            Some("Detection"),
            1,
        ),
        p_toggle(
            &format!("{pid}.sc.hpf"),
            "SC HPF",
            Some("Sidechain"),
            false,
        ),
    ]
}

fn deesser_params(pid: &str) -> Vec<Parameter> {
    vec![
        bypass_param(pid, false),
        p_continuous(
            &format!("{pid}.freq"),
            "Freq",
            [2000.0, 12000.0],
            ScaleCurve::Hertz,
            Some("Hz"),
            Some("Detection"),
            6500.0,
        ),
        p_continuous(
            &format!("{pid}.threshold"),
            "Threshold",
            [-40.0, 0.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Detection"),
            -22.0,
        ),
        p_continuous(
            &format!("{pid}.range"),
            "Range",
            [0.0, 18.0],
            ScaleCurve::Linear,
            Some("dB"),
            Some("Reduction"),
            6.0,
        ),
        p_enum(
            &format!("{pid}.mode"),
            "Mode",
            &["Wideband", "Split"],
            Some("Mode"),
            0,
        ),
    ]
}

fn reverb_params(pid: &str) -> Vec<Parameter> {
    vec![
        bypass_param(pid, false),
        p_continuous(
            &format!("{pid}.predelay"),
            "PreDelay",
            [0.0, 200.0],
            ScaleCurve::Linear,
            Some("ms"),
            Some("Time"),
            12.0,
        ),
        p_continuous(
            &format!("{pid}.size"),
            "Size",
            [0.0, 1.0],
            ScaleCurve::Linear,
            None,
            Some("Time"),
            0.55,
        ),
        p_continuous(
            &format!("{pid}.decay"),
            "Decay",
            [0.1, 12.0],
            ScaleCurve::Logarithmic,
            Some("s"),
            Some("Time"),
            2.4,
        ),
        p_continuous(
            &format!("{pid}.damping"),
            "Damping",
            [0.0, 1.0],
            ScaleCurve::Linear,
            None,
            Some("Tone"),
            0.4,
        ),
        p_continuous(
            &format!("{pid}.lowcut"),
            "LoCut",
            [20.0, 1000.0],
            ScaleCurve::Hertz,
            Some("Hz"),
            Some("Tone"),
            120.0,
        ),
        p_continuous(
            &format!("{pid}.hicut"),
            "HiCut",
            [1000.0, 20000.0],
            ScaleCurve::Hertz,
            Some("Hz"),
            Some("Tone"),
            9000.0,
        ),
        p_continuous(
            &format!("{pid}.mix"),
            "Dry/Wet",
            [0.0, 1.0],
            ScaleCurve::Linear,
            None,
            Some("Mix"),
            0.25,
        ),
        p_enum(
            &format!("{pid}.algo"),
            "Algorithm",
            &["Hall", "Room", "Plate", "Spring"],
            Some("Mode"),
            0,
        ),
    ]
}

fn limiter_params(pid: &str) -> Vec<Parameter> {
    vec![
        bypass_param(pid, false),
        p_continuous(
            &format!("{pid}.ceiling"),
            "Ceiling",
            [-6.0, 0.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Output"),
            -0.3,
        ),
        p_continuous(
            &format!("{pid}.release"),
            "Release",
            [1.0, 1000.0],
            ScaleCurve::Logarithmic,
            Some("ms"),
            Some("Envelope"),
            120.0,
        ),
        p_continuous(
            &format!("{pid}.gain"),
            "In Gain",
            [-24.0, 24.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Input"),
            0.0,
        ),
        p_enum(
            &format!("{pid}.mode"),
            "Mode",
            &["Transparent", "Loud", "Smooth"],
            Some("Mode"),
            0,
        ),
        p_toggle(
            &format!("{pid}.iso.link"),
            "Stereo Link",
            Some("Mode"),
            true,
        ),
    ]
}

fn generic_fx_params(pid: &str) -> Vec<Parameter> {
    vec![
        bypass_param(pid, false),
        p_continuous(
            &format!("{pid}.drive"),
            "Drive",
            [0.0, 1.0],
            ScaleCurve::Linear,
            None,
            Some("Tone"),
            0.3,
        ),
        p_continuous(
            &format!("{pid}.mix"),
            "Mix",
            [0.0, 1.0],
            ScaleCurve::Linear,
            None,
            Some("Mix"),
            0.5,
        ),
        p_continuous(
            &format!("{pid}.output"),
            "Output",
            [-24.0, 24.0],
            ScaleCurve::Decibels,
            Some("dB"),
            Some("Output"),
            0.0,
        ),
    ]
}

fn params_for(uri: &str, pid: &str) -> Vec<Parameter> {
    match uri {
        "lv2:eq" | "lv2:nova" => eq_params(pid),
        "lv2:comp" | "lv2:kotelnikov" => comp_params(pid),
        "lv2:de-esser" => deesser_params(pid),
        "lv2:reverb" => reverb_params(pid),
        "lv2:limiter" => limiter_params(pid),
        _ => generic_fx_params(pid),
    }
}

pub(crate) fn default_inserts_for(slug: &str) -> Vec<PluginInstance> {
    let insert = |pid: &str, name: &str, uri: &str| {
        let full = format!("plugin.{slug}.{pid}");
        PluginInstance {
            id: EntityId::new(full.clone()),
            name: name.into(),
            uri: Some(uri.into()),
            bypassed: false,
            params: params_for(uri, &full),
        }
    };
    match slug {
        "kick" => vec![
            insert("eq", "x42 EQ", "lv2:eq"),
            insert("comp", "x42 Compressor", "lv2:comp"),
        ],
        "snare" => vec![
            insert("eq", "x42 EQ", "lv2:eq"),
            insert("comp", "x42 Compressor", "lv2:comp"),
            insert("rev", "Calf Reverb", "lv2:reverb"),
        ],
        "bass" => vec![
            insert("eq", "x42 EQ", "lv2:eq"),
            insert("comp", "x42 Compressor", "lv2:comp"),
        ],
        "vox" => vec![
            insert("eq", "x42 EQ", "lv2:eq"),
            insert("de_ess", "x42 De-esser", "lv2:de-esser"),
            insert("comp", "TDR Kotelnikov", "lv2:kotelnikov"),
        ],
        "reverb_bus" => vec![insert("rev", "Calf Reverb", "lv2:reverb")],
        "master" => vec![
            insert("eq", "TDR Nova", "lv2:nova"),
            insert("lim", "TDR Limiter", "lv2:limiter"),
        ],
        _ => vec![],
    }
}

pub(crate) fn initial_session() -> Session {
    Session {
        schema_version: SCHEMA_VERSION,
        transport: Transport {
            playing: toggle("transport.playing", "Play"),
            recording: toggle("transport.recording", "Record"),
            looping: toggle("transport.looping", "Loop"),
            tempo: Parameter {
                id: EntityId::new("transport.tempo"),
                kind: ControlKind::Continuous,
                label: "Tempo".into(),
                range: Some([20.0, 300.0]),
                scale: ScaleCurve::Linear,
                unit: Some("BPM".into()),
                enum_labels: vec![],
                group: None,
                value: ControlValue::Float(120.0),
            },
            time_signature_num: Parameter {
                id: EntityId::new("transport.ts.num"),
                kind: ControlKind::Discrete,
                label: "TS Num".into(),
                range: Some([1.0, 32.0]),
                scale: ScaleCurve::Linear,
                unit: None,
                enum_labels: vec![],
                group: None,
                value: ControlValue::Int(4),
            },
            time_signature_den: Parameter {
                id: EntityId::new("transport.ts.den"),
                kind: ControlKind::Discrete,
                label: "TS Den".into(),
                range: Some([1.0, 32.0]),
                scale: ScaleCurve::Linear,
                unit: None,
                enum_labels: vec![],
                group: None,
                value: ControlValue::Int(4),
            },
            position_beats: Parameter {
                id: EntityId::new("transport.position"),
                kind: ControlKind::Meter,
                label: "Position".into(),
                range: None,
                scale: ScaleCurve::Linear,
                unit: Some("beats".into()),
                enum_labels: vec![],
                group: None,
                value: ControlValue::Float(0.0),
            },
        },
        tracks: vec![
            track("kick", "Kick", TrackKind::Audio, Some("#c04040")),
            track("snare", "Snare", TrackKind::Audio, Some("#c08040")),
            track("bass", "Bass", TrackKind::Audio, Some("#40c080")),
            track("vox", "Vox", TrackKind::Audio, Some("#4080c0")),
            track("reverb_bus", "Reverb", TrackKind::Bus, Some("#808080")),
            track("master", "Master", TrackKind::Master, None),
        ],
        meta: serde_json::json!({ "project": "demo", "sample_rate": 48000 }),
    }
}

/// Session with no tracks/plugins/regions — only the transport stub. Used
/// when the sidecar boots in launcher mode (Ardour is the configured
/// default but the user hasn't picked a project yet). The mixer/timeline
/// render their empty state so no demo data bleeds into the picker UX.
pub(crate) fn empty_session() -> Session {
    let mut s = initial_session();
    s.tracks.clear();
    s.meta = serde_json::json!({ "project": null, "sample_rate": 48000, "launcher": true });
    s
}

/// Peak meters for every track — a flat list so the stub state can iterate cheaply.
pub(crate) fn peak_meter_ids(session: &Session) -> Vec<EntityId> {
    session
        .tracks
        .iter()
        .filter_map(|t| t.peak_meter.clone())
        .collect()
}

/// Seed meter values for initial state.
pub(crate) fn seed_meters(ids: &[EntityId]) -> Vec<(EntityId, Parameter)> {
    ids.iter()
        .map(|id| (id.clone(), meter(id.as_str())))
        .collect()
}
