enabled: true

# Session lifecycle (open / save / browse)

The `session` tool is the user's project workspace. Most actions
operate on the CURRENTLY-LOADED session via the active backend.

## Survey

- `summary` — cheap counters (track count, plugin count, position,
  sample rate). Call this first.
- `full` — every track + plugin + region + automation. Heavy; only
  when you need the whole tree.

## Open / new / close

```json
{"subcommand": "backends"}
```
returns the configured backend ids (e.g. `["ardour", "stub"]`).
`backend_id: "auto"` resolves to the active one.

```json
{"subcommand": "new", "backend_id": "auto"}
{"subcommand": "open", "backend_id": "auto",
 "path": "projects/MyTune.ardour", "sample_rate": 48000}
{"subcommand": "close", "session_id": "sess.42"}
```

- `open` reuses the user's project picker pipeline — same RBAC,
  same launcher. Always relative to the filesystem jail.
- `new` is fast on stub backends; Ardour may require a `path` for
  a fresh project location.

## Save

```json
{"subcommand": "save"}                              // save in place
{"subcommand": "save_as", "path": "projects/v2.ardour"}
```
Acts on the current session. Returns when the backend finishes
writing. Don't call this every minute — the user has their own
save cadence.

## Browse + recents

```json
{"subcommand": "browse", "path": "projects", "show_hidden": false}
```
Lists directory entries inside the filesystem jail. Use this when
the user says "open the X session" and you need to find it.

```json
{"subcommand": "recents"}
{"subcommand": "forget_recent", "path": "projects/Abandoned.ardour"}
{"subcommand": "list_open"}
```

## Path discipline

EVERY path over the wire (path arguments, returned paths, error
messages) is RELATIVE TO THE FILESYSTEM JAIL. The user's host
filesystem layout (`/workspaces/foo`, `/projects/tenant`, …) is a
deployment detail the agent should not learn or echo. If the user
gives you an absolute path, gently rewrite it as relative before
passing through.

## Multi-session reality

The sidecar can hold multiple open sessions; `list_open` returns
each with its session_id and metadata. The agent normally operates
on the one bound to the current attach, but `close` accepts any
session_id you've discovered.
