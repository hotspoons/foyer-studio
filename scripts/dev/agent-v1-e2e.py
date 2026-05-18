#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Drive Foyer's /v1 OpenAI-compat endpoint through a full music-making
workflow — the deep e2e companion to `agent-v1-smoke.py`.

Goal: confirm a non-Claude LLM (Kimi K2.6, GPT-4o, Llama 3.1, etc.) can
infer Foyer's full tool surface through the OpenAI surface alone, with
no MCP-specific decorations on the tools. The agent's in-process tool
registry + system prompt + skills all run inside the request; the
upstream LLM only ever sees an OpenAI-style chat completion.

Stresses, in order across 8 turns:

  * T1 — orient: session.summary / tracks.list (proves tool use at all)
  * T2 — save / list / new session: session.save + session.list + session.new
  * T3 — drum track with GM drum MIDI (kick=36, snare=38, hat=42)
         — the regression test for "drums got written as piano notes"
  * T4 — bass track
  * T5 — melody track
  * T6 — heavy visualize burst (mixer, timeline, spectrum, region zooms)
         — stresses the agent's in-request context compaction; each
         visualize.* tool result is a base64 PNG that bloats fast
  * T7 — save + dump every region's MIDI pitches to verify nothing
         drifted to piano range
  * T8 — close + reopen session, confirm tracks survived persistence

Final verification asserts:
  - The drum-region pitch dump in T7 contains 36/38/42 and NOT
    piano-range pitches (60/62/64/65/67/69/71/72).
  - T6 acknowledged producing visualizations (proxy for compaction
    not having frozen the agent).
  - Session 'Kimi E2E' was created (T2) and survived close/reopen (T8).

