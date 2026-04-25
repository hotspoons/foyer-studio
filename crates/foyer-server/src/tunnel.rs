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
        Err(e) => {
            tracing::warn!("tunnel manifest path err: {e}");
            return TunnelManifest::default();
        }
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => TunnelManifest::default(),
    }
}

pub async fn save_manifest(manifest: &TunnelManifest) -> anyhow::Result<()> {
    let path = manifest_path()?;
    let raw = serde_json::to_string_pretty(manifest)?;
    let mut tmp =
        tempfile::NamedTempFile::with_prefix_in("tunnel-manifest", path.parent().unwrap())?;
    tmp.write_all(raw.as_bytes())?;
    tmp.flush()?;
    tokio::fs::rename(tmp.path(), &path).await?;
    Ok(())
}

// ─── Credential hashing + generation ─────────────────────────────────
//
// Auth model: each connection is identified by an email + password pair.
// The server stores `sha256(email_norm:password|pepper)` (hex-encoded).
// The URL token is `base64url(sha256_bytes(email_norm:password|pepper))`
// — i.e. the same digest, base64'd instead of hex'd. The token is *not*
// reversible: an invite URL leaking does not directly expose the
// recipient's email or the generated password. (It still grants access
// to whoever holds it — that's the trust model. This is theater on top
// of an opaque-bearer-token design, not bank-grade auth.)
//
// Two paths can authenticate:
//
//   1. URL token (`?token=<base64url>`): decode → 32 bytes → hex →
//      direct match against stored `token_hash`. No knowledge of the
//      original credentials required by the server side.
//
//   2. Form login (`verify_credentials`): hash the user-typed
//      email+password with the same pepper, match against stored
//      `token_hash`. Inputs are clear text on the wire to the server
//      but never written anywhere.
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

/// Raw 32-byte sha256 digest of `email_norm:password|pepper`. Internal
/// helper — callers either hex-encode (storage) or base64url-encode
/// (URL token) the result. Pepper keeps the stored hashes from being
/// trivially rainbow-table'd if the manifest file leaks.
fn digest_credentials(email_norm: &str, password: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(email_norm.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    hasher.update(HASH_PEPPER.as_bytes());
    hasher.finalize().into()
}

/// Hex-encoded credential digest. This is what we persist in
/// `TunnelConnection.token_hash` and what we match against on auth.
fn hash_credentials(email_norm: &str, password: &str) -> String {
    hex::encode(digest_credentials(email_norm, password))
}

/// Base64url-encoded credential digest — the opaque URL token.
/// `URL_SAFE_NO_PAD` so the string is drop-in for a `?token=` query
/// parameter without percent-encoding surprises. 32 raw bytes → 43
/// chars unpadded base64url.
///
/// **Not reversible**: the token contains the digest, not the
/// credentials. To authorize, the server decodes the b64 back to
/// bytes, hex-encodes, and compares to the stored hash.
fn encode_token(email_norm: &str, password: &str) -> String {
    let digest = digest_credentials(email_norm, password);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// Decode a URL token to its hex hash form, ready for direct match
/// against `TunnelConnection.token_hash`. Returns `None` if the token
/// isn't valid base64url or doesn't decode to exactly 32 bytes.
fn decode_token_to_hash(token: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .ok()?;
    if bytes.len() != 32 {
        return None;
    }
    Some(hex::encode(bytes))
}

/// Random 16-char password. Alphabet excludes visually-ambiguous
/// characters (0/O, 1/l/I) so users can hand-type from a phone screen
/// without second-guessing.
fn generate_password() -> String {
    use rand::{rngs::StdRng, Rng, SeedableRng};
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = StdRng::from_entropy();
    (0..16)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
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
///   · `token` is the opaque `base64url(sha256(email:password|pepper))`
///     string — used in the share URL as `?token=<...>`. Not reversible
///     to the original credentials; the token IS the digest.
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
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '@' || c == '.' {
                    c
                } else {
                    '-'
                }
            })
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
        id: foyer_schema::EntityId::new(format!("conn_{}", &token[..12.min(token.len())])),
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
        save_manifest(&m).await?;
    }
    broadcast_tunnel_state(state).await;
    Ok((conn, token, password))
}

pub async fn revoke_token(state: &AppState, id: &foyer_schema::EntityId) -> anyhow::Result<()> {
    {
        let mut m = state.tunnel_manifest.write().await;
        m.connections.retain(|c| &c.id != id);
        save_manifest(&m).await?;
    }
    broadcast_tunnel_state(state).await;
    Ok(())
}

