//! Remote-access tunnel manager — supports ngrok (embedded) and Cloudflare
//! (cloudflared subprocess + secondary auth server).

use std::io::Write;
use std::path::PathBuf;

use foyer_schema::{
    Envelope, Event, TunnelConnection, TunnelManifest, TunnelProviderConfig, TunnelProviderKind,
    TunnelRole, TunnelState,
};

use crate::AppState;

const HASH_PEPPER: &str = "foyer_tunnel_v1_pepper_4692a1f3";
const MANIFEST_FILE: &str = "tunnel-manifest.json";

fn manifest_path() -> anyhow::Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow::anyhow!("no data dir"))?;
    let dir = base.join("foyer");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(MANIFEST_FILE))
}

#[allow(dead_code)]
pub async fn load_manifest() -> TunnelManifest {
    let path = match manifest_path() {
        Ok(p) => p,
        Err(e) => { tracing::warn!("tunnel manifest path err: {e}"); return TunnelManifest::default(); }
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => TunnelManifest::default(),
    }
}

pub async fn save_manifest(manifest: &TunnelManifest) -> anyhow::Result<()> {
    let path = manifest_path()?;
    let raw = serde_json::to_string_pretty(manifest)?;
    let mut tmp = tempfile::NamedTempFile::with_prefix_in("tunnel-manifest", path.parent().unwrap())?;
    tmp.write_all(raw.as_bytes())?;
    tmp.flush()?;
    tokio::fs::rename(tmp.path(), &path).await?;
    Ok(())
}

// ─── Credential hashing + generation ─────────────────────────────────
//
// Auth model: each connection is identified by an email + password pair.
// The server stores `sha256(normalize(email):password|pepper)` — never
// the password itself. The URL token is `base64url(normalize(email):password)`,
// which clients pass as `?token=<...>` and we decode to rehash and match.
//
// Email normalization is trim + ASCII-lowercase. This avoids a user
// getting locked out because they typed `Bob@EXAMPLE.com` at login
// after the invite was created for `bob@example.com`. International
// (IDN) local-parts keep their Unicode casing — Unicode lowercasing is
// a big dependency to pull in for an edge case that isn't on the
// critical path today.

use base64::Engine;

