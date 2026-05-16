// SPDX-License-Identifier: Apache-2.0
//! Renderers for `foyer_agent::tools::visualize`.
//!
//! Two implementations:
//!
//!   * [`FeRenderer`] — round-trips through any attached browser tab
//!     via `Event::AgentRenderRequest` / `Command::AgentRenderResult`.
//!     Preferred when a real Primary is connected because the tab
//!     already has the live data + cached peaks; we just ask it to
//!     paint the viz it would have painted anyway and ship the bytes
//!     back.
//!
//!   * [`HeadlessChromeRenderer`] (gated behind the `headless-render`
//!     cargo feature, default on) — spawns a headless Chromium
//!     instance via `chromiumoxide`, navigates to the standalone
//!     `/viz` page, waits for `[data-foyer-viz-ready]`, screenshots
//!     the body, and returns the PNG bytes. Used when no FE is
//!     attached (TUI sessions, external MCP clients, batch jobs).
//!
//! The two are layered: `visualize` tool prefers FE-attached and
//! falls back to headless. Both are wired in `attach_agent` in
//! `crate::lib`.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use foyer_agent::tools::{FeRenderer, HeadlessRenderer, ToolError};
use foyer_schema::Event;
use serde_json::Value;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::AppState;

const FE_RENDER_TIMEOUT_SECS: u64 = 30;
// Chromium cold-launch in a container can take 5–15 s on its own,
// and complex views (mixer with WebGL meters, spectrograms) burn
// another ~10 s on first paint. 30 s left no headroom — the first
// call after a foyer restart routinely hit "exceeded 30s" before the
// page even reached `wait_for_navigation`. Bump to 60 s so cold
// hits resolve; warm calls still typically finish in 2–5 s.
#[cfg(feature = "headless-render")]
const HEADLESS_RENDER_TIMEOUT_SECS: u64 = 60;

/// Per-request reply channel from the browser back to the
/// pending tool call. Named so the map type below stays readable.
type RenderReply = oneshot::Sender<Result<Vec<u8>, ToolError>>;

/// Browser-driven renderer — dispatches via control WS and awaits
/// the reply via a oneshot keyed on `request_id`.
pub struct FeRendererImpl {
    state: Weak<AppState>,
    pending: Mutex<HashMap<String, RenderReply>>,
}

impl FeRendererImpl {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Resolve a pending oneshot from a `Command::AgentRenderResult`
    /// dispatch. Called from `ws::dispatch_command`.
    pub async fn resolve(&self, request_id: &str, png_b64: Option<String>, error: Option<String>) {
        let Some(tx) = self.pending.lock().await.remove(request_id) else {
            tracing::debug!("agent_render: no pending request {request_id}");
            return;
        };
        let result = match (png_b64, error) {
            (Some(b64), _) => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| ToolError::Execution(format!("b64 decode: {e}"))),
            (None, Some(err)) => Err(ToolError::Execution(err)),
            (None, None) => Err(ToolError::Execution(
                "render result missing both png_b64 and error".into(),
            )),
        };
        let _ = tx.send(result);
    }
}

#[async_trait]
impl FeRenderer for FeRendererImpl {
    async fn render(&self, request: Value) -> Result<Vec<u8>, ToolError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| ToolError::Execution("server shutting down".into()))?;
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);
        let request_json = serde_json::to_string(&request)
            .map_err(|e| ToolError::Execution(format!("encode render request: {e}")))?;
        crate::ws::broadcast_event(
            &state,
            Event::AgentRenderRequest {
                request_id: request_id.clone(),
                request_json,
            },
        )
        .await;
        let timeout = Duration::from_secs(FE_RENDER_TIMEOUT_SECS);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ToolError::Execution(
                "fe renderer cancelled before reply".into(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(ToolError::Execution(format!(
                    "fe render timed out after {FE_RENDER_TIMEOUT_SECS}s — no Foyer browser tab attached?"
                )))
            }
        }
    }
}

// ─── Headless Chromium renderer ─────────────────────────────────────

