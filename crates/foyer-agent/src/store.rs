// SPDX-License-Identifier: Apache-2.0
//! Filesystem-backed skills / memory / templates store.
//!
//! Layout under `$XDG_DATA_HOME/foyer/agent/`:
//!
//!   skills/    *.md — user-authored task / persona files, surfaced
//!                     to the model via the system prompt when
//!                     `enabled` is true.
//!   memory/    *.md — short markdown snippets injected on every
//!                     session start. Agent can write here via the
//!                     `memory.save` tool.
//!   templates/ *.foyersession — saved project templates the agent
//!                                can spawn into fresh sessions.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use foyer_schema::agent::{
    AgentMemoryInfo, AgentMessageRecord, AgentSessionInfo, AgentSkillInfo, AgentTemplateInfo,
};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// Built-in skill files seeded into a fresh `skills/` directory on
/// first store open. Each entry is `(filename, body)`. The seeded
/// files are markdown with the same `enabled: true` frontmatter
/// shape user-authored skills use, so `list_skills` picks them up
/// without special-casing. New defaults can be added without
/// breaking existing user data — only filenames that aren't
/// already on disk get written.
const DEFAULT_SKILL_SEEDS: &[(&str, &str)] = &[
    (
        "ardour-lua-dsp.md",
        include_str!("skills_seed/ardour-lua-dsp.md"),
    ),
    (
        "ardour-lua-action.md",
        include_str!("skills_seed/ardour-lua-action.md"),
    ),
    (
        "ardour-lua-hook.md",
        include_str!("skills_seed/ardour-lua-hook.md"),
    ),
    (
        "ardour-lua-snippet.md",
        include_str!("skills_seed/ardour-lua-snippet.md"),
    ),
];

/// Persisted shape of the agent's LLM transport config. The
/// runtime's full `AgentConfig` carries deployment knobs that come
/// from `config.yaml` instead (`prefer_headless_render`); those are
/// deliberately NOT round-tripped through this file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredAgentConfig {
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub autonomy: Option<foyer_schema::agent::AgentAutonomy>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid name: {0}")]
    InvalidName(String),
    #[error("data dir unavailable")]
    DataDirUnavailable,
}

pub struct AgentStore {
    root: PathBuf,
}

impl AgentStore {
    /// Open the store under the user's XDG data dir. Creates the
    /// directory tree on first use.
    pub async fn open_default() -> Result<Self, StoreError> {
        let base = dirs::data_dir().ok_or(StoreError::DataDirUnavailable)?;
        let root = base.join("foyer").join("agent");
        Self::open_at(root).await
    }

    pub async fn open_at(root: PathBuf) -> Result<Self, StoreError> {
        for sub in ["skills", "memory", "templates", "sessions", "trace"] {
            fs::create_dir_all(root.join(sub)).await?;
        }
        // Drop the built-in skill seeds into `skills/` unless the
        // user has already written a file by the same name. Lets a
        // fresh install ship useful agent knowledge (Lua DSP,
        // editor action / hook / snippet authoring) without
        // overwriting anything the user has tuned. New skills
        // added in future versions land automatically — the user
        // can re-seed by deleting the file.
        let skills_dir = root.join("skills");
        for (name, body) in DEFAULT_SKILL_SEEDS {
            let path = skills_dir.join(name);
            if fs::metadata(&path).await.is_err() {
                let _ = fs::write(&path, body).await;
            }
        }
        Ok(Self { root })
    }

    pub fn trace_dir(&self) -> PathBuf {
        self.root.join("trace")
    }

    /// Append one JSONL line to the per-session debug trace. Used by
    /// the engine to capture LLM requests / responses / tool calls
    /// for later fine-tuning. Each session's trace lands in
    /// `~/.local/share/foyer/agent/trace/<session_id>.jsonl`.
    pub async fn append_trace(
        &self,
        session_id: &str,
        line: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let safe = safe_session_id(session_id)?;
        let path = self.trace_dir().join(format!("{safe}.jsonl"));
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let mut body = serde_json::to_string(line)
            .map_err(|e| StoreError::InvalidName(format!("trace encode: {e}")))?;
        body.push('\n');
        f.write_all(body.as_bytes()).await?;
        f.flush().await?;
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn skills_dir(&self) -> PathBuf {
        self.root.join("skills")
    }
    fn memory_dir(&self) -> PathBuf {
        self.root.join("memory")
    }
    fn templates_dir(&self) -> PathBuf {
        self.root.join("templates")
    }
    fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }
    fn sessions_index_path(&self) -> PathBuf {
        self.sessions_dir().join("index.json")
    }
    fn session_path(&self, id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{id}.jsonl"))
    }
    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    // ─── Live agent config (endpoint / model / api_key / autonomy) ──
    //
    // Persisted as JSON next to the per-domain subdirs. Lets a server
    // restart pick up the operator's last-saved LLM transport without
    // them having to re-open Settings → Save on every reload. Includes
    // `api_key` because the rest of the agent's local-only data
    // (memories, transcripts) sits in the same dir and the user has
    // already opted into trusting it.

