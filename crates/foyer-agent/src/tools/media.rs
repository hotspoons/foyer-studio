// SPDX-License-Identifier: Apache-2.0
//! Recall media that the agent has already produced this conversation.
//!
//! Why this exists: every tool that emits inline media (a visualizer
//! PNG, an audio render, a spectrogram, …) gets the bytes spliced
//! back into the next-turn LLM context via the introspective-vision
//! loop in [`crate::engine::AgentEngine::maybe_feed_back_media`]. To
//! keep vLLM's prefix cache stable across turns, those bytes are then
//! redacted from older records on subsequent rounds — but the model
//! sometimes legitimately needs to re-examine an earlier render. This
//! tool provides the recall path: each tool-produced attachment is
//! stamped with a short id (`i3`, `a1`, …) in
//! [`crate::media::MediaLibrary`] at production time; a
//! `media(subcommand="get", id="i3")` call returns the bytes again
//! as a fresh attachment, which the same vision-feedback loop then
//! re-injects into context.
//!
//! Subcommands:
//!
//!   * `list` — enumerate all stamped media with `{id, mime, name,
//!     source_tool, source_call_id, decoded_byte_size}`. Cheap; the
//!     model uses this to find out what's available before recalling.
//!   * `get` — fetch the bytes for one id. Returns a `ToolResult`
//!     with the attachment in `data.attachments` so the standard
//!     vision-feedback path picks it up.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct MediaTool;

#[derive(Deserialize)]
struct Args {
    subcommand: String,
    #[serde(default)]
    id: Option<String>,
}

