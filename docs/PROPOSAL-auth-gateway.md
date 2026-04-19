# Proposal: Auth Gateway for Remote DAW Collaboration

**Status:** draft — no code committed yet
**Author:** Foyer Studio team
**Related:** [TODO.md](TODO.md), [DECISIONS.md](DECISIONS.md),
             [PLAN.md](PLAN.md) §M6 collaboration milestones

## Problem

Today, a Foyer deployment is one sidecar listening on one WebSocket
port on one machine. To let a second user connect from the outside
world, someone has to:

1. Poke a hole through the studio's firewall (or Tailscale / Cloudflare
   Tunnel / ngrok).
2. Hand out an IP or hostname + port.
3. Decide how to authenticate — currently "nothing", because we assume
   trusted LAN.
4. Tell the remote user which of potentially many DAW sessions
   they're connecting to.

For any real-world collaboration workflow this is annoying at best
and actively unsafe at worst. We want a **gateway** that handles
discovery, auth, and routing — so a remote producer can just "log in
to the Foyer cloud" and pick which studio/session they're joining,
without the engineer having to configure anything per-session.

## Shape of the solution

```
 ┌──────────────┐          ┌────────────────────┐          ┌──────────────┐
 │ DAW host A   │          │                    │          │ Client 1     │
 │  hardour     │          │  Foyer Gateway     │          │  browser     │
 │   └─ shim    │──WS──►─┐ │                    │ ┌──►──WS──┤              │
 │   └─ sidecar │◄─WS──┐ │ │  · auth (OIDC/     │ │         └──────────────┘
 └──────────────┘      │ │ │    JWT / API key)  │ │
                       ├─┼─┼─ session registry  │ │         ┌──────────────┐
 ┌──────────────┐      │ │ │ · WS fan-out       │ │ ┌──►──WS─┤ Client 2     │
 │ DAW host B   │      │ │ │ · TURN/STUN for    │ │ │        │  desktop     │
 │  hardour     │──WS──┘ │ │   WebRTC audio     │ │ │        │  (wry)       │
 │   └─ shim    │        │ │                    │ │ │        └──────────────┘
 │   └─ sidecar │◄──WS───┘ │                    │◄┘ │
 └──────────────┘          └────────────────────┘   │
                                                    └── additional clients…
```

**Key framing:** the gateway is a *network service*, not a process
colocated with Ardour. The sidecar running next to each DAW already
speaks the foyer wire protocol over WebSocket; we just add an
optional upstream connection to the gateway on top.

### Terminology

- **DAW host** — a machine running Ardour (or a future Reaper/etc)
  plus a Foyer sidecar. Has private network access to the DAW's IPC
  socket; exposes only WebSocket upstream.
- **Gateway** — a single publicly-reachable Foyer server. Auths
  clients, maintains a registry of connected DAW hosts, routes
  WebSocket frames between them.
- **Session** — a named (DAW host, Ardour session) pair. E.g.
  `studio-a/thursday-mix`. The gateway may expose multiple sessions
  from the same DAW host if it's running multiple Ardour instances
  (see [TODO.md §Multi-session management](TODO.md)).
- **Client** — a browser or `foyer-desktop` instance connecting to
  the gateway. Identified by a user token; may be read-only, editor,
  or owner.

## Protocol sketch

The foyer wire protocol (see [`crates/foyer-schema/src/message.rs`](../crates/foyer-schema/src/message.rs))
stays unchanged. The gateway adds an envelope OUTSIDE the existing
`Envelope<Event>` / `Envelope<Command>`, identifying session + user.

### Gateway envelope (new)

