// SPDX-License-Identifier: Apache-2.0
//
// Browser-side WebLLM client.
//
// Loads @mlc-ai/web-llm via the esm.run CDN (vendored install would
// be ~30 MB of WASM + model shards that we don't want in the
// shipping binary), attaches to the sidecar at `/ws/webllm`, and
// fulfills inference requests routed in from the OpenAI-compatible
// HTTP bridge at `/llm/v1/*`. See DECISIONS.md 49 for the loop.
//
// Lifecycle:
//   const client = new WebLLMClient(modelId);
//   await client.start();   // opens the WS, loads the model
//   ...
//   await client.stop();    // closes the WS, unloads the model
//
// One client per browser tab. Multiple tabs all racing on the same
// `/ws/webllm` slot is fine — the sidecar logs a warning and uses
// the most recently attached connection.

const WEBLLM_ESM = "https://esm.run/@mlc-ai/web-llm";

export class WebLLMClient extends EventTarget {
  constructor(modelId) {
    super();
    this.modelId = modelId;
    this._ws = null;
    this._engine = null;
    this._status = "idle"; // idle | loading | ready | error | stopped
  }

  get status() {
    return this._status;
  }

  _setStatus(s, extra) {
    this._status = s;
    this.dispatchEvent(new CustomEvent("status", { detail: { status: s, ...extra } }));
    this._announceModelInfo();
  }

  /// Attach to /ws/webllm AND load the model. Sequence:
  ///   1. Open the WS so the sidecar can announce status updates
  ///      back to the agent settings modal.
  ///   2. Dynamic-import the WebLLM ESM bundle (~5 MB; cached by
  ///      the browser after first run).
  ///   3. Construct the engine — this kicks off the model-shard
  ///      download to the OPFS cache. Progress fires as `loading`
  ///      events.
  ///   4. Flip to `ready` so the sidecar's bridge starts accepting
  ///      `/llm/v1/chat/completions` traffic.
  async start() {
    if (this._status === "ready" || this._status === "loading") return;
    this._setStatus("loading");
    const wsUrl = new URL("/ws/webllm", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    this._ws = new WebSocket(wsUrl);
    this._ws.addEventListener("open", () => this._announceModelInfo());
    this._ws.addEventListener("message", (ev) => this._onWsMessage(ev));
    this._ws.addEventListener("close", () => {
      this._setStatus("stopped");
    });
    try {
      const { CreateMLCEngine } = await import(WEBLLM_ESM);
      this._engine = await CreateMLCEngine(this.modelId, {
        initProgressCallback: (p) => {
          this.dispatchEvent(
            new CustomEvent("progress", {
              detail: { progress: p?.progress ?? 0, text: p?.text || "" },
            }),
          );
        },
      });
      this._setStatus("ready");
    } catch (e) {
      console.error("[webllm] load failed:", e);
      this._setStatus("error", { error: String(e) });
      try {
        this._ws?.close();
      } catch {}
      this._ws = null;
      this._engine = null;
    }
  }

  async stop() {
    this._setStatus("stopped");
    try {
      this._ws?.close();
    } catch {}
    try {
      await this._engine?.unload?.();
    } catch {}
    this._ws = null;
    this._engine = null;
  }

  _announceModelInfo() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(
      JSON.stringify({
        type: "model_info",
        model_id: this.modelId,
        status: this._status,
      }),
    );
  }

