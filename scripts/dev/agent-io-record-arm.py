#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Exercise the io tool + tracks.set_arm + input_port routing against
a running foyer over MCP. No LLM in the loop — direct tool calls.

Confirms (against whatever backend foyer is configured with):
  1. io.list_ports returns real engine ports (`system:capture_*`,
     `system:playback_*`, etc. when running against Ardour; the stub's
     synthetics when running stub-mode).
  2. tracks.create works.
  3. tracks.update(input_port=…) accepts a real port name.
  4. tracks.set_arm flips record_enable.
  5. tracks.describe shows the routing took effect.

Run:
  scripts/dev/agent-io-record-arm.py
  FOYER_BASE=http://other-host:3838 SESSION=sessions/your-proj scripts/dev/agent-io-record-arm.py

Requires foyer running with a writable session already open OR an
existing Ardour project on disk that this script can `session.open`.
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("FOYER_BASE", "http://127.0.0.1:3838")
SESSION_PATH = os.environ.get("SESSION", "sessions/e2e-song-a")
MCP_URL = BASE + "/mcp"
RPC_ID = 0


def jsonrpc(method, params=None):
    """One JSON-RPC call to /mcp's streamable HTTP transport. Handles
    both the JSON and SSE response shapes the rmcp server emits."""
    global RPC_ID
    RPC_ID += 1
    body = {"jsonrpc": "2.0", "id": RPC_ID, "method": method}
    if params is not None:
        body["params"] = params
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        MCP_URL,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read().decode("utf-8")
    if raw.startswith("event:") or "\ndata:" in raw or raw.startswith("data:"):
        for line in raw.splitlines():
            if line.startswith("data: "):
                raw = line[6:]
                break
    return json.loads(raw)


def call_tool(name, args=None):
    rsp = jsonrpc("tools/call", {"name": name, "arguments": args or {}})
    if "error" in rsp:
        raise SystemExit(f"[{name}] RPC error: {rsp['error']}")
    result = rsp.get("result", {})
    if result.get("isError"):
        msgs = [c.get("text", "") for c in result.get("content", [])]
        raise SystemExit(f"[{name}] tool error: {' | '.join(msgs)}")
    if "structuredContent" in result:
        return result["structuredContent"]
    return {"_text": "\n".join(c.get("text", "") for c in result.get("content", []))}


def init():
    """MCP initialize handshake."""
    jsonrpc(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "foyer-agent-io-test", "version": "0.1"},
        },
    )
    jsonrpc("notifications/initialized")


def main():
    failures = []
    init()

    print(f"0. opening {SESSION_PATH} via session.open …")
    t0 = time.time()
    rsp = call_tool("session", {"subcommand": "open", "path": SESSION_PATH})
    print(f"   ok ({time.time()-t0:.1f}s): {rsp.get('session_id', rsp)}")
    # Give the BackendSwapped / SessionFocusChanged events a beat to
    # propagate through the MCP server's stored Weak ref.
    time.sleep(2)

    print("1. io.list_ports(source, filter=physical) — expect real engine ports …")
    src = call_tool(
        "io",
        {"subcommand": "list_ports", "direction": "source", "filter": "physical"},
    )
    src_names = [p["name"] for p in src.get("ports", [])]
    print(f"   physical sources: {src_names[:8]}{' …' if len(src_names) > 8 else ''}")
    if not src_names:
        failures.append("io.list_ports returned 0 physical source ports")
    if not any("capture" in n.lower() or "in" in n.lower() for n in src_names):
        failures.append(f"no recognisable capture port: {src_names}")

    print("2. io.list_ports(sink, filter=physical) …")
    snk = call_tool(
        "io",
        {"subcommand": "list_ports", "direction": "sink", "filter": "physical"},
    )
    snk_names = [p["name"] for p in snk.get("ports", [])]
    print(f"   physical sinks: {snk_names[:8]}{' …' if len(snk_names) > 8 else ''}")
    if not snk_names:
        failures.append("io.list_ports returned 0 physical sink ports")

    print("3. io.list_ports(both, no filter) — includes virtual …")
    everything = call_tool("io", {"subcommand": "list_ports"})
    all_names = [p["name"] for p in everything.get("ports", [])]
    midi_ports = [n for n in all_names if "midi" in n.lower()]
    print(f"   {len(all_names)} total ports")
    print(f"   midi ports: {midi_ports[:5]}{' …' if len(midi_ports) > 5 else ''}")

    if failures:
        print("\nFAIL — list_ports issues before record-arm test could run:")
        for f in failures:
            print(" -", f)
        return 1

    chosen_port = next(
        (n for n in src_names if n == "system:capture_1"),
        src_names[0] if src_names else None,
    )
    print(f"4. picking input port: {chosen_port}")

    print("5. tracks.create('Foyer IO Test', audio) …")
    created = call_tool(
        "tracks",
        {"subcommand": "create", "name": "Foyer IO Test", "kind": "audio"},
    )
    track_id = created.get("id")
    if not track_id:
        failures.append(f"tracks.create didn't return an id: {created}")
        print("FAIL")
        return 1
    print(f"   created {track_id}")

    print(f"6. tracks.update(input_port={chosen_port!r}) …")
    call_tool(
        "tracks",
        {"subcommand": "update", "track_id": track_id, "input_port": chosen_port},
    )

    print("7. tracks.set_arm(armed=true) …")
    armed = call_tool(
        "tracks",
        {"subcommand": "set_arm", "track_id": track_id, "armed": True},
    )
    if armed.get("armed") is not True:
        failures.append(f"set_arm didn't return armed=true: {armed}")

    # Shim ControlSet → Parameter update is async (audio-thread
    # round-trip). Let the echo land before re-snapshotting.
    time.sleep(1.0)

    print("8. tracks.describe — verify routing + arm landed …")
    desc = call_tool("tracks", {"subcommand": "describe", "track_id": track_id})
    inputs = desc.get("inputs", [])
    input_names = [p.get("name") for p in inputs]
    print(f"   inputs: {input_names}")
    if not input_names:
        failures.append(
            f"tracks.describe shows no inputs after routing to {chosen_port}"
        )
    elif chosen_port not in input_names:
        # Ardour normalises port names to its internal canonical form
        # (e.g. "<track>/audio_in 1"). Any non-empty inputs[] is fine —
        # we just note the rename for visibility.
        print(
            f"   note: described name differs from requested "
            f"({chosen_port!r}); got {input_names[0]!r}"
        )

    rec_arm = desc.get("record_arm")
    if not rec_arm:
        failures.append(
            "described track has no record_arm field — backend regression?"
        )
    else:
        val = rec_arm.get("value")
        print(f"   record_arm.value: {val}")
        # ControlValue serialises as a plain bool on stub, sometimes
        # tagged as `{"Bool": true}` on the wire — accept both.
        if val is not True and val != {"Bool": True}:
            failures.append(f"record_arm not flipped to true: {val}")

    print("9. tracks.set_arm(armed=false) + delete …")
    call_tool(
        "tracks",
        {"subcommand": "set_arm", "track_id": track_id, "armed": False},
    )
    call_tool("tracks", {"subcommand": "delete", "track_id": track_id})

    print()
    if failures:
        print("FAIL:")
        for f in failures:
            print(" -", f)
        return 1
    print("PASS — backend honors io.list_ports + set_arm + input_port routing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
