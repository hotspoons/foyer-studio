# Ardour shim for Foyer

This directory is an **out-of-tree Ardour Control Surface** that speaks the
DAW-agnostic `foyer-ipc` protocol. It is our first host shim; see
`docs/PLAN.md` §5 (Host Adapter Contract) and §7 M3 for the full design.

## What it does

1. Registers with Ardour's `ControlProtocolManager` as a surface named
   `foyer_shim`.
2. Opens a Unix domain socket (default `/tmp/foyer.sock`) and accepts exactly one
   sidecar connection at a time.
3. Translates Ardour's session/controllable model into Foyer's neutral schema
   and emits `session.snapshot`, `session.patch`, `control.update`, and meter
   batches.
4. Applies incoming `control.set` commands by routing to the appropriate
   `AutomationControl`.
5. (M6a/M6b) taps a configurable bus for audio egress and provides a virtual
   JACK input for ingress.

The shim **does not** speak WebSocket. All browser-facing concerns live in the
Rust sidecar (`foyer-cli`), which connects to this shim via IPC.

## Build

Prereqs — system packages are all satisfied by the Foyer dev container. The only
remaining prereq is a **built Ardour tree** at `/workspaces/ardour`:

```bash
cd /workspaces/ardour
./waf configure --optimize --no-coreaudio
./waf
```

(First-time Ardour build takes ~30+ minutes; subsequent shim rebuilds are fast.)

Once Ardour is built, either:

```bash
# Option A — drop the shim into Ardour's libs/surfaces/ and rebuild there.
ln -s /workspaces/foyer-studio/shims/ardour /workspaces/ardour/libs/surfaces/foyer_shim
cd /workspaces/ardour && ./waf build

# Option B — build out-of-tree (equivalent waf run from shim dir).
cd /workspaces/foyer-studio/shims/ardour && waf configure build
```

The `wscript` pulls in Ardour's full sub-library header graph (`libardour`,
`libardour_cp`, `libpbd`, `libgtkmm2ext`) automatically via `obj.use`. Ardour
isn't required to iterate on `src/ipc.cc` or `src/interface.cc` alone — both of
those compile cleanly against the public headers Ardour ships out-of-the-box —
but the signal-bridge / schema-map / dispatcher / msgpack-out files need the
internal headers that `waf` wires up.

## Install for testing

```bash
# one-time: ensure Ardour sees our surface
cp foyer_shim.so $ARDOUR_BUILD/libs/surfaces/
# or set ARDOUR_SURFACES_PATH to include this directory
export ARDOUR_SURFACES_PATH=/workspaces/foyer-studio/shims/ardour/build:$ARDOUR_SURFACES_PATH
```

Launch Ardour, open Preferences → Control Surfaces, enable **Foyer Studio
Shim**. Then on the sidecar side:

```bash
cd /workspaces/foyer-studio
just run-stub              # ...or...
cargo run -p foyer-cli -- serve --backend=host --socket=/tmp/foyer.sock
```

## File layout

- `src/surface.{h,cc}` — `FoyerShim` class, extends `ControlProtocol + AbstractUI`
- `src/interface.cc` — exported `protocol_descriptor()` entry point
- `src/signal_bridge.{h,cc}` — subscribes to Ardour signals, emits events
- `src/ipc.{h,cc}` — UDS server + `foyer-ipc` framing (length-prefixed MsgPack)
- `src/dispatch.{h,cc}` — resolves Foyer IDs to `AutomationControl` and applies writes
- `src/schema_map.{h,cc}` — translates Ardour's `Stripable`/`Plugin`/`Parameter` into Foyer neutral types
- `src/audio_tap.cc` — (M6a) JACK port tap for egress
- `src/audio_sink.cc` — (M6b) virtual JACK input + latency compensation
- `wscript` — waf build recipe

## Upstream patches

If a change to Ardour itself turns out to be necessary, we stage it as a
standalone patch in `docs/ardour-patches/NNN-short-name.patch` and submit it
upstream as a narrow PR rather than carrying it in a fork. Keep the shim
out-of-tree; keep Ardour pristine.