Environment:
  FOYER_BASE     base URL (default http://127.0.0.1:3838)
  FOYER_SESSION  session name to create/reuse (default 'Kimi E2E')

Requires Foyer running with --agent-upstream-endpoint already configured.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request

BASE = os.environ.get("FOYER_BASE", "http://127.0.0.1:3838") + "/v1"
SESSION_NAME = os.environ.get("FOYER_SESSION", "Kimi E2E")
TIMEOUT_S = 900  # heavy viz / multi-track turns can dispatch dozens of
                 # tool calls; ten minutes per turn keeps headroom.

SYSTEM = (
    "You are operating Foyer Studio, a digital audio workstation. "
    "Use the Foyer tools to make music. CRITICAL: when working with "
    "drum tracks, always use a beat-sequencer region OR write MIDI on "
    "the standard General MIDI drum pitches "
    "(kick=C1=note 36, snare=D1=note 38, closed hat=F#1=note 42, "
    "open hat=A#1=note 46). NEVER write drum patterns on melodic "
    "pitches like C4 (60) — that produces piano notes instead of drum "
    "hits. If the beat sequencer tool is available, prefer it for "
    "drum tracks. When you make changes, briefly confirm what you did."
)


def chat(messages: list[dict], label: str) -> tuple[str, str]:
    """One /v1/chat/completions turn. Returns (raw_content, plaintext).

    Plaintext strips any <think>...</think> reasoning block models emit."""
    body = {
        "model": "foyer-agent",
        "messages": messages,
        "stream": False,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"[{label}] HTTP {e.code}: {body[:600]}")
    dt = time.time() - t0

    raw = resp["choices"][0]["message"]["content"] or ""
    plain = raw.split("</think>")[-1].strip()

    print(f"\n=== [{label}] {dt:.1f}s, {len(raw)} chars raw, "
          f"{len(plain)} chars plain ===")
    print(plain[:1800] + (
        f"\n... [truncated, {len(plain) - 1800} more chars]"
        if len(plain) > 1800 else ""
    ))

    messages.append({"role": "assistant", "content": raw})
    return raw, plain


def find_midi_pitches(text: str) -> set[str]:
    """Yank standalone 0–127 integers from a text window — used to scan
    near 'drum' / region-dump lines for what pitches the agent reported."""
    hits = set()
    for m in re.finditer(r"\b(\d{1,3})\b", text):
        n = int(m.group(1))
        if 0 <= n <= 127:
            hits.add(str(n))
    return hits


def main() -> int:
    failures: list[str] = []
    msgs: list[dict] = [{"role": "system", "content": SYSTEM}]

    msgs.append({"role": "user", "content":
        "What's the current Foyer session? Tell me: project name, BPM, "
        "track count, transport state. Use the appropriate tools — don't "
        "guess."})
    _, t1 = chat(msgs, "T1 orient")

    msgs.append({"role": "user", "content":
        "I want to start a clean test. First, SAVE the currently-active "
        "session (if any) so no work is lost. Then list every saved "
        f"session. Then create a brand-new session called '{SESSION_NAME}' "
        "and open it. Confirm it's the active session."})
    _, t2 = chat(msgs, "T2 new session")

    msgs.append({"role": "user", "content":
        "Create a MIDI track called 'Drums'. On that track, add a 4-bar "
        "MIDI region at bar 1 with a basic rock beat:\n"
        "  - Kick (MIDI note 36, C1) on beats 1 and 3 of every bar\n"
        "  - Snare (MIDI note 38, D1) on beats 2 and 4\n"
        "  - Closed hi-hat (MIDI note 42, F#1) on every 8th note\n"
        "Prefer the beat-sequencer tool if you have one — otherwise use "
        "the MIDI write tool but USE THE PITCH NUMBERS I GAVE YOU "
        "(36, 38, 42). Do NOT write the pattern on C4/D4/E4 — those are "
        "piano notes, not drum sounds. After writing, dump the actual "
        "pitches you wrote so I can verify."})
    _, t3 = chat(msgs, "T3 drums (GM-drum MIDI)")

    msgs.append({"role": "user", "content":
        "Add a MIDI track called 'Bass'. Add a 4-bar MIDI region with a "
        "I-V-vi-IV bass line in C major: one whole-note per bar, root "
        "notes only (C2 / G2 / A2 / F2 — MIDI 36, 43, 45, 41)."})
    _, t4 = chat(msgs, "T4 bass")

    msgs.append({"role": "user", "content":
        "Add a MIDI track called 'Melody'. Add a 4-bar MIDI region with "
        "a simple 8-note melody in C major in the C5–C6 range "
        "(MIDI 72–84). Make it sing over the I-V-vi-IV progression."})
    _, t5 = chat(msgs, "T5 melody")

    # T6 — heavy visualization burst. Each visualize.* tool emits a
    # base64-PNG payload that, before compaction, bloats the agent's
    # working context. If `redact_records_for_llm` / chunked compaction
    # are broken the agent will either error out or freeze here.
    msgs.append({"role": "user", "content":
        "Now render visualizations of what you've built. Use the visualize "
        "tools to produce, IN ORDER:\n"
        "  1. The mixer\n"
        "  2. The timeline view of the whole song\n"
        "  3. A spectrogram snapshot of the master bus\n"
        "  4. A close-up of the Drums region\n"
        "  5. A close-up of the Bass region\n"
        "  6. A close-up of the Melody region\n"
        "  7. The mixer again — confirm the meters are showing levels\n"
        "Describe what's visible in each image as you produce it."})
    _, t6 = chat(msgs, "T6 viz burst x7 (compaction stress)")

    msgs.append({"role": "user", "content":
        "Save the session. Then list every track you've created and every "
        "MIDI region on each track. For each region, print the actual "
        "MIDI note pitches (as integers) in the order they play. I want "
        "to verify the drum region is on pitches 36/38/42, not 60/62/64."})
    _, t7 = chat(msgs, "T7 save + verify pitches")

    msgs.append({"role": "user", "content":
        f"Close the '{SESSION_NAME}' session. List every saved session "
        f"you can see. Then re-open '{SESSION_NAME}'. Confirm the Drums / "
        "Bass / Melody tracks survived."})
    _, t8 = chat(msgs, "T8 close + reopen")

    print("\n\n========= VERIFICATION =========")

    # 1. Drum pitches. Scan text near 'drum' mentions in T7 for the
    #    pitches the agent reported. 36/38/42 = good (GM drum). 60+ in a
    #    drum context = regression to piano notes.
    t7_lower = t7.lower()
    drum_window = ""
    for m in re.finditer(r"drum", t7_lower):
        drum_window += t7_lower[max(0, m.start()-200):m.end()+400] + "\n---\n"
    drum_pitches = find_midi_pitches(drum_window)
    print(f"Numeric tokens near 'drum' in T7: "
          f"{sorted(int(p) for p in drum_pitches if 0 <= int(p) <= 127)}")

    has_drum_pitches = bool({"36", "38", "42"} & drum_pitches)
    has_piano_pitches = bool(
        {"60", "62", "64", "65", "67", "69", "71", "72"} & drum_pitches
    )
    if not has_drum_pitches:
        failures.append(
            "T7: drum region report doesn't show pitches 36/38/42 — "
            "agent may have skipped them or used different pitches")
    if has_piano_pitches:
        failures.append(
            "T7: drum region report mentions piano-range pitches "
            "(60/62/64/65/67/69/71/72) — REGRESSION: drum sequence likely "
            "uses piano notes")

    # 2. Visualization survived (proxy for compaction not freezing).
    viz_evidence = any(
        kw in t6.lower() for kw in
        ["image", "render", "visualiz", "snapshot", "shown", "depicted", "see"]
    )
    if not viz_evidence:
        failures.append("T6: no visualization evidence in reply")

    # 3. Session lifecycle persistence.
    if SESSION_NAME.lower() not in t2.lower():
        failures.append(
            f"T2: session creation didn't reference '{SESSION_NAME}'")
    for name in ("drum", "bass", "melody"):
        if name not in t8.lower():
            failures.append(
                f"T8: track '{name}' missing after close/reopen")

    # 4. Crude liveness — every reply should be more than a one-liner.
    for label, reply in [
        ("T2", t2), ("T3", t3), ("T4", t4), ("T5", t5), ("T6", t6),
        ("T7", t7), ("T8", t8),
    ]:
        if len(reply) < 40:
            failures.append(
                f"{label}: suspiciously short reply ({len(reply)} chars)")

    print()
    if failures:
        print("FAIL — agent didn't drive the full surface cleanly:")
        for f in failures:
            print(" -", f)
        return 1
    print("PASS — agent drove /v1 end-to-end, compaction held, "
          "drums on GM drum pitches")
    return 0


if __name__ == "__main__":
    sys.exit(main())
