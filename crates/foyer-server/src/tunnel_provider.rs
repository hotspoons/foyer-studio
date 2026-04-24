//! Generic tunnel provider trait — polymorphic across embedded providers.
//!
//! `NgrokProvider` is pure-Rust (in-process).  `CloudflareProvider` wraps the
//! `cloudflared` subprocess and spins up a secondary auth server.

use std::sync::Arc;

use foyer_schema::{TunnelProviderConfig, TunnelProviderKind};

/// Snapshot of the main Foyer server's local endpoint. Passed into
/// providers that might want to forward directly to it (ngrok, once
/// re-wired). The Cloudflare provider ignores this and routes through
/// its own auth server port instead — see the two-port design in
/// DECISION 37 and the docstring on `cloudflare_provider.rs` — but we
/// keep the field around so ngrok (which doesn't have an RBAC surface
/// yet) can still target the main port when we bring it back.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct LocalTarget {
    pub port: u16,
    /// True when foyer's own HTTP server is running HTTPS. Providers
    /// that forward directly need this to match the scheme or the
    /// upstream TLS handshake fails.
    pub https: bool,
}

#[allow(dead_code)]
impl LocalTarget {
    pub fn service_url(&self) -> String {
        let scheme = if self.https { "https" } else { "http" };
        format!("{scheme}://localhost:{}", self.port)
    }
}

#[async_trait::async_trait]
#[allow(dead_code)]
pub(crate) trait TunnelProvider: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn kind(&self) -> TunnelProviderKind;
    /// Bring the tunnel up and return the advertised public hostname.
    ///
    /// `target` describes the main Foyer listener (providers that
    /// forward directly — future ngrok wiring — use it). `state` is
    /// handed through so providers that stand up their own listener
    /// can rebuild the shared HTTP/WS router via
    /// `crate::build_http_router`.
    async fn start(
        &mut self,
        target: LocalTarget,
        state: std::sync::Arc<crate::AppState>,
    ) -> anyhow::Result<String>;
    async fn stop(&mut self);
}

pub(crate) fn make_provider(
    kind: TunnelProviderKind,
    cfg: &TunnelProviderConfig,
) -> anyhow::Result<Arc<tokio::sync::Mutex<Box<dyn TunnelProvider>>>> {
    match kind {
        #[cfg(feature = "ngrok")]
        TunnelProviderKind::Ngrok => {
            let p = NgrokProvider::new(cfg)?;
            Ok(Arc::new(tokio::sync::Mutex::new(Box::new(p))))
        }
        #[cfg(not(feature = "ngrok"))]
        TunnelProviderKind::Ngrok => Err(anyhow::anyhow!(
            "ngrok feature not enabled — rebuild with --features ngrok"
        )),
        TunnelProviderKind::Cloudflare => {
            let p = crate::cloudflare_provider::CloudflareProvider::new(cfg)?;
            Ok(Arc::new(tokio::sync::Mutex::new(Box::new(p))))
        }
    }
}

// ─── Ngrok provider (pure Rust) ──────────────────────────────────────

#[cfg(feature = "ngrok")]
pub struct NgrokProvider {
    session: Option<ngrok::Session>,
    auth_token: Option<String>,
    domain: Option<String>,
}

#[cfg(feature = "ngrok")]
impl NgrokProvider {
    pub fn new(cfg: &foyer_schema::TunnelProviderConfig) -> anyhow::Result<Self> {
        match cfg {
            foyer_schema::TunnelProviderConfig::Ngrok { auth_token, domain, .. } => {
                Ok(Self { session: None, auth_token: auth_token.clone(), domain: domain.clone() })
            }
            _ => anyhow::bail!("NgrokProvider created with non-ngrok config"),
        }
    }
}

#[cfg(feature = "ngrok")]
#[async_trait::async_trait]
impl TunnelProvider for NgrokProvider {
    fn name(&self) -> &'static str { "ngrok" }

    fn kind(&self) -> TunnelProviderKind { TunnelProviderKind::Ngrok }

    async fn start(
        &mut self,
        target: LocalTarget,
        _state: std::sync::Arc<crate::AppState>,
    ) -> anyhow::Result<String> {
        use ngrok::prelude::*;
        let sess = if let Some(tok) = &self.auth_token {
            ngrok::Session::builder()
                .authtoken(tok.clone())
                .connect()
                .await
        } else {
            ngrok::Session::builder()
                .authtoken_from_env()
                .connect()
                .await
        }
        .map_err(|e| anyhow::anyhow!("ngrok session: {e}"))?;
        let local_url = target
            .service_url()
            .parse::<url::Url>()
            .map_err(|e| anyhow::anyhow!("invalid local url: {e}"))?;
        let mut tun = sess.http_endpoint();
        if let Some(d) = &self.domain {
            tun.domain(d.clone());
        }
        let tun = tun
            .listen_and_forward(local_url)
            .await
            .map_err(|e| anyhow::anyhow!("ngrok tunnel: {e}"))?;
        let url = tun.url().to_string();
        self.session = Some(sess);
        Ok(url)
    }

    async fn stop(&mut self) {
        self.session = None;
    }
}