    pub async fn load_config(&self) -> Option<StoredAgentConfig> {
        let bytes = fs::read(self.config_path()).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub async fn save_config(&self, cfg: &StoredAgentConfig) -> Result<(), StoreError> {
        let body = serde_json::to_vec_pretty(cfg)
            .map_err(|e| StoreError::InvalidName(format!("config encode: {e}")))?;
        let path = self.config_path();
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &body).await?;
        fs::rename(&tmp, &path).await?;
        Ok(())
    }

    // ─── Skills ────────────────────────────────────────────────────

    pub async fn list_skills(&self) -> Result<Vec<AgentSkillInfo>, StoreError> {
        list_md(&self.skills_dir(), |name, body, _modified| {
            let summary = first_paragraph(&body);
            let tokens = approx_tokens(&body);
            // `enabled: true|false` frontmatter line opts in by default.
            let enabled = body.lines().take(20).any(|l| {
                l.trim_start()
                    .to_ascii_lowercase()
                    .starts_with("enabled: true")
            });
            AgentSkillInfo {
                name,
                summary,
                tokens_approx: tokens,
                enabled,
            }
        })
        .await
    }

    pub async fn enabled_skill_bodies(&self) -> Result<Vec<(String, String)>, StoreError> {
        let mut out = Vec::new();
        let infos = self.list_skills().await?;
        for info in infos.into_iter().filter(|s| s.enabled) {
            let path = self.skills_dir().join(format!("{}.md", info.name));
            if let Ok(body) = fs::read_to_string(&path).await {
                out.push((info.name, body));
            }
        }
        Ok(out)
    }

    pub async fn set_skill_enabled(&self, name: &str, enabled: bool) -> Result<(), StoreError> {
        let path = self.skills_dir().join(format!("{}.md", safe_name(name)?));
        let body = fs::read_to_string(&path).await?;
        let new_body = rewrite_enabled(&body, enabled);
        fs::write(&path, new_body).await?;
        Ok(())
    }

    /// Write a new skill file (or overwrite an existing one). The
    /// uploaded body is taken verbatim except that the canonical
    /// `enabled: true` frontmatter line is appended when not
    /// already present so the skill is on by default after upload.
    pub async fn upload_skill(&self, name: &str, body: &str) -> Result<(), StoreError> {
        let path = self.skills_dir().join(format!("{}.md", safe_name(name)?));
        let needs_enable = !body
            .lines()
            .take(20)
            .any(|l| l.trim_start().to_ascii_lowercase().starts_with("enabled:"));
        let final_body = if needs_enable {
            format!("{body}\n\nenabled: true\n")
        } else {
            body.to_string()
        };
        fs::write(&path, final_body).await?;
        Ok(())
    }

    // ─── Memory ────────────────────────────────────────────────────

    pub async fn list_memories(&self) -> Result<Vec<AgentMemoryInfo>, StoreError> {
        list_md(&self.memory_dir(), |name, body, modified_ms| {
            AgentMemoryInfo {
                name,
                body,
                modified_ms,
            }
        })
        .await
    }

    pub async fn save_memory(&self, name: &str, body: &str) -> Result<(), StoreError> {
        let path = self.memory_dir().join(format!("{}.md", safe_name(name)?));
        fs::write(path, body).await?;
        Ok(())
    }

    pub async fn forget_memory(&self, name: &str) -> Result<(), StoreError> {
        let path = self.memory_dir().join(format!("{}.md", safe_name(name)?));
        match fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    // ─── Templates ─────────────────────────────────────────────────

    // ─── Sessions ──────────────────────────────────────────────────

    async fn load_session_index(&self) -> SessionIndex {
        let path = self.sessions_index_path();
        match fs::read_to_string(&path).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => SessionIndex::default(),
        }
    }

    async fn save_session_index(&self, idx: &SessionIndex) -> Result<(), StoreError> {
        let path = self.sessions_index_path();
        let body = serde_json::to_string_pretty(idx)
            .map_err(|e| StoreError::InvalidName(format!("index encode: {e}")))?;
        fs::write(path, body).await?;
        Ok(())
    }

