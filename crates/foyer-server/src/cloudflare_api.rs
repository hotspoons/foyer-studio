//! Minimal Cloudflare v4 REST client — just enough to auto-provision a
//! Cloudflare Tunnel end-to-end (create tunnel → fetch run token → set
//! ingress config → upsert DNS CNAME).
//!
//! Why this module exists: Cloudflare does not publish a Rust SDK. Their
//! official SDKs are Go, Python, Node, TypeScript, PHP. The unofficial
//! community crate (`cloudflare-rs`) predates the `cfd_tunnel` endpoints
//! and doesn't expose the Tunnel configuration / token / ingress APIs we
//! need here, so it would not reduce the amount of code. Calling the v4
//! REST endpoints directly with `reqwest` is a few hundred lines and
//! avoids an unmaintained dependency.
//!
//! All endpoints use `Authorization: Bearer <api_token>`. The API token
//! needs two permissions:
//!   • **Account → Cloudflare Tunnel → Edit**  (tunnel + ingress config)
//!   • **Zone   → DNS          → Edit**        (DNS CNAME upsert)
//!
//! Create one at <https://dash.cloudflare.com/profile/api-tokens> via
//! the "Create Custom Token" flow.
//!
//! Cloudflare wraps every response in the v4 envelope shape:
//! ```json
//! {
//!   "success": true | false,
//!   "errors":   [ { "code": 7003, "message": "..." } ],
//!   "messages": [ ... ],
//!   "result":   <T>                // absent on error
//! }
//! ```
//! We surface `errors[]` as an anyhow chain so the user sees the actual
//! Cloudflare diagnostic ("zone not found", "DNS name invalid", etc.)
//! instead of a generic HTTP failure.
//!
//! All functions here are *idempotent where practical*: `create_tunnel`
//! reuses an existing tunnel with the same name; `ensure_dns_cname`
//! updates the record in place if it already exists. That way restarting
//! the tunnel doesn't leave orphaned Cloudflare objects.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.cloudflare.com/client/v4";

// ─── Envelope decoding ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<ApiError>,
    // Option<T> is already treated as optional by serde; adding
    // `#[serde(default)]` here pulls in a spurious `T: Default` bound.
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

fn decode_errors(errs: &[ApiError]) -> String {
    if errs.is_empty() {
        "cloudflare api: request failed (no error detail)".to_string()
    } else {
        errs.iter()
            .map(|e| format!("{} ({})", e.message, e.code))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

async fn send_json<T: for<'de> Deserialize<'de>>(req: reqwest::RequestBuilder) -> Result<T> {
    // Capture status+body so 401/403/5xx don't get silently swallowed
    // by serde when the body isn't the expected envelope shape.
    let resp = req.send().await.context("cloudflare api request")?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .context("cloudflare api: read response body")?;
    let env: Envelope<T> = match serde_json::from_str(&text) {
        Ok(e) => e,
        Err(e) => bail!(
            "cloudflare api {}: {} (body: {})",
            status,
            e,
            text.chars().take(500).collect::<String>()
        ),
    };
    if !env.success {
        bail!("cloudflare api {}: {}", status, decode_errors(&env.errors));
    }
    env.result
        .ok_or_else(|| anyhow!("cloudflare api {}: success but no result", status))
}

// ─── Public types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
}

// ─── Tunnel lifecycle ────────────────────────────────────────────────

/// Find a tunnel by exact name, skipping soft-deleted entries.
/// Cloudflare's DELETE on tunnels is logical — the record sticks around
/// with a `deleted_at` timestamp and would otherwise confuse our
/// create-or-reuse logic.
pub async fn find_tunnel_by_name(
    http: &reqwest::Client,
    token: &str,
    account_id: &str,
    name: &str,
) -> Result<Option<Tunnel>> {
    #[derive(Debug, Deserialize)]
    struct Raw {
        id: String,
        name: String,
        #[serde(default)]
        deleted_at: Option<String>,
    }
    let url = format!(
        "{API_BASE}/accounts/{account_id}/cfd_tunnel?name={}",
        urlencoding::encode(name)
    );
    let list: Vec<Raw> = send_json(http.get(&url).bearer_auth(token)).await?;
    Ok(list
        .into_iter()
        .find(|t| t.deleted_at.is_none())
        .map(|t| Tunnel {
            id: t.id,
            name: t.name,
        }))
}

/// Create a new Cloudflare Tunnel with `config_src: cloudflare` so
/// ingress lives in the Cloudflare side (we push it via
/// `set_tunnel_ingress`) rather than a local config.yml. Generates a
/// fresh 32-byte base64 tunnel secret — we never need it again because
/// we fetch run tokens via the /token endpoint, but the create API
/// requires it.
pub async fn create_tunnel(
    http: &reqwest::Client,
    token: &str,
    account_id: &str,
    name: &str,
) -> Result<Tunnel> {
    use base64::Engine;
    use rand::RngCore;

    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    let secret_b64 = base64::engine::general_purpose::STANDARD.encode(secret);

    #[derive(Serialize)]
    struct Body<'a> {
        name: &'a str,
        tunnel_secret: String,
        config_src: &'a str,
    }
    let body = Body {
        name,
        tunnel_secret: secret_b64,
        config_src: "cloudflare",
    };
    let url = format!("{API_BASE}/accounts/{account_id}/cfd_tunnel");
    send_json(http.post(&url).bearer_auth(token).json(&body)).await
}