/// One-shot install hint for the user when chromium can't be found.
/// Surfaced verbatim to the agent (so the LLM can tell the user how
/// to fix it) AND logged on every startup probe that comes up empty,
/// so the human sees the same instructions in their `foyer serve`
/// terminal without having to ask the agent first.
#[cfg_attr(not(feature = "headless-render"), allow(dead_code))]
const CHROMIUM_NOT_FOUND_HINT: &str = "\
The Foyer agent's headless renderer (used by `visualize.*`) needs \
Chromium or Google Chrome installed and on PATH.

INSTALL (pick your platform):
  · Debian / Ubuntu  :  sudo apt-get install -y chromium
  · Fedora           :  sudo dnf install -y chromium
  · Arch / Manjaro   :  sudo pacman -S --noconfirm chromium
  · Alpine           :  sudo apk add chromium
  · macOS (Homebrew) :  brew install --cask chromium
                        then: export CHROME=\"/Applications/Chromium.app/Contents/MacOS/Chromium\"
  · macOS (Chrome)   :  export CHROME=\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\"
  · Windows          :  winget install Chromium
                        then: set CHROME=C:\\Program Files\\Chromium\\Application\\chromium.exe

ALREADY HAVE IT INSTALLED?
  Point Foyer at it with:   export CHROME=/full/path/to/chromium
  Then restart `foyer serve`.

DON'T WANT TO INSTALL ANYTHING?
  Set `agent.prefer_headless_render: false` in ~/.local/share/foyer/config.yaml \
  and keep a Foyer browser tab open. The FE-attached renderer can take care \
  of any view that's currently mounted there, but it'll fail on views the \
  user hasn't opened yet — which is why headless is the default.\
";

/// Probe common chromium / chrome install locations. Returns the
/// first executable that exists. Used at startup (so the warning
/// fires loudly in the boot log) AND on first `visualize.*` call
/// (so the env-var fallback wins if CHROME was set after boot).
#[cfg_attr(not(feature = "headless-render"), allow(dead_code))]
fn find_chromium_executable() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    // Honor an explicit override first.
    if let Ok(p) = std::env::var("CHROME") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(p) = std::env::var("CHROMIUM_PATH") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    // Common executable names on $PATH.
    for name in [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "chrome",
    ] {
        if let Ok(found) = which::which(name) {
            return Some(found);
        }
    }
    // Last-ditch: known absolute paths per platform.
    let candidates: &[&str] = &[
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/snap/bin/chromium",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "C:\\Program Files\\Chromium\\Application\\chromium.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for p in candidates {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    // Playwright fallback: Playwright caches a private chromium under
    // `~/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome` (or
    // `chrome-mac/Chromium.app/...` / `chrome-win/chrome.exe`). Most
    // dev containers already have this from installing the test
    // tooling — no extra apt install needed.
    if let Some(path) = playwright_chromium() {
        return Some(path);
    }
    None
}

#[cfg_attr(not(feature = "headless-render"), allow(dead_code))]
fn playwright_chromium() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    // Allow an explicit override (Playwright honors this too).
    let cache_root = if let Ok(p) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        if p.is_empty() || p == "0" {
            // `0` is Playwright's marker for "store inside node_modules" —
            // skip in that case; nothing we can reliably probe.
            return None;
        }
        PathBuf::from(p)
    } else {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        let home = PathBuf::from(home);
        // Cross-platform Playwright cache locations.
        #[cfg(target_os = "macos")]
        let cache = home.join("Library/Caches/ms-playwright");
        #[cfg(target_os = "windows")]
        let cache = home.join("AppData/Local/ms-playwright");
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let cache = home.join(".cache/ms-playwright");
        cache
    };
    if !cache_root.exists() {
        return None;
    }
    // Each chromium revision lives in its own directory. Walk them
    // sorted descending (newest first) and try the standard exe layout.
    // Bucket into "full chromium" vs "headless_shell" and sort each
    // bucket newest-first. We try full chromium first (it carries the
    // devtools surface some viz components rely on), then fall back
    // to headless_shell when only that variant is cached.
    let all: Vec<PathBuf> = std::fs::read_dir(&cache_root)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("chromium-") || n.starts_with("chromium_headless_shell-"))
                .unwrap_or(false)
        })
        .collect();
    let (mut full, mut shell): (Vec<_>, Vec<_>) = all.into_iter().partition(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("chromium-"))
            .unwrap_or(false)
    });
    // Lexicographic sort on these `<prefix>-<rev>` names gives
    // ascending revision; reverse so newest-revision comes first.
    full.sort();
    full.reverse();
    shell.sort();
    shell.reverse();
    let revs: Vec<PathBuf> = full.into_iter().chain(shell).collect();
    let exe_relpaths: &[&str] = &[
        "chrome-linux/chrome",
        "chrome-linux/headless_shell",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-win/chrome.exe",
    ];
    for rev_dir in revs {
        for rel in exe_relpaths {
            let candidate = rev_dir.join(rel);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Run at server boot when headless rendering is the configured
/// preferred renderer. Logs the install hint at WARN level when no
/// chromium can be found so the user sees the fix in their terminal
/// without having to issue an agent call first. No-op when the
/// `headless-render` feature is off.
#[cfg(feature = "headless-render")]
pub fn probe_headless_chromium_at_boot() {
    match find_chromium_executable() {
        Some(p) => {
            tracing::info!(
                "headless renderer: chromium found at {} — visualize.* will use it",
                p.display()
            );
        }
        None => {
            // Use a multi-line warn so it actually stands out in the
            // boot log against the usual one-liner trace level.
            tracing::warn!(
                "\n\n\
                 ╔══════════════════════════════════════════════════════════╗\n\
                 ║  HEADLESS RENDERER UNAVAILABLE — NO CHROMIUM FOUND        ║\n\
                 ╚══════════════════════════════════════════════════════════╝\n\
                 {}\n",
                CHROMIUM_NOT_FOUND_HINT
            );
        }
    }
}

#[cfg(not(feature = "headless-render"))]
pub fn probe_headless_chromium_at_boot() {}

#[cfg(feature = "headless-render")]
pub struct HeadlessChromeRendererImpl {
    state: Weak<AppState>,
}

#[cfg(feature = "headless-render")]
impl HeadlessChromeRendererImpl {
    pub fn new(state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self { state })
    }

    async fn server_origin(&self) -> Result<String, ToolError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| ToolError::Execution("server shutting down".into()))?;
        let port = state.listen_port.load(std::sync::atomic::Ordering::Relaxed);
        if port == 0 {
            return Err(ToolError::Execution(
                "headless render attempted before HTTP listener bound".into(),
            ));
        }
        let scheme = if state.tls_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            "https"
        } else {
            "http"
        };
        Ok(format!("{scheme}://127.0.0.1:{port}"))
    }
}

