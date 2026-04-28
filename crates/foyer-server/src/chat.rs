// SPDX-License-Identifier: Apache-2.0
//! In-app chat + push-to-talk relay.
//!
//! This module is not audio-engine bound — it carries conversation
//! between connected Foyer peers, independent of whether a DAW is
//! attached. Chat text rides JSON envelopes on the main control WS;
//! PTT audio rides binary frames on the *same* socket to avoid
//! blowing past the per-origin HTTP connection cap.
//!
//! Persistence model:
//!   - Live history lives in `ChatState::messages` (bounded ring).
//!   - Admins (and any LAN connection — LAN is trusted) may clear it.
//!   - `Command::ChatSnapshot` writes the ring to
//!     `$XDG_DATA_HOME/foyer/chat/<filename>.jsonl` (one record per
//!     line). Basename-only — any path separators in `filename` are
//!     stripped so clients can't escape the chat dir.
//!
//! PTT wire format (binary WS frames on `/ws`):
//!
//!   Inbound (speaker → server):
//!     [0] magic  'P' (0x50)
//!     [1] version 0x01
//!     [2..] raw f32 LE samples, mono, 48 kHz
//!
//!   Outbound (server → every listener):
//!     [0] magic  'P'
//!     [1] version 0x01
//!     [2..10]  ts_ms u64 BE
//!     [10..42] 32-byte ASCII hex peer id
//!     [42..]   raw f32 LE samples
//!
//! Clients not currently designated as the speaker (per `PttState`)
//! can still send frames — the server simply drops them. That way a
//! brief click/race around `PttStart` doesn't lose audio.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use foyer_schema::{ChatMessageRecord, Envelope, Event, PttSpeaker, SCHEMA_VERSION};
use tokio::sync::RwLock;

use crate::ws::ConnectionAuth;
use crate::AppState;

/// Upper bound on the in-memory ring. Old messages are dropped from
/// the front once this is exceeded — the snapshot-to-disk path is how
/// anyone who wants full history preserves it.
const MAX_LIVE_MESSAGES: usize = 500;

/// Minimum length of an inbound PTT binary frame (`[magic, version]`
/// plus at least one f32 sample).
const MIN_PTT_FRAME_LEN: usize = 2 + 4;

const PTT_MAGIC: u8 = b'P';
const PTT_VERSION: u8 = 0x01;

#[derive(Default)]
pub(crate) struct ChatState {
    pub(crate) messages: RwLock<VecDeque<ChatMessageRecord>>,
    pub(crate) next_message_id: AtomicU64,
    /// `Some(peer_id)` when someone is actively holding PTT. Server
    /// drops inbound binary frames from any other peer while a
    /// speaker is held.
    pub(crate) speaker: RwLock<Option<PttSpeaker>>,
}