```rust
struct GatewayFrame {
    /// Logical routing target — which DAW session this frame is for.
    /// `None` means "this is a gateway-control frame" (auth, list,
    /// subscribe, heartbeat).
    session: Option<SessionId>,

    /// Origin tag. Gateway rewrites this to `user:<sub>` or
    /// `daw:<session>` before forwarding, so downstream can't spoof.
    origin: Option<String>,

    /// Inner payload — either a foyer `Envelope<Event>` /
    /// `Envelope<Command>`, or a gateway control message.
    body: GatewayBody,
}

enum GatewayBody {
    // Gateway control plane
    AuthRequest   { token: String, client_info: ClientInfo },
    AuthAck       { user: UserInfo, sessions: Vec<SessionInfo> },
    SessionList   { sessions: Vec<SessionInfo> },
    Subscribe     { session: SessionId },
    Unsubscribe   { session: SessionId },
    SessionJoined { session: SessionId, role: Role },
    SessionLeft   { session: SessionId, reason: String },
    Error         { code: String, message: String },
    // Forwarded foyer frames (transparent passthrough)
    Forward       { inner: Vec<u8> },  // serialized Envelope<Event|Command>
}
```

### DAW host → gateway registration

A DAW host running a sidecar optionally connects upstream to the
gateway with credentials of its own (a long-lived **host token**,
separate from user tokens). On connect:

1. Sidecar sends `AuthRequest { token, client_info: { kind: "daw-host", ... } }`.
2. Gateway validates, responds with `AuthAck { user: { ... }, sessions: [] }`.
3. Sidecar sends one `SessionJoined { session, role: Daw }` per
   Ardour session it exposes. Sessions can come and go without
   reconnecting.
4. Gateway's session registry adds the session with back-pointer to
   this sidecar connection.

### Client → gateway → session

A client-side sidecar or browser follows the same auth handshake
with a **user token**, then either:

- Fetches `SessionList`, lets the user pick a session, sends
  `Subscribe { session }`.
- Or specifies a session at connect time via URL:
  `wss://foyer.example/join/studio-a/thursday-mix?token=…`, which the
  gateway translates into an implicit `Subscribe`.

From that point forward, every `Forward` frame the client sends gets
routed to the DAW host's sidecar; every `Forward` frame the DAW host
emits gets fanned out to all clients subscribed to that session.
Neither side needs to know who else is connected; fan-out is the
gateway's problem.

### Heartbeats + presence

Both sides send a gateway-level ping every 15s. On miss for 45s the
gateway drops the peer and emits `SessionLeft` to the counterpart.
Presence is already a concept at the foyer-schema layer (Envelope
`origin` tag); the gateway fills in the right `user:<sub>` or
`daw:<name>` value so clients see who's who without trusting the
wire.

## Auth model

We want something a studio owner can run themselves, plus a managed
instance for "plug and play" users. Three levels:

1. **Zero-auth / LAN mode** (current). Gateway URL is unset; sidecar
   listens on a local port; everyone on the LAN can connect. Not
   going away — it's the easiest onboarding.
2. **Self-hosted gateway with API keys.** Studio runs the gateway on
   their own infra (one binary, one config file). API keys are
   issued statically (YAML config) or via a small admin UI. Fits
   "one engineer + a handful of trusted collaborators."
3. **Gateway with OIDC / SSO.** Gateway delegates to Auth0 /
   Keycloak / GitHub / Google for identity; authorization
   (which sessions a user can access) is handled by the gateway's
   own ACL store. Fits "managed SaaS / enterprise." Same binary as
   (2) with an `oidc.issuer=…` config line.

### Roles per session

- **Owner** — full control, can invite / revoke.
- **Editor** — can `ControlSet`, `UpdateRegion`, all write commands.
- **Viewer** — read-only; `ControlSet` frames are rejected at the
  gateway with an error forwarded back to the client.

Role is resolved by the gateway at join time and stapled onto every
forwarded frame, so the DAW host can trust the origin tag without
rechecking per-frame.

## Configuration

Env var, CLI flag, and config file — in that order of precedence.

| Env var | CLI | Default |
|---|---|---|
| `FOYER_GATEWAY_URL` | `--gateway <url>` | (unset → LAN mode) |
| `FOYER_GATEWAY_TOKEN` | `--gateway-token <token>` | (unset) |
| `FOYER_GATEWAY_CONFIG` | `--gateway-config <path>` | `$XDG_CONFIG_HOME/foyer/gateway.toml` |

