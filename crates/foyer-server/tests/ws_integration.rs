//! End-to-end: spin up the server against a StubBackend, connect two websocket
//! clients, verify snapshot delivery, command round-trip, and fan-out to both.

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use foyer_backend_stub::StubBackend;
use foyer_schema::{Command, ControlValue, EntityId, Envelope, Event, SCHEMA_VERSION};
use foyer_server::{Config, Server};
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

/// Find a free port. `port 0` approach with a throwaway TcpListener.
async fn free_port() -> u16 {
    static SEED: AtomicU16 = AtomicU16::new(0);
    let _ = SEED.fetch_add(1, Ordering::Relaxed);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap().port()
}

async fn spin_server() -> (u16, tokio::task::JoinHandle<()>) {
    let port = free_port().await;
    let addr = format!("127.0.0.1:{port}").parse().unwrap();
    let server = Server::new(StubBackend::new());
    let cfg = Config {
        tls: None,
        listen: addr,
        web_root: None,
        web_overlays: Vec::new(),
        jail_root: None,
    };
    let h = tokio::spawn(async move {
        server.run(cfg).await.unwrap();
    });
    // Poll until the server is actually accepting.
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .is_ok()
        {
            return (port, h);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("server never came up");
}

fn envelope_of(
    msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Envelope<Event> {
    let m = msg.unwrap().unwrap();
    let t = match m {
        Message::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    };
    serde_json::from_str(&t).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_then_control_set_round_trip() {
    let (port, _h) = spin_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws?origin=alice");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Client requests subscribe explicitly; server pushes a snapshot back.
    let cmd = Envelope {
        schema: SCHEMA_VERSION,
        seq: 0,
        origin: Some("alice".into()),
        session_id: None,
        body: Command::Subscribe,
    };
    ws.send(Message::Text(serde_json::to_string(&cmd).unwrap()))
        .await
        .unwrap();

    // Pull messages until we see a SessionSnapshot (meter batches are noise).
    let deadline = tokio::time::sleep(Duration::from_millis(1500));
    tokio::pin!(deadline);
    let snapshot;
    loop {
        tokio::select! {
            _ = &mut deadline => panic!("no snapshot received"),
            msg = ws.next() => {
                let env = envelope_of(msg);
                if matches!(env.body, Event::SessionSnapshot { .. }) {
                    snapshot = env;
                    break;
                }
            }
        }
    }
    let Event::SessionSnapshot { session } = snapshot.body else {
        unreachable!()
    };
    assert!(!session.tracks.is_empty());

    // Move the tempo, expect a ControlUpdate echo tagged with our origin.
    let cmd = Envelope {
        schema: SCHEMA_VERSION,
        seq: 0,
        origin: Some("alice".into()),
        session_id: None,
        body: Command::ControlSet {
            id: EntityId::new("transport.tempo"),
            value: ControlValue::Float(144.0),
        },
    };
    ws.send(Message::Text(serde_json::to_string(&cmd).unwrap()))
        .await
        .unwrap();

    let deadline = tokio::time::sleep(Duration::from_millis(1500));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => panic!("no ControlUpdate received"),
            msg = ws.next() => {
                let env = envelope_of(msg);
                if let Event::ControlUpdate { update } = &env.body {
                    if update.id.as_str() == "transport.tempo" {
                        assert_eq!(update.value, ControlValue::Float(144.0));
                        // The origin-tagged echo lets alice distinguish her own write.
                        assert_eq!(env.origin.as_deref(), Some("alice"));
                        return;
                    }
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_client_gets_cached_snapshot_without_request() {
    let (port, _h) = spin_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");

    // First client: subscribe to prime the cache.
    let (mut ws1, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws1.send(Message::Text(
        serde_json::to_string(&Envelope {
            schema: SCHEMA_VERSION,
            seq: 0,
            origin: None,
            session_id: None,
            body: Command::Subscribe,
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    // Drain until we see snapshot (so cache is populated).
    loop {
        let env = envelope_of(ws1.next().await);
        if matches!(env.body, Event::SessionSnapshot { .. }) {
            break;
        }
    }

    // Second client connects fresh — should receive snapshot proactively.
    // The unicast ClientGreeting lands first (per-connection metadata);
    // the snapshot is the next event, either from the cached catch-up
    // path or the initial replay.
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_millis(2000);
    let mut saw_snapshot = false;
    while std::time::Instant::now() < deadline {
        let Ok(frame) = tokio::time::timeout(Duration::from_millis(500), ws2.next()).await else {
            break;
        };
        let env = envelope_of(frame);
        if matches!(env.body, Event::SessionSnapshot { .. }) {
            saw_snapshot = true;
            break;
        }
    }
    assert!(
        saw_snapshot,
        "expected snapshot in the first few events, never saw one"
    );
}
