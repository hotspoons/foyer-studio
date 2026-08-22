# ACP — Agent Client Protocol support

Foyer speaks the [Agent Client Protocol](https://agentclientprotocol.com/)
as an **agent**, so any ACP client — Zed, JetBrains, marimo, a
custom control room — can drive the embedded Foyer agent and,
through it, the live DAW session. Protocol **v1** (stable) and
**v2** (2026-07-20 draft) are both served; the version is picked
per-connection at `initialize`.

This is the third thin surface over the same
[`AgentRuntime`](../crates/foyer-agent/src/runtime.rs) (browser FAB
and MCP being the first two — see the architecture note in
[foyer-agent's lib.rs](../crates/foyer-agent/src/lib.rs)). The
symmetry that matters:

| Surface | External party | What they get |
|---|---|---|
| `/mcp` ([foyer-mcp](../crates/foyer-mcp/)) | external **agents** (Claude Code, Codex) | Foyer's *tools* — they bring their own brain |
| `/acp/ws` ([foyer-acp](../crates/foyer-acp/)) | external **clients** (editors, agent UIs) | Foyer's *agent* — prompt it, watch tool calls stream, gate permissions |

## Architecture

```
Zed / JetBrains / any ACP client
        │ spawns `foyer acp` (stdio, JSON-RPC lines)
        ▼
foyer-cli `acp` subcommand — dumb line↔frame relay
        │ WebSocket (one JSON-RPC message per text frame)
        ▼
foyer-server  /acp/ws  ──►  foyer-acp bridge
                              │ AgentProtocolRouter (v1 | v2, by initialize)
                              ▼
                        AgentRuntime (in-process; shared with FAB + MCP)
```

- **Protocol ceremony stays in the bridge crate** — the official
  [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol)
  SDK (Apache-2.0, same one Zed maintains), `unstable_protocol_v2`
  feature for the v2 chain. `foyer-agent` keeps zero ACP types, the
  same way it keeps zero rmcp types (CLAUDE.md's MCP rule, extended).
- **The server process hosts the bridge** because that's where the
  `AgentRuntime` lives. ACP-over-WebSocket at `/acp/ws` is the native
  transport; editors that only know how to spawn subprocesses run
  `foyer acp [--url ws://…]`, which is a ~100-line stdio↔WS relay
  with no ACP parsing of its own.
- **One shared conversation.** ACP clients drive the *same* agent
  the browser FAB shows — a prompt sent from Zed streams into the
  producer's FAB transcript, and vice versa. That's the
  backend-is-source-of-truth rule applied to agent state; ACP
  sessions map 1:1 onto the runtime's persisted agent sessions
  (`session/new` → `new_session`, v1 `session/load` /
  v2 `session/resume` → `load_session`, v2 `session/list` →
  the store's session list).

## Mapping (both versions)

| ACP | Foyer |
|---|---|
| `initialize` | capability advert (`loadSession`, image+audio prompts; no fs, no terminal) |
| `session/new` | `AgentRuntime::new_session` |
| `session/prompt` | `send_user_message` — the response resolves when the turn ends |
| `session/update` ← | `AgentEvent::Token` → message chunk; `AgentEvent::ToolUpdate` → tool_call / tool_call_update |
| `session/request_permission` ← | `ToolUpdate{status: AwaitingConfirm}` (autonomy=ask) → reply routes to `confirm_tool(call_id, approve)` |
| `session/cancel` | `stop_current_turn` → prompt resolves `stop_reason: cancelled` |
| v1 `session/set_mode` (`ask`/`auto`) | `set_autonomy` — the FAB's safety toggle, exposed as ACP session modes |
| v2 `session/resume`, `session/close`, `session/list`, `session/delete` | `load_session` / no-op ack / `list_sessions` / `delete_session` |

Turn-model split, per the v2 draft's design intent:

- **v1 connections** get classic turn semantics: `session/update`
  notifications flow only while that client's own `session/prompt`
  is in flight.
- **v2 connections** get the decoupled model: updates forward
  continuously (other surfaces' prompts included) with
  `StateUpdate` running/idle transitions, using stable
  `MessageId`s derived from the runtime's monotonic record ids.

## Milestones

1. **M1 — v1 end-to-end** *(shipped with this doc)*:
   `crates/foyer-acp` (bridge lib + axum router), `/acp/ws` mount in
   foyer-server, `foyer acp` relay subcommand, session modes,
   permission round-trip, integration tests (in-memory duplex
   transport + scripted OpenAI-shape LLM on loopback + stub backend).
2. **M2 — v2 chain** *(shipped with this doc)*: protocol router
   serving both; v2 session lifecycle, continuous updates, state
   transitions, permission subjects.
3. **M3 — deferred**, in rough order of pull:
   - Client-provided MCP servers (`session/new` carries them; wire
     into `foyer-agent`'s existing `mcp_proxy` so an editor can hand
     Foyer's agent extra tools).
   - v2 session config options (autonomy + model picker as
     `SessionConfigOption`s).
   - v2 `session/fork` (needs conversation-store fork support).
   - Terminal/fs passthrough: n/a by design — Foyer's agent runs
     against the DAW, not the client's filesystem.
   - ACP auth methods once the tunnel-auth story needs them
     (today `/acp/ws` sits behind the same network posture as
     `/mcp`; RBAC on the WS surface gates what tools can do).

## Trying it

```bash
just run --backend stub          # or a real session
foyer acp --url ws://127.0.0.1:3838/acp/ws   # stdio ACP agent, spawn from any client
```

Zed `settings.json`:

```json
{
  "agent_servers": {
    "Foyer Studio": { "command": "foyer", "args": ["acp"] }
  }
}
```