/// Validate a tunnel URL token against the manifest. The token is
/// `base64url(sha256_bytes(...))`; decoding gives us the hash directly,
/// no knowledge of the original credentials needed.
#[allow(dead_code)]
pub async fn verify_token(state: &AppState, token: &str) -> Option<TunnelConnection> {
    let hash = decode_token_to_hash(token)?;
    let m = state.tunnel_manifest.read().await;
    if !m.enabled {
        return None;
    }
    m.connections.iter().find(|c| c.token_hash == hash).cloned()
}

/// Validate a raw (email, password) pair — for the form-login endpoint
/// that doesn't use the URL token. Hashes the inputs with the same
/// pepper used at invite time and matches against the stored
/// `token_hash`. The returned `TunnelConnection` carries role +
/// recipient; the form-login handler uses it to mint the matching
/// digest token to send back to the client.
pub async fn verify_credentials(
    state: &AppState,
    email: &str,
    password: &str,
) -> Option<TunnelConnection> {
    let email_norm = normalize_email(email);
    let hash = hash_credentials(&email_norm, password);
    let m = state.tunnel_manifest.read().await;
    if !m.enabled {
        return None;
    }
    m.connections.iter().find(|c| c.token_hash == hash).cloned()
}

/// Mint the URL token for a given (email, password) pair. Used by the
/// form-login bridge: after `verify_credentials` succeeds, the server
/// regenerates the token deterministically from the same inputs and
/// hands it back so the client can redirect with `?token=...`. Same
/// digest as the invite URL — `base64url(sha256(...|pepper))`.
pub fn token_for_credentials(email: &str, password: &str) -> String {
    let email_norm = normalize_email(email);
    encode_token(&email_norm, password)
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
        // Rewrite every existing connection's share URL onto the new
        // hostname. Quick tunnels rotate `*.trycloudflare.com` on
        // every restart; a stale invite URL from the last run would
        // 404. We reuse the token already baked into the old URL
        // (`?token=<base64url(digest)>`) so existing invites remain
        // valid — the stored hash didn't change.
        let renamed = rewrite_connection_urls(&mut m.connections, &hostname);
        if renamed > 0 {
            tracing::info!("tunnel: rewrote {renamed} share URL(s) onto {hostname}");
        }
        let _ = save_manifest(&m).await;
    }
    broadcast_tunnel_state(&state).await;
    broadcast_event(
        &state,
        Event::TunnelUp {
            provider: kind,
            hostname: hostname.clone(),
            url: hostname,
        },
    )
    .await;
    Ok(())
}

/// Rewrite each connection's `tunnel_url` so the host portion matches
/// the current tunnel hostname. Extracts the existing `?token=...`
/// from the old URL (so we don't need the clear-text password — the
/// stored hash is unchanged and the token is URL-addressable data)
/// and re-stitches it onto the new hostname. Returns how many entries
/// were rewritten, for logging.
///
/// Connections with a malformed or tokenless URL are left alone —
/// the invite is effectively dead either way and we'd rather surface
/// that by leaving the old URL visible than quietly hand out something
/// that won't actually authenticate.
fn rewrite_connection_urls(
    connections: &mut [foyer_schema::TunnelConnection],
    hostname: &str,
) -> usize {
    let mut n = 0;
    let scheme_prefix = if hostname.starts_with("http://") || hostname.starts_with("https://") {
        String::new()
    } else {
        "https://".to_string()
    };
    for conn in connections.iter_mut() {
        let Some(ref old_url) = conn.tunnel_url else {
            continue;
        };
        let Some(token) = extract_token_param(old_url) else {
            continue;
        };
        let new_url = format!("{scheme_prefix}{hostname}/?token={token}");
        if Some(&new_url) != conn.tunnel_url.as_ref() {
            conn.tunnel_url = Some(new_url);
            n += 1;
        }
    }
    n
}

/// Pull `?token=<value>` out of a share URL. Lightweight parse — we
/// don't want to pull `url::Url` into the hot loop and we control the
/// exact shape we wrote in `create_token`. Returns `None` if the URL
/// doesn't have a `token=` query param.
fn extract_token_param(url: &str) -> Option<&str> {
    let (_, query) = url.split_once('?')?;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("token=") {
            return Some(value);
        }
    }
    None
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
        let _ = save_manifest(&m).await;
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
            m.active_provider,
            m.active_provider_url.clone(),
            m.connections.clone(),
        )
    };
    broadcast_event(
        state,
        Event::TunnelState {
            state: TunnelState {
                enabled,
                active_provider: provider,
                active_provider_url: provider_url,
                connections,
            },
        },
    )
    .await;
}

async fn broadcast_event(state: &AppState, event: Event) {
    use foyer_schema::SCHEMA_VERSION;
    use std::sync::atomic::Ordering;
    let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
    let env = Envelope {
        schema: SCHEMA_VERSION,
        seq,
        origin: Some("server".into()),
        session_id: None,
        body: event,
    };
    state.ring.write().await.push(env.clone());
    let _ = state.tx.send(env);
}