    pub async fn list_sessions(&self) -> (Vec<AgentSessionInfo>, Option<String>) {
        let idx = self.load_session_index().await;
        let mut sessions = idx.sessions.clone();
        // Newest first by updated_ms (created_ms as tiebreaker).
        sessions.sort_by(|a, b| {
            b.updated_ms
                .cmp(&a.updated_ms)
                .then_with(|| b.created_ms.cmp(&a.created_ms))
        });
        (sessions, idx.active_id)
    }

    pub async fn active_session_id(&self) -> Option<String> {
        self.load_session_index().await.active_id
    }

    /// Load every record in a session, in insertion order. Bad
    /// JSON lines are skipped (don't break the rest of the file).
    pub async fn load_session_records(
        &self,
        id: &str,
    ) -> Result<Vec<AgentMessageRecord>, StoreError> {
        let path = self.session_path(&safe_session_id(id)?);
        let body = match fs::read_to_string(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(rec) = serde_json::from_str::<AgentMessageRecord>(trimmed) {
                out.push(rec);
            }
        }
        Ok(out)
    }

    /// Create a new session with an auto-generated id; activate it.
    /// Returns the new session's info.
    pub async fn new_session(&self, title: Option<&str>) -> Result<AgentSessionInfo, StoreError> {
        let id = generate_session_id();
        let now = now_ms();
        let title = title
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_session_title);
        let info = AgentSessionInfo {
            id: id.clone(),
            title,
            created_ms: now,
            updated_ms: now,
            message_count: 0,
        };
        // Touch the file so subsequent reads succeed even before any
        // record has been appended.
        fs::write(self.session_path(&id), "").await?;
        let mut idx = self.load_session_index().await;
        idx.sessions.push(info.clone());
        idx.active_id = Some(id.clone());
        self.save_session_index(&idx).await?;
        Ok(info)
    }

    pub async fn set_active_session(&self, id: &str) -> Result<(), StoreError> {
        let mut idx = self.load_session_index().await;
        if !idx.sessions.iter().any(|s| s.id == id) {
            return Err(StoreError::InvalidName(format!("unknown session: {id}")));
        }
        idx.active_id = Some(id.to_string());
        self.save_session_index(&idx).await
    }

    pub async fn delete_session(&self, id: &str) -> Result<(), StoreError> {
        let safe = safe_session_id(id)?;
        let path = self.session_path(&safe);
        match fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let mut idx = self.load_session_index().await;
        idx.sessions.retain(|s| s.id != id);
        if idx.active_id.as_deref() == Some(id) {
            idx.active_id = idx
                .sessions
                .iter()
                .max_by_key(|s| s.updated_ms)
                .map(|s| s.id.clone());
        }
        self.save_session_index(&idx).await
    }

    pub async fn rename_session(&self, id: &str, title: &str) -> Result<(), StoreError> {
        let mut idx = self.load_session_index().await;
        for s in idx.sessions.iter_mut() {
            if s.id == id {
                s.title = title.to_string();
                s.updated_ms = now_ms();
            }
        }
        self.save_session_index(&idx).await
    }

    /// Append a batch of records to a session's JSONL + bump
    /// metadata. Writes are batched at the runtime layer (see
    /// `AgentRuntime::session_flusher`) so this is called once per
    /// flush tick, not once per record — avoids fsync contention on
    /// busy turns where streaming tokens + tool results would
    /// otherwise hammer the disk.
    pub async fn append_records_batch(
        &self,
        id: &str,
        records: &[AgentMessageRecord],
    ) -> Result<(), StoreError> {
        if records.is_empty() {
            return Ok(());
        }
        let safe = safe_session_id(id)?;
        let path = self.session_path(&safe);
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let mut buf = String::with_capacity(records.len() * 256);
        for record in records {
            let line = serde_json::to_string(record)
                .map_err(|e| StoreError::InvalidName(format!("record encode: {e}")))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        f.write_all(buf.as_bytes()).await?;
        f.flush().await?;
        drop(f);
        // Index update: one rebuild per batch, not per record.
        let mut idx = self.load_session_index().await;
        let mut updated = false;
        for s in idx.sessions.iter_mut() {
            if s.id == id {
                let user_assistant = records
                    .iter()
                    .filter(|r| {
                        matches!(
                            r.role,
                            foyer_schema::agent::AgentRole::User
                                | foyer_schema::agent::AgentRole::Assistant
                        )
                    })
                    .count() as u32;
                s.message_count = s.message_count.saturating_add(user_assistant);
                s.updated_ms = now_ms();
                if s.title.starts_with("Session ") || s.title.trim().is_empty() {
                    if let Some(first_user) = records
                        .iter()
                        .find(|r| r.role == foyer_schema::agent::AgentRole::User)
                    {
                        if let Some(line) = first_user
                            .content
                            .lines()
                            .map(str::trim)
                            .find(|l| !l.is_empty())
                        {
                            s.title = line.chars().take(60).collect();
                        }
                    }
                }
                updated = true;
                break;
            }
        }
        if !updated {
            let now = now_ms();
            let count = records
                .iter()
                .filter(|r| {
                    matches!(
                        r.role,
                        foyer_schema::agent::AgentRole::User
                            | foyer_schema::agent::AgentRole::Assistant
                    )
                })
                .count() as u32;
            idx.sessions.push(AgentSessionInfo {
                id: id.to_string(),
                title: default_session_title(),
                created_ms: now,
                updated_ms: now,
                message_count: count,
            });
            if idx.active_id.is_none() {
                idx.active_id = Some(id.to_string());
            }
        }
        self.save_session_index(&idx).await
    }

    pub async fn list_templates(&self) -> Result<Vec<AgentTemplateInfo>, StoreError> {
        let mut out = Vec::new();
        let mut rd = fs::read_dir(self.templates_dir()).await?;
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            // Templates are session bundles — opaque to the store
            // beyond name/path. A sibling README.md (when present)
            // supplies the description.
            let readme = path.join("README.md");
            let summary = match fs::read_to_string(&readme).await {
                Ok(body) => first_paragraph(&body),
                Err(_) => String::new(),
            };
            out.push(AgentTemplateInfo {
                name,
                summary,
                path: path.display().to_string(),
            });
        }
        Ok(out)
    }
}

