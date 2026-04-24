# Foyer Studio — security and threat model

Foyer is designed to be shared: one click opens a Cloudflare tunnel
and a couple more generate invite URLs for collaborators anywhere
in the world. That convenience has to come with a clear picture of
what the boundary actually protects.

This doc is the short version for operators and auditors; the full
rationale behind individual decisions lives in
[DECISIONS.md](DECISIONS.md) entries 35–38.

## Who the owner is

The process running `foyer serve` on the host is the owner. It
binds the HTTP/WebSocket port, holds the filesystem access, and
owns the IPC socket to the shim. The browser tab that opened it
from `127.0.0.1:3838` (or the desktop wrapper) is the owner's
session and always has full access.

Everyone else is a guest that reached the server via one of:
- The local network (owner typed an IP into another device)
- A Cloudflare tunnel the owner explicitly opened
- An ngrok tunnel (scaffolded, not audited)

## Roles

Defined in
[`crates/foyer-schema/src/tunnel.rs`](../crates/foyer-schema/src/tunnel.rs):

| Role                | What they can do                                              |
|---------------------|---------------------------------------------------------------|
| `Viewer`            | Read-only. Watch meters, hear audio, see the timeline.        |
| `Performer`         | Viewer + capture live audio/MIDI into a dedicated ingress channel. |
| `SessionController` | Transport, channel gain, mute/solo, capture. **No** track/plugin/region edits, no session save/open. |
| `Admin`             | Everything the owner can do, including minting new invites.   |

The exact per-command allowlist is `TunnelRole::allows_command(...)`
in the same file. That function is called server-side on every
inbound WS command; the frontend calls an identical client copy
only to grey out UI controls. Never trust the client.

## Invite tokens

- Minted by an owner or Admin via the UI or `foyer` CLI.
- Bound to a role, a session identifier, and (optionally) a TTL.
- Single-use by default: first successful WebSocket handshake
  consumes the token. A guest that reloads the page uses a short
  cookie the server set during handshake, not the original token.
- Stored server-side; the invite URL carries only an opaque id.
  Revocation is "delete the row" — immediate, no crypto ceremony.
- Token leakage (e.g. URL pasted in the wrong chat) can be handled
  by revoking before first use; after first use, kick the session.

## Threat model

**In scope:**
- Attackers on the public internet reaching a tunneled instance.
- A guest with a legitimate token trying to do more than their
  role allows.
- A guest replaying a consumed token.
- A compromised browser (malicious extension) trying to bypass
  role gates via direct WS traffic.

**Out of scope (explicit):**
- Attackers with shell access to the host running `foyer serve`.
  They own the process; RBAC is not a sandbox against them.
- Compromise of the Cloudflare tunnel control plane.
- DAW-internal security (Ardour session files, plugin loading).
  The shim statically trusts Ardour; users import `.ardour` files
  at their own risk.
- Cryptographic binding of the invite URL to a specific recipient.
  Whoever loads the URL first gets the role. Use a secure channel
  to send it.

## Network surface

When tunneling is off, the sidecar binds `127.0.0.1:3838` only.
Nothing is reachable from outside the host.

When tunneling is on:
- The Cloudflare tunnel terminates TLS at Cloudflare's edge and
  forwards plaintext inside the tunnel's encrypted backhaul to
  the local sidecar. The sidecar sees `127.0.0.1` traffic either
  way.
- The invite URL points at the Cloudflare hostname, not the
  owner's IP.
- Audio is sent as Opus by default; an opt-in uncompressed
  f32 path exists for fidelity-critical sessions. Both rides the
  same tunnel.

For LAN access without a tunnel, `just run-tls` is required
(browsers gate `AudioWorklet` and `getUserMedia` on secure
contexts). The self-signed cert only covers the HTTPS handshake;
authentication is still the invite-token model above.

## Audit checklist for a new deployment

- [ ] `foyer serve` runs as an unprivileged user, not root.
- [ ] `config.yaml` is `0600`, not world-readable (contains the
      Cloudflare API token if auto-provisioning).
- [ ] Tunnel is only opened when actively sharing; closed when the
      session ends.
- [ ] Invite URLs are sent over a secure channel (Signal, PGP,
      1Password share) — not pasted in public chat.
- [ ] TTLs are set for Viewer/Performer invites used by one-time
      collaborators.
- [ ] Session recordings are stored on encrypted media if they
      may contain sensitive material.

## Reporting vulnerabilities

GitHub security advisory:
https://github.com/hotspoons/foyer-studio/security/advisories/new

Or email the maintainer directly (see `Cargo.toml`). Please do not
open a public issue for security reports.
