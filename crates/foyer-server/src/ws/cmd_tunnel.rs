// SPDX-License-Identifier: Apache-2.0
//! Tunnel-management `Command` handlers — token mint / revoke /
//! enable / start / stop / state. Heavy lifting lives in
//! `crate::tunnel`; these are routing shims that emit
//! `Event::Error` on failure so the FE shows a banner instead of
//! a silent no-op.

use std::sync::Arc;

use foyer_schema::{EntityId, Event, TunnelProviderConfig, TunnelProviderKind, TunnelRole};

use super::broadcast_event;
use crate::AppState;

pub(super) async fn create_token(state: &Arc<AppState>, recipient: String, role: TunnelRole) {
    match crate::tunnel::create_token(state, recipient.clone(), role).await {
        Ok((conn, token, password)) => {
            let url = conn
                .tunnel_url
                .clone()
                .unwrap_or_else(|| format!("http://localhost:3838/?token={token}"));
            tracing::info!("tunnel token created for {recipient}: {url}");
            broadcast_event(
                state,
                Event::TunnelTokenCreated {
                    connection: conn,
                    token,
                    password,
                    url,
                },
            )
            .await;
        }
        Err(e) => {
            broadcast_event(
                state,
                Event::Error {
                    code: "tunnel_create_failed".into(),
                    message: e.to_string(),
                    target_peer_id: None,
                    localized: None,
                },
            )
            .await;
        }
    }
}

pub(super) async fn revoke_token(state: &Arc<AppState>, id: EntityId) {
    if let Err(e) = crate::tunnel::revoke_token(state, &id).await {
        broadcast_event(
            state,
            Event::Error {
                code: "tunnel_revoke_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn set_enabled(state: &Arc<AppState>, enabled: bool) {
    {
        let mut m = state.tunnel_manifest.write().await;
        m.enabled = enabled;
        let _ = crate::tunnel::save_manifest(&m).await;
    }
    crate::tunnel::broadcast_tunnel_state(state).await;
}

pub(super) async fn start(state: &Arc<AppState>, provider: TunnelProviderKind) {
    let tunnel_cfg = state.tunnel_cfg.read().await.clone();
    let config = match provider {
        TunnelProviderKind::Ngrok => TunnelProviderConfig::Ngrok {
            auth_token: tunnel_cfg.ngrok.as_ref().and_then(|c| c.auth_token.clone()),
            region: tunnel_cfg.ngrok.as_ref().and_then(|c| c.region.clone()),
            subdomain: tunnel_cfg.ngrok.as_ref().and_then(|c| c.subdomain.clone()),
            domain: tunnel_cfg.ngrok.as_ref().and_then(|c| c.domain.clone()),
        },
        TunnelProviderKind::Cloudflare => TunnelProviderConfig::Cloudflare {
            api_token: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.api_token.clone()),
            account_id: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.account_id.clone()),
            zone_id: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.zone_id.clone()),
            tunnel_name: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.tunnel_name.clone()),
            hostname: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.hostname.clone()),
            tunnel_token: tunnel_cfg
                .cloudflare
                .as_ref()
                .and_then(|c| c.tunnel_token.clone()),
        },
    };
    if let Err(e) = crate::tunnel::start_tunnel(state.clone(), provider, &config).await {
        broadcast_event(
            state,
            Event::Error {
                code: "tunnel_start_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn stop(state: &Arc<AppState>) {
    crate::tunnel::stop_tunnel(state).await;
}

pub(super) async fn request_state(state: &Arc<AppState>) {
    crate::tunnel::broadcast_tunnel_state(state).await;
}