  async _onWsMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || !msg.id) return;
    if (this._status !== "ready" || !this._engine) {
      this._sendReply({ id: msg.id, error: `webllm not ready: ${this._status}` });
      return;
    }
    const wantsStream = !!msg.stream;
    const { messages: rawMessages, model: _unused, tools, ...rest } = msg;
    const id = msg.id;

    // WebLLM's native `tools` parameter only works for a small set of
    // Hermes-family models, so we always strip it and emulate tool
    // calls via prompt injection + stream-side parsing. Port of
    // patapsco-ai-platform/.../lib/webllm-provider.js.
    const toolDefs = Array.isArray(tools) ? tools : [];
    const usePromptTools = toolDefs.length > 0;
    const messages = usePromptTools
      ? injectToolPrompt(rewriteHistoryForText(rawMessages), toolDefs)
      : rawMessages;

    try {
      if (wantsStream) {
        const iter = await this._engine.chat.completions.create({
          messages,
          stream: true,
          ...rest,
        });
        if (usePromptTools) {
          await this._streamWithToolParsing(id, iter);
        } else {
          for await (const chunk of iter) {
            this._sendReply({ id, type: "chunk", ...sanitizeChunk(chunk) });
          }
          this._sendReply({ id, type: "done" });
        }
      } else {
        const reply = await this._engine.chat.completions.create({
          messages,
          stream: false,
          ...rest,
        });
        this._sendReply({ id, ...sanitizeReply(reply) });
      }
    } catch (e) {
      console.error("[webllm] inference failed:", e);
      this._sendReply({ id, error: String(e) });
    }
  }

  /// Stream tokens through a `<tool_call>…</tool_call>` filter,
  /// emitting OpenAI-shaped chunks: visible text as `delta.content`,
  /// each closed tool block as a `delta.tool_calls[]` entry. The
  /// agent harness in Rust consumes the same shape it would from any
  /// real tools-capable provider.
  async _streamWithToolParsing(id, iter) {
    const filter = createToolCallStreamFilter();
    let toolCallIndex = 0;
    let hasToolCalls = false;
    for await (const chunk of iter) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      const text = delta.content || "";
      if (text) {
        const { visible, completedCalls } = filter.push(text);
        if (visible) {
          this._sendReply({
            id,
            type: "chunk",
            choices: [{ index: 0, delta: { content: visible }, finish_reason: null }],
          });
        }
        for (const tc of completedCalls) {
          hasToolCalls = true;
          this._sendReply({
            id,
            type: "chunk",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolCallIndex,
                  id: `call_webllm_${Date.now()}_${toolCallIndex}`,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments || {}),
                  },
                }],
              },
              finish_reason: null,
            }],
          });
          toolCallIndex++;
        }
      }
    }
    const tail = filter.flush();
    if (tail) {
      this._sendReply({
        id,
        type: "chunk",
        choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
      });
    }
    // Terminal finish_reason so the harness sees a clean turn-end.
    this._sendReply({
      id,
      type: "chunk",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      }],
    });
    this._sendReply({ id, type: "done" });
  }

  _sendReply(payload) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify(payload));
  }
}

/// Strip the request id (echoed back on every chunk) from the
/// WebLLM stream chunk before forwarding — the sidecar re-stamps it.
function sanitizeChunk(chunk) {
  const out = { ...chunk };
  delete out.id;
  return out;
}

function sanitizeReply(reply) {
  const out = { ...reply };
  delete out.id;
  return out;
}

// Singleton accessor — agent settings + agent panel both poke the
// same client. Mounted on `window.__foyer.webllm` so external probes
// (`just ui-probe eval`) can inspect it.
let _singleton = null;

export function getWebLLMClient() {
  return _singleton;
}

export async function startWebLLM(modelId) {
  if (_singleton && _singleton.modelId !== modelId) {
    await _singleton.stop();
    _singleton = null;
  }
  if (!_singleton) {
    _singleton = new WebLLMClient(modelId);
    if (typeof window !== "undefined") {
      window.__foyer = window.__foyer || {};
      window.__foyer.webllm = _singleton;
    }
  }
  await _singleton.start();
  return _singleton;
}

export async function stopWebLLM() {
  if (_singleton) {
    await _singleton.stop();
  }
}

// ─── Tool-call prompt injection + stream filter (patapsco port) ─────

