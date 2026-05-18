// SPDX-License-Identifier: Apache-2.0
//! `welcome` — onboarding tool for external agents connecting via MCP.
//!
//! When Claude Code (or any other external MCP client) attaches to
//! Foyer's MCP server, the tool list looks like a generic DAW remote.
//! But Foyer's in-process agent gets a curated system prompt, the
//! current skills index, and the user's memory snippets injected on
//! every turn — which substantially shapes how the model uses the
//! tool surface. Without that context, an external agent has to
//! rediscover the conventions empirically (and often badly).
//!
//! This tool closes the gap: every other tool's description nudges
//! external clients to call `welcome` before doing anything else.
//! `welcome` returns the same system prompt + skills + memory the
//! built-in agent gets, plus a brief orientation about Foyer's
//! polymorphic tool shape (one tool per domain, `subcommand`
//! discriminator inside the args). The point isn't to convince a
//! cold-started agent that it's now the built-in agent — it's to
//! erase the context gap that makes external agents perform poorly
//! against the same tool surface.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::store::AgentStore;
use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

/// One entry in the welcome payload's skills manifest. We send the
/// `name + summary + tokens_approx` to the agent on the first turn,
/// NOT the full body — bodies for niche authoring guides (Ardour Lua
/// DSP, Editor Action / Hook / Snippet) used to be ~6 KB collectively
/// and bloated every external MCP client's context. The agent fetches
/// the body on demand via `scripts.skill { name }` when it actually
/// needs to author the corresponding script type.
#[derive(Default, Clone)]
pub struct SkillManifestEntry {
    pub name: String,
    pub summary: String,
    pub tokens_approx: u32,
}

/// Snapshot of the harness's current prompt + skill + memory state.
/// Held behind an `RwLock` so the runtime can update it as files
/// change or the user edits the prompt mid-session.
#[derive(Default)]
pub struct WelcomeContext {
    pub system_prompt: String,
    /// Manifest of enabled skills (no bodies). Bodies fetched on
    /// demand through `scripts.skill { name }`.
    pub skills: Vec<SkillManifestEntry>,
    pub memories: Vec<(String, String)>,
}

pub struct WelcomeTool {
    ctx: Arc<RwLock<WelcomeContext>>,
}

impl WelcomeTool {
    pub fn new(ctx: Arc<RwLock<WelcomeContext>>) -> Self {
        Self { ctx }
    }

    /// Re-read skills + memory from the store and stash them on the
    /// context. Called by the runtime on boot + on every
    /// AgentListSkills / AgentListMemories command so the welcome
    /// payload tracks what the in-process agent sees.
    pub async fn refresh_from_store(
        ctx: &Arc<RwLock<WelcomeContext>>,
        store: &AgentStore,
        system_prompt: String,
    ) {
        let skills: Vec<SkillManifestEntry> = store
            .list_skills()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.enabled)
            .map(|s| SkillManifestEntry {
                name: s.name,
                summary: s.summary,
                tokens_approx: s.tokens_approx,
            })
            .collect();
        let memories: Vec<(String, String)> = store
            .list_memories()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|m| (m.name, m.body))
            .collect();
        let mut w = ctx.write().await;
        w.system_prompt = system_prompt;
        w.skills = skills;
        w.memories = memories;
    }
}

#[async_trait]
impl Tool for WelcomeTool {
    fn name(&self) -> &'static str {
        "welcome"
    }

    fn description(&self) -> &'static str {
        "Onboarding for external MCP clients. CALL THIS FIRST. \
         Returns Foyer's curated system prompt, the user's enabled \
         skills, and saved memory — the same context the in-process \
         agent receives. Without it, your performance against \
         Foyer's tools will be noticeably worse than the built-in \
         agent. Subsequent tools are polymorphic: one tool per \
         domain (transport, mixer, tracks, regions, automation, \
         plugins, midi, session, visualize), with a `subcommand` \
         discriminator inside the args."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    async fn call(&self, _ctx: &ToolContext, _args: Value) -> Result<ToolResult, ToolError> {
        let w = self.ctx.read().await;
        let payload = json!({
            "system_prompt": w.system_prompt,
            "skills": w.skills.iter()
                .map(|s| json!({
                    "name": s.name,
                    "summary": s.summary,
                    "tokens_approx": s.tokens_approx,
                }))
                .collect::<Vec<_>>(),
            "skills_note": "Skill BODIES are not included here. This list is an \
                index of available playbooks. BEFORE running an unfamiliar tool \
                (especially `plugins`, `midi`, `sequencer`, `automation`, `ui`, \
                `visualize`, `session`, or `scripts`), call \
                `scripts.skill { name: \"<skill-name>\" }` to load the playbook for \
                the task — the playbooks document the actual call shapes, the \
                gotchas, and the batch-vs-loop tradeoffs that small models tend \
                to get wrong on the first try.",
            "memories": w.memories.iter()
                .map(|(name, body)| json!({"name": name, "body": body}))
                .collect::<Vec<_>>(),
            "tool_convention": "Each Foyer tool is polymorphic — one tool per \
                domain, with a `subcommand` field inside args selecting the \
                operation. Use the `session.summary` subcommand of the \
                `session` tool to get a low-cost overview before driving \
                anything destructive.",
            "autonomy_note": "Destructive operations may be gated by the \
                operator's autonomy mode: `ask` (the harness pauses for \
                operator approval on destructive tools) or `auto` (no \
                gating, every call dispatches immediately). When a call \
                is parked for confirmation you'll see an `AwaitingConfirm` \
                status; the operator either approves it (the call resumes) \
                or rejects it (you'll see a `Rejected` error you can \
                explain to the user)."
        });
        Ok(ToolResult::ok(format!(
            "welcome — {} skills (bodies on demand via scripts.skill), {} memories",
            w.skills.len(),
            w.memories.len()
        ))
        .with_data(payload))
    }
}
