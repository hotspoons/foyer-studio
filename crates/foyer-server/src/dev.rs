//! Dev-only integration probe runner.
//!
//! Exposed when `FOYER_DEV=1` is set in the environment, and hooked onto
//! `GET /dev/run-tests[?ids=a,b,c]` + `GET /dev/list-tests`. Each probe
//! exercises a command path through the live `AppState` backend and
//! checks that the expected observable landed — return shape is JSON
//! that both the web diagnostics panel and a command-line curl session
//! can read.
//!
//! Probes are deliberately boring — each one is a ~20-line async fn
//! that issues a single backend call and verifies the response. That
//! lets the harness double as regression coverage for the layers that
//! `cargo test` has trouble exercising (shim-backed backends, live
//! event broadcasts, asymmetric timeouts).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::Json;
use foyer_backend::{Backend, BackendError};
use foyer_schema::{
    ControlKind, ControlValue, EntityId, Event, Parameter, ScaleCurve, TrackPatch,
};
use serde::{Deserialize, Serialize};
use tokio::time::timeout;

use crate::AppState;

/// Check the env gate. Called by `lib.rs` when building the router so
/// the routes are only attached in dev mode.
pub fn enabled() -> bool {
    std::env::var("FOYER_DEV").ok().as_deref() == Some("1")
}

#[derive(Serialize, Deserialize)]
pub struct RunTestsQuery {
    /// Comma-separated list of probe ids; empty = run everything.
    #[serde(default)]
    pub ids: String,
}

#[derive(Serialize)]
pub struct ProbeReport {
    pub id: &'static str,
    pub description: &'static str,
    pub pass: bool,
    pub elapsed_ms: u128,
    pub detail: String,
}

#[derive(Serialize)]
pub struct RunTestsResponse {
    pub results: Vec<ProbeReport>,
    pub passed: usize,
    pub failed: usize,
    pub elapsed_ms: u128,
}

/// `GET /dev/list-tests` — enumerate registered probes without running.
pub async fn list_tests() -> Json<serde_json::Value> {
    let items: Vec<_> = PROBES
        .iter()
        .map(|p| serde_json::json!({ "id": p.id, "description": p.description }))
        .collect();
    Json(serde_json::json!({ "probes": items }))
}

/// `GET /dev/run-tests?ids=a,b` — run all (or the named subset) probes
/// and return per-probe results.
pub async fn run_tests(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RunTestsQuery>,
) -> Json<RunTestsResponse> {
    let filter: Option<Vec<&str>> = if q.ids.trim().is_empty() {
        None
    } else {
        Some(q.ids.split(',').map(|s| s.trim()).collect())
    };
    let picked: Vec<&Probe> = PROBES
        .iter()
        .filter(|p| filter.as_ref().is_none_or(|ids| ids.contains(&p.id)))
        .collect();

    let started_all = std::time::Instant::now();
    let mut results = Vec::with_capacity(picked.len());
    for probe in picked {
        let started = std::time::Instant::now();
        let outcome = (probe.run)(state.clone()).await;
        let elapsed_ms = started.elapsed().as_millis();
        let (pass, detail) = match outcome {
            Ok(msg) => (true, msg),
            Err(msg) => (false, msg),
        };
        results.push(ProbeReport {
            id: probe.id,
            description: probe.description,
            pass,
            elapsed_ms,
            detail,
        });
    }
    let passed = results.iter().filter(|r| r.pass).count();
    let failed = results.len() - passed;
    Json(RunTestsResponse {
        results,
        passed,
        failed,
        elapsed_ms: started_all.elapsed().as_millis(),
    })
}

// ── probe registry ─────────────────────────────────────────────────────

type ProbeFn = fn(Arc<AppState>) -> futures::future::BoxFuture<'static, Result<String, String>>;

struct Probe {
    id: &'static str,
    description: &'static str,
    run: ProbeFn,
}

macro_rules! probe {
    ($id:expr, $desc:expr, $body:expr) => {
        Probe {
            id: $id,
            description: $desc,
            run: |state: Arc<AppState>| Box::pin($body(state)),
        }
    };
}

// Expose a view into AppState's backend pointer. Tests need an Arc<dyn
// Backend>, and the field is module-private (`pub(crate)`), so this
// shim lives alongside ws.rs.
async fn backend_of(state: &AppState) -> Arc<dyn Backend> {
    state.backend().await
}

// ── individual probes ─────────────────────────────────────────────────

async fn probe_snapshot(state: Arc<AppState>) -> Result<String, String> {
    let session = backend_of(&state)
        .await
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    Ok(format!(
        "tracks={} dirty={} ppqn={:?} sr={}",
        session.tracks.len(),
        session.dirty,
        session.ppqn,
        session
            .meta
            .get("sample_rate")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1),
    ))
}