#[cfg(feature = "headless-render")]
#[async_trait]
impl HeadlessRenderer for HeadlessChromeRendererImpl {
    async fn render(&self, request: Value) -> Result<Vec<u8>, ToolError> {
        use chromiumoxide::browser::{Browser, BrowserConfig};
        use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
        use chromiumoxide::page::ScreenshotParams;
        use futures::StreamExt;

        let origin = self.server_origin().await?;
        let query = serde_urlencoded::to_string(&request).unwrap_or_default();
        // We piggyback on the regular index page — `headless-viz.js`
        // sees the subcommand query param and swaps the layout to a
        // single full-window tile before signaling ready. Cheaper than
        // a separate /viz route + bundle.
        let url = format!("{origin}/?{query}");
        tracing::info!(target: "foyer_server::agent_render", "headless render: url={url}");

        // Pre-flight: probe for a chromium binary BEFORE asking
        // chromiumoxide to launch one. This lets us surface the loud
        // install hint to the agent (and the log) without waiting for
        // chromiumoxide's terse "Could not auto detect…" message.
        let chrome_path = find_chromium_executable().ok_or_else(|| {
            tracing::warn!(
                "headless render requested but no chromium binary found — \
                 returning install hint to caller"
            );
            ToolError::Execution(CHROMIUM_NOT_FOUND_HINT.to_string())
        })?;

        // Container-safe chromium launch.
        //
        // chromiumoxide's `.arg()` ALWAYS prepends `--` to whatever
        // string you pass it (see `argument.rs` ArgsBuilder::into_iter:
        // `format!("--{}", key)`), so `.arg("--no-sandbox")` produces
        // `----no-sandbox` on the command line and chromium silently
        // discards it. Two ways to get the flags through:
        //   1. Use the typed builder methods (`.no_sandbox()`,
        //      `.new_headless_mode()`) — these set internal fields
        //      that translate to the correct CLI flags at launch.
        //   2. For flags without a builder method, pass the BARE name
        //      (`.arg("no-zygote")`, NOT `.arg("--no-zygote")`).
        //
        // What we need + why:
        //   no_sandbox()           — adds `--no-sandbox` AND
        //                            `--disable-setuid-sandbox` (the
        //                            zygote-host sandbox check fails
        //                            without BOTH inside an
        //                            unprivileged container).
        //   new_headless_mode()    — uses `--headless=new` instead of
        //                            the deprecated old headless mode.
        //   no-zygote              — kills the zygote process model
        //                            entirely; otherwise the FATAL
        //                            "No usable sandbox!" fires from
        //                            the zygote even though the parent
        //                            has `--no-sandbox`.
        //   disable-gpu            — no GPU in the container.
        //   disable-dev-shm-usage  — already in chromiumoxide's
        //                            DEFAULT_ARGS, but redundant is
        //                            cheap; /dev/shm is tiny in
        //                            containers.
        // Fresh user-data-dir per launch. Chromiumoxide's default
        // ("$TMPDIR/chromiumoxide-runner") is SHARED across every
        // render call AND persists across foyer restarts, which means
        // chromium's disk cache hangs onto stale `web/` files —
        // edits to a view's JS were silently ignored until the agent
        // happened to invalidate the cache. We mint a tempdir per
        // call and drop it after `browser.close()` below.
        let profile_dir =
            std::env::temp_dir().join(format!("foyer-cox-{}", uuid::Uuid::new_v4().simple()));
        let mut builder = BrowserConfig::builder()
            .chrome_executable(&chrome_path)
            .user_data_dir(&profile_dir)
            .no_sandbox()
            .new_headless_mode()
            .arg("no-zygote")
            .arg("disable-gpu")
            .arg("disable-dev-shm-usage")
            .viewport(Some(chromiumoxide::handler::viewport::Viewport {
                width: 1280,
                height: 800,
                device_scale_factor: Some(1.0),
                emulating_mobile: false,
                is_landscape: false,
                has_touch: false,
            }));
        let _ = &mut builder; // silence unused-mut when no extra .arg appended
        let config = builder
            .build()
            .map_err(|e| ToolError::Execution(format!("chromiumoxide config: {e}")))?;

        let (mut browser, mut handler) = Browser::launch(config).await.map_err(|e| {
            let s = e.to_string();
            ToolError::Execution(format!(
                "chromium launch failed using {}: {s}\n\n{CHROMIUM_NOT_FOUND_HINT}",
                chrome_path.display()
            ))
        })?;

        // Pump the browser handler in the background; if it dies the
        // page calls below will surface meaningful errors.
        let handler_task = tokio::spawn(async move { while handler.next().await.is_some() {} });

        let render = async {
            // Open a blank tab first, THEN explicitly `goto` the
            // target URL. `new_page(url)` + `wait_for_navigation` was
            // racing the page's initial scripts: by the time the JS
            // evaluation channel was ready chromium had sometimes
            // already finished the first nav, leaving wait_for_nav
            // hanging on a phantom second navigation. `goto` blocks
            // until the resource is fully fetched + parsed, which is
            // the contract we actually want.
            let page = browser
                .new_page("about:blank")
                .await
                .map_err(|e| ToolError::Execution(format!("chromium new_page: {e}")))?;
            page.goto(url.as_str())
                .await
                .map_err(|e| ToolError::Execution(format!("chromium goto: {e}")))?;
            page.wait_for_navigation()
                .await
                .map_err(|e| ToolError::Execution(format!("chromium navigation: {e}")))?;
            // Verify the browser landed where we asked. Chromium can
            // strip the query string under some flag combinations
            // (notably new headless without disable-features=Translate)
            // and we silently get the welcome screen instead of the
            // requested view. Log what we actually got so we can spot
            // the drift in the foyer terminal.
            if let Ok(eval) = page.evaluate("window.location.href").await {
                if let Ok(href) = eval.into_value::<String>() {
                    tracing::info!(
                        target: "foyer_server::agent_render",
                        "headless page landed at: {href}"
                    );
                }
            }
            // Poll for ready attribute with a 10 s cap. Most viz are
            // ready in < 1 s; complex spectrograms can take longer.
            let mut waited = Duration::ZERO;
            let step = Duration::from_millis(200);
            let cap = Duration::from_secs(10);
            loop {
                let ready: bool = page
                    .evaluate("!!document.body.dataset.foyerVizReady")
                    .await
                    .ok()
                    .and_then(|r| r.into_value::<bool>().ok())
                    .unwrap_or(false);
                if ready {
                    break;
                }
                if waited >= cap {
                    return Err(ToolError::Execution(
                        "viz did not signal foyerVizReady within 10 s".into(),
                    ));
                }
                tokio::time::sleep(step).await;
                waited += step;
            }
            // headless-viz.js sets `foyerVizError` when the requested
            // view isn't registered (or fails to mount). Without this
            // check the screenshot is the "Unknown view: …" placeholder
            // returned as a fake success — surface the error instead so
            // the agent can react. NB: chromiumoxide's `into_value` can't
            // deserialize a JS `null` into Option<String> (CDP doesn't
            // emit a value field for null), so the expression always
            // returns a string and we treat "" as the absent case.
            let err: String = page
                .evaluate("document.body.dataset.foyerVizError || ''")
                .await
                .ok()
                .and_then(|r| r.into_value::<String>().ok())
                .unwrap_or_default();
            if !err.is_empty() {
                tracing::warn!(
                    target: "foyer_server::agent_render",
                    "headless render reported viz error: {err}"
                );
                return Err(ToolError::Execution(err));
            }
            let png = page
                .screenshot(
                    ScreenshotParams::builder()
                        .format(CaptureScreenshotFormat::Png)
                        .full_page(true)
                        .build(),
                )
                .await
                .map_err(|e| ToolError::Execution(format!("chromium screenshot: {e}")))?;
            Ok(png)
        };

        let result =
            tokio::time::timeout(Duration::from_secs(HEADLESS_RENDER_TIMEOUT_SECS), render)
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::Execution(format!(
                        "headless render exceeded {HEADLESS_RENDER_TIMEOUT_SECS}s"
                    )))
                });

        let _ = browser.close().await;
        let _ = browser.wait().await;
        handler_task.abort();
        // Drop the per-launch user-data-dir. Best-effort: if chromium
        // hadn't fully released the lock the rmdir errors out, but
        // tempfile turnover means stale dirs get GC'd on container
        // restart even when this miss happens.
        let _ = std::fs::remove_dir_all(&profile_dir);
        result
    }
}