impl ChatState {
    pub(crate) fn new() -> Self {
        Self {
            messages: RwLock::new(VecDeque::with_capacity(MAX_LIVE_MESSAGES)),
            next_message_id: AtomicU64::new(1),
            speaker: RwLock::new(None),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn envelope(state: &AppState, body: Event) -> Envelope<Event> {
    Envelope {
        schema: SCHEMA_VERSION,
        seq: state.next_seq.fetch_add(1, Ordering::Relaxed),
        origin: Some("server".into()),
        session_id: None,
        body,
    }
}

async fn broadcast(state: &AppState, body: Event) {
    let env = envelope(state, body);
    state.ring.write().await.push(env.clone());
    let _ = state.tx.send(env);
}

pub(crate) async fn handle_send(
    state: &Arc<AppState>,
    peer_id: &str,
    peer_label: &str,
    body: String,
) {
    // Trim but don't reject empty — the client will usually guard.
    let body = body.trim().to_string();
    if body.is_empty() {
        return;
    }
    if body.len() > 64 * 1024 {
        // A 64 KB chat message is already egregious; silently cap.
        // (Pasting a huge log is the usual culprit. Client will see
        // the truncated form when the server broadcasts back.)
    }
    let body = body.chars().take(64_000).collect::<String>();

    let record = ChatMessageRecord {
        id: state.chat.next_message_id.fetch_add(1, Ordering::Relaxed),
        from_peer_id: peer_id.to_string(),
        from_label: peer_label.to_string(),
        body,
        ts_ms: now_ms(),
    };

    {
        let mut ring = state.chat.messages.write().await;
        if ring.len() >= MAX_LIVE_MESSAGES {
            ring.pop_front();
        }
        ring.push_back(record.clone());
    }

    broadcast(state, Event::ChatMessage { record }).await;
}

pub(crate) async fn handle_clear(
    state: &Arc<AppState>,
    peer_id: &str,
    peer_label: &str,
    auth: &ConnectionAuth,
) {
    // LAN is trusted; tunnel guests must be admin (or the RBAC policy
    // wildcard allow-listed `chat_clear`). `dispatch_command` already
    // applied the role allow-list before we got here, so reaching
    // this handler is already approval enough — but we double-check
    // the role explicitly for defense in depth.
    let allowed = match auth {
        ConnectionAuth::Lan => true,
        ConnectionAuth::Authenticated { role_id, .. } => role_id == "admin",
        ConnectionAuth::Unauthenticated => false,
    };
    if !allowed {
        broadcast(
            state,
            Event::Error {
                code: "forbidden".into(),
                message: "chat_clear requires admin role".into(),
            },
        )
        .await;
        return;
    }

    state.chat.messages.write().await.clear();
    broadcast(
        state,
        Event::ChatCleared {
            cleared_by_peer_id: peer_id.to_string(),
            cleared_by_label: peer_label.to_string(),
        },
    )
    .await;
}

pub(crate) async fn handle_history_request(state: &Arc<AppState>) {
    let records: Vec<_> = state.chat.messages.read().await.iter().cloned().collect();
    // History replies broadcast — the sender filters for themselves
    // via the freshness of the reply in their own UI (match on event
    // arrival time rather than trying to address it). This is cheap:
    // history is at most MAX_LIVE_MESSAGES and every client benefits
    // from the fresh snapshot anyway.
    broadcast(state, Event::ChatHistory { records }).await;
}

pub(crate) async fn handle_snapshot(
    state: &Arc<AppState>,
    auth: &ConnectionAuth,
    filename: Option<String>,
) {
    let allowed = match auth {
        ConnectionAuth::Lan => true,
        ConnectionAuth::Authenticated { role_id, .. } => role_id == "admin",
        ConnectionAuth::Unauthenticated => false,
    };
    if !allowed {
        broadcast(
            state,
            Event::Error {
                code: "forbidden".into(),
                message: "chat_snapshot requires admin role".into(),
            },
        )
        .await;
        return;
    }

    let dir = match chat_dir() {
        Ok(d) => d,
        Err(e) => {
            broadcast(
                state,
                Event::Error {
                    code: "chat_snapshot_failed".into(),
                    message: format!("chat dir unavailable: {e}"),
                },
            )
            .await;
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        broadcast(
            state,
            Event::Error {
                code: "chat_snapshot_failed".into(),
                message: format!("create chat dir: {e}"),
            },
        )
        .await;
        return;
    }

    let fname = sanitize_filename(filename.as_deref()).unwrap_or_else(|| {
        format!(
            "chat-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        )
    });
    let path = dir.join(&fname);

    let records: Vec<_> = state.chat.messages.read().await.iter().cloned().collect();
    let count = records.len() as u32;

    let mut out = String::with_capacity(records.len() * 200);
    for rec in &records {
        match serde_json::to_string(rec) {
            Ok(line) => {
                out.push_str(&line);
                out.push('\n');
            }
            Err(e) => {
                tracing::warn!("chat snapshot: skipping un-serializable record: {e}");
            }
        }
    }
    if let Err(e) = std::fs::write(&path, out.as_bytes()) {
        broadcast(
            state,
            Event::Error {
                code: "chat_snapshot_failed".into(),
                message: format!("write {}: {}", path.display(), e),
            },
        )
        .await;
        return;
    }

    broadcast(
        state,
        Event::ChatSnapshotSaved {
            path: fname,
            message_count: count,
        },
    )
    .await;
}

pub(crate) async fn handle_ptt_start(state: &Arc<AppState>, peer_id: &str, peer_label: &str) {
    // Resolve the hold state, release the lock, then react.
    enum Decision {
        Claim(PttSpeaker),
        Idempotent,
        Conflict(String),
    }
    let decision = {
        let mut slot = state.chat.speaker.write().await;
        match slot.as_ref() {
            Some(current) if current.peer_id == peer_id => Decision::Idempotent,
            Some(current) => Decision::Conflict(current.label.clone()),
            None => {
                let speaker = PttSpeaker {
                    peer_id: peer_id.to_string(),
                    label: peer_label.to_string(),
                    since_ms: now_ms(),
                };
                *slot = Some(speaker.clone());
                Decision::Claim(speaker)
            }
        }
    };
    match decision {
        Decision::Idempotent => {}
        Decision::Conflict(label) => {
            broadcast(
                state,
                Event::Error {
                    code: "ptt_conflict".into(),
                    message: format!("{label} is already speaking"),
                },
            )
            .await;
        }
        Decision::Claim(speaker) => {
            broadcast(
                state,
                Event::PttState {
                    speaker: Some(speaker),
                },
            )
            .await;
        }
    }
}

pub(crate) async fn handle_ptt_stop(state: &Arc<AppState>, peer_id: &str) {
    let mut slot = state.chat.speaker.write().await;
    match slot.as_ref() {
        Some(current) if current.peer_id == peer_id => {
            *slot = None;
            drop(slot);
            broadcast(state, Event::PttState { speaker: None }).await;
        }
        _ => {
            // Not our slot to release — ignore silently.
        }
    }
}

/// Fan out a binary WS frame from the speaker to every connected
/// peer. Only the peer currently holding PTT is allowed to emit
/// audio; frames from anyone else (race between press and server
/// ack) get dropped.
pub(crate) async fn handle_binary(
    state: &Arc<AppState>,
    peer_id: &str,
    _peer_label: &str,
    frame: &[u8],
) {
    if frame.len() < MIN_PTT_FRAME_LEN {
        return;
    }
    if frame[0] != PTT_MAGIC {
        return;
    }
    if frame[1] != PTT_VERSION {
        return;
    }

    // Only the acknowledged speaker can post PTT audio.
    {
        let slot = state.chat.speaker.read().await;
        match slot.as_ref() {
            Some(s) if s.peer_id == peer_id => {}
            _ => return,
        }
    }

    // Build outbound framing: magic, version, ts_ms BE, 32-char peer id,
    // then payload (unchanged).
    let payload = &frame[2..];
    let mut out = Vec::with_capacity(2 + 8 + 32 + payload.len());
    out.push(PTT_MAGIC);
    out.push(PTT_VERSION);
    out.extend_from_slice(&now_ms().to_be_bytes());
    // peer_id is a 32-char hex (uuid::Uuid::simple()); clients parse
    // fixed-width.
    let id_bytes = peer_id.as_bytes();
    if id_bytes.len() >= 32 {
        out.extend_from_slice(&id_bytes[..32]);
    } else {
        // Shorter ids are left-padded with '0' so downstream parsers
        // always see 32 chars. Realistically uuid::simple() is
        // always 32, but this keeps the contract clean.
        out.resize(out.len() + (32 - id_bytes.len()), b'0');
        out.extend_from_slice(id_bytes);
    }
    out.extend_from_slice(payload);

    // Send to every active broadcast subscriber. The WS handler
    // writer loop reads `state.tx` for envelopes; we use a second
    // channel for binary fanout so the JSON envelope stream stays
    // clean.
    let _ = state.ptt_tx.send(out);
}

fn chat_dir() -> std::io::Result<PathBuf> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| std::io::Error::other("no XDG data dir"))?;
    Ok(base.join("foyer").join("chat"))
}

fn sanitize_filename(input: Option<&str>) -> Option<String> {
    let raw = input?.trim();
    if raw.is_empty() {
        return None;
    }
    // Basename only — strip any leading `../` or `/foo/bar/`. Replace
    // disallowed characters with `_` to avoid surprises on weird
    // filesystems. Cap length at 120 so the resulting path fits in
    // common filesystem limits.
    let base = std::path::Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("chat");
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let safe = safe.trim().to_string();
    if safe.is_empty() {
        None
    } else if safe.ends_with(".jsonl") {
        Some(safe)
    } else {
        Some(format!("{safe}.jsonl"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_paths() {
        assert_eq!(
            sanitize_filename(Some("../../etc/passwd")),
            Some("passwd.jsonl".into())
        );
        assert_eq!(
            sanitize_filename(Some("team meeting 2026-04-24")),
            Some("team meeting 2026-04-24.jsonl".into())
        );
        assert_eq!(
            sanitize_filename(Some("rich/notes.jsonl")),
            Some("notes.jsonl".into())
        );
        assert_eq!(sanitize_filename(Some("")), None);
        assert_eq!(sanitize_filename(None), None);
    }

    #[test]
    fn sanitize_filename_replaces_weird_chars() {
        let out = sanitize_filename(Some("hello\nworld\t$session#1"))
            .expect("non-empty input should sanitize");
        assert!(!out.contains('\n'));
        assert!(!out.contains('\t'));
        assert!(!out.contains('$'));
        assert!(out.ends_with(".jsonl"));
    }
}