// ─── Helpers ───────────────────────────────────────────────────────

async fn list_md<T, F>(dir: &Path, mut map: F) -> Result<Vec<T>, StoreError>
where
    F: FnMut(String, String, u64) -> T,
{
    let mut out = Vec::new();
    let mut rd = fs::read_dir(dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let body = match fs::read_to_string(&path).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        let modified_ms = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(map(name, body, modified_ms));
    }
    out.sort_by(|a, b| {
        let _ = (a, b);
        std::cmp::Ordering::Equal
    });
    Ok(out)
}

fn first_paragraph(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .skip_while(|l| l.is_empty() || l.starts_with("---") || l.starts_with('#'))
        .take_while(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn approx_tokens(body: &str) -> u32 {
    // Crude 4-chars-per-token estimate.
    ((body.len() / 4) as u32).max(1)
}

fn safe_name(name: &str) -> Result<String, StoreError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(StoreError::InvalidName("empty name".into()));
    }
    let sanitized: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        return Err(StoreError::InvalidName(format!("unusable: {trimmed}")));
    }
    let _ = SystemTime::now(); // touch the import; keeps the export from being flagged
    Ok(sanitized)
}

fn rewrite_enabled(body: &str, enabled: bool) -> String {
    let target = if enabled { "true" } else { "false" };
    let mut found = false;
    let mut out = String::with_capacity(body.len() + 16);
    for line in body.lines() {
        let trimmed = line.trim_start();
        if !found && trimmed.to_ascii_lowercase().starts_with("enabled:") {
            out.push_str(&format!("enabled: {target}\n"));
            found = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !found {
        // Append a frontmatter-style line at the bottom — agents can
        // promote it into proper YAML frontmatter when authoring new
        // skills; we just need a readable on/off marker.
        out.push_str(&format!("\nenabled: {target}\n"));
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SessionIndex {
    #[serde(default)]
    sessions: Vec<AgentSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_id: Option<String>,
}

fn safe_session_id(id: &str) -> Result<String, StoreError> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(StoreError::InvalidName("empty session id".into()));
    }
    let sanitized: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        return Err(StoreError::InvalidName(format!("unusable id: {trimmed}")));
    }
    Ok(sanitized)
}

fn generate_session_id() -> String {
    let ts = now_ms();
    let mut s = format!("{:x}", ts);
    let mut rng_buf = [0u8; 4];
    use std::io::Read;
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut rng_buf))
        .is_ok()
    {
        let suffix = u32::from_le_bytes(rng_buf);
        s.push_str(&format!("{:08x}", suffix));
    } else {
        s.push_str(&format!(
            "{:x}",
            std::process::id() ^ ((ts & 0xffff) as u32)
        ));
    }
    s
}

fn default_session_title() -> String {
    let now = now_ms();
    let secs = now / 1000;
    let minutes = (secs / 60) % 60;
    let hour = (secs / 3600) % 24;
    format!("Session {:02}:{:02}", hour, minutes)
}
