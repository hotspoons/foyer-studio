// SPDX-License-Identifier: Apache-2.0
//! End-to-end-against-stub: enumerate hardware, route a track input,
//! arm it. Exercises the surface a remote agent would touch to set up
//! recording from an actual microphone or MIDI controller — but
//! against the in-process stub backend, so it runs anywhere (CI,
//! devcontainer, no JACK / Ardour required).
//!
//! Why this is here: the io tool + tracks.set_arm exist specifically
//! so non-Ardour deployments (stub demo, future Reaper/Bitwig/etc.
//! backends) can drive the same record-arm workflow. If the stub ever
//! regresses port enumeration or input_port reflection this test
//! catches it before a real session does.

use std::sync::Arc;

use foyer_agent::tools::{
    io::IoTool, tracks::TracksTool, transport::TransportTool, Tool, ToolContext,
};
use foyer_backend::Backend;
use foyer_backend_stub::StubBackend;
use serde_json::{json, Value};

/// Wire a stub backend into a ToolContext with only the fields a
/// straight tool dispatch needs. Takes by reference so the caller
/// retains the strong Arc — the BackendRef holds a Weak and would
/// otherwise resolve to BackendGone the moment this fn returns.
fn ctx_for(backend: &Arc<dyn Backend>) -> ToolContext {
    let weak = Arc::downgrade(backend);
    ToolContext {
        backend: Arc::new(std::sync::RwLock::new(Some(weak))),
        fe_attached: false,
        fe_render: None,
        headless_render: None,
        ui_director: None,
        session_director: None,
        spectrum_director: None,
        prefer_headless_render: false,
        turn_budget: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn io_list_ports_returns_physical_audio_midi_and_virtual() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let io = IoTool;

    // Sources first — what a track's INPUT can connect to.
    let res = io
        .call(
            &ctx,
            json!({ "subcommand": "list_ports", "direction": "source" }),
        )
        .await
        .expect("io.list_ports(source) succeeds");
    let ports = res
        .data
        .get("ports")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let names: Vec<String> = ports
        .iter()
        .map(|p| p["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        names.contains(&"system:capture_1".to_string()),
        "missing physical audio capture port: {names:?}"
    );
    assert!(
        names.contains(&"system:midi/capture_1".to_string()),
        "missing physical MIDI capture port: {names:?}"
    );
    assert!(
        names.contains(&"foyer:ingress-stub".to_string()),
        "missing virtual ingress source port: {names:?}"
    );
    // Physical vs virtual flag plumbed through.
    let cap = ports
        .iter()
        .find(|p| p["name"] == "system:capture_1")
        .unwrap();
    assert_eq!(cap["is_physical"], Value::Bool(true));
    assert_eq!(cap["is_midi"], Value::Bool(false));
    let ing = ports
        .iter()
        .find(|p| p["name"] == "foyer:ingress-stub")
        .unwrap();
    assert_eq!(ing["is_physical"], Value::Bool(false));

    // Filter: physical-only drops virtual.
    let phys = io
        .call(
            &ctx,
            json!({
                "subcommand": "list_ports",
                "direction": "source",
                "filter": "physical",
            }),
        )
        .await
        .expect("io.list_ports physical filter succeeds");
    let phys_names: Vec<String> = phys.data["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(!phys_names.contains(&"foyer:ingress-stub".to_string()));
    assert!(phys_names.contains(&"system:capture_1".to_string()));

    // Sinks — what a track's OUTPUT can connect to.
    let sinks = io
        .call(
            &ctx,
            json!({ "subcommand": "list_ports", "direction": "sink" }),
        )
        .await
        .expect("io.list_ports(sink) succeeds");
    let sink_names: Vec<String> = sinks.data["ports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(sink_names.contains(&"system:playback_1".to_string()));
    assert!(sink_names.contains(&"system:midi/playback_1".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn route_input_and_arm_track() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let tracks = TracksTool;

    // Create a fresh audio track so we have a known id to drive
    // (the stub's default session has demo tracks but they may
    // mutate as the test surface evolves).
    let created = tracks
        .call(
            &ctx,
            json!({
                "subcommand": "create",
                "name": "Vox",
                "kind": "audio",
            }),
        )
        .await
        .expect("tracks.create succeeds");
    let track_id = created.data["id"]
        .as_str()
        .expect("created track id present")
        .to_string();

    // Route the input to a physical mic input. Stub stamps this into
    // `track.inputs[0].name` so we can read it back via describe.
    tracks
        .call(
            &ctx,
            json!({
                "subcommand": "update",
                "track_id": track_id,
                "input_port": "system:capture_1",
            }),
        )
        .await
        .expect("tracks.update(input_port=…) succeeds");

    let described = tracks
        .call(
            &ctx,
            json!({
                "subcommand": "describe",
                "track_id": track_id,
            }),
        )
        .await
        .expect("tracks.describe succeeds");
    let inputs = described.data["inputs"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        inputs.iter().any(|p| p["name"] == "system:capture_1"),
        "input_port assignment didn't propagate to inputs[]: {described:?}"
    );

    // Arm the track.
    let armed = tracks
        .call(
            &ctx,
            json!({
                "subcommand": "set_arm",
                "track_id": track_id,
                "armed": true,
            }),
        )
        .await
        .expect("tracks.set_arm(true) succeeds");
    assert_eq!(armed.data["armed"], Value::Bool(true));

    // Confirm the record_arm parameter actually flipped on the
    // backend (mirrors what a ControlUpdate would show in the UI).
    let snap = backend.snapshot().await.unwrap();
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id.as_str() == track_id)
        .expect("track present");
    let rec = track
        .record_arm
        .as_ref()
        .expect("audio track has record_arm");
    match &rec.value {
        foyer_schema::ControlValue::Bool(b) => assert!(*b, "armed control should be true"),
        other => panic!("record_arm should be bool, got {other:?}"),
    }

    // Disarm.
    tracks
        .call(
            &ctx,
            json!({
                "subcommand": "set_arm",
                "track_id": track_id,
                "armed": false,
            }),
        )
        .await
        .expect("tracks.set_arm(false) succeeds");
    let snap2 = backend.snapshot().await.unwrap();
    let track2 = snap2
        .tracks
        .iter()
        .find(|t| t.id.as_str() == track_id)
        .unwrap();
    match &track2.record_arm.as_ref().unwrap().value {
        foyer_schema::ControlValue::Bool(b) => assert!(!*b, "disarmed control should be false"),
        other => panic!("record_arm should be bool, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn arm_rejects_bus_tracks() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let tracks = TracksTool;

    // Find a bus / master track in the default stub session.
    let snap = backend.snapshot().await.unwrap();
    let bus = snap
        .tracks
        .iter()
        .find(|t| {
            matches!(
                t.kind,
                foyer_schema::TrackKind::Master | foyer_schema::TrackKind::Bus
            )
        })
        .expect("stub session has a bus / master");

    // set_arm on a bus must error out with a clear message —
    // buses and master have no record_arm in the schema.
    let err = tracks
        .call(
            &ctx,
            json!({
                "subcommand": "set_arm",
                "track_id": bus.id.as_str(),
                "armed": true,
            }),
        )
        .await
        .expect_err("set_arm on a bus should fail");
    let msg = format!("{err}");
    assert!(
        msg.contains("no record_arm") || msg.contains("can't be armed"),
        "expected helpful error, got: {msg}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn midi_track_route_to_midi_input_marks_is_midi() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let tracks = TracksTool;

    let created = tracks
        .call(
            &ctx,
            json!({
                "subcommand": "create",
                "name": "Keys",
                "kind": "midi",
            }),
        )
        .await
        .expect("create midi track succeeds");
    let track_id = created.data["id"].as_str().unwrap().to_string();

    tracks
        .call(
            &ctx,
            json!({
                "subcommand": "update",
                "track_id": track_id,
                "input_port": "system:midi/capture_1",
            }),
        )
        .await
        .expect("route midi input succeeds");

    let snap = backend.snapshot().await.unwrap();
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id.as_str() == track_id)
        .unwrap();
    assert_eq!(track.inputs.len(), 1, "stub should reflect input_port");
    assert_eq!(track.inputs[0].name, "system:midi/capture_1");
    assert!(
        track.inputs[0].is_midi,
        "midi-routed input should be is_midi"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transport_set_tempo_writes_parameter() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let transport = TransportTool;

    let res = transport
        .call(&ctx, json!({ "subcommand": "set_tempo", "bpm": 140.0 }))
        .await
        .expect("set_tempo(140) succeeds");
    assert_eq!(res.data["bpm"], json!(140.0));

    let snap = backend.snapshot().await.unwrap();
    match &snap.transport.tempo.value {
        foyer_schema::ControlValue::Float(f) => {
            assert!((*f - 140.0).abs() < 1e-6, "tempo should be 140, got {f}");
        }
        other => panic!("tempo should be Float, got {other:?}"),
    }

    // Out-of-range clamps; agent reports the clamped value back.
    let clamped = transport
        .call(&ctx, json!({ "subcommand": "set_tempo", "bpm": 999.0 }))
        .await
        .expect("set_tempo(999) clamps + succeeds");
    assert_eq!(clamped.data["bpm"], json!(300.0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transport_set_time_signature_writes_both_params() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let transport = TransportTool;

    let res = transport
        .call(
            &ctx,
            json!({
                "subcommand": "set_time_signature",
                "numerator": 7,
                "denominator": 8,
            }),
        )
        .await
        .expect("set_time_signature(7/8) succeeds");
    assert_eq!(res.data["numerator"], json!(7));
    assert_eq!(res.data["denominator"], json!(8));

    let snap = backend.snapshot().await.unwrap();
    match &snap.transport.time_signature_num.value {
        foyer_schema::ControlValue::Int(n) => assert_eq!(*n, 7),
        other => panic!("ts.num should be Int, got {other:?}"),
    }
    match &snap.transport.time_signature_den.value {
        foyer_schema::ControlValue::Int(n) => assert_eq!(*n, 8),
        other => panic!("ts.den should be Int, got {other:?}"),
    }

    // Invalid denominator (non-power-of-2) errors before any
    // ControlSet fires — leaves the previous 7/8 intact.
    let err = transport
        .call(
            &ctx,
            json!({
                "subcommand": "set_time_signature",
                "numerator": 4,
                "denominator": 6,
            }),
        )
        .await
        .expect_err("denominator=6 should be rejected");
    let msg = format!("{err}");
    assert!(
        msg.contains("denominator must be one of"),
        "expected validation error, got: {msg}"
    );
    // Verify the prior 7/8 is still in place.
    let snap2 = backend.snapshot().await.unwrap();
    match &snap2.transport.time_signature_num.value {
        foyer_schema::ControlValue::Int(n) => {
            assert_eq!(*n, 7, "bad denominator must not have stomped numerator")
        }
        other => panic!("ts.num should be Int, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transport_set_metronome_toggles_click_and_gain() {
    let backend: Arc<dyn Backend> = Arc::new(StubBackend::new());
    let ctx = ctx_for(&backend);
    let transport = TransportTool;

    // On + custom gain in one call.
    transport
        .call(
            &ctx,
            json!({
                "subcommand": "set_metronome",
                "enabled": true,
                "gain_db": -3.0,
            }),
        )
        .await
        .expect("set_metronome(on, -3 dB) succeeds");

    let snap = backend.snapshot().await.unwrap();
    let metro = snap
        .transport
        .metronome
        .as_ref()
        .expect("stub session exposes metronome param");
    match &metro.value {
        foyer_schema::ControlValue::Bool(b) => assert!(*b, "metronome should be on"),
        other => panic!("metronome should be bool, got {other:?}"),
    }
    let gain = snap
        .transport
        .metronome_gain
        .as_ref()
        .expect("stub session exposes metronome_gain param");
    match &gain.value {
        foyer_schema::ControlValue::Float(f) => {
            assert!(
                (*f + 3.0).abs() < 1e-6,
                "metronome gain should be -3 dB, got {f}"
            );
        }
        other => panic!("metronome gain should be Float, got {other:?}"),
    }

    // Toggle off without touching the gain — prior gain should
    // survive a no-gain-arg call.
    transport
        .call(
            &ctx,
            json!({"subcommand": "set_metronome", "enabled": false}),
        )
        .await
        .expect("set_metronome(off) succeeds");
    let snap2 = backend.snapshot().await.unwrap();
    match &snap2.transport.metronome.as_ref().unwrap().value {
        foyer_schema::ControlValue::Bool(b) => assert!(!*b, "metronome should be off"),
        other => panic!("metronome should be bool, got {other:?}"),
    }
    match &snap2.transport.metronome_gain.as_ref().unwrap().value {
        foyer_schema::ControlValue::Float(f) => {
            assert!((*f + 3.0).abs() < 1e-6, "gain should remain -3 dB, got {f}");
        }
        other => panic!("metronome gain should be Float, got {other:?}"),
    }
}