A sidecar with `FOYER_GATEWAY_URL` set connects upstream in addition
to its usual local WS listener. A client with it set connects to the
gateway *instead of* a local sidecar. Both modes coexist — you can
have an engineer on localhost plus remote collaborators through the
gateway simultaneously.

## Implementation plan

Split into four stages — each one shippable independently.

### Stage 1: local gateway, no auth (1 week)

- New crate `foyer-gateway` — axum server with WebSocket endpoints:
  - `POST /ws` for peers (both DAW hosts + clients use same endpoint;
    role determined by `AuthRequest.client_info.kind`).
  - `GET /health` for smoke checks.
- In-memory session registry (a `DashMap<SessionId, SessionEntry>`).
- No auth — every peer gets a default identity. Good enough for LAN
  demos and integration tests.
- Transparent forwarding of `Envelope<Event|Command>` frames in
  both directions.
- New `foyer-cli` command `foyer gateway --listen …` for local runs.

### Stage 2: API-key auth + persistence (1 week)

- API keys as static YAML (`$CONFIG/gateway.yaml`) plus a `/admin`
  REST endpoint behind a master key for issuing new ones.
- Persistent session registry backed by SQLite — survives gateway
  restart (sessions re-announce from the DAW hosts anyway; DB holds
  roles / ACLs).
- ACL model: `{ user, session, role }` rows.
- Rate-limiting on `AuthRequest` and `ControlSet` (token bucket, per
  user).

### Stage 3: OIDC + managed instance polish (1-2 weeks)

- Integrate with `openidconnect` crate. Delegate identity to any
  standards-compliant IDP.
- Admin UI for session / user / role management. Single-page app
  served from the gateway itself (same Lit + Tailwind stack as
  Foyer proper).
- TLS termination handled externally (nginx / Caddy); gateway
  doesn't ship its own TLS for Stage 3.

### Stage 4: WebRTC signaling (1 week, depends on M6)

- When the gateway supports forwarded `AudioEgressStart`, translate
  that into a WebRTC offer/answer signaling exchange between DAW
  host and client.
- Gateway is only a **signaling server**; actual audio flows
  peer-to-peer through STUN (or TURN on the gateway itself for
  fallback).

## Out of scope (for now)

- **P2P WebSocket between clients without the gateway.** Not worth the
  complexity when the gateway is already a hub.
- **Multiple gateways in a mesh.** One gateway per deployment. If
  someone needs geographic redundancy, they run two gateways and
  configure their DAW hosts to connect to both.
- **Encrypted-at-rest session data.** The gateway never sees session
  contents other than forwarded foyer frames; all persistent data
  lives on the DAW host.
- **Billing / quotas.** Managed instance concern; not a protocol
  concern.

## Open questions

1. **Token bootstrapping for the DAW host.** A new studio installs
   Foyer — how do they get their first host token? Options: (a)
   admin UI on the gateway; (b) `foyer gateway enroll` CLI on the
   gateway that prints a one-shot token; (c) email/out-of-band. We'll
   likely do (a) or (b).
2. **Audio bandwidth policy.** A gateway hosting 10 sessions × 5
   clients × 2 ch * 48 kHz * 32-bit = ~8 MB/s outbound per session.
   Do we cap at N concurrent audio streams per gateway? Offer
   tiered quality (Opus 128 / 256 / raw)? TODO.
3. **Disconnect + resume.** If a DAW host's gateway connection
   drops mid-session, clients see `SessionLeft`. Do we hold their
   state and auto-rejoin on reconnect? Timeout? 30s feels right;
   revisit.
4. **Cross-session commands.** Not for v1. Multi-session UI
   (switching between sessions) is in TODO.md and doesn't need the
   gateway.

## Why now

We can ship the local-LAN flow we have today and stop there — the
product works. The gateway unlocks the actual *collaboration* pitch
in [PLAN.md](PLAN.md) M6 (collaborative mixing, remote tracking,
A&R sessions with artists not in the room). Building it now while
the wire protocol is still malleable avoids protocol retrofits
later. Building it as an **optional** layer preserves the "works
offline, works on LAN, works on internet" triad that justifies
non-SaaS pricing if we ever get there.
