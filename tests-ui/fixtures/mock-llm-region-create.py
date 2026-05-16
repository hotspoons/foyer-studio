#!/usr/bin/env python3
# OpenAI-compatible SSE mock that emits a tool_call to
# `regions.create` (audio, on the first track in the snapshot it
# discovers via a prior `session.full` call), then on the follow-up
# request that contains tool results, emits a short "done" reply.

import http.server
import json
import sys


def sse(chunk):
    return f"data: {json.dumps(chunk)}\n\n".encode()


def is_followup(messages):
    return bool(messages) and messages[-1].get("role") == "tool"


def last_tool_content(messages):
    for m in reversed(messages):
        if m.get("role") == "tool":
            return m.get("content") or ""
    return ""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        sys.stderr.write("[mock-llm-region-create] " + (a[0] % a[1:]) + "\n")

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
        # Round 1: no tool reply yet → call regions.create on stub's
        # first audio track. The stub fixture always seeds a few
        # `track.<n>` ids; we hard-code `track.1` here, which the
        # stub backend recognizes (it auto-creates the track if
        # missing). The result is captured and re-emitted as our
        # final assistant text so the test can assert the call
        # actually round-tripped.
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
                        "function": {"name": "regions",
                            "arguments": json.dumps({
                                "subcommand": "create",
                                "track_id": "track.1",
                                "at_samples": 0,
                                "length_samples": 48000,
                                "kind": "midi",
                                "name": "agent-test"
                            })}}]},
                    "finish_reason": None}]},
                {"id": "x", "choices": [{"index": 0,
                    "delta": {}, "finish_reason": "tool_calls"}]},
            ):
                self.wfile.write(sse(chunk))
        else:
            tag = "CREATED:OK" if "created" in last_tool_content(messages).lower() else "CREATED:UNEXPECTED"
            for chunk in (
                {"id": "x", "choices": [{"index": 0,
                    "delta": {"role": "assistant", "content": tag},
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9912
    srv = ThreadedServer(("127.0.0.1", port), Handler)
    sys.stdout.write(f"mock-llm-region-create ready on 127.0.0.1:{port}\n")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
