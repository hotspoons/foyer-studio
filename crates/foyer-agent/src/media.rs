// SPDX-License-Identifier: Apache-2.0
//! Short-id registry for media produced during an agent conversation.
//!
//! When a tool emits inline media (visualizer PNG, audio render, …)
//! the engine stamps each attachment with a short id (`i1`, `i2`,
//! `a1`, …) and stashes it here. Two callers consume the registry:
//!
//!   * The introspective-vision loop in
//!     [`crate::engine::AgentEngine::maybe_feed_back_media`] embeds the
//!     stamped id in the synthetic user record's content text so the
//!     model knows what to ask for later.
//!   * The [`crate::tools::media::MediaTool`] reads it on
//!     `media(subcommand="get", id=…)` to pull a previously-produced
//!     attachment back into the context window.
//!
//! Why this exists: the wire payload sent upstream has to redact
//! attachment bytes aggressively from older turns so vLLM's prefix
//! cache stays warm round-to-round. Without a recall path the model
//! would be unable to re-examine a render it produced earlier in the
//! same session — the bytes are dropped from the rolling context the
//! moment they're not the latest. The media library gives the model
//! a typed, byte-cheap pointer it can dereference on demand instead.
//!
//! Scope: one library per logical conversation. The in-process FAB
//! runtime keeps a single library that lives as long as the
//! `Conversation` does; the `/v1/chat/completions` proxy mints a
//! fresh, transient library per request so external API calls don't
//! see or mutate the FAB's archive.

use std::collections::HashMap;

use foyer_schema::agent::AgentAttachment;

/// Insertion-ordered registry of media attachments stamped with
/// short, human-readable ids. Cheap to clone the `Arc<Mutex<…>>`
/// wrapper that `ToolContext` carries.
#[derive(Debug, Default)]
pub struct MediaLibrary {
    entries: HashMap<String, MediaEntry>,
    /// Insertion order — keeps `list()` stable for the model so it
    /// can reason about "first / second / most recent" without
    /// hashing surprises.
    ordered: Vec<String>,
    /// Monotonic counter for the next id assignment. Per-mime-type
    /// prefix (`i` for image, `a` for audio, `m` for other) keeps
    /// ids short and self-describing.
    next_image: u64,
    next_audio: u64,
    next_other: u64,
}

#[derive(Debug, Clone)]
pub struct MediaEntry {
    /// Stamped id (`i3`, `a1`, …). Stable for the lifetime of the
    /// conversation.
    pub id: String,
    /// The attachment payload — name, MIME, base64 bytes.
    pub attachment: AgentAttachment,
    /// Which tool produced the bytes (`visualize`, `render`, …).
    pub source_tool: String,
    /// Tool-call id of the producing call. Lets a client correlate a
    /// `media` entry with the corresponding `foyer_tool_calls` row
    /// from the original assistant turn.
    pub source_call_id: String,
}

impl MediaLibrary {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stamp + store an attachment. Returns the assigned id. The id
    /// prefix is `i` for image MIMEs, `a` for audio, `m` for
    /// anything else — short so the model can quote it cheaply, and
    /// self-describing so a glance at the synthetic vision-context
    /// record's text tells you what kind of media it is.
    pub fn register(
        &mut self,
        source_tool: &str,
        source_call_id: &str,
        attachment: AgentAttachment,
    ) -> String {
        let id = if attachment.mime.starts_with("image/") {
            self.next_image += 1;
            format!("i{}", self.next_image)
        } else if attachment.mime.starts_with("audio/") {
            self.next_audio += 1;
            format!("a{}", self.next_audio)
        } else {
            self.next_other += 1;
            format!("m{}", self.next_other)
        };
        let entry = MediaEntry {
            id: id.clone(),
            attachment,
            source_tool: source_tool.to_string(),
            source_call_id: source_call_id.to_string(),
        };
        self.ordered.push(id.clone());
        self.entries.insert(id.clone(), entry);
        id
    }

    pub fn get(&self, id: &str) -> Option<&MediaEntry> {
        self.entries.get(id)
    }

    /// Insertion-ordered view of all entries. Used by
    /// `media(subcommand="list")`.
    pub fn list(&self) -> Vec<&MediaEntry> {
        self.ordered
            .iter()
            .filter_map(|id| self.entries.get(id))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(mime: &str, name: &str) -> AgentAttachment {
        AgentAttachment {
            name: name.into(),
            mime: mime.into(),
            b64: "AAAA".into(),
        }
    }

    #[test]
    fn ids_by_mime_prefix() {
        let mut lib = MediaLibrary::new();
        let i1 = lib.register("visualize", "c1", att("image/png", "a.png"));
        let i2 = lib.register("visualize", "c2", att("image/jpeg", "b.jpg"));
        let a1 = lib.register("render", "c3", att("audio/wav", "x.wav"));
        let m1 = lib.register("scripts", "c4", att("application/json", "x.json"));
        assert_eq!(i1, "i1");
        assert_eq!(i2, "i2");
        assert_eq!(a1, "a1");
        assert_eq!(m1, "m1");
        assert_eq!(lib.len(), 4);
    }

    #[test]
    fn list_is_insertion_ordered() {
        let mut lib = MediaLibrary::new();
        let _ = lib.register("v", "c1", att("image/png", "a.png"));
        let _ = lib.register("r", "c2", att("audio/wav", "b.wav"));
        let _ = lib.register("v", "c3", att("image/png", "c.png"));
        let ids: Vec<&str> = lib.list().iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["i1", "a1", "i2"]);
    }

    #[test]
    fn get_round_trips_attachment() {
        let mut lib = MediaLibrary::new();
        let id = lib.register("visualize", "c1", att("image/png", "thumb.png"));
        let entry = lib.get(&id).unwrap();
        assert_eq!(entry.source_tool, "visualize");
        assert_eq!(entry.source_call_id, "c1");
        assert_eq!(entry.attachment.mime, "image/png");
    }
}