function injectToolPrompt(messages, toolDefs) {
  const toolBlock = toolDefs.map((t) => {
    const f = t.function || t;
    const params = f.parameters ? `\n  Parameters: ${JSON.stringify(f.parameters)}` : "";
    return `- ${f.name}: ${f.description || ""}${params}`;
  }).join("\n");
  const toolPrompt = [
    "You have access to tools. To call one, output a <tool_call> block:",
    "<tool_call>",
    "{\"name\": \"exact_tool_id\", \"arguments\": {...}}",
    "</tool_call>",
    "",
    "CRITICAL: The JSON MUST be wrapped in <tool_call></tool_call> tags. Bare JSON will be ignored.",
    "WRONG:   {\"name\": \"navigate\", \"arguments\": {\"route\": \"x\"}}",
    "CORRECT: <tool_call>{\"name\": \"navigate\", \"arguments\": {\"route\": \"x\"}}</tool_call>",
    "",
    "IMPORTANT RULES:",
    "- \"name\" MUST be the exact tool identifier shown before the colon below.",
    "- Call ONLY ONE tool per response. After the single <tool_call> block, STOP. Do not output more text or more tool calls.",
    "- Wait for the tool result before deciding the next step. Do NOT plan multiple steps ahead.",
    "- If no tool is needed, respond normally without <tool_call> tags.",
    "",
    "Available tools:",
    toolBlock,
  ].join("\n");
  const out = [...messages];
  if (out.length > 0 && out[0].role === "system") {
    out[0] = { ...out[0], content: `${out[0].content || ""}\n\n${toolPrompt}` };
  } else {
    out.unshift({ role: "system", content: toolPrompt });
  }
  return out;
}

function rewriteHistoryForText(messages) {
  return messages.map((m) => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const callText = m.tool_calls.map((tc) => {
        const fn = tc.function || {};
        return `<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || "{}"}}\n</tool_call>`;
      }).join("\n");
      const { tool_calls: _drop, ...rest } = m;
      return { ...rest, content: `${rest.content || ""}\n${callText}`.trim() };
    }
    if (m.role === "tool") {
      const label = m.name || m.tool_call_id || "unknown";
      return { role: "user", content: `[Tool result: ${label}]\n${m.content || ""}` };
    }
    return m;
  });
}

/// Streaming filter for `<tool_call>…</tool_call>` blocks. Hides
/// the literal tags + their JSON payload from `visible` and emits
/// each parsed block as a `{name, arguments}` object.
function createToolCallStreamFilter() {
  const OPEN_TAG = "<tool_call>";
  const CLOSE_TAG = "</tool_call>";
  let state = "normal"; // normal | pending | inside
  let buffer = "";
  let blockContent = "";

  function push(chunk) {
    let visible = "";
    const completedCalls = [];
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (state === "normal") {
        if (ch === "<") {
          state = "pending";
          buffer = "<";
        } else {
          visible += ch;
        }
        i++;
      } else if (state === "pending") {
        buffer += ch;
        i++;
        if (OPEN_TAG.startsWith(buffer)) {
          if (buffer === OPEN_TAG) {
            state = "inside";
            buffer = "";
            blockContent = "";
          }
        } else {
          visible += buffer;
          buffer = "";
          state = "normal";
        }
      } else if (state === "inside") {
        buffer += ch;
        i++;
        if (buffer.endsWith(CLOSE_TAG)) {
          blockContent += buffer.slice(0, -CLOSE_TAG.length);
          try {
            const obj = JSON.parse(blockContent.trim());
            completedCalls.push({
              name: obj.name || obj.function?.name || "",
              arguments: obj.arguments || obj.parameters || {},
            });
          } catch { /* skip malformed */ }
          buffer = "";
          blockContent = "";
          state = "normal";
        }
        if (buffer.length > 1024) {
          blockContent += buffer.slice(0, -CLOSE_TAG.length);
          buffer = buffer.slice(-CLOSE_TAG.length);
        }
      }
    }
    return { visible, completedCalls };
  }

  function flush() {
    if (state === "pending") {
      const tail = buffer;
      buffer = "";
      state = "normal";
      return tail;
    }
    return "";
  }

  return { push, flush };
}
