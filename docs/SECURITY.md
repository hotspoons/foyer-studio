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

The role table is **policy, not code.** Seeded defaults live in
[`crates/foyer-config/defaults/roles.yaml`](../crates/foyer-config/defaults/roles.yaml)
and are baked into the binary; on first run they're copied to
`$XDG_DATA_HOME/foyer/roles.yaml` for editing. Delete that file to
regenerate from the bundled default.

Each role is a `{ allow, deny }` pair of command-tag patterns
(`"*"`, `"foo_*"`, or literal `"foo_bar"`); `deny` wins over `allow`.
Command tags are the snake_case wire names defined by `Command` in
[`crates/foyer-schema/src/message.rs`](../crates/foyer-schema/src/message.rs).
The four shipped roles:

| Role id              | What they can do (default)                                      |
|----------------------|-----------------------------------------------------------------|
| `viewer`             | Read-only. Subscribe, watch meters, hear audio, see the timeline. Text chat only — no push-to-talk. |
| `performer`          | Viewer + send live audio/MIDI ingress, push-to-talk, list track browser-source assignments. No transport/mix control. |
| `session_controller` | Wildcard allow minus structural edits — transport, mix, mute/solo, capture. **No** add/remove track/plugin/group, session save/open, undo/redo, tunnel-token management. |
| `admin`              | Wildcard `"*"`. Everything the LAN owner can do, including minting and revoking invites. |

The server gate is `state.roles_policy.allows(role_id, tag)` in
[`crates/foyer-server/src/ws.rs`](../crates/foyer-server/src/ws.rs)
— called on every inbound WS command from a tunnel guest. LAN/loopback
connections skip the RBAC check entirely (see the comment at the top
of `roles.yaml`); the LAN is the studio-network trust zone. The
frontend's `web/core/rbac.js` mirror is UI sugar only — never trust
the client.

Edits to `~/.local/share/foyer/roles.yaml` take effect on next
`foyer serve` start. There's no live reload yet; restart the sidecar
after a policy change.

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

## Project upload — defense in depth

Foyer accepts user-uploaded Ardour project archives over HTTP
(`POST /sessions/upload`). Ardour's session loader is **not** safe to
point at untrusted bytes — it auto-executes embedded Lua, follows
unsanitized paths during file lookup, and uses libxml2 with the
`XML_PARSE_HUGE` flag (no entity-expansion cap). Foyer treats every
upload as hostile and runs four layers of defense before the project
ever lands in the jail.

**1. Magic-byte format gate** — only `zip`, `tar.gz`, and `tar.zst`
are accepted, identified by the leading bytes of the body. Anything
else returns 400 before a decompressor opens. Body capped at
1 GiB on the wire.

**2. Hardened extractor** ([`crates/foyer-server/src/archive.rs`](../crates/foyer-server/src/archive.rs)).
The Rust extractor refuses:

- Symlinks and hardlinks (classic write-redirection vector)
- Char/block/fifo entries (device nodes)
- Path components rooted at `/`, containing `..`, or carrying a
  Windows drive letter
- Archives with > 50 000 entries
- Cumulative uncompressed payload > 4 GiB (zip-bomb cap)

We never call Ardour's own `file_archive.cc` — that codepath uses
libarchive without `ARCHIVE_EXTRACT_SECURE_*` flags, so symlinks and
absolute paths flow straight through.

**3. Session XML scrubber** ([`crates/foyer-server/src/session_scrub.rs`](../crates/foyer-server/src/session_scrub.rs)).
Every `*.ardour` and `*.ardour.bak` file in the extracted tree is
parsed by `quick-xml` (no entity expansion, eliminating the
billion-laughs DoS surface) and rewritten:

- `<Script>`, `<LuaScripts>`, `<Videotimeline>`, `<Videomonitor>`,
  `<XJSettings>` subtrees are **quarantined** — captured verbatim,
  base64-encoded, and emitted as inert XML comments with a
  `foyer:scrubbed:<TagName>:<base64>` prefix. Ardour ignores
  comments, so the auto-execute paths and the
  xjadeo-stdin-injection path go cold.

  *Quarantine, not delete*: an operator can restore the original on
  a trusted desktop with `foyer scrub-restore <session.ardour>`,
  which decodes the comments back into live elements. The HTTP
  upload path never restores — re-introducing scripts from
  untrusted input would defeat the scrubber.

- Path-bearing attributes are validated. Reject the upload outright
  if any of these contain `..`, are absolute, carry a Windows drive
  letter, or contain NUL/newline:
  - `<Source>` family elements (`Source`, `AudioSource`,
    `MidiSource`, `FileSource`, `AudioFileSource`,
    `SilentFileSource`, `SMFSource`): `name`, `file`, `path`,
    `origin`, `location`. The `name=` check is critical — Ardour's
    `FileSource::FileSource` seeds `_path = _name` so a malicious
    `name="../../../etc/passwd"` is the same arbitrary-write vector
    as a malicious `origin=`.
  - `<Region>` family: same path attrs (but **not** `name`, which is
    a display label).
  - `<Option name=audio-search-path|midi-search-path|raid-path|video-server-url|video-server-docroot>`:
    the `value=` attribute.

**4. Risk-prone state files are deleted, not scrubbed**:

- `*.history`, `*.history.bak` — the undo stack, parsed with
  `XML_PARSE_HUGE`. Useless in a fresh upload from another machine.
- `instant.xml`, `instant.xml.bak` — UI layout state, same parser
  and same uselessness.

Ardour regenerates both on next save. Deleting them removes a free
DoS surface.

### What we don't defend against

- **Locally installed plugins.** LV2/VST3 plugins discovered through
  `LV2_PATH` / `VST3_PATH` are trusted — the operator put them
  there, and they can run arbitrary code as the Ardour user. Foyer
  doesn't try to gate plugin loading because doing so would prevent
  the DAW from doing its job. **Implication:** don't enable plugin
  paths that pull from a writable, world-shared location like
  `/tmp/lv2`.

- **Audio/MIDI file format parsers.** Ardour will hand the files an
  archive references to libsndfile (audio) and evoral/libsmf (MIDI).
  These are mature parsers with no recent CVEs but parse
  attacker-controlled bytes. Run Ardour as an unprivileged user;
  on a Cloud Run/container deploy, a process-level sandbox
  (seccomp/AppArmor) is reasonable defense-in-depth.

- **Ardour bugs we haven't found.** The audit covered the high-
  signal paths (`session_state.cc`, the Lua bindings, `SystemExec`
  callers, plugin scan). It is not exhaustive. If you find a new
  vector, see "Reporting vulnerabilities" below.

### Plugin allowlist — deferred

The original threat model called for whitelisting plugin unique-IDs
referenced in session XML to prevent an attacker from referencing a
plugin the operator hasn't pre-approved. We've **deferred** this:
session XML references plugins by unique-ID and Ardour resolves
them through its pre-scanned `PluginManager` list, so a session
can't smuggle a `.lv2` bundle in via the archive — `LV2_PATH` is
not mutated by session content. We'd need to add the allowlist if
we ever support packaging a plugin alongside a session, but that's
not a planned feature.

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