/// Lowercase + trim. This is what we hash and what we put in URLs.
fn normalize_email(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// sha256(`email_norm:password` || pepper), hex-encoded. Pepper keeps
/// the stored hashes from being trivially rainbow-table'd if the
/// manifest file leaks.
fn hash_credentials(email_norm: &str, password: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(email_norm.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    hasher.update(HASH_PEPPER.as_bytes());
    hex::encode(hasher.finalize())
}

/// Base64url-encoded `email_norm:password` — the opaque URL token.
/// `URL_SAFE_NO_PAD` so the string is drop-in for a `?token=` query
/// parameter without percent-encoding surprises.
fn encode_token(email_norm: &str, password: &str) -> String {
    let raw = format!("{email_norm}:{password}");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

/// Inverse of `encode_token`. Returns `(email_norm, password)` on
/// success, `None` on malformed input. Callers use this during WS
/// handshake to locate and authorize a connection.
fn decode_token(token: &str) -> Option<(String, String)> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .ok()?;
    let s = std::str::from_utf8(&bytes).ok()?;
    let (email, password) = s.split_once(':')?;
    if email.is_empty() || password.is_empty() {
        return None;
    }
    Some((email.to_string(), password.to_string()))
}

/// Random 16-char password. Alphabet excludes visually-ambiguous
/// characters (0/O, 1/l/I) so users can hand-type from a phone screen
/// without second-guessing.
fn generate_password() -> String {
    use rand::{rngs::StdRng, Rng, SeedableRng};
    const ALPHABET: &[u8] =
        b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = StdRng::from_entropy();
    (0..16).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

// ─── Token CRUD ──────────────────────────────────────────────────────

/// True when the recipient string parses as a plausible email. Used to
/// decide whether we can auto-derive a username from `recipient` (the
/// schema field is a display name; for non-email recipients the user
/// still needs a normalized username, which we slug from the display
/// name).
fn looks_like_email(s: &str) -> bool {
    s.contains('@') && s.contains('.')
}

/// Create a new connection entry and return the generated credentials.
///
/// The returned tuple is `(connection, token, password)`:
///   · `connection` is what gets stored and broadcast to clients.
///   · `token` is the opaque `base64url(email:password)` string — used
///     in the share URL as `?token=<...>`.
///   · `password` is the raw clear-text password, shown once in the UI.
///     Never persisted server-side.
pub async fn create_token(
    state: &AppState,
    recipient: String,
    role: TunnelRole,
) -> anyhow::Result<(TunnelConnection, String, String)> {
    // Derive the normalized username from the recipient. For real email
    // addresses this is trim+lowercase; for free-form names we slug
    // them (spaces→hyphens, lowercased) so the username is stable even
    // when the user typed something like "Bob Smith" as the label.
    let email_norm = if looks_like_email(&recipient) {
        normalize_email(&recipient)
    } else {
        recipient
            .trim()
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '@' || c == '.' { c } else { '-' })
            .collect::<String>()
    };
    let password = generate_password();
    let hash = hash_credentials(&email_norm, &password);
    let token = encode_token(&email_norm, &password);
    let tunnel_url = {
        let m = state.tunnel_manifest.read().await;
        m.active_provider_url.clone().map(|h| {
            if h.starts_with("http://") || h.starts_with("https://") {
                format!("{h}/?token={token}")
            } else {
                format!("https://{h}/?token={token}")
            }
        })
    };
    let conn = TunnelConnection {
        id: foyer_schema::EntityId::new(&format!("conn_{}", &token[..12.min(token.len())])),
        recipient: recipient.clone(),
        token_hash: hash,
        role,
        created_at: now_ms(),
        last_seen_at: None,
        tunnel_url,
    };
    {
        let mut m = state.tunnel_manifest.write().await;
        m.connections.push(conn.clone());
        save_manifest(&*m).await?;
    }
    broadcast_tunnel_state(state).await;
    Ok((conn, token, password))
}

pub async fn revoke_token(state: &AppState, id: &foyer_schema::EntityId) -> anyhow::Result<()> {
    {
        let mut m = state.tunnel_manifest.write().await;
        m.connections.retain(|c| &c.id != id);
        save_manifest(&*m).await?;
    }
    broadcast_tunnel_state(state).await;
    Ok(())
}

/// Validate a tunnel URL token against the manifest. The token is
/// `base64url(email_norm:password)`; we decode it, recompute the
/// credential hash, and match against the connections list.
#[allow(dead_code)]
pub async fn verify_token(state: &AppState, token: &str) -> Option<TunnelConnection> {
    let (email_norm, password) = decode_token(token)?;
    let hash = hash_credentials(&email_norm, &password);
    let m = state.tunnel_manifest.read().await;
    if !m.enabled { return None; }
    m.connections.iter().find(|c| c.token_hash == hash).cloned()
}

/// Validate a raw (email, password) pair — for a login form endpoint
/// that doesn't use the URL token. Mirrors `verify_token` but takes
/// clear-text inputs and normalizes the email before hashing.
#[allow(dead_code)]
pub async fn verify_credentials(
    state: &AppState,
    email: &str,
    password: &str,
) -> Option<TunnelConnection> {
    let email_norm = normalize_email(email);
    let hash = hash_credentials(&email_norm, password);
    let m = state.tunnel_manifest.read().await;
    if !m.enabled { return None; }
    m.connections.iter().find(|c| c.token_hash == hash).cloned()
}

// ─── Provider lifecycle ──────────────────────────────────────────────

pub async fn start_tunnel(
    state: std::sync::Arc<AppState>,
    kind: TunnelProviderKind,
    config: &TunnelProviderConfig,
) -> anyhow::Result<()> {
    let port = state.listen_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        anyhow::bail!("server port not yet known — cannot start tunnel");
    }
    let https = state.tls_enabled.load(std::sync::atomic::Ordering::Relaxed);

    // Stop any existing tunnel first.
    stop_tunnel(&state).await;

    let provider = crate::tunnel_provider::make_provider(kind, config)?;
    let target = crate::tunnel_provider::LocalTarget { port, https };
    let hostname = {
        let mut p = provider.lock().await;
        p.start(target, state.clone()).await?
    };
    tracing::info!("tunnel active: {} -> {:?}", hostname, kind);
    *state.tunnel_hostname.write().await = Some(hostname.clone());
    *state.tunnel_provider.lock().await = Some(provider);
    {
        let mut m = state.tunnel_manifest.write().await;
        m.active_provider = Some(kind);
        // Persist the tunnel URL so it's available after restarts.
        m.active_provider_url = Some(hostname.clone());
        let _ = save_manifest(&*m).await;
    }
    broadcast_tunnel_state(&state).await;
    broadcast_event(
        &state,
        Event::TunnelUp {
            provider: kind,
            hostname: hostname.clone(),
            url: hostname,
        },
    ).await;
    Ok(())
}

pub async fn stop_tunnel(state: &AppState) {
    let provider_kind = {
        let m = state.tunnel_manifest.read().await;
        m.active_provider
    };
    if let Some(p) = state.tunnel_provider.lock().await.take() {
        let mut locked = p.lock().await;
        locked.stop().await;
    }
    *state.tunnel_hostname.write().await = None;
    {
        let mut m = state.tunnel_manifest.write().await;
        m.active_provider = None;
        m.active_provider_url = None;
        let _ = save_manifest(&*m).await;
    }
    broadcast_tunnel_state(state).await;
    if let Some(kind) = provider_kind {
        broadcast_event(state, Event::TunnelDown { provider: kind }).await;
    }
}

// ─── Command gating ──────────────────────────────────────────────────

#[allow(dead_code)]
pub async fn connection_role(
    state: &AppState,
    env: &Envelope<foyer_schema::Command>,
) -> TunnelRole {
    if let Some(ref origin) = env.origin {
        if let Some(token) = origin.strip_prefix("token:") {
            if let Some(conn) = verify_token(state, token).await {
                return conn.role;
            }
        }
    }
    TunnelRole::Admin
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) async fn broadcast_tunnel_state(state: &AppState) {
    let (enabled, provider, provider_url, connections) = {
        let m = state.tunnel_manifest.read().await;
        (
            m.enabled,
            m.active_provider.clone(),
            m.active_provider_url.clone(),
            m.connections.clone(),
        )
    };
    broadcast_event(
        state,
        Event::TunnelState {
            state: TunnelState { enabled, active_provider: provider, active_provider_url: provider_url, connections },
        },
    ).await;
}

async fn broadcast_event(state: &AppState, event: Event) {
    use std::sync::atomic::Ordering;
    use foyer_schema::SCHEMA_VERSION;
    let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
    let env = Envelope {
        schema: SCHEMA_VERSION, seq,
        origin: Some("server".into()),
        session_id: None, body: event,
    };
    state.ring.write().await.push(env.clone());
    let _ = state.tx.send(env);
}
