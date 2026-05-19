// SPDX-License-Identifier: Apache-2.0
//! Mixdown / render-to-file tool.
//!
//! Drives the backend's `render_session` and surfaces the encoded
//! audio bytes as a message attachment. Subcommands:
//!
//!   - `capabilities` — what encoders / bit depths / sample rates the
//!     active backend supports. Agents call this BEFORE `render` so
//!     they don't ask for a format the backend can't produce.
//!
//!   - `render` — perform the mixdown. By default the output rides
//!     back as a base64-encoded attachment on the tool result, so the
//!     model can hand the file to the user inline. Set
//!     `inline = false` to skip the bytes and return only the file
//!     path (the agent harness will then point the user at the
//!     artifact endpoint).
//!
//! The tool deliberately runs synchronously (await the full backend
//! render) — the engine's per-turn cancellation token already covers
//! the "user clicked stop" case, and the WS dispatch path is what
//! emits incremental `RenderProgress` events to other browsers (this
//! tool's caller sees one consolidated result).

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{Tool, ToolContext, ToolError, ToolResult};
use foyer_schema::{RenderOptions, RenderTarget};

pub struct RenderTool;

#[derive(Debug, Deserialize)]
#[serde(tag = "subcommand", rename_all = "snake_case")]
enum Op {
    /// Surface the backend's `RenderCapabilities`. Use to discover
    /// supported `format_id` / `sample_rates` / `bit_depths` before
    /// firing `render`.
    Capabilities,
    /// Mix down the session to an audio file and return it.
    Render {
        /// Encoder id from `capabilities.formats[].id`. Defaults to
        /// the first entry the backend advertises (usually `"wav"`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sample_rate: Option<u32>,
        /// One of `"int16"`, `"int24"`, `"int32"`, `"float32"`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bit_depth: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channels: Option<u8>,
        /// Quality 0..=10 for lossy encoders; ignored by lossless.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quality: Option<u8>,
        /// `"master"` (default), `"loop"`, or `{start_samples, end_samples}`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<RangeArg>,
        /// `None` = the backend picks a sensible exports/ folder.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_path: Option<String>,
        /// Default `true` — the tool ships the encoded bytes back
        /// inline so the model can attach the rendered audio to its
        /// reply. Pass `false` to return only `path` + `size_bytes`
        /// (the user fetches the file via the artifact endpoint).
        #[serde(default = "default_true")]
        inline: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RangeArg {
    /// Full session — start to last region's tail.
    Session,
    /// Explicit sample window.
    Range {
        start_samples: u64,
        end_samples: u64,
    },
    /// Use the session's currently-active loop range.
    Loop,
}

fn default_true() -> bool {
    true
}

#[async_trait]
impl Tool for RenderTool {
    fn name(&self) -> &'static str {
        "render"
    }

    fn description(&self) -> &'static str {
        "Mix down the session to a downloadable audio file (WAV / FLAC / OGG / MP3, \
         backend-dependent). Subcommands: capabilities (what the backend can encode) · \
         render (perform the mixdown — returns the bytes as an attachment by default \
         so you can hand the file to the user inline). Call `capabilities` first to \
         discover supported formats; respect the advertised set or the render will be \
         rejected before any audio is touched."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["subcommand"],
            "properties": {
                "subcommand": { "type": "string", "enum": ["capabilities", "render"] },
                "format_id":   { "type": "string" },
                "sample_rate": { "type": "integer", "minimum": 8000, "maximum": 384000 },
                "bit_depth":   { "type": "string", "enum": ["int16", "int24", "int32", "float32"] },
                "channels":    { "type": "integer", "minimum": 1, "maximum": 8 },
                "quality":     { "type": "integer", "minimum": 0, "maximum": 10 },
                "range":       { "type": "object" },
                "target_path": { "type": "string" },
                "inline":      { "type": "boolean" }
            }
        })
    }

    fn destructive(&self) -> bool {
        // Writes a file to the project's exports folder. Not
        // destructive of session state, but it CAN clobber an existing
        // file when the caller supplies a `target_path`. Treat as
        // destructive so the autonomy gate confirms in safe mode.
        true
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let op: Op =
            serde_json::from_value(args).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
        match op {
            Op::Capabilities => {
                let backend = ctx.backend()?;
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let caps = snap.render.unwrap_or_default();
                let format_ids: Vec<&str> = caps.formats.iter().map(|f| f.id.as_str()).collect();
                Ok(ToolResult::ok(format!(
                    "render encoders: [{}] · stems={} · range={}",
                    format_ids.join(", "),
                    caps.supports_stems,
                    caps.supports_range
                ))
                .with_data(serde_json::to_value(&caps).unwrap_or(Value::Null)))
            }
            Op::Render {
                format_id,
                sample_rate,
                bit_depth,
                channels,
                quality,
                range,
                target_path,
                inline,
            } => {
                let backend = ctx.backend_with_loaded_session().await?;
                let snap = backend
                    .snapshot()
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let caps = snap.render.ok_or_else(|| {
                    ToolError::Execution(
                        "active backend does not advertise render capabilities".into(),
                    )
                })?;
                if caps.formats.is_empty() {
                    return Err(ToolError::Execution(
                        "active backend advertises no render formats".into(),
                    ));
                }
                let chosen_format = format_id
                    .clone()
                    .unwrap_or_else(|| caps.formats[0].id.clone());
                if !caps.formats.iter().any(|f| f.id == chosen_format) {
                    return Err(ToolError::InvalidArgs(format!(
                        "format_id {chosen_format:?} not in backend's supported list: [{}]",
                        caps.formats
                            .iter()
                            .map(|f| f.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                let chosen_bit_depth = match bit_depth.as_deref() {
                    None => None,
                    Some("int16") => Some(foyer_schema::RenderBitDepth::Int16),
                    Some("int24") => Some(foyer_schema::RenderBitDepth::Int24),
                    Some("int32") => Some(foyer_schema::RenderBitDepth::Int32),
                    Some("float32") => Some(foyer_schema::RenderBitDepth::Float32),
                    Some(other) => {
                        return Err(ToolError::InvalidArgs(format!(
                            "unknown bit_depth {other:?} — use int16 / int24 / int32 / float32"
                        )))
                    }
                };
                let chosen_range = match range {
                    None => foyer_schema::RenderRange::Session,
                    Some(RangeArg::Session) => foyer_schema::RenderRange::Session,
                    Some(RangeArg::Range {
                        start_samples,
                        end_samples,
                    }) => foyer_schema::RenderRange::Range {
                        start_samples,
                        end_samples,
                    },
                    Some(RangeArg::Loop) => foyer_schema::RenderRange::Loop,
                };
                let opts = RenderOptions {
                    format_id: chosen_format.clone(),
                    sample_rate,
                    bit_depth: chosen_bit_depth,
                    channels,
                    quality,
                    target: RenderTarget::Master,
                    range: chosen_range,
                    normalize_to_master: true,
                    target_path,
                    inline_bytes: inline,
                };
                let outputs = backend
                    .render_session(opts, None)
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let out = outputs
                    .into_iter()
                    .next()
                    .ok_or_else(|| ToolError::Execution("backend returned no outputs".into()))?;
                // Re-derive a friendly file name for the attachment.
                let name = std::path::Path::new(&out.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("render.{}", chosen_format));
                let summary = format!(
                    "rendered {} → {} ({} bytes)",
                    chosen_format, out.path, out.size_bytes
                );
                let mut data = json!({
                    "path": out.path,
                    "size_bytes": out.size_bytes,
                    "format_id": out.format_id,
                    "mime": out.mime,
                });
                // Surface as `data.attachments[]` so the OpenAI proxy
                // sink's attachment-harvest path picks it up and the
                // FAB renders it as a download chip. The proxy sink
                // converts each entry to an `ExternalChatStreamEvent
                // ::Attachment`; the agent-FAB UI just inlines the
                // chip on the assistant card. Empty `bytes_b64`
                // collapses to "show only the path".
                if let Some(b64) = out.bytes_b64.clone() {
                    if !b64.is_empty() {
                        data["attachments"] = json!([{
                            "name": name,
                            "mime": out.mime,
                            "b64": b64,
                        }]);
                    }
                }
                Ok(ToolResult::ok(summary).with_data(data))
            }
        }
    }
}
