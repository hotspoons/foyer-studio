// SPDX-License-Identifier: Apache-2.0
//! Hidden escape hatch for the per-turn tool-round budget.
//!
//! The engine seeds every turn with `INITIAL_TOOL_ROUND_BUDGET`
//! rounds of model→tool→model loop. That's deliberately a comfortable
//! number — the agent shouldn't normally hit it, and when it does the
//! right move is usually to wrap up and ask the user. But Foyer ops
//! sometimes *legitimately* span more than 32 rounds (a multi-track
//! plugin pass, a long sequencer authoring session, a big MIDI
//! transcription). For those cases this tool grants the agent a
//! second wind without the engine having to hard-stop the user mid-
//! flow.
//!
//! The tool is intentionally **not advertised in the system prompt**:
//! the welcome payload doesn't mention it, the skills don't reference
//! it, and the `tools/list` advertisement lives only inside the
//! polymorphic registry. The engine surfaces the tool by name in the
//! wrap-up nudge ("…or call `continue_working` if you're genuinely
//! mid-task"), so the model only learns about it when it's
//! contextually appropriate.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::engine::ROUND_BUDGET_EXTENSION;
use crate::tools::{Tool, ToolContext, ToolError, ToolResult};

pub struct ContinueWorkingTool;

#[async_trait]
impl Tool for ContinueWorkingTool {
    fn name(&self) -> &'static str {
        "continue_working"
    }

    fn description(&self) -> &'static str {
        "Extend your tool-round budget by another batch when you're \
         genuinely in the middle of a multi-step task (e.g. wiring up \
         a long plugin chain, authoring a complex sequencer pattern, \
         transcribing a long region). The harness asks you to confirm \
         before each batch instead of just running forever so the user \
         keeps a clear handle on what you're spending tokens on. PREFER \
         to wrap up and let the user re-prompt when feasible — only use \
         this when stopping now would leave the session in a half-done \
         state."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "One short sentence on what you're \
                        still working on so the operator can audit the \
                        extension later. Surfaced in the trace + the \
                        FAB transcript banner."
                }
            }
        })
    }

    fn destructive(&self) -> bool {
        // The autonomy gate skips this — extending the budget is a
        // self-serve harness operation, not a session mutation. We
        // log loudly so unsupervised runs still get a paper trail.
        false
    }

    async fn call(&self, ctx: &ToolContext, args: Value) -> Result<ToolResult, ToolError> {
        let reason = args
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let Some(budget) = ctx.turn_budget.as_ref() else {
            // Dispatched outside `run_turn` — no per-turn budget exists
            // to extend. This only happens on thin paths used in tests;
            // FAB, `/v1/chat/completions`, and MCP all funnel through
            // `run_turn` and have a live budget. Return success with a
            // benign message so a misuse from the model doesn't error
            // the turn.
            return Ok(
                ToolResult::ok("no per-turn budget to extend in this dispatch context")
                    .with_data(json!({ "extended": false })),
            );
        };
        let (new_cap, total_extensions) = {
            let mut guard = budget
                .lock()
                .map_err(|_| ToolError::Execution("turn budget mutex poisoned".into()))?;
            guard.extend();
            (guard.cap, guard.extensions)
        };
        let summary = if reason.is_empty() {
            format!(
                "extended tool round budget by {ROUND_BUDGET_EXTENSION} \
                 (cap now {new_cap}, {total_extensions} extensions)"
            )
        } else {
            format!(
                "extended tool round budget by {ROUND_BUDGET_EXTENSION} \
                 (cap now {new_cap}, {total_extensions} extensions): {reason}"
            )
        };
        Ok(ToolResult::ok(summary).with_data(json!({
            "extended": true,
            "new_cap": new_cap,
            "extension_count": total_extensions,
            "reason": reason,
        })))
    }
}
