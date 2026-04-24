//! Remote-access tunnel schema — CloudFlare (and future providers).
//!
//! Every incoming WebSocket connection carries an optional token that maps
//! to a role.  When a token is present the server runs in *restricted mode*:
//! commands are filtered through the role's allow-list before reaching the
//! backend.  The tunnel itself (Cloudflare `cloudflared`, Ngrok, whatever)
//! is an orthogonal concern — this module only deals with the *local*
//! auth + sharing surface.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::EntityId;

// ─── Role-based access control ───────────────────────────────────────

/// What a remote user is allowed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelRole {
    /// Read-only: can watch meters, hear audio, see the timeline.
    Viewer,
    /// Can do everything a Viewer can, plus capture live audio/MIDI
    /// from the browser into a dedicated channel (input-only).
    Performer,
    /// Can control the session: play/pause/seek, mute/solo tracks,
    /// adjust channel gain. Cannot edit structure (add/remove tracks,
    /// plugins, regions) or grant/revoke tokens.
    SessionController,
    /// Full access — same as a local user.
    Admin,
}

impl TunnelRole {
    /// Human label used in UI pickers and e-mail invites.
    pub fn label(&self) -> &'static str {
        match self {
            TunnelRole::Viewer => "Viewer / Listener",
            TunnelRole::Performer => "Performer",
            TunnelRole::SessionController => "Session Controller",
            TunnelRole::Admin => "Admin",
        }
    }

    /// One-sentence description for the share form.
    pub fn description(&self) -> &'static str {
        match self {
            TunnelRole::Viewer => "Watch and listen only",
            TunnelRole::Performer => "Send live audio or MIDI into the session",
            TunnelRole::SessionController => {
                "Control transport, levels, mute/solo, and capture input"
            }
            TunnelRole::Admin => "Full control — same as owner",
        }
    }

    /// Whether this role may send the given command type on the wire.
    /// The FE uses the same list to grey-out disallowed controls.
    pub fn allows_command(&self, cmd_id: &str) -> bool {
        match self {
            TunnelRole::Admin => true,

            TunnelRole::SessionController => {
                // Deny structural edits, plugin management, undo, and
                // token management.
                let denied: HashSet<&str> = [
                    "track.add",
                    "track.delete",
                    "track.add_bus",
                    "plugin.add",
                    "plugin.delete",
                    "plugin_window",
                    "create_group",
                    "delete_group",
                    "update_group",
                    "session.save",
                    "session.save_as",
                    "session.new",
                    "session.open",
                    "undo",
                    "redo",
                    "tunnel.create_token",
                    "tunnel.revoke_token",
                ]
                .into();
                !denied.contains(cmd_id)
            }

            TunnelRole::Performer => {
                let allowed: HashSet<&str> = [
                    // Audio ingress only
                    "audio_stream_open",
                    "audio_stream_close",
                    "audio_sdp_answer",
                    "audio_ice_candidate",
                    // Input capture (MIDI, OSC)
                    "capture_input",
                    // Transport read
                    "locate",
                    // Self-presence
                    "ping",
                ]
                .into();
                allowed.contains(cmd_id)
            }

            TunnelRole::Viewer => {
                let allowed: HashSet<&str> = [
                    "audio_stream_open",
                    "audio_stream_close",
                    "audio_sdp_answer",
                    "audio_ice_candidate",
                    "locate",
                    "ping",
                ]
                .into();
                allowed.contains(cmd_id)
            }
        }
    }
}

// ─── Connection token / manifest entry ───────────────────────────────

/// A single shareable connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TunnelConnection {
    /// Stable UUID v4.
    pub id: EntityId,
    /// Name or email address of the person this token is for.
    /// If it contains '@' we attempt to send the link via `mailto:`.
    pub recipient: String,
    /// sha256(token | pepper).  We only store the hash locally — the
    /// original token is shown once at creation time and then
    /// forgotten.
    pub token_hash: String,
    /// Role assigned at creation.  Upgradable only by an Admin.
    pub role: TunnelRole,
    /// When the connection was created (Unix ms).
    pub created_at: u64,
    /// Last successful connection (Unix ms).  `None` = never used.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_seen_at: Option<u64>,
    /// Public hostname the tunnel was serving when this token was created.
    /// Stored per-connection so we can rebuild the share URL later.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tunnel_url: Option<String>,
}

