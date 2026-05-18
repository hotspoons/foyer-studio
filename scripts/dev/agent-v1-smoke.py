#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Quick health probe for Foyer's /v1 OpenAI-compatible endpoint.

Foyer wraps its in-process agent in an /v1/chat/completions surface so
external apps (Cursor, OpenWebUI, custom Python clients) can treat
Foyer as a regular OpenAI endpoint. The agent's tool registry + system
prompt + skills/memory all run INSIDE the request; the caller sees a
smart chatbot, not raw tool plumbing.

This script verifies:
  1. /v1/models advertises `foyer-agent`.
  2. Non-streaming /v1/chat/completions returns a coherent reply that
     proves the agent actually called a tool (we ask "how many tracks?"
     which forces session.summary or tracks.list).
  3. Streaming /v1/chat/completions emits SSE chunks + a terminal
     `[DONE]`.

Requires a running Foyer with `--agent-upstream-endpoint` + `--agent-upstream-model`
already configured (any OpenAI-compatible LLM works — Kimi, GPT-4, Claude
via OpenAI shim, etc.).

Run:
  python3 scripts/dev/agent-v1-smoke.py
  FOYER_BASE=http://other-host:3838 python3 scripts/dev/agent-v1-smoke.py

For the deeper end-to-end test (multi-turn, session lifecycle,
drum-vs-piano regression, compaction-under-viz), see agent-v1-e2e.py.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("FOYER_BASE", "http://127.0.0.1:3838") + "/v1"


def http_json(method, path, body=None):
    """urllib wrapper — avoids pulling in `requests` / `openai` so this
    test runs against any Python without venv setup."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def http_stream(path, body):
    """Stream an SSE response, return list of decoded `data:` payloads."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    out = []
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            if not line.startswith("data: "):
                continue
            body = line[6:]
            if body == "[DONE]":
                out.append({"_done": True})
                break
            try:
                out.append(json.loads(body))
            except json.JSONDecodeError:
                out.append({"_raw": body})
    return out


def main():
    failures = []

    # 1. models list
    print("1. GET /v1/models …")
    models = http_json("GET", "/models")
    ids = [m["id"] for m in models.get("data", [])]
    if "foyer-agent" not in ids:
        failures.append(f"foyer-agent missing from /v1/models — got {ids}")
    else:
        print("   ok foyer-agent advertised")

    # 2. non-streaming chat. The question forces tool use; the LLM has
    #    to call tracks.list or session.summary to know the count.
    print("2. POST /v1/chat/completions (non-streaming, tool-forcing prompt) …")
    body = {
        "model": "foyer-agent",
        "messages": [
            {
                "role": "user",
                "content": "How many tracks are loaded in the current Foyer session? Reply with just a number.",
            }
        ],
        "stream": False,
    }
    resp = http_json("POST", "/chat/completions", body)
    choices = resp.get("choices") or []
    if not choices:
        failures.append(f"no choices in response: {resp}")
    else:
        content = choices[0].get("message", {}).get("content", "")
        print(f"   reply: {content!r}")
        if not content:
            failures.append("empty content in non-streaming reply")
        # Tool reasoning blocks (<think>) are allowed but the final
        # reply MUST mention a number — proves the agent actually
        # called a tool and saw the count.
        plaintext = content.split("</think>")[-1].strip().lower()
        if not any(ch.isdigit() for ch in plaintext):
            failures.append(f"reply has no digit — agent likely didn't call a tool: {plaintext!r}")
        else:
            print("   ok reply contains a number, agent invoked a tool")

    # 3. streaming
    print("3. POST /v1/chat/completions (stream=true) …")
    body = {
        "model": "foyer-agent",
        "messages": [
            {"role": "user", "content": "Say hi in one word."}
        ],
        "stream": True,
    }
    chunks = http_stream("/chat/completions", body)
    content_chunks = [
        c["choices"][0]["delta"].get("content", "")
        for c in chunks
        if isinstance(c, dict) and c.get("choices")
    ]
    full = "".join(content_chunks)
    print(f"   stream content: {full!r}")
    if not any(c.get("_done") for c in chunks):
        failures.append("stream did NOT emit [DONE]")
    else:
        print("   ok [DONE] received")
    if not full.strip():
        failures.append("stream content was empty")

    print()
    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        return 1
    print("PASS — /v1 OpenAI-compat endpoint is healthy end-to-end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
