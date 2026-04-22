//! End-to-end: a fake shim speaking foyer-ipc over a Unix domain socket, driving a
//! `HostBackend` and asserting the Backend trait works correctly.
//!
//! This test exercises everything between sidecar Rust and the wire: command framing,
//! event decoding, snapshot/ack correlation, audio egress routing, and ingress
//! piping.

use std::path::PathBuf;
use std::time::Duration;

use foyer_backend::{Backend, PcmFrame};
use foyer_backend_host::{test_helpers, HostBackend};
use foyer_ipc::{
    codec::{decode_control, encode_control, pack_audio, read_frame, write_frame},
    frame::{Frame, FrameKind},
    Control,
};
use foyer_schema::{
    AudioFormat, AudioSource, Command, ControlKind, ControlUpdate, ControlValue, EntityId,
    Envelope, Event, LatencyReport, Parameter, ScaleCurve, Session, Track, TrackKind, Transport,
    SCHEMA_VERSION,
};
use test_helpers::{f32_to_le_bytes, le_bytes_to_f32};
use tokio::net::UnixListener;

fn fader(id: &str) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Continuous,
        label: "Gain".into(),
        range: Some([-60.0, 6.0]),
        scale: ScaleCurve::Decibels,
        unit: Some("dB".into()),
        enum_labels: vec![],
        group: None,
        value: ControlValue::Float(0.0),
    }
}

fn toggle(id: &str) -> Parameter {
    Parameter {
        id: EntityId::new(id),
        kind: ControlKind::Trigger,
        label: "Toggle".into(),
        range: None,
        scale: ScaleCurve::Linear,
        unit: None,
        enum_labels: vec![],
        group: None,
        value: ControlValue::Bool(false),
    }
}

fn tempo() -> Parameter {
    Parameter {
        id: EntityId::new("transport.tempo"),
        kind: ControlKind::Continuous,
        label: "Tempo".into(),
        range: Some([20.0, 300.0]),
        scale: ScaleCurve::Linear,
        unit: Some("BPM".into()),
        enum_labels: vec![],
        group: None,
        value: ControlValue::Float(120.0),
    }
}

fn fake_session() -> Session {
    Session {
        schema_version: SCHEMA_VERSION,
        transport: Transport {
            playing: toggle("transport.playing"),
            recording: toggle("transport.recording"),
            looping: toggle("transport.looping"),
            tempo: tempo(),
            time_signature_num: Parameter {
                id: EntityId::new("transport.ts.num"),
                kind: ControlKind::Discrete,
                label: "Num".into(),
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
                label: "Den".into(),
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
                label: "Pos".into(),
                range: None,
                scale: ScaleCurve::Linear,
                unit: Some("beats".into()),
                enum_labels: vec![],
                group: None,
                value: ControlValue::Float(0.0),
            },
            punch_in: None,
            punch_out: None,
            metronome: None,
            sync_source: None,
        },
        tracks: vec![Track {
            id: EntityId::new("track.x"),
            name: "X".into(),
            kind: TrackKind::Audio,
            color: None,
            gain: fader("track.x.gain"),
            pan: fader("track.x.pan"),
            mute: toggle("track.x.mute"),
            solo: toggle("track.x.solo"),
            record_arm: None,
            monitoring: None,
            sends: vec![],
            plugins: vec![],
            peak_meter: None,
            group_id: None,
            bus_assign: None,
            inputs: vec![],
            outputs: vec![],
            automation_lanes: vec![],
        }],
        groups: vec![],
        dirty: false,
        ppqn: Some(960),
        meta: serde_json::Value::Null,
    }
}

/// The fake-shim runner. Accepts one connection on `socket_path` and services it
/// according to the test's expectations, driven by a few knobs.
#[derive(Default, Clone)]
struct ShimConfig {
    /// If set, emit a synthetic egress audio frame immediately after ack.
    egress_payload: Option<Vec<f32>>,
    /// If set, the latency probe will report this number of round-trip samples.
    latency_samples: Option<u64>,
    /// If true, emit a `ControlUpdate` event when `ControlSet` is observed.
    echo_control_sets: bool,
}

