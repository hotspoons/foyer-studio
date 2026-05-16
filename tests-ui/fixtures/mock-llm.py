#!/usr/bin/env python3
# Tiny OpenAI-compatible /v1/chat/completions SSE mock. Used by the
# agent-backend-swap spec to drive the agent harness deterministically
# without any external LLM. First request → emits a tool_call for
# session(subcommand="summary"); a request whose last message is a
# `tool` reply → emits a short "ok" wrap-up. No deps.

import http.server
import json
import sys


def sse(chunk):
    return f"data: {json.dumps(chunk)}\n\n".encode()


def is_followup(messages):
    # Only treat as followup when the LAST message is a tool result —
    # the engine has just fed us a tool output and expects a wrap-up.
    return bool(messages) and messages[-1].get("role") == "tool"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        sys.stderr.write("[mock-llm] " + (a[0] % a[1:]) + "\n")

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        try:
            req = json.loads(body)
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        messages = req.get("messages", [])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not is_followup(messages):
            for chunk in (
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"role": "assistant"}, "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"tool_calls": [{"index": 0, "id": "call_1",
                        "type": "function",
                        "function": {"name": "session", "arguments": ""}}]},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"tool_calls": [{"index": 0,
                        "function": {"arguments": '{"subcommand":"summary"}'}}]},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {}, "finish_reason": "tool_calls"}]},
            ):
                self.wfile.write(sse(chunk))
        else:
            # Wrap-up turn: emit a <think> block followed by a short
            # reply. Exercises the FE's parseThinking() — the test
            # spec asserts the thinking text never leaks into the
            # visible content and the "Thinking" details block lands
            # in the DOM.
            for chunk in (
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"role": "assistant", "content": "<think>"},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"content": "internal reasoning that should NOT appear in the final reply"},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"content": "</think>"},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"content": "ok"},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {}, "finish_reason": "stop"}]},
            ):
                self.wfile.write(sse(chunk))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class ThreadedServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
    srv = ThreadedServer(("127.0.0.1", port), Handler)
    sys.stdout.write(f"mock-llm ready on 127.0.0.1:{port}\n")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