/// Manifest persisted on the *server* machine.  One manifest per
/// Foyer data dir (`$XDG_DATA_HOME/foyer/tunnel-manifest.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TunnelManifest {
    /// All live connections.  Revoking == removing the entry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<TunnelConnection>,
    /// Global toggle — when `false`, every token is rejected
    /// regardless of its presence in `connections`.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Which provider is currently active.  `None` = tunnels
    /// disabled / local-only mode.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_provider: Option<TunnelProviderKind>,
    /// Public URL of the active tunnel (e.g. "https://abc.trycloudflare.com").
    /// Persisted so the URL survives server restarts.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_provider_url: Option<String>,
}

fn yes() -> bool { true }

// ─── Provider enum (extensible) ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelProviderKind {
    Ngrok,
    Cloudflare,
}

/// Provider-specific configuration.  The UI renders a form per variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TunnelProviderConfig {
    Ngrok {
        /// Optional auth token.  When omitted the provider reads
        /// `NGROK_AUTHTOKEN` from the environment.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        auth_token: Option<String>,
        /// Region to request (us, eu, ap, au, sa, jp, in).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        region: Option<String>,
        /// Subdomain for paid plans.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subdomain: Option<String>,
        /// Custom domain for paid plans.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        domain: Option<String>,
    },
    Cloudflare {
        /// Cloudflare API token with `Account:Cloudflare Tunnel:Edit` and
        /// `Zone:DNS:Edit` permissions. Set alongside `account_id` and
        /// `hostname` to enable fully auto-provisioned named tunnels —
        /// the server creates the tunnel, configures ingress, and
        /// upserts the DNS CNAME record on the user's behalf.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        api_token: Option<String>,
        /// Cloudflare account ID. Required with `api_token` for the
        /// auto-provisioning flow.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        account_id: Option<String>,
        /// Cloudflare zone ID — the DNS zone the hostname lives under.
        /// Optional; when omitted the server lists zones the token can
        /// see and picks the longest-suffix match against `hostname`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        zone_id: Option<String>,
        /// Name to use when creating the tunnel in Cloudflare. If the
        /// tunnel already exists under this name, it's reused instead of
        /// duplicated. Defaults to `foyer-<hostname-slugified>`.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        tunnel_name: Option<String>,
        /// Public hostname to serve the session on (e.g. "studio.example.com").
        /// Required for both auto-provision (`api_token`) and raw-token
        /// (`tunnel_token`) modes. Omit to get a `*.trycloudflare.com`
        /// quick tunnel instead.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        hostname: Option<String>,
        /// Raw Tunnel token pasted from the Cloudflare Zero Trust dashboard
        /// ("Install and run a connector"). Bypasses the API flow entirely —
        /// ingress + DNS must already be configured on the dashboard side.
        /// Useful when the user doesn't want to hand us an API token.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        tunnel_token: Option<String>,
    },
}

// ─── Wire events / commands ──────────────────────────────────────────

/// Server → FE: current manifest snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TunnelState {
    pub enabled: bool,
    pub active_provider: Option<TunnelProviderKind>,
    /// Public URL of the active tunnel (e.g. "https://abc.trycloudflare.com").
    pub active_provider_url: Option<String>,
    pub connections: Vec<TunnelConnection>,
}

/// Server → FE: a new tunnel just came up (or changed hostname).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TunnelUp {
    pub provider: TunnelProviderKind,
    pub hostname: String,
    pub url: String,
}

/// FE → Server: create a new shareable token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TunnelCreateToken {
    pub label: String,
    pub role: TunnelRole,
    pub email: Option<String>,
}

/// FE → Server: revoke a token permanently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TunnelRevokeToken {
    pub id: EntityId,
}
