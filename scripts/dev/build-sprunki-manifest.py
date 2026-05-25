#!/usr/bin/env python3
"""
Rebuild web/ui-sprunki/sprunki-assets.json from the canonical
project.json shipped with the OG sprunki TurboWarp/Scratch package.

Why this exists
---------------
The original manifest in web/ui-sprunki/sprunki-assets.json was
hand-rolled and conflated normal-mode costumes with horror-mode
costumes. Concretely, the project labels the second resting-pose
costume `idle2`, but that frame is in fact the scary baseline:
Raddy's idle2 SVG is built almost entirely from #1a0c12 / #4d2637
over a #660000→#000 gradient, and Oren's idle2 uses #331600
gradients. Cycling through it during default-mode play made
horror sprunkis flash in over the cheerful ones (the bug Rich
flagged on 2026-05-25).

True costume naming in project.json
-----------------------------------
The canonical Scratch project uses three discriminating prefixes:

  idle      — the safe resting pose (one frame per character)
  idle2     — the *scary*-mode resting pose
  anim[N]   — primary play/dance frames (sync'd to the safe sound)
  anim???[N] — scary-mode play/dance frames

This rebuild buckets them into:

  costumes.idle           : [{name:"idle", file:...}]
  costumes.idle_alternate : [{name:"idle2", file:...}]   (scary)
  costumes.play           : anim*       (safe play loop)
  costumes.alternate      : anim???*    (scary play loop)
  costumes.other          : anything that doesn't match (overlays)

Character metadata (id, roleId, roleLabel, category) is carried
over from the existing manifest so downstream code keeps working
without changes. Sounds are flattened into primary=first-sound +
alternate=remaining-sounds, mirroring the old manifest's split
heuristic (the runtime currently doesn't read this section).

Usage
-----
  python3 scripts/dev/build-sprunki-manifest.py

Re-run this whenever ext/sprunki-website/assets/project.json is
refreshed (e.g. after a new OG release).
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECT_JSON = REPO / "ext/sprunki-website/assets/project.json"
EXISTING_MANIFEST = REPO / "web/ui-sprunki/sprunki-assets.json"
OUT = EXISTING_MANIFEST  # in-place

ANIM_SAFE = re.compile(r"^anim(\d+)?$")
ANIM_ALT = re.compile(r"^anim\?\?\?(\d+)?$")


def bucket_costumes(costumes):
    """Split a Scratch target's costume array into the manifest buckets."""
    idle, idle_alt, play, alt, other = [], [], [], [], []
    for c in costumes:
        name = c["name"]
        entry = {"name": name, "file": c["md5ext"]}
        if name == "idle":
            idle.append(entry)
        elif name == "idle2":
            idle_alt.append(entry)
        elif ANIM_SAFE.match(name):
            play.append(entry)
        elif ANIM_ALT.match(name):
            alt.append(entry)
        else:
            other.append(entry)
    return idle, idle_alt, play, alt, other


def bucket_sounds(sounds):
    """Match the old manifest's primary/alternate split: first sound is
    primary, the rest go to alternate. The runtime currently ignores
    this section; we keep the shape stable so older code doesn't
    have to be touched."""
    primary, alternate = [], []
    for i, s in enumerate(sounds):
        entry = {
            "name": s["name"],
            "file": s["md5ext"],
            "rate": s.get("rate", 48000),
            "samples": s.get("sampleCount", 0),
        }
        (primary if i == 0 else alternate).append(entry)
    return primary, alternate


def find_target(targets, display_name):
    for t in targets:
        if t.get("name") == display_name:
            return t
    return None


def build_icon_map(targets):
    """OG palette uses an `Icons` sprite whose costumes are named
    `01-a`, `01-b`, `01-c`, … `20-a`, `20-b`, `20-c`. Suffixes:
      a = full-color normal tile
      b = pressed / shadowed
      c = grayscale / dimmed (e.g. "already on stage")

    Indices 01-20 align with the OG character order in
    project.json's targets list (verified by color spot-check:
    01-a is orange = Oren, 02-a is red = Raddy, 03-a is silver
    = Clukr, …). This returns a dict keyed by the 1-based index,
    each value carrying the three variant md5s.
    """
    icons = find_target(targets, "Icons")
    if not icons:
        return {}
    out = {}
    for c in icons["costumes"]:
        name = c["name"]
        m = re.match(r"^(\d+)-([abc])$", name)
        if not m:
            continue
        idx = int(m.group(1))
        variant = m.group(2)
        out.setdefault(idx, {})[variant] = c["md5ext"]
    return out


def main():
    project = json.loads(PROJECT_JSON.read_text())
    manifest = json.loads(EXISTING_MANIFEST.read_text())

    targets = project["targets"]
    icon_map = build_icon_map(targets)
    rebuilt = []
    for i, ch in enumerate(manifest["characters"], start=1):
        target = find_target(targets, ch["displayName"])
        if not target:
            print(f"[warn] no project.json target for {ch['displayName']!r}; preserving as-is")
            rebuilt.append(ch)
            continue
        idle, idle_alt, play, alt, other = bucket_costumes(target["costumes"])
        primary_snd, alt_snd = bucket_sounds(target.get("sounds", []))
        icons = icon_map.get(i, {})
        rebuilt_ch = {
            "id": ch["id"],
            "displayName": ch["displayName"],
            "category": ch["category"],
            "roleId": ch["roleId"],
            "roleLabel": ch["roleLabel"],
            "sounds": {"primary": primary_snd, "alternate": alt_snd},
            "costumes": {
                "idle": idle,
                "idle_alternate": idle_alt,
                "play": play,
                "alternate": alt,
            },
            "icon": {
                "normal":  icons.get("a"),
                "pressed": icons.get("b"),
                "dimmed":  icons.get("c"),
            },
        }
        if other:
            rebuilt_ch["costumes"]["other"] = other
        rebuilt.append(rebuilt_ch)

    manifest["characters"] = rebuilt
    manifest["version"] = 2
    manifest["source"] = (
        "ext/sprunki-website/assets/project.json (decompiled TurboWarp/Scratch project); "
        "rebuilt via scripts/dev/build-sprunki-manifest.py"
    )
    # Document the bucketing convention so future readers don't have
    # to grep the script to learn the rules.
    manifest["costumeBuckets"] = {
        "idle": "Safe resting frame (default mode). One entry per character.",
        "idle_alternate": "Horror-mode resting frame (project.json `idle2`). Only surfaced when scary mode is unlocked + enabled.",
        "play": "Safe play / dance cycle (project.json `anim`, `anim2`, ...).",
        "alternate": "Horror-mode play cycle (project.json `anim???`, `anim???2`, ...). Hidden unless scary mode is on.",
        "other": "Costumes that don't match the idle / anim / anim??? naming (overlays, UI fragments).",
    }

    OUT.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"[ok] wrote {OUT.relative_to(REPO)} — {len(rebuilt)} characters")


if __name__ == "__main__":
    main()