/// Fetch the connector run token for a tunnel. This is the opaque
/// base64 blob `cloudflared tunnel run --token <...>` consumes.
pub async fn get_tunnel_run_token(
    http: &reqwest::Client,
    token: &str,
    account_id: &str,
    tunnel_id: &str,
) -> Result<String> {
    let url = format!("{API_BASE}/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token");
    let tok: String = send_json(http.get(&url).bearer_auth(token)).await?;
    Ok(tok)
}

/// PUT the ingress config for a tunnel. The shape is a plain replace —
/// we always send the full rule list, terminating with the required
/// catch-all `http_status:404` rule that Cloudflare enforces.
pub async fn set_tunnel_ingress(
    http: &reqwest::Client,
    token: &str,
    account_id: &str,
    tunnel_id: &str,
    hostname: &str,
    service_url: &str,
) -> Result<()> {
    let body = serde_json::json!({
        "config": {
            "ingress": [
                { "hostname": hostname, "service": service_url },
                { "service": "http_status:404" }
            ]
        }
    });
    let url = format!("{API_BASE}/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations");
    let _: serde_json::Value = send_json(http.put(&url).bearer_auth(token).json(&body)).await?;
    Ok(())
}

// ─── Zone / DNS ──────────────────────────────────────────────────────

/// Pick the zone that best matches a fully-qualified hostname. Walks
/// every zone the token can see and returns the one whose `name` is the
/// longest suffix of `hostname` — so `studio.prod.example.com` picks
/// `prod.example.com` over `example.com` if both zones exist.
pub async fn find_zone_for_hostname(
    http: &reqwest::Client,
    token: &str,
    hostname: &str,
) -> Result<Option<Zone>> {
    let url = format!("{API_BASE}/zones");
    let zones: Vec<Zone> = send_json(http.get(&url).bearer_auth(token)).await?;
    let best = zones
        .into_iter()
        .filter(|z| hostname == z.name || hostname.ends_with(&format!(".{}", z.name)))
        .max_by_key(|z| z.name.len());
    Ok(best)
}

/// Create or update a CNAME record pointing `hostname` at `target`
/// (`<tunnel_id>.cfargotunnel.com`). `proxied: true` is what makes
/// Cloudflare orange-cloud the record so tunnel traffic works.
pub async fn ensure_dns_cname(
    http: &reqwest::Client,
    token: &str,
    zone_id: &str,
    hostname: &str,
    target: &str,
) -> Result<()> {
    #[derive(Debug, Deserialize)]
    struct Raw {
        id: String,
        content: String,
        #[serde(default)]
        proxied: bool,
    }
    let search_url = format!(
        "{API_BASE}/zones/{zone_id}/dns_records?type=CNAME&name={}",
        urlencoding::encode(hostname)
    );
    let existing: Vec<Raw> = send_json(http.get(&search_url).bearer_auth(token)).await?;
    let body = serde_json::json!({
        "type": "CNAME",
        "name": hostname,
        "content": target,
        "proxied": true,
        "ttl": 1, // "auto" — required when proxied
    });
    if let Some(rec) = existing.into_iter().next() {
        if rec.content == target && rec.proxied {
            tracing::info!("dns record {hostname} -> {target} already correct (proxied)");
            return Ok(());
        }
        let url = format!("{API_BASE}/zones/{zone_id}/dns_records/{}", rec.id);
        let _: serde_json::Value = send_json(http.put(&url).bearer_auth(token).json(&body)).await?;
        tracing::info!("updated dns {hostname} -> {target}");
    } else {
        let url = format!("{API_BASE}/zones/{zone_id}/dns_records");
        let _: serde_json::Value =
            send_json(http.post(&url).bearer_auth(token).json(&body)).await?;
        tracing::info!("created dns {hostname} -> {target}");
    }
    Ok(())
}