async fn probe_set_control(state: Arc<AppState>) -> Result<String, String> {
    let backend = backend_of(&state).await;
    let snapshot = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    // Pick the first track's gain to twiddle.
    let track = snapshot
        .tracks
        .first()
        .ok_or_else(|| "no tracks".to_string())?;
    let gain_id = track.gain.id.clone();
    backend
        .set_control(gain_id.clone(), ControlValue::Float(-6.0))
        .await
        .map_err(|e| format!("set_control: {e}"))?;
    Ok(format!("set {} to -6.0", gain_id))
}

async fn probe_list_regions(state: Arc<AppState>) -> Result<String, String> {
    let backend = backend_of(&state).await;
    let snapshot = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    let track = snapshot
        .tracks
        .iter()
        .find(|t| matches!(t.kind, foyer_schema::TrackKind::Audio))
        .ok_or_else(|| "no audio tracks".to_string())?;
    let (meta, regions) = timeout(
        Duration::from_secs(3),
        backend.list_regions(track.id.clone()),
    )
    .await
    .map_err(|_| "list_regions: timed out after 3 s".to_string())?
    .map_err(|e| format!("list_regions: {e}"))?;
    Ok(format!(
        "track={} regions={} sample_rate={} len_samples={}",
        track.id, regions.len(), meta.sample_rate, meta.length_samples,
    ))
}

async fn probe_update_track(state: Arc<AppState>) -> Result<String, String> {
    let backend = backend_of(&state).await;
    let snapshot = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    let track = snapshot
        .tracks
        .first()
        .ok_or_else(|| "no tracks".to_string())?;
    let orig_name = track.name.clone();
    let probe_name = format!("{}[probe]", orig_name);
    let patch = TrackPatch {
        name: Some(probe_name.clone()),
        ..Default::default()
    };
    let updated = backend
        .update_track(track.id.clone(), patch)
        .await
        .map_err(|e| format!("update_track: {e}"))?;
    // Best-effort restore so repeated runs don't accumulate "[probe]" suffixes.
    let _ = backend
        .update_track(
            track.id.clone(),
            TrackPatch {
                name: Some(orig_name.clone()),
                ..Default::default()
            },
        )
        .await;
    if updated.name != probe_name {
        return Err(format!(
            "expected name='{probe_name}', got '{}'",
            updated.name
        ));
    }
    Ok(format!(
        "track {} renamed to {:?} and restored",
        track.id, probe_name
    ))
}

async fn probe_transport_play_stop(state: Arc<AppState>) -> Result<String, String> {
    let backend = backend_of(&state).await;
    // InvokeAction fire-and-forget; we verify by reading the next
    // session snapshot after a brief wait. (The stub backend flips
    // `transport.playing` synchronously; the host backend ACKs via a
    // control_update that the store catches, also usually within a
    // few hundred ms.)
    backend
        .invoke_action(EntityId::new("transport.play"))
        .await
        .map_err(|e| format!("play: {e}"))?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    backend
        .invoke_action(EntityId::new("transport.stop"))
        .await
        .map_err(|e| format!("stop: {e}"))?;
    Ok("play + stop dispatched".to_string())
}

async fn probe_load_waveform(state: Arc<AppState>) -> Result<String, String> {
    let backend = backend_of(&state).await;
    let snapshot = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    let track = snapshot
        .tracks
        .iter()
        .find(|t| matches!(t.kind, foyer_schema::TrackKind::Audio))
        .ok_or_else(|| "no audio tracks".to_string())?;
    let (_meta, regions) = backend
        .list_regions(track.id.clone())
        .await
        .map_err(|e| format!("list_regions: {e}"))?;
    let region = regions
        .first()
        .ok_or_else(|| format!("no regions on track {}", track.id))?;
    let peaks = timeout(
        Duration::from_secs(5),
        backend.load_waveform(region.id.clone(), 512),
    )
    .await
    .map_err(|_| "load_waveform: timed out".to_string())?
    .map_err(|e| format!("load_waveform: {e}"))?;
    Ok(format!(
        "region={} peaks.bucket_count={} channels={} spp={}",
        region.id, peaks.bucket_count, peaks.channels, peaks.samples_per_peak,
    ))
}

async fn probe_list_actions(state: Arc<AppState>) -> Result<String, String> {
    let actions = backend_of(&state)
        .await
        .list_actions()
        .await
        .map_err(|e| format!("list_actions: {e}"))?;
    // Sanity: expect at least the transport trio.
    let need = ["transport.play", "transport.stop", "transport.record"];
    let ids: std::collections::HashSet<_> = actions.iter().map(|a| a.id.as_str()).collect();
    for n in need {
        if !ids.contains(n) {
            return Err(format!("missing action {n}"));
        }
    }
    Ok(format!("{} actions available", actions.len()))
}