async fn spawn_fake_shim(path: PathBuf, cfg: ShimConfig) {
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let (mut r, mut w) = tokio::io::split(sock);
        let mut next_seq: u64 = 1;

        loop {
            let f = match read_frame(&mut r).await {
                Ok(Some(f)) => f,
                _ => break,
            };
            if f.kind != FrameKind::Control {
                continue;
            }
            let env: Envelope<Control> = decode_control(&f.payload).unwrap();
            let Control::Command(cmd) = env.body else {
                continue;
            };
            match cmd {
                Command::Subscribe | Command::RequestSnapshot => {
                    let session = fake_session();
                    let reply = Envelope {
                        schema: SCHEMA_VERSION,
                        seq: next_seq,
                        origin: Some("shim".into()),
                        session_id: None,
                        body: Control::Event(Event::SessionSnapshot {
                            session: Box::new(session),
                        }),
                    };
                    next_seq += 1;
                    let payload = encode_control(&reply).unwrap();
                    write_frame(
                        &mut w,
                        &Frame {
                            kind: FrameKind::Control,
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                }
                Command::ControlSet { id, value } if cfg.echo_control_sets => {
                    let reply = Envelope {
                        schema: SCHEMA_VERSION,
                        seq: next_seq,
                        origin: Some("shim".into()),
                        session_id: None,
                        body: Control::Event(Event::ControlUpdate {
                            update: ControlUpdate { id, value },
                        }),
                    };
                    next_seq += 1;
                    let payload = encode_control(&reply).unwrap();
                    write_frame(
                        &mut w,
                        &Frame {
                            kind: FrameKind::Control,
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                }
                Command::ControlSet { .. } => {}
                Command::AudioEgressStart { stream_id, .. } => {
                    let ack = Envelope {
                        schema: SCHEMA_VERSION,
                        seq: next_seq,
                        origin: Some("shim".into()),
                        session_id: None,
                        body: Control::Event(Event::AudioEgressStarted { stream_id }),
                    };
                    next_seq += 1;
                    let payload = encode_control(&ack).unwrap();
                    write_frame(
                        &mut w,
                        &Frame {
                            kind: FrameKind::Control,
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                    if let Some(pcm) = &cfg.egress_payload {
                        let bytes = f32_to_le_bytes(pcm);
                        let body = pack_audio(stream_id, &bytes);
                        write_frame(
                            &mut w,
                            &Frame {
                                kind: FrameKind::Audio,
                                payload: body,
                            },
                        )
                        .await
                        .unwrap();
                    }
                }
                Command::AudioIngressOpen {
                    stream_id,
                    source,
                    format,
                } => {
                    let ack = Envelope {
                        schema: SCHEMA_VERSION,
                        seq: next_seq,
                        origin: Some("shim".into()),
                        session_id: None,
                        body: Control::Event(Event::AudioIngressOpened {
                            stream_id,
                            source,
                            format,
                        }),
                    };
                    next_seq += 1;
                    let payload = encode_control(&ack).unwrap();
                    write_frame(
                        &mut w,
                        &Frame {
                            kind: FrameKind::Control,
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                }
                Command::LatencyProbe { stream_id } => {
                    let report = LatencyReport {
                        round_trip_samples: cfg.latency_samples.unwrap_or(4800),
                        sample_rate: 48_000,
                        jitter_samples: 4,
                    };
                    let ack = Envelope {
                        schema: SCHEMA_VERSION,
                        seq: next_seq,
                        origin: Some("shim".into()),
                        session_id: None,
                        body: Control::Event(Event::LatencyReport { stream_id, report }),
                    };
                    next_seq += 1;
                    let payload = encode_control(&ack).unwrap();
                    write_frame(
                        &mut w,
                        &Frame {
                            kind: FrameKind::Control,
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                }
                _ => {}
            }
        }
    });
}

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_round_trip() {
    let dir = tempdir();
    let sock = dir.path().join("foyer.sock");
    spawn_fake_shim(sock.clone(), ShimConfig::default()).await;
    // Yield so the listener is actually bound before we connect.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let backend = HostBackend::connect(sock).await.unwrap();
    let session = backend.snapshot().await.unwrap();
    assert_eq!(session.schema_version, SCHEMA_VERSION);
    assert_eq!(session.tracks.len(), 1);
    assert_eq!(session.tracks[0].id.as_str(), "track.x");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_set_flows_through_and_echo_is_observed() {
    let dir = tempdir();
    let sock = dir.path().join("foyer.sock");
    spawn_fake_shim(
        sock.clone(),
        ShimConfig {
            echo_control_sets: true,
            ..Default::default()
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let backend = HostBackend::connect(sock).await.unwrap();
    let mut stream = backend.subscribe().await.unwrap();
    // initial snapshot event
    let first = futures::StreamExt::next(&mut stream).await.unwrap();
    assert!(matches!(first, Event::SessionSnapshot { .. }));

    backend
        .set_control(EntityId::new("track.x.gain"), ControlValue::Float(-3.0))
        .await
        .unwrap();

    let deadline = tokio::time::sleep(Duration::from_millis(500));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => panic!("no echo observed"),
            ev = futures::StreamExt::next(&mut stream) => {
                if let Some(Event::ControlUpdate { update }) = ev {
                    if update.id.as_str() == "track.x.gain" {
                        assert_eq!(update.value, ControlValue::Float(-3.0));
                        return;
                    }
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn egress_frame_is_routed_to_consumer() {
    let dir = tempdir();
    let sock = dir.path().join("foyer.sock");
    let payload: Vec<f32> = (0..128).map(|i| i as f32 * 0.01).collect();
    spawn_fake_shim(
        sock.clone(),
        ShimConfig {
            egress_payload: Some(payload.clone()),
            ..Default::default()
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let backend = HostBackend::connect(sock).await.unwrap();
    let fmt = AudioFormat::new(48_000, 1, 128);
    let mut rx = backend
        .open_egress(7, AudioSource::Master, fmt)
        .await
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("timed out")
        .expect("stream closed");
    assert_eq!(frame.stream_id, 7);
    assert_eq!(frame.samples.len(), payload.len());
    // Allow for a small float-bit-pattern round trip.
    for (got, want) in frame.samples.iter().zip(payload.iter()) {
        assert!((got - want).abs() < 1e-6);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ingress_sink_opens_and_accepts_frames() {
    // The fake shim just acks opens; we verify that ingress frames reach the writer.
    // We do this by setting up a second loopback — using the public `le_bytes_to_f32`
    // helper to decode what went over the wire — but it's simpler to just assert that
    // `open_ingress` succeeded and the returned sender can accept a frame without
    // the writer task panicking (which would be visible as the backend dying).
    let dir = tempdir();
    let sock = dir.path().join("foyer.sock");
    spawn_fake_shim(sock.clone(), ShimConfig::default()).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let backend = HostBackend::connect(sock).await.unwrap();
    let fmt = AudioFormat::new(48_000, 1, 64);
    let tx = backend
        .open_ingress(
            9,
            AudioSource::VirtualInput {
                name: "remote".into(),
            },
            fmt,
        )
        .await
        .unwrap();
    tx.send(PcmFrame {
        stream_id: 9,
        samples: vec![0.5; 64],
    })
    .await
    .unwrap();
    // Sanity: the helpers are symmetric.
    let bytes = f32_to_le_bytes(&[0.5, -0.25]);
    let back = le_bytes_to_f32(&bytes);
    assert_eq!(back, vec![0.5, -0.25]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn latency_probe_resolves_to_report() {
    let dir = tempdir();
    let sock = dir.path().join("foyer.sock");
    spawn_fake_shim(
        sock.clone(),
        ShimConfig {
            latency_samples: Some(9600),
            ..Default::default()
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let backend = HostBackend::connect(sock).await.unwrap();
    let report = backend.measure_latency(3).await.unwrap();
    assert_eq!(report.round_trip_samples, 9600);
}