/// Stub renderer used when the `headless-render` feature is disabled
/// at build time. Returns a clear error directing the user to either
/// rebuild with the feature on or open a Foyer tab.
#[cfg(not(feature = "headless-render"))]
pub struct HeadlessChromeRendererImpl;

#[cfg(not(feature = "headless-render"))]
impl HeadlessChromeRendererImpl {
    pub fn new(_state: Weak<AppState>) -> Arc<Self> {
        Arc::new(Self)
    }
}

#[cfg(not(feature = "headless-render"))]
#[async_trait]
impl HeadlessRenderer for HeadlessChromeRendererImpl {
    async fn render(&self, _request: Value) -> Result<Vec<u8>, ToolError> {
        Err(ToolError::Execution(
            "foyer-server built without the `headless-render` cargo feature; \
             rebuild with `cargo build --features headless-render` (default on) \
             or keep a Foyer browser tab open"
                .into(),
        ))
    }
}

/// True when this binary CAN attempt headless rendering at all (the
/// feature was compiled in). Doesn't say whether chromium is installed —
/// the actual launch call surfaces that.
#[allow(dead_code)]
pub const fn headless_supported() -> bool {
    cfg!(feature = "headless-render")
}

// Helper so the AgentRuntime can be handed FE + headless renderers
// in one shot.
pub async fn attach_renderers(
    runtime: &foyer_agent::AgentRuntime,
    fe: Arc<dyn FeRenderer>,
    headless: Arc<dyn HeadlessRenderer>,
) {
    runtime.set_renderers(Some(fe), Some(headless)).await;
}