#[async_trait]
impl Tool for MediaTool {
    fn name(&self) -> &'static str {
        "media"
    }

    fn description(&self) -> &'static str {
        "Recall media (images, audio) produced earlier in this conversation by previous tool \
         calls. Each piece of media is stamped with a short id shown in the synthetic vision-\
         context user record that follows every media-producing tool call (e.g. `i3` for the \
         third image, `a1` for the first audio clip). The rolling LLM context redacts older \
         attachment bytes to keep the prefix cache warm — when you need to re-examine an \
         earlier render, call this tool to pull the bytes back into context as a fresh \
         attachment that your vision tower can read.\n\n\
         Subcommands:\n\
         · list — enumerate all stamped media in this conversation. Returns ids + source tool \
           + MIME + approximate decoded byte size. Use this when you don't remember the id \
           of the render you want.\n\
         · get  — fetch the bytes for one id. The bytes ride back as a standard image_url / \
           input_audio content block on the next round, so you can reason over the image \
           directly. Requires `id`."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "subcommand": {
                    "type": "string",
                    "enum": ["list", "get"],
                    "description": "list = enumerate stamped media; get = pull one back into context"
                },
                "id": {
                    "type": "string",
                    "description": "Stamped short id (e.g. `i3`, `a1`). Required for subcommand=get."
                }
            },
            "required": ["subcommand"]
        })
    }

    fn destructive(&self) -> bool {
        // Read-only — recall doesn't mutate session state and
        // doesn't even mutate the library. Skip the autonomy gate.
        false
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let args: Args =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        let library = ctx.media_library.lock().await;
        match args.subcommand.as_str() {
            "list" => {
                let items: Vec<Value> = library
                    .list()
                    .iter()
                    .map(|e| {
                        json!({
                            "id": e.id,
                            "mime": e.attachment.mime,
                            "name": e.attachment.name,
                            "source_tool": e.source_tool,
                            "source_call_id": e.source_call_id,
                            // 4 b64 chars ≈ 3 raw bytes — gives the
                            // model a sense of "is this clip big" so
                            // it doesn't blindly recall a 500 KB
                            // render when a stat would do.
                            "approx_bytes": (e.attachment.b64.len() / 4) * 3,
                        })
                    })
                    .collect();
                Ok(
                    ToolResult::ok(format!("{} media item(s) stamped", items.len()))
                        .with_data(json!({ "items": items })),
                )
            }
            "get" => {
                let id = args.id.ok_or_else(|| {
                    ToolError::InvalidArgs(
                        "subcommand=get requires the `id` field (call media(subcommand=\"list\") \
                         first if you don't remember it)"
                            .into(),
                    )
                })?;
                let entry = library.get(&id).ok_or_else(|| {
                    ToolError::InvalidArgs(format!(
                        "no media stamped with id `{id}` — call media(subcommand=\"list\") to \
                         see what's available"
                    ))
                })?;
                // Return the attachment via the `data.attachments`
                // convention. The engine's vision-feedback path
                // (`maybe_feed_back_media`) scrapes this on the next
                // tool-result handler and pushes a fresh synthetic
                // user record with the bytes — so calling this tool
                // is enough; the model doesn't need to do anything
                // else, the image/audio will appear in its context
                // on the next round.
                let attachment = entry.attachment.clone();
                let summary = format!(
                    "recalled {} ({}, produced by `{}`)",
                    entry.id, attachment.mime, entry.source_tool
                );
                Ok(ToolResult::ok(summary).with_data(json!({
                    "id": entry.id,
                    "source_tool": entry.source_tool,
                    "source_call_id": entry.source_call_id,
                    "attachments": [attachment],
                })))
            }
            other => Err(ToolError::InvalidArgs(format!(
                "unknown subcommand: {other} (expected `list` or `get`)"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaLibrary;
    use foyer_schema::agent::AgentAttachment;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn ctx_with_library(lib: Arc<Mutex<MediaLibrary>>) -> ToolContext {
        ToolContext {
            backend: crate::tools::make_backend_ref(std::sync::Weak::<
                foyer_backend_stub::StubBackend,
            >::new()),
            fe_attached: false,
            fe_render: None,
            headless_render: None,
            ui_director: None,
            session_director: None,
            spectrum_director: None,
            prefer_headless_render: false,
            turn_budget: None,
            media_library: lib,
        }
    }

    fn seed_library() -> Arc<Mutex<MediaLibrary>> {
        let mut lib = MediaLibrary::new();
        lib.register(
            "visualize",
            "call_a",
            AgentAttachment {
                name: "mixer.png".into(),
                mime: "image/png".into(),
                b64: "AAAA".repeat(40),
            },
        );
        lib.register(
            "render",
            "call_b",
            AgentAttachment {
                name: "render.wav".into(),
                mime: "audio/wav".into(),
                b64: "BBBB".repeat(80),
            },
        );
        Arc::new(Mutex::new(lib))
    }

    #[tokio::test]
    async fn list_returns_all_entries() {
        let ctx = ctx_with_library(seed_library());
        let res = MediaTool
            .call(&ctx, json!({ "subcommand": "list" }))
            .await
            .unwrap();
        let items = res.data.get("items").unwrap().as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "i1");
        assert_eq!(items[0]["source_tool"], "visualize");
        assert_eq!(items[1]["id"], "a1");
    }

    #[tokio::test]
    async fn get_returns_attachment_for_known_id() {
        let ctx = ctx_with_library(seed_library());
        let res = MediaTool
            .call(&ctx, json!({ "subcommand": "get", "id": "i1" }))
            .await
            .unwrap();
        let atts = res.data.get("attachments").unwrap().as_array().unwrap();
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0]["mime"], "image/png");
    }

    #[tokio::test]
    async fn get_errors_on_unknown_id() {
        let ctx = ctx_with_library(seed_library());
        let err = MediaTool
            .call(&ctx, json!({ "subcommand": "get", "id": "i99" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no media stamped"));
    }

    #[tokio::test]
    async fn get_errors_when_id_missing() {
        let ctx = ctx_with_library(seed_library());
        let err = MediaTool
            .call(&ctx, json!({ "subcommand": "get" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("requires the `id` field"));
    }
}