// ─── One-shot orchestration ──────────────────────────────────────────

/// Result of `provision_tunnel`. The `run_token` is what gets handed to
/// `cloudflared tunnel run --token <...>`.
pub struct ProvisionedTunnel {
    pub tunnel_id: String,
    pub run_token: String,
}

/// End-to-end auto-provision:
///   1. Resolve/auto-discover the zone that owns `hostname`.
///   2. Find or create a tunnel named `tunnel_name`
///      (default: `foyer-<hostname-slug>`).
///   3. Configure ingress: `hostname → service_url` + 404 fallback.
///   4. Upsert CNAME `hostname → <tunnel_id>.cfargotunnel.com` proxied.
///   5. Fetch the run token and return it.
///
/// Returns a clear, user-facing error if any step fails — Cloudflare's
/// error messages are the most useful diagnostic, so we surface them
/// verbatim.
pub async fn provision_tunnel(
    http: &reqwest::Client,
    api_token: &str,
    account_id: &str,
    zone_id: Option<&str>,
    tunnel_name: Option<&str>,
    hostname: &str,
    service_url: &str,
) -> Result<ProvisionedTunnel> {
    let zone = match zone_id {
        Some(zid) => zid.to_string(),
        None => {
            find_zone_for_hostname(http, api_token, hostname)
                .await?
                .ok_or_else(|| {
                    anyhow!(
                        "no Cloudflare zone found for {hostname} — check that the domain \
                     is in this account and the API token has Zone:Read access"
                    )
                })?
                .id
        }
    };
    tracing::info!("cloudflare: using zone {zone} for {hostname}");

    let default_name = default_tunnel_name(hostname);
    let name = tunnel_name.unwrap_or(&default_name);
    let tunnel = match find_tunnel_by_name(http, api_token, account_id, name).await? {
        Some(t) => {
            tracing::info!("cloudflare: reusing tunnel '{}' ({})", t.name, t.id);
            t
        }
        None => {
            let t = create_tunnel(http, api_token, account_id, name).await?;
            tracing::info!("cloudflare: created tunnel '{}' ({})", t.name, t.id);
            t
        }
    };

    set_tunnel_ingress(
        http,
        api_token,
        account_id,
        &tunnel.id,
        hostname,
        service_url,
    )
    .await
    .context("set tunnel ingress")?;
    tracing::info!(
        "cloudflare: ingress {hostname} -> {service_url} on tunnel {}",
        tunnel.id
    );

    let cname_target = format!("{}.cfargotunnel.com", tunnel.id);
    ensure_dns_cname(http, api_token, &zone, hostname, &cname_target)
        .await
        .context("ensure dns cname")?;

    let run_token = get_tunnel_run_token(http, api_token, account_id, &tunnel.id)
        .await
        .context("fetch tunnel run token")?;

    Ok(ProvisionedTunnel {
        tunnel_id: tunnel.id,
        run_token,
    })
}

/// Slug a hostname into a tunnel name like "foyer-studio-example-com".
/// Cloudflare's tunnel name rules are forgiving but lowercase-ASCII keeps
/// it tidy in the dashboard and avoids edge cases with Unicode.
fn default_tunnel_name(hostname: &str) -> String {
    let mut s = String::with_capacity(hostname.len() + 6);
    s.push_str("foyer-");
    for c in hostname.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else {
            s.push('-');
        }
    }
    s
}