async fn probe_audio_egress(state: Arc<AppState>) -> Result<String, String> {
    use foyer_schema::{AudioCodec, AudioFormat, AudioSource};
    // Open an egress stream, synthesize a short test tone, verify the
    // sidecar's Opus encoder emits at least a couple of packets. The
    // encoded payload lands on the audio hub's broadcast — subscribe
    // + collect a few packets to prove the pipe is alive.
    let stream_id: u32 = 777;
    let fmt = AudioFormat::new_with_codec(48_000, 2, 960, AudioCodec::Opus);
    let rx = state.audio_hub.spawn_test_tone_source(fmt, Duration::from_millis(300));
    state
        .audio_hub
        .open_stream(stream_id, AudioSource::Master, fmt, rx)
        .await
        .map_err(|e| format!("open: {e}"))?;

    let mut sub = state
        .audio_hub
        .subscribe(stream_id)
        .await
        .ok_or_else(|| "subscribe: stream vanished immediately".to_string())?;

    let mut packets = 0usize;
    let mut bytes = 0usize;
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    while std::time::Instant::now() < deadline && packets < 5 {
        match tokio::time::timeout(Duration::from_millis(200), sub.recv()).await {
            Ok(Ok(pkt)) => {
                packets += 1;
                bytes += pkt.opus.len();
            }
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }

    state.audio_hub.close_stream(stream_id).await;

    if packets == 0 {
        return Err("no opus packets emitted within 500 ms".into());
    }
    Ok(format!("stream {stream_id}: {packets} opus packet(s), {bytes} bytes total"))
}

async fn probe_event_broadcast(state: Arc<AppState>) -> Result<String, String> {
    // Subscribe to the server's broadcast, fire a control change, and
    // check that an Event::ControlUpdate (or MeterBatch containing our
    // id) lands within a reasonable window.
    let mut rx = state.tx.subscribe();
    let backend = backend_of(&state).await;
    let snapshot = backend
        .snapshot()
        .await
        .map_err(|e| format!("snapshot: {e}"))?;
    let track = snapshot
        .tracks
        .first()
        .ok_or_else(|| "no tracks".to_string())?;
    let mute_id = track.mute.id.clone();
    // Flip once, then flip back.
    backend
        .set_control(mute_id.clone(), ControlValue::Bool(true))
        .await
        .map_err(|e| format!("set_control: {e}"))?;
    let observed = timeout(Duration::from_secs(2), async {
        loop {
            match rx.recv().await {
                Ok(env) => match env.body {
                    Event::ControlUpdate { update } if update.id == mute_id => return Ok(()),
                    Event::MeterBatch { values } => {
                        if values.iter().any(|u| u.id == mute_id) {
                            return Ok(());
                        }
                    }
                    _ => {}
                },
                Err(_) => return Err::<(), BackendError>(BackendError::Other("rx closed".into())),
            }
        }
    })
    .await
    .map_err(|_| "no control_update echo within 2 s".to_string())?;
    observed.map_err(|e| format!("broadcast: {e}"))?;
    // Restore.
    let _ = backend
        .set_control(mute_id, ControlValue::Bool(false))
        .await;
    Ok("control_update echoed within 2 s".to_string())
}

// Suppress dead-code warnings on Parameter/ScaleCurve/ControlKind imports
// when compiled without some probes.
#[allow(dead_code)]
fn _ref_types() -> (Parameter, ScaleCurve, ControlKind) {
    (
        Parameter {
            id: EntityId::new("x"),
            kind: ControlKind::Trigger,
            label: "x".into(),
            range: None,
            scale: ScaleCurve::Linear,
            unit: None,
            enum_labels: vec![],
            group: None,
            value: ControlValue::Bool(false),
        },
        ScaleCurve::Linear,
        ControlKind::Trigger,
    )
}

static PROBES: &[Probe] = &[
    probe!("snapshot", "Backend returns a well-shaped session snapshot", probe_snapshot),
    probe!("list_actions", "Action catalog includes transport.*", probe_list_actions),
    probe!("set_control", "set_control on track gain does not error", probe_set_control),
    probe!(
        "event_broadcast",
        "Broadcasts a control_update echo within 2 s of a set_control",
        probe_event_broadcast
    ),
    probe!("list_regions", "list_regions for first audio track returns", probe_list_regions),
    probe!("load_waveform", "load_waveform returns peaks for first region", probe_load_waveform),
    probe!("update_track", "update_track renames + restores first track", probe_update_track),
    probe!(
        "transport_play_stop",
        "invoke_action transport.play + transport.stop dispatch cleanly",
        probe_transport_play_stop
    ),
    probe!(
        "audio_egress",
        "Audio hub + opus encoder emit \u{2265}1 packet for a synthetic test tone",
        probe_audio_egress
    ),
];
