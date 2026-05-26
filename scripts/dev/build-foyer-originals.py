#!/usr/bin/env python3
"""Build the Foyer Originals built-in asset pack.

Sprunki visual recipe (matches OG aesthetic; not byte-for-byte):

  - Body is a tall solid silhouette: rounded dome on top, straight
    parallel sides going down, lower body hidden behind the grass
    clip. NO visible arms. NO visible feet. The whole character is
    one silhouette plus a crown.

  - Face: large droopy heavy-lidded eyes (chill expression), large
    pupils with a small highlight, tiny subtle smile mouth. No teeth
    grin, no blush cheeks. The face is uniform across the cast — the
    crown carries character identity, not the face.

  - Per-character CROWN: the recognizable silhouette identifier.
    Antennae, horns, cat ears, helmets, leafy bushes, monitor-head,
    flower-petal head — drawn growing out of the top of the head as
    part of the silhouette, not stuck on as separate props. This is
    what makes each character readable at a glance.

  - Play frames: clear at-a-glance pose changes, not micro-tweaks.
    idle  = rest neutral
    play1 = lean LEFT, head tilts left, slight bounce up
    play2 = BIG JUMP UP, body shifts up dramatically
    play3 = lean RIGHT, head tilts right, slight bounce up
    The stage advances one frame per audio transient on the slot's
    track, so the cast reads "left → up → right → rest" per beat.

  - Backdrop grass anchored at exactly 78% from the top of its SVG
    (matches sprunki-stage's 22% clip from the bottom). The
    character's lower body falls into the clip and looks rooted in
    the grass instead of floating above it. Document that constant
    in stage code if it ever drifts.

  - Empty Polo body color is a distinctly different value from any
    populated costume color (lead flagged the previous gray as
    indistinguishable from gray-bass — fixed to a near-white ash).

Same character ids as the OG manifest so the patch -> sprunki_id
mapping in patches.js works against either pack interchangeably.

Run:  python3 scripts/dev/build-foyer-originals.py
"""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "ui-sprunkadoo" / "builtin-assets"
CHAR_DIR = OUT / "characters"

# Canvas. 200×360 viewBox. The sprunki-stage clips the bottom 22%
# behind the grass, so the visible region is y=0..281; everything
# below that is hidden. All character art is composed against this
# constant.
VB_W, VB_H = 200, 360
GRASS_CLIP_PCT = 22                # documented in stage code
VISIBLE_H = int(VB_H * (100 - GRASS_CLIP_PCT) / 100)  # = 281

# OG-style anatomy: separate HEAD (oval/round) + NECK + BODY parts.
# The face fits inside the head; the neck is narrow; the body is
# wider than the neck. Heavy black outline throughout.
HEAD_CX = 100
HEAD_CY = 110
HEAD_RX = 78       # head half-width — slightly OVALIZED HORIZONTALLY,
HEAD_RY = 72       # ~8% wider than tall (78/72 ≈ 1.08, half as oval as before)

# Body = ONE trapezoid. The "neck" is just the narrow TOP of the
# trapezoid; the bottom flares out. No separate neck rectangle.
BODY_TOP_HALF = 24                   # half-width at the very top (neck)
BODY_BOT_HALF = 38                   # half-width at the bottom (clipped)
BODY_TOP_Y = HEAD_CY + HEAD_RY - 6   # body starts at the chin
BODY_BOT_Y = VB_H + 8                # extends past stage bottom

# Kept aliases — some legacy crown code still references BCX/DOME_TOP_Y.
BCX = HEAD_CX
DOME_TOP_Y = HEAD_CY - HEAD_RY       # top of the head
BW_HALF = HEAD_RX

# Face anchors inside the head.
EYE_Y = 110             # eye center y (slightly above head center)
EYE_DX = 33             # half-distance between eye centers — picked so
                        # the inner-edge gap stays ~8px even as the
                        # eyes change size (Rich confirmed the gap
                        # was spot-on at this absolute size)
EYE_RX = 29             # eyes round and ~3% smaller than the last pass
EYE_RY = 29
PUPIL_RX = 19           # pupil scales with eye
PUPIL_RY = 17           # pupil — overlaps the body-colored upper-half
                        # eyelid above the eyelid crease line so the
                        # two merge into the OG D-shape mass
PUPIL_DY = 2            # pupil center sits slightly below eye center;
                        # bottom edge ends well clear of the eye floor
                        # leaving a thick white crescent at the bottom
BROW_Y = 74             # eyebrow row sits a little above the eye top
MOUTH_Y = 158           # mouth — low on the head
OUTLINE = "#1a1a1a"     # universal black outline weight ~3px


# ── character roster ────────────────────────────────────────────────
#
# (id, displayName, category, roleLabel, bodyColor, crown_style,
#  optional face_style="default")
#
# face_style is one of:
#   "default"   — droopy chill eyes + tiny smile (the cast brand)
#   "disgusted" — side-eye + raised brow + zigzag mouth (flower only,
#                 per Rich's 8yo's request)
CHARACTERS = [
    ("oren",            "Foyer Oren",     "drums",   "Kick drum",     "#ff6f00", "antennae"),
    ("raddy",           "Foyer Raddy",    "drums",   "Snare drum",    "#b30000", "horns"),
    ("clukr",           "Foyer Clukr",    "drums",   "Hi-hat",        "#c5c8cb", "hiHatCymbal"),
    ("fun-bot",         "Foyer Bot",      "drums",   "Drum kit",      "#f7c548", "tvMonitor"),
    ("vineria",         "Foyer Vineria",  "drums",   "Shaker",        "#3acb52", "leafSpike"),
    ("gray",            "Foyer Gray",     "bass",    "Bass",          "#808080", "none", "default", "flat", "body"),
    ("brud",            "Foyer Brud",     "fx",      "Vox glitch",    "#7a4a1f", "glitchSparks"),
    ("garnold",         "Foyer Garnold",  "melody",  "Arpeggio",      "#ffd000", "pixelCrown"),
    ("owakcx",          "Foyer Owakcx",   "fx",      "Riser",         "#caff2a", "rocketTop"),
    ("sky",             "Foyer Sky",      "melody",  "Music box",     "#7ec8e3", "cloudPuff"),
    ("mr-sun",          "Foyer Sunny",    "melody",  "Piano",         "#ffd200", "sunRays"),
    ("durple",          "Foyer Durple",   "melody",  "Brass",         "#7d2dbd", "wizardHat"),
    ("mr-tree",         "Foyer Treebo",   "melody",  "Organ",         "#3a7a26", "treeCanopy"),
    ("simon",           "Foyer Simon",    "melody",  "Square wave",   "#ffe93a", "squareWave"),
    ("tunner",          "Foyer Tunner",   "fx",      "Whistle",       "#d8b27a", "fedora"),
    ("mr-fun-computer", "Foyer Comp",     "vocal",   "AI vocal",      "#272a32", "crtMonitor"),
    ("wenda",           "Foyer Wenda",    "vocal",   "Hey vocal",     "#f4f4f4", "megaphone"),
    ("pinki",           "Foyer Pinki",    "vocal",   "Female choir",  "#ff80c0", "bigBow"),
    ("jevin",           "Foyer Jevin",    "vocal",   "Male choir",    "#3548d6", "topHat"),
    ("black",           "Foyer Phantom",  "phantom", "Phantom",       "#181420", "wispySmoke"),
    # Rich's 8yo's design pick. Unique disgusted face + flower-petal
    # crown integrated with the head silhouette.
    ("flower",          "Foyer Flower",   "melody",  "Flower",        "#a85cd9", "petalHead", "disgusted"),
]


def char_face_style(char) -> str:
    return char[6] if len(char) > 6 else "default"


def char_mouth_style(char) -> str:
    """Optional 8th tuple element. `flat` = horizontal line (the OG
    cast brand). `curve` = gentle smile arc. Default is `flat` —
    matches the OG cast which uniformly has flat-line mouths."""
    return char[7] if len(char) > 7 else "flat"


# ── per-character animation profile ────────────────────────────────
#
# Each sprunki has its own subtle idle motion + on-hit reaction so
# the cast feels alive without flailing in unison. Drives the CSS
# variables consumed by [web/ui-sprunkadoo/components/sprunki-stage.js].
#
# kind:
#   "bob"  — vertical head bob (drums). Quick down-up on each audio hit.
#   "sway" — gentle horizontal head sway (bass / melody). Slow side-to-side
#            idle; small tilt on each hit.
#   "look" — head turn / look-around (vocal / fx). Slow rotate idle; tiny
#            yaw on each hit.
# amplitude is in CSS-pixels at default scale.
def animation_profile_for(category: str) -> dict:
    if category == "drums":
        return {"kind": "bob", "amplitude": 4}
    if category in ("bass", "melody"):
        return {"kind": "sway", "amplitude": 3}
    if category in ("vocal", "fx"):
        return {"kind": "look", "amplitude": 2}
    return {"kind": "bob", "amplitude": 3}


def char_eye_style(char) -> str:
    """Optional 9th tuple element. `white` = eye whites filled with
    pure white (most characters — classic cartoon read). `body` = eye
    whites filled with the body color so the eye outline blends into
    the body (OG gray polo style). Default is `white`."""
    return char[8] if len(char) > 8 else "white"


# ── color helpers ───────────────────────────────────────────────────
def darken(hex_color: str, amount: float = 0.4) -> str:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (f"#{max(0,int(r*(1-amount))):02x}"
            f"{max(0,int(g*(1-amount))):02x}"
            f"{max(0,int(b*(1-amount))):02x}")


def lighten(hex_color: str, amount: float = 0.3) -> str:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (f"#{min(255,int(r+(255-r)*amount)):02x}"
            f"{min(255,int(g+(255-g)*amount)):02x}"
            f"{min(255,int(b+(255-b)*amount)):02x}")


def mix_toward_black(hex_color: str, amount: float) -> str:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    r = max(0, int(r * (1 - amount)))
    g = max(0, int(g * (1 - amount)))
    b = max(0, int(b * (1 - amount)))
    return f"#{r:02x}{g:02x}{b:02x}"


# ── body silhouette — OG anatomy: head + chin + neck + body ────────
def render_body(body: str, horror: bool = False) -> str:
    """OG-style anatomy. Three connected pieces:

      HEAD: an oval (slightly taller than wide) sitting at the top.
            The chin is just the bottom of this oval; a soft crescent
            shadow sells it as a distinct chin.

      NECK: a narrow vertical column from the bottom of the head down
            to the top of the body. Has a small cast shadow at the
            top (from the head occluding it).

      BODY: a wider section below the neck, with rounded shoulders,
            extending past the stage bottom (clipped by grass).

    Heavy black outline throughout (not body-color-darkened — proper
    black, ~3px). Subtle gradient shading inside each piece.
    """
    if horror:
        body = mix_toward_black(body, 0.55)
    hl = lighten(body, 0.32)
    sh = darken(body, 0.30)
    chin_sh = darken(body, 0.45)

    s = '<g class="body">'
    # Cast shadow on the ground
    s += (f'<ellipse cx="{HEAD_CX}" cy="288" rx="56" ry="9" '
          f'fill="#000" opacity="0.28"/>')

    # Body trapezoid path — used three times: fill, clip, stroke.
    body_path = (f"M{HEAD_CX-BODY_TOP_HALF} {BODY_TOP_Y} "
                 f"L{HEAD_CX-BODY_BOT_HALF} {BODY_BOT_Y} "
                 f"L{HEAD_CX+BODY_BOT_HALF} {BODY_BOT_Y} "
                 f"L{HEAD_CX+BODY_TOP_HALF} {BODY_TOP_Y} Z")
    # ── BODY FILL ── (stroke is drawn LAST so shadows can't eat it)
    s += f'<path d="{body_path}" fill="{body}" stroke="none"/>'
    # Subtle body shadow on the right side — narrow strip
    s += (f'<path d="M{HEAD_CX+BODY_TOP_HALF-2} {BODY_TOP_Y+6} '
          f'L{HEAD_CX+BODY_BOT_HALF-12} {BODY_BOT_Y} '
          f'L{HEAD_CX+BODY_BOT_HALF} {BODY_BOT_Y} '
          f'L{HEAD_CX+BODY_TOP_HALF} {BODY_TOP_Y+6} Z" '
          f'fill="{sh}" opacity="0.28"/>')

    # ── NECK SHADOW ── a thick curved band sitting on top of the
    # trapezoid, following the chin's downward curve. Drawn as a
    # STROKED arc (not a filled path) so the curvature reads cleanly
    # at every width. Clipped to the body trapezoid so it doesn't
    # spill out the sides.
    s += (f'<defs><clipPath id="body-clip">'
          f'<path d="{body_path}"/>'
          f'</clipPath></defs>')
    s += (f'<g clip-path="url(#body-clip)">'
          # Wide arc that mirrors the chin's curve, sitting just
          # inside the body's top edge.
          f'<path d="M{HEAD_CX-BODY_TOP_HALF-4} {BODY_TOP_Y+4} '
          f'Q{HEAD_CX} {BODY_TOP_Y+20}, '
          f'{HEAD_CX+BODY_TOP_HALF+4} {BODY_TOP_Y+4}" '
          f'stroke="{darken(body, 0.22)}" stroke-width="10" '
          f'fill="none" stroke-linecap="butt" opacity="0.75"/>'
          f'</g>')

    # ── BODY STROKE ── drawn LAST so the trapezoid's black outline
    # always sits on top of the neck shadow. Otherwise the shadow's
    # 10px width eats the inner half of the 3px stroke, making the
    # border look thin or absent at the top of the body. Rich called
    # this out — "the shadow is poking over the black border".
    s += (f'<path d="{body_path}" fill="none" '
          f'stroke="{OUTLINE}" stroke-width="3"/>')

    # ── HEAD ── (drawn last so it covers the top of the body)
    s += (f'<ellipse cx="{HEAD_CX}" cy="{HEAD_CY}" '
          f'rx="{HEAD_RX}" ry="{HEAD_RY}" '
          f'fill="{body}" stroke="{OUTLINE}" stroke-width="3.4"/>')
    # Chin shadow — a thin SLIVER of darker color hugging the bottom
    # 50% of the chin curve. Not a beard, not a soft gradient — a
    # narrow band that reads as the underside of the chin in shadow.
    # Clipped to the head outline so it doesn't escape.
    s += (f'<defs><clipPath id="head-clip">'
          f'<ellipse cx="{HEAD_CX}" cy="{HEAD_CY}" '
          f'rx="{HEAD_RX-1.5}" ry="{HEAD_RY-1.5}"/>'
          f'</clipPath></defs>')
    # Chin shadow: ear-to-ear curve hugging the underside of the
    # head. Endpoints at the "ears" (head's widest points at the
    # vertical 50% mark, x = HEAD_CX ± HEAD_RX, y = HEAD_CY). Curve
    # follows the head's bottom oval shape, shifted up 2px, so it
    # dips down to just above the chin in the middle. 1px thicker
    # stroke + lighter opacity than the last pass.
    s += (f'<g clip-path="url(#head-clip)">'
          f'<path d="M{HEAD_CX-HEAD_RX} {HEAD_CY} '
          f'A{HEAD_RX} {HEAD_RY-2} 0 0 0 '
          f'{HEAD_CX+HEAD_RX} {HEAD_CY}" '
          f'stroke="{chin_sh}" stroke-width="3.4" fill="none" '
          f'stroke-linecap="round" opacity="0.7"/>'
          f'</g>')
    if horror:
        # Hairline cracks on the head
        s += (f'<path d="M{HEAD_CX-20} {HEAD_CY-30} l8 14 l-4 14 '
              f'l10 18 l-4 14" '
              f'stroke="#e0d0c0" stroke-width="1.2" fill="none" '
              f'opacity="0.55"/>')
        # Black drip from chin onto body
        s += (f'<path d="M{HEAD_CX-3} {HEAD_CY+HEAD_RY-2} '
              f'q1 30 5 60 l-4 6 l-6 -8 q-1 -28 5 -56 Z" '
              f'fill="#08010a" opacity="0.85"/>')

    s += "</g>"
    return s


# ── face — OG-style: HUGE half-shut eyes, arched brows, tiny mouth ─
def render_face(eye_dx: int = 0, mouth_dy: int = 0,
                face_style: str = "default",
                mouth_style: str = "curve",
                phantom: bool = False,
                body: str = "#c5c8cb",
                gaze: str = "chill",
                eye_color: str | None = None) -> str:
    """OG sprunki face. Three elements, always in this order:

      EYEBROWS: thin black arcs ABOVE each eye, both arching slightly
                upward in the middle (raised / mildly concerned).

      EYES: GIANT (~33% of head width each). A "D"-shaped black mass
            fills the upper half AND most of the lower half — the
            pupil and upper eyelid are merged into one continuous
            shape, leaving only a thin white crescent visible at the
            bottom and sides. Heavy black outline.

      MOUTH: TINY — a small smile arc OR just a dot. Sits well below
             the eyes, near the bottom of the head.

    `eye_dx` is a per-frame jitter so the cast feels alive without
    breaking the uniform face style.

    `face_style="disgusted"` is the flower-only exception: pupils
    look up-and-right, one brow raised, zigzag mouth + tongue.
    """
    s = ""

    eye_cx_L = HEAD_CX - EYE_DX + eye_dx
    eye_cx_R = HEAD_CX + EYE_DX + eye_dx

    eye_fill = "#fff" if not phantom else "#3a0a0a"
    # OG pupils are pure black; OUTLINE is #1a1a1a which is close but
    # slightly less punchy. Use pure black for contrast.
    pupil_fill = "#000" if not phantom else "#ff2828"
    # `eye_color` is the SCLERA fill (the eye-white). For most cast
    # members this is pure white; for gray (and horror overrides) it
    # matches the body color so the eye blends into the head.
    # The lid OVERLAY always uses the body color so when it drapes
    # over the top of the eye it visually merges with the head.
    eye_body = eye_color if eye_color else body
    lid_body = body

    # GAZE — each frame defines per-eye state: (left_eye, right_eye).
    # A single eye_state is one of:
    #   ("LID", lid_yL, lid_yM, lid_yR, p_dx, p_dy, p_scale)
    #     lid_y* are y positions of the lid bottom edge at left corner,
    #     middle, and right corner (relative to eye center; positive =
    #     below center). p_dx/dy = pupil offset from eye center.
    #     p_scale = pupil size factor (1.0 = full eye); the pupil is a
    #     large circle that gets masked by the lid overlay above.
    #   ("WIDE", p_dx, p_dy, p_scale)
    #     No lid — small or large pupil shown as full circle.
    #     Optional p_dx/dy/scale; default (0, 2, 0.72).
    #   ("BLINK",) — closed eye, horizontal line.
    # Convenience: "CHILL" = ("LID", 0, 2, 0, 0, 0, 1.0) symmetric.
    # All numbers are in MY coord system (mine r=29; OG r=23.48 scale ~1.235).
    # Lid arch positions (relative to eye center). Negative = lid bottom
    # edge dips UP above center (more eye visible); positive = lid edge
    # dips DOWN below center (less eye visible).
    #   chill ≈ 0 (lid edge at center)
    #   wide  ≈ -19 (strongly up-arched, most pupil visible)
    #   closed≈ +22 (almost fully covers eye)
    CHILL = ("LID", 0, 1, 0, 0, 0, 1.0)
    HEAVY = ("LID", 2, 8, 2, 0, 0, 1.0)         # ~2/3 covered
    SLEEPY = ("LID", 4, 14, 4, 0, 0, 1.0)
    CLOSED = ("LID", 0, 22, 0, 0, 0, 1.0)       # nearly full coverage
    LOOK_R = ("LID", 0, 1, 0, 4, 0, 1.0)
    LOOK_L = ("LID", 0, 1, 0, -4, 0, 1.0)
    # Wide-open variants — lid up-arched off the eye (or well above center).
    WIDE_LIGHT = ("LID", 0, -9, 0, 0, 0, 1.0)   # slight wide-open
    WIDE = ("LID", 0, -19, 0, 0, 0, 1.0)        # fully wide-open
    WIDE_R = ("LID", 0, -9, 0, 5, 0, 1.0)       # slight wide + pupil right
    WIDE_HORROR = ("LID", 0, -22, 0, 0, 0, 1.25)  # full wide + bigger pupil

    gaze_table = {
        # OG Polo 1 cycle: chill is the resting frame; the cycle works
        # through various lid positions (closed→wide→back) over 15
        # frames. polo-3/5R/8/9R = mostly-closed (no visible pupil);
        # polo-11 = slightly wide; polo-12 = fully wide.
        "polo-0":  (CHILL, CHILL),
        "polo-1":  (CHILL, CHILL),       # body=#fff via override
        "polo-2":  (CHILL, CHILL),
        "polo-3":  (CLOSED, CLOSED),     # lid covers nearly all of eye
        "polo-4":  (CHILL, CHILL),
        # Polo 5 — L chill, R nearly closed (the half-blink frame).
        "polo-5":  (CHILL, CLOSED),
        "polo-6":  (CHILL, CHILL),
        "polo-7":  (CHILL, CHILL),
        # Polo 8 — both eyes heavier than chill (transition to closed).
        "polo-8":  (HEAVY, HEAVY),
        # Polo 9 — L heavy/closed-ish, R chill (mirror of polo-5).
        "polo-9":  (CLOSED, CHILL),
        # Polo 10 — both heavier, pupils shifted left.
        "polo-10": (("LID", 2, 8, 2, -4, 0, 1.0),
                    ("LID", 2, 8, 2, -4, 0, 1.0)),
        # Polo 11 — slightly wide, pupils shifted right.
        "polo-11": (WIDE_R, WIDE_R),
        # Polo 12 — fully wide-open.
        "polo-12": (WIDE, WIDE),
        # Polo 13, 14 — horror transition (body+eye color via override).
        # Pupils nearly fill the eye.
        "polo-13": (WIDE_HORROR, WIDE_HORROR),
        "polo-14": (WIDE_HORROR, WIDE_HORROR),
        # Aliases for non-Polo callers
        "chill":      (CHILL, CHILL),
        "sleepy":     (SLEEPY, SLEEPY),
        "wide":       (WIDE, WIDE),
        "wide-left":  (("LID", 0, -19, 0, -5, 0, 1.0),
                       ("LID", 0, -19, 0, -5, 0, 1.0)),
        "wide-right": (("LID", 0, -19, 0, 5, 0, 1.0),
                       ("LID", 0, -19, 0, 5, 0, 1.0)),
        "wide-up":    (("LID", 0, -19, 0, 0, -5, 1.0),
                       ("LID", 0, -19, 0, 0, -5, 1.0)),
        "look-left":  (LOOK_L, LOOK_L),
        "look-right": (LOOK_R, LOOK_R),
        "look-down":  (SLEEPY, SLEEPY),
        "blink":      (("BLINK",), ("BLINK",)),
    }
    eye_pair = gaze_table.get(gaze, gaze_table["chill"])

    if face_style == "disgusted":
        # Both eyes: tilted lid + small pupil shifted right (gross-out)
        eye_pair = (("LID", -4, -10, 0, 5, 0, 0.7),
                    ("LID", -4, -10, 0, 5, 0, 0.7))

    # OG-style eye: a body-colored circle with the pupil rendered as
    # a black SHAPE that doubles as the eyelid. Lid state is encoded
    # in the pupil's top-edge curve and the pupil's vertical extent.
    # For 1/3 shut: lid arches UP at center (more eye visible mid).
    # For 1/2 shut: lid is FLAT (the classic chill).
    # For 2/3 shut: lid arches DOWN at center (less eye visible mid).
    # For wide:    pupil is a full circle, no lid at all.
    # For blink:   pupil hidden, a horizontal closed-lid line shown.

    # ── EYEBROWS ── thin arched lines, NOT filled almonds. The OG
    # uses a slim stroke that arches up gently and tilts outward at
    # the inner ends so the two brows aim toward each other.
    brow_half_w = 14
    brow_arch = 6        # how high the brow center is above the ends
    # Each brow is a Q-curve drawn with a stroke. Rotated outward 12°
    # so the inner ends point at each other roughly horizontally.
    for cx, rot in ((eye_cx_L, -12), (eye_cx_R, 12)):
        ctrl_y = BROW_Y - brow_arch * 2  # solves Q midpoint = BROW_Y - arch
        s += (f'<g transform="rotate({rot} {cx} {BROW_Y})">'
              f'<path d="M{cx-brow_half_w} {BROW_Y} '
              f'Q{cx} {ctrl_y}, {cx+brow_half_w} {BROW_Y}" '
              f'stroke="{OUTLINE}" stroke-width="2.4" fill="none" '
              f'stroke-linecap="round"/>'
              f'</g>')

    # ── EYES ── OG-style: body-color circle + black pupil + body-
    # color LID OVERLAY on top. The lid's bottom edge is a Q-curve
    # through three control points (left corner, middle, right
    # corner) so it can be asymmetric for side-look variants. Lid
    # spans the FULL eye width. Each eye has independent state.
    for i, (cx, eye_state) in enumerate(zip((eye_cx_L, eye_cx_R), eye_pair)):
        eye_id = f"eye-{i}"
        eye_top = EYE_Y - EYE_RY

        # 1. Eye background: body-color circle.
        s += (f'<ellipse cx="{cx}" cy="{EYE_Y}" rx="{EYE_RX}" ry="{EYE_RY}" '
              f'fill="{eye_body if not phantom else eye_fill}" '
              f'stroke="{OUTLINE}" stroke-width="3"/>')
        # Clip everything inside to the eye interior.
        s += (f'<defs><clipPath id="{eye_id}">'
              f'<ellipse cx="{cx}" cy="{EYE_Y}" '
              f'rx="{EYE_RX-1.5}" ry="{EYE_RY-1.5}"/>'
              f'</clipPath></defs>')
        s += f'<g clip-path="url(#{eye_id})">'

        kind = eye_state[0]
        if kind == "BLINK":
            # Closed lid line across the eye.
            s += (f'<path d="M{cx-EYE_RX*0.78} {EYE_Y} '
                  f'q{EYE_RX*0.78} 3 {EYE_RX*1.56} 0" '
                  f'stroke="{OUTLINE}" stroke-width="3" fill="none" '
                  f'stroke-linecap="round"/>')
        elif kind == "WIDE":
            # No lid — full-circle pupil filling the eye. Optional
            # pupil_dx / pupil_dy / scale shifts let "wide" variants
            # gaze off-center or have smaller pupils.
            wp_dx = eye_state[1] if len(eye_state) > 1 else 0
            wp_dy = eye_state[2] if len(eye_state) > 2 else 0
            wp_scale = eye_state[3] if len(eye_state) > 3 else 1.0
            pr = EYE_RX * 0.70 * wp_scale
            s += (f'<circle cx="{cx+wp_dx}" cy="{EYE_Y+wp_dy}" r="{pr}" '
                  f'fill="{pupil_fill}"/>')
        else:
            # ("LID", lid_yL, lid_yM, lid_yR, p_dx, p_dy, p_scale)
            _, lid_dy_L, lid_dy_M, lid_dy_R, p_dx, p_dy, p_scale = eye_state
            # 2. Pupil. For center-look variants (p_scale ≈ 1) it's a
            # large circle filling the eye; the lid overlay above
            # masks the top to produce the D-shape. For side-looks
            # (p_scale < 1) it's a smaller shifted oval.
            # OG pupil/eye radius ratio is ~0.70. The pupil is a full
            # circle; the lid overlay above masks the top half.
            pr = EYE_RX * 0.70 * p_scale
            s += (f'<circle cx="{cx+p_dx}" cy="{EYE_Y+p_dy}" '
                  f'r="{pr}" fill="{pupil_fill}"/>')

            # 3. LID overlay — Q-curve top through three points
            # (left, center, right) — body-color fill, drawn over
            # the pupil to cover the upper portion.
            lid_y_L = EYE_Y + lid_dy_L
            lid_y_M = EYE_Y + lid_dy_M
            lid_y_R = EYE_Y + lid_dy_R
            ctrl_y = 2 * lid_y_M - (lid_y_L + lid_y_R) / 2
            top_y = eye_top - 6
            lid_color = lid_body if not phantom else eye_fill
            s += (f'<path d="M{cx-EYE_RX-2} {lid_y_L:.1f} '
                  f'Q{cx} {ctrl_y:.1f}, {cx+EYE_RX+2} {lid_y_R:.1f} '
                  f'L{cx+EYE_RX+2} {top_y} '
                  f'L{cx-EYE_RX-2} {top_y} Z" '
                  f'fill="{lid_color}"/>')
            # 4. Crease line along the lid's bottom edge.
            s += (f'<path d="M{cx-EYE_RX} {lid_y_L:.1f} '
                  f'Q{cx} {ctrl_y:.1f}, {cx+EYE_RX} {lid_y_R:.1f}" '
                  f'stroke="{OUTLINE}" stroke-width="2.2" fill="none"/>')
        s += "</g>"

    # ── MOUTH ── ~24% of head width. Either a flat horizontal line
    # (chill characters like clukr) or a very gentle smile curve
    # (most characters, e.g. oren).
    my = MOUTH_Y + mouth_dy
    mouth_half = int(HEAD_RX * 0.20)   # ≈15, total mouth width ≈30
    if face_style == "disgusted":
        s += (f'<path d="M{HEAD_CX-mouth_half+4} {my+5} l5 -6 l6 5 '
              f'l6 -5 l5 6 l-2 0" '
              f'stroke="{OUTLINE}" stroke-width="2.8" fill="none" '
              f'stroke-linejoin="round" stroke-linecap="round"/>')
        s += (f'<path d="M{HEAD_CX-12} {my+2} q-5 8 6 10 q4 -7 -3 -9 Z" '
              f'fill="#ff7a8a" stroke="{OUTLINE}" stroke-width="1.4"/>')
    elif mouth_style == "flat":
        # Completely horizontal line. clukr-style chill.
        s += (f'<line x1="{HEAD_CX-mouth_half}" y1="{my}" '
              f'x2="{HEAD_CX+mouth_half}" y2="{my}" '
              f'stroke="{OUTLINE}" stroke-width="2.6" '
              f'stroke-linecap="round"/>')
    else:
        # Gentle smile curve — wide and shallow.
        s += (f'<path d="M{HEAD_CX-mouth_half} {my} '
              f'Q{HEAD_CX} {my+5}, {HEAD_CX+mouth_half} {my}" '
              f'stroke="{OUTLINE}" stroke-width="2.6" fill="none" '
              f'stroke-linecap="round"/>')
    return s


# ── crowns — per-character silhouette identifier ───────────────────
#
# Each crown draws elements ABOVE the body's dome top (DOME_TOP_Y),
# typically in the y=−10..80 range. Some crowns also overlap the
# face area (visor, monitor) — they're meant to feel like part of
# the head, not stuck-on accessories.
def render_crown(style: str, body: str) -> str:
    s = ""
    head_top = HEAD_CY - HEAD_RY     # very top of the head oval

    if style == "none":
        # No crown — used for the simpler "Polo"-style characters
        # (like gray) where the silhouette is just head+body, no
        # accessory.
        return s
    elif style == "hiHatCymbal":
        # Brass cymbal seen from a slight 3/4 top-down angle. The
        # wide flat disc, the raised center bell, and the concentric
        # grooves are what make it READ as a cymbal vs. a hat.
        brass = "#e9c449"
        brass_hl = "#fff4a8"
        brass_sh = "#8a6a14"
        cy_y = head_top - 6           # disc center y, just above head
        # Main disc — wide oval (rx >> ry) showing the disc tilted
        # almost flat toward the viewer.
        s += (f'<ellipse cx="{HEAD_CX}" cy="{cy_y}" rx="60" ry="14" '
              f'fill="{brass}" stroke="{OUTLINE}" stroke-width="2.8"/>')
        # Concentric grooves — the etched rings of a real cymbal.
        # All ellipses share the disc's center but with smaller rx
        # and proportionally smaller ry.
        for r in (52, 44, 36, 26, 18):
            s += (f'<ellipse cx="{HEAD_CX}" cy="{cy_y}" '
                  f'rx="{r}" ry="{r * 14 / 60:.1f}" '
                  f'fill="none" stroke="{brass_sh}" '
                  f'stroke-width="0.8" opacity="0.55"/>')
        # Center bell — small raised dome at the disc center
        s += (f'<ellipse cx="{HEAD_CX}" cy="{cy_y-2}" rx="10" ry="4" '
              f'fill="{brass_hl}" stroke="{OUTLINE}" stroke-width="1.8"/>')
        # Tiny highlight inside the bell — sells the metallic shine
        s += (f'<ellipse cx="{HEAD_CX-3}" cy="{cy_y-3}" rx="3" ry="1.2" '
              f'fill="#fff" opacity="0.85"/>')
        # Bright top-edge crescent — the catch-light along the disc's
        # upper rim
        s += (f'<path d="M{HEAD_CX-50} {cy_y-7} '
              f'Q{HEAD_CX} {cy_y-12}, {HEAD_CX+50} {cy_y-7}" '
              f'stroke="{brass_hl}" stroke-width="1.8" fill="none"/>')
        # Underside shadow along the disc's lower rim
        s += (f'<path d="M{HEAD_CX-50} {cy_y+7} '
              f'Q{HEAD_CX} {cy_y+11}, {HEAD_CX+50} {cy_y+7}" '
              f'stroke="{brass_sh}" stroke-width="1.6" fill="none"/>')

    elif style == "antennae":
        # Two tall thin antennae with round bulb tips. Knobs are
        # body-colored so they read as part of the character.
        knob = lighten(body, 0.30)
        for x in (76, 124):
            s += (f'<line x1="{x}" y1="{head_top+10}" x2="{x}" y2="{head_top-22}" '
                  f'stroke="{darken(body, 0.55)}" stroke-width="3.2" '
                  f'stroke-linecap="round"/>')
            s += (f'<circle cx="{x}" cy="{head_top-28}" r="9" '
                  f'fill="{knob}" stroke="{darken(body, 0.6)}" stroke-width="2.4"/>')
            s += f'<circle cx="{x-2}" cy="{head_top-30}" r="2.6" fill="#fff" opacity="0.8"/>'

    elif style == "horns":
        # Two devil-style horn spikes at the top corners of the dome.
        for sign, anchor in ((-1, BCX-32), (1, BCX+32)):
            tip_x = anchor + sign * 8
            tip_y = head_top - 38
            s += (f'<path d="M{anchor-12} {head_top+10} '
                  f'Q{anchor-2} {head_top-10}, {tip_x} {tip_y} '
                  f'Q{anchor+8} {head_top}, {anchor+12} {head_top+12} Z" '
                  f'fill="{darken(body, 0.5)}" stroke="{darken(body, 0.7)}" '
                  f'stroke-width="2.2" stroke-linejoin="round"/>')

    elif style == "catEars":
        # Two prominent pointed cat ears anchored to the top corners
        # of the dome. Big enough that they read as the character's
        # signature silhouette from across the stage.
        inner = "#ffb6c8"   # pink inner ear — pops against the gray body
        outline = darken(body, 0.55)
        for sign in (-1, 1):
            # Outer ear triangle — anchored where the dome curves
            # inward, tip pointing UP and slightly outward.
            base_in_x = BCX + sign * 22       # inner edge of base
            base_out_x = BCX + sign * 56      # outer edge of base
            base_y = head_top + 24            # base sits ON the dome curve
            tip_x = BCX + sign * 44           # tip leans outward
            tip_y = head_top - 60             # tip far above the head
            s += (f'<path d="M{base_in_x} {base_y} '
                  f'L{tip_x} {tip_y} '
                  f'L{base_out_x} {base_y+6} Z" '
                  f'fill="{body}" stroke="{outline}" stroke-width="2.6" '
                  f'stroke-linejoin="round"/>')
            # Inner pink ear — smaller triangle, offset inward
            in_x = base_in_x + sign * 6
            in_out_x = base_out_x - sign * 10
            in_tip_x = tip_x - sign * 3
            in_tip_y = tip_y + 16
            s += (f'<path d="M{in_x} {base_y+2} '
                  f'L{in_tip_x} {in_tip_y} '
                  f'L{in_out_x} {base_y+4} Z" '
                  f'fill="{inner}" opacity="0.85"/>')

    elif style == "tvMonitor":
        # Visor / monitor strip across the upper face area + two
        # short antennae poking up. The visor is part of the head;
        # the eyes peek out through the screen.
        s += (f'<rect x="{BCX-46}" y="{head_top+24}" width="92" height="56" '
              f'rx="10" fill="#1a1f28" stroke="#0a0d14" stroke-width="2.4"/>')
        # Scanlines hint
        for sy in (head_top+30, head_top+44, head_top+58):
            s += (f'<line x1="{BCX-42}" y1="{sy}" x2="{BCX+42}" y2="{sy}" '
                  f'stroke="#3a4350" stroke-width="0.8" opacity="0.5"/>')
        # Glow dot in the corner
        s += f'<circle cx="{BCX-40}" cy="{head_top+30}" r="2.2" fill="#5fff88"/>'
        # Two antennae
        for x_off in (-22, 22):
            s += (f'<line x1="{BCX+x_off}" y1="{head_top+10}" '
                  f'x2="{BCX+x_off}" y2="{head_top-18}" '
                  f'stroke="#1a1f28" stroke-width="3" stroke-linecap="round"/>')
            s += (f'<circle cx="{BCX+x_off}" cy="{head_top-22}" r="5" '
                  f'fill="#bcc4d0" stroke="#0a0d14" stroke-width="1.8"/>')

    elif style == "leafSpike":
        # One pointed leaf growing out the top, slight curl.
        s += (f'<path d="M{BCX} {head_top+12} '
              f'C{BCX-16} {head_top-10}, {BCX-12} {head_top-46}, {BCX+2} {head_top-50} '
              f'C{BCX+18} {head_top-44}, {BCX+18} {head_top-10}, {BCX} {head_top+12} Z" '
              f'fill="#7adf6a" stroke="#244e1c" stroke-width="2.2"/>')
        # Vein
        s += (f'<path d="M{BCX} {head_top+10} Q{BCX+2} {head_top-20}, {BCX+1} {head_top-46}" '
              f'stroke="#244e1c" stroke-width="1.4" fill="none"/>')

    elif style == "headphones":
        # Curved headphones band over the top of the head with two
        # earcups on the sides.
        s += (f'<path d="M{BCX-44} {head_top+30} '
              f'C{BCX-44} {head_top-6}, {BCX+44} {head_top-6}, {BCX+44} {head_top+30}" '
              f'stroke="#1a1f28" stroke-width="6" fill="none" stroke-linecap="round"/>')
        for sign in (-1, 1):
            cx = BCX + sign * 46
            s += (f'<rect x="{cx-9}" y="{head_top+22}" width="18" height="26" '
                  f'rx="5" fill="#1a1f28" stroke="#0a0d14" stroke-width="2"/>')
            s += (f'<rect x="{cx-6}" y="{head_top+26}" width="12" height="18" '
                  f'rx="3" fill="#4a5260"/>')

    elif style == "glitchSparks":
        # Jagged static bursts radiating from the top + a few
        # offset color-shift slabs across the body's upper region.
        s += '<g opacity="0.92">'
        # Top-mounted zigzag bursts
        s += (f'<path d="M{BCX-30} {head_top-10} l8 -12 l-4 -2 l12 -16 l-2 8 l10 -12 l-4 6 l10 -8 l-4 12 l8 -2" '
              f'stroke="#0ff" stroke-width="2" fill="none" stroke-linejoin="round"/>')
        s += (f'<path d="M{BCX+8} {head_top-14} l-4 -10 l6 -2 l-2 -8 l8 4 l-2 -12 l8 8 l-2 -4 l8 12" '
              f'stroke="#f0f" stroke-width="2" fill="none" stroke-linejoin="round"/>')
        s += "</g>"
        # Cyan + magenta glitch slabs on body
        s += (f'<rect x="{BCX-44}" y="{EYE_Y-26}" width="28" height="4" '
              f'fill="#0ff" opacity="0.55"/>')
        s += (f'<rect x="{BCX+12}" y="{EYE_Y+10}" width="34" height="4" '
              f'fill="#f0f" opacity="0.55"/>')

    elif style == "pixelCrown":
        # Crown of square pixel blocks along the top of the dome.
        block_y = head_top - 4
        for i, w in enumerate([10, 14, 18, 14, 10]):
            bx = BCX - 35 + i * 14
            h = 10 + (i % 2) * 8
            s += (f'<rect x="{bx}" y="{block_y-h}" width="{w}" height="{h+10}" '
                  f'fill="{lighten(body, 0.20)}" stroke="{darken(body, 0.55)}" '
                  f'stroke-width="2"/>')
        # Single jewel pixel in the middle
        s += f'<rect x="{BCX-4}" y="{block_y-14}" width="8" height="8" fill="#ff4a6e"/>'

    elif style == "rocketTop":
        # Conical rocket nose-cone on top + small fins peeking out
        # the sides of the body.
        s += (f'<path d="M{BCX-16} {head_top+22} '
              f'L{BCX} {head_top-48} '
              f'L{BCX+16} {head_top+22} Z" '
              f'fill="{lighten(body, 0.15)}" stroke="{darken(body, 0.55)}" '
              f'stroke-width="2.4" stroke-linejoin="round"/>')
        s += (f'<circle cx="{BCX}" cy="{head_top-12}" r="4.5" '
              f'fill="#ff4a3a" stroke="#7a1c12" stroke-width="1.6"/>')
        # Small thruster fins on body sides
        for sign in (-1, 1):
            s += (f'<path d="M{BCX+sign*BW_HALF-sign*2} {EYE_Y+40} '
                  f'l{sign*22} 6 l{-sign*4} 18 l{-sign*16} -6 Z" '
                  f'fill="{darken(body, 0.45)}" stroke="{darken(body, 0.65)}" '
                  f'stroke-width="1.8"/>')

    elif style == "cloudPuff":
        # A puffy cloud overlapping the top of the dome — the head
        # peeks out from inside the cloud.
        s += '<g>'
        for (cx, cy, r) in [
            (BCX-30, head_top+10, 22),
            (BCX, head_top-6, 28),
            (BCX+30, head_top+8, 24),
            (BCX-12, head_top+18, 18),
            (BCX+18, head_top+20, 20),
        ]:
            s += (f'<circle cx="{cx}" cy="{cy}" r="{r}" '
                  f'fill="#fff" stroke="#b0c8de" stroke-width="2"/>')
        s += "</g>"

    elif style == "sunRays":
        # Wavy sun rays around the entire upper head — alternating
        # long/short spikes radiating outward.
        cx_c, cy_c = BCX, head_top + 14
        for ang_deg in range(-90, 90, 18):
            length = 28 if ang_deg % 36 == 0 else 22
            import math
            ang = math.radians(ang_deg - 90)
            tx = cx_c + math.cos(ang) * (BW_HALF + length)
            ty = cy_c + math.sin(ang) * (BW_HALF + length)
            mx = cx_c + math.cos(ang) * (BW_HALF + length * 0.35)
            my = cy_c + math.sin(ang) * (BW_HALF + length * 0.35)
            # Tapered ray
            perp_ang = ang + math.pi / 2
            half_w = 5
            x1 = mx + math.cos(perp_ang) * half_w
            y1 = my + math.sin(perp_ang) * half_w
            x2 = mx - math.cos(perp_ang) * half_w
            y2 = my - math.sin(perp_ang) * half_w
            s += (f'<path d="M{x1:.1f} {y1:.1f} L{tx:.1f} {ty:.1f} '
                  f'L{x2:.1f} {y2:.1f} Z" '
                  f'fill="#ffd84a" stroke="#a87800" stroke-width="1.6" '
                  f'stroke-linejoin="round"/>')

    elif style == "wizardHat":
        # Tall pointed wizard hat with a band + star.
        s += (f'<path d="M{BCX-30} {head_top+14} '
              f'L{BCX+2} {head_top-66} '
              f'L{BCX+30} {head_top+14} Z" '
              f'fill="{darken(body, 0.25)}" stroke="{darken(body, 0.6)}" '
              f'stroke-width="2.4" stroke-linejoin="round"/>')
        # Band
        s += (f'<rect x="{BCX-32}" y="{head_top+10}" width="64" height="8" '
              f'fill="{lighten(body, 0.25)}" stroke="{darken(body, 0.6)}" '
              f'stroke-width="2"/>')
        # Star
        s += (f'<path d="M{BCX-3} {head_top-30} l3 -8 l3 8 l8 1 l-6 5 l2 8 l-7 -4 '
              f'l-7 4 l2 -8 l-6 -5 z" fill="#ffe34a" stroke="#7a5500" '
              f'stroke-width="1.4"/>')

    elif style == "treeCanopy":
        # Bunch of leafy bushes forming a leaf canopy crown.
        s += '<g>'
        for (cx, cy, r) in [
            (BCX-30, head_top+4, 20),
            (BCX-6, head_top-14, 26),
            (BCX+22, head_top-6, 22),
            (BCX+34, head_top+12, 18),
            (BCX-18, head_top+16, 16),
        ]:
            s += (f'<circle cx="{cx}" cy="{cy}" r="{r}" '
                  f'fill="#2f7a2a" stroke="#143518" stroke-width="2"/>')
        # Lighter inner highlights
        for (cx, cy, r) in [(BCX-26, head_top-2, 6), (BCX+18, head_top-12, 7)]:
            s += (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#67c252" opacity="0.6"/>')
        s += "</g>"

    elif style == "squareWave":
        # Square-wave zigzag block crest along the top edge of the dome.
        outline = darken(body, 0.6)
        s += (f'<path d="M{BCX-44} {head_top+18} '
              f'L{BCX-44} {head_top-10} L{BCX-30} {head_top-10} '
              f'L{BCX-30} {head_top+8} L{BCX-16} {head_top+8} '
              f'L{BCX-16} {head_top-16} L{BCX-2} {head_top-16} '
              f'L{BCX-2} {head_top+6} L{BCX+12} {head_top+6} '
              f'L{BCX+12} {head_top-12} L{BCX+26} {head_top-12} '
              f'L{BCX+26} {head_top+10} L{BCX+44} {head_top+10} '
              f'L{BCX+44} {head_top+18} Z" '
              f'fill="{lighten(body, 0.10)}" stroke="{outline}" stroke-width="2"/>')

    elif style == "fedora":
        # Detective fedora — low cylinder crown + wide brim + band.
        # Brim
        s += (f'<ellipse cx="{BCX}" cy="{head_top+16}" rx="58" ry="9" '
              f'fill="#7a4a1f" stroke="#3a2008" stroke-width="2.2"/>')
        # Crown body
        s += (f'<path d="M{BCX-32} {head_top+16} L{BCX-32} {head_top-22} '
              f'Q{BCX} {head_top-32}, {BCX+32} {head_top-22} '
              f'L{BCX+32} {head_top+16} Z" '
              f'fill="#a07042" stroke="#3a2008" stroke-width="2.2"/>')
        # Band
        s += (f'<rect x="{BCX-32}" y="{head_top+4}" width="64" height="8" '
              f'fill="#3a2008"/>')
        # Pinch on top
        s += (f'<path d="M{BCX-12} {head_top-20} q12 -8 24 0" '
              f'stroke="#3a2008" stroke-width="1.6" fill="none"/>')

    elif style == "crtMonitor":
        # Full CRT-monitor head replacement: a boxy retro monitor
        # frame covering the upper face. Eyes are LED-style dots
        # inside the screen instead of normal eyes (we still emit
        # the normal face — the monitor frames AROUND them).
        s += (f'<rect x="{BCX-54}" y="{head_top-6}" width="108" height="118" '
              f'rx="10" fill="#1a1f28" stroke="#0a0d14" stroke-width="2.6"/>')
        # Screen
        s += (f'<rect x="{BCX-46}" y="{head_top+2}" width="92" height="100" '
              f'rx="6" fill="#0a3a2a" stroke="#3a5040" stroke-width="2"/>')
        # Scanlines
        for sy in range(int(head_top+10), int(head_top+98), 8):
            s += (f'<line x1="{BCX-44}" y1="{sy}" x2="{BCX+44}" y2="{sy}" '
                  f'stroke="#0c4a36" stroke-width="0.7" opacity="0.6"/>')
        # Status LEDs in the bottom-right of the bezel
        s += f'<circle cx="{BCX+38}" cy="{head_top+108}" r="2.2" fill="#5fff88"/>'
        s += f'<circle cx="{BCX+30}" cy="{head_top+108}" r="2.2" fill="#ffe34a"/>'

    elif style == "megaphone":
        # Conical megaphone shape on top — narrow at the head, wide
        # at the open end.
        s += (f'<path d="M{BCX-10} {head_top+18} '
              f'L{BCX-32} {head_top-30} '
              f'L{BCX+32} {head_top-30} '
              f'L{BCX+10} {head_top+18} Z" '
              f'fill="#cfd6e2" stroke="#5a6068" stroke-width="2.4" '
              f'stroke-linejoin="round"/>')
        # Inner shadow
        s += (f'<path d="M{BCX-26} {head_top-26} L{BCX+26} {head_top-26} '
              f'L{BCX+8} {head_top+14} L{BCX-8} {head_top+14} Z" '
              f'fill="#7a8390" opacity="0.5"/>')
        # Sound waves coming out the front
        for r in (22, 32, 42):
            s += (f'<path d="M{BCX+38} {head_top-32+r*0.3} '
                  f'q12 {r*0.7} 0 {r}" '
                  f'stroke="#ffe34a" stroke-width="2.2" fill="none" '
                  f'opacity="0.8"/>')

    elif style == "bigBow":
        # Big asymmetric bow on top of the head, ribbon trails to the
        # sides.
        s += (f'<g transform="translate({BCX} {head_top-14})">')
        # Left loop
        s += ('<path d="M0 0 q-22 -16 -30 -2 q-6 14 6 22 q18 10 24 -2 Z" '
              'fill="#ff6aa3" stroke="#7a1c3e" stroke-width="2.4"/>')
        # Right loop
        s += ('<path d="M0 0 q22 -16 30 -2 q6 14 -6 22 q-18 10 -24 -2 Z" '
              'fill="#ff6aa3" stroke="#7a1c3e" stroke-width="2.4"/>')
        # Center knot
        s += ('<rect x="-7" y="-8" width="14" height="16" rx="3" '
              'fill="#ffa6c8" stroke="#7a1c3e" stroke-width="2"/>')
        # Ribbon trails
        s += ('<path d="M-3 8 Q-14 28 -12 40 L-4 36 Q-4 22 0 12 Z" '
              'fill="#ff6aa3" stroke="#7a1c3e" stroke-width="1.6"/>')
        s += ('<path d="M3 8 Q14 28 12 40 L4 36 Q4 22 0 12 Z" '
              'fill="#ff6aa3" stroke="#7a1c3e" stroke-width="1.6"/>')
        s += "</g>"

    elif style == "topHat":
        # Classic tall top hat: brim + cylinder.
        # Brim
        s += (f'<ellipse cx="{BCX}" cy="{head_top+16}" rx="56" ry="8" '
              f'fill="#0a0a18" stroke="#000" stroke-width="2.2"/>')
        # Cylinder
        s += (f'<rect x="{BCX-30}" y="{head_top-44}" width="60" height="60" '
              f'fill="#1a1f3a" stroke="#000" stroke-width="2.4"/>')
        # Yellow band
        s += (f'<rect x="{BCX-30}" y="{head_top+4}" width="60" height="8" '
              f'fill="#ffd200" stroke="#7a5500" stroke-width="1.4"/>')

    elif style == "wispySmoke":
        # Translucent wisps of smoke curling up from the head — the
        # phantom's signature.
        s += '<g opacity="0.85">'
        s += (f'<path d="M{BCX-26} {head_top+14} '
              f'q-6 -22 14 -28 q-14 -16 8 -32 q10 -2 14 6" '
              f'stroke="#8a78c8" stroke-width="4" fill="none" '
              f'stroke-linecap="round"/>')
        s += (f'<path d="M{BCX+10} {head_top+8} '
              f'q14 -16 -2 -30 q22 -6 22 -22" '
              f'stroke="#5a4a8a" stroke-width="3" fill="none" '
              f'stroke-linecap="round" opacity="0.7"/>')
        s += (f'<circle cx="{BCX-26}" cy="{head_top-48}" r="6" fill="#8a78c8" opacity="0.55"/>')
        s += (f'<circle cx="{BCX+24}" cy="{head_top-36}" r="5" fill="#5a4a8a" opacity="0.5"/>')
        s += "</g>"

    elif style == "petalHead":
        # Flower-petal head — five large petals around the top of
        # the body, with a small green leaf sticking out one side
        # and yellow polka dots on the body (drawn here so they're
        # integrated with the silhouette, not a stuck-on overlay).
        # Petals around the upper dome
        s += f'<g transform="translate({BCX} {head_top+34})">'
        for ang in range(-90, 90 + 1, 45):
            s += (f'<g transform="rotate({ang})">'
                  f'<ellipse cx="0" cy="-44" rx="20" ry="32" '
                  f'fill="#ff80c0" stroke="#7a1c3e" stroke-width="2.4"/>'
                  f'<ellipse cx="-4" cy="-58" rx="6" ry="14" '
                  f'fill="#ffc6e0" opacity="0.85"/>'
                  f'</g>')
        # Yellow flower center disc
        s += ('<circle cx="0" cy="0" r="22" fill="#ffdf45" '
              'stroke="#7a5500" stroke-width="2.4"/>')
        s += '<circle cx="-6" cy="-6" r="4" fill="#fff" opacity="0.65"/>'
        s += "</g>"
        # Leaf on the side of the body
        s += (f'<path d="M{BCX-BW_HALF+4} {EYE_Y-10} '
              f'q-22 8 -14 30 q22 -2 14 -30 Z" '
              f'fill="#67c252" stroke="#1f3a14" stroke-width="2"/>')
        # Yellow polka dots scattered on body
        polka = [(BCX-30, MOUTH_Y+10, 5), (BCX+24, MOUTH_Y+22, 6),
                 (BCX-18, MOUTH_Y+40, 5), (BCX+8, MOUTH_Y+56, 5.5),
                 (BCX-34, MOUTH_Y+58, 4.5), (BCX+34, MOUTH_Y+48, 5)]
        for (cx, cy, r) in polka:
            s += (f'<circle cx="{cx}" cy="{cy}" r="{r}" '
                  f'fill="#ffe34a" stroke="#7a5500" stroke-width="1.2"/>')

    return s


# ── poses — visibly distinct frame-to-frame ─────────────────────────
#
# Each pose is (body_dy, body_lean_deg, eye_dx_jitter, mouth_dy).
# body_dy: vertical offset (negative = up). The character "bounces"
#   between frames on each audio transient on its track.
# body_lean_deg: skewX rotation around the body's base — the
#   character tilts L/R during play frames.
# eye_dx_jitter: small per-frame eye drift to make the cast feel alive.
# mouth_dy: small mouth offset (slightly open on jump).
POSES = {
    "idle":  (  0,   0,  0, 0),
    "play1": (-10, -14, -4, 1),    # lean left
    "play2": (-32,   0,  0, 4),    # JUMP UP big
    "play3": (-10,  14,  4, 1),    # lean right
}


# ── full character render — body + crown + face, posed ─────────────
def render_character_pose(char, pose: str, horror: bool = False) -> str:
    cid, name, cat, role, body, crown_style = char[:6]
    face_style = char_face_style(char)
    mouth_style = char_mouth_style(char)
    eye_style = char_eye_style(char)
    body_dy, lean_deg, eye_dx, mouth_dy = POSES[pose]
    phantom = cid == "black"
    eye_color = body if eye_style == "body" else "#fff"

    inner = '<g class="char">'

    # The whole character (body + crown + face) leans + bounces.
    # Lean pivots around a point near the body's base so the head
    # tilts but the feet stay planted.
    pivot_y = 290
    transform_parts = []
    if body_dy != 0:
        transform_parts.append(f'translate(0 {body_dy})')
    if lean_deg != 0:
        transform_parts.append(f'rotate({lean_deg} {BCX} {pivot_y})')
    transform = " ".join(transform_parts)
    inner += f'<g transform="{transform}">' if transform else '<g>'

    # Body silhouette
    if horror:
        inner += render_body(body, horror=True)
    else:
        inner += render_body(body)
    # Crown — drawn between body and face so it visually sits behind
    # the eyes when they overlap (e.g. tvMonitor).
    inner += render_crown(crown_style, body)
    # Face
    if horror:
        inner += render_horror_face(eye_dx=eye_dx, mouth_dy=mouth_dy,
                                    face_style=face_style)
    else:
        inner += render_face(eye_dx=eye_dx, mouth_dy=mouth_dy,
                             face_style=face_style,
                             mouth_style=mouth_style,
                             phantom=phantom, body=body,
                             eye_color=eye_color)

    inner += "</g>"  # close transform group
    inner += "</g>"  # close char group
    return svg_doc(inner)


# ── horror face — red glow eyes + fang grin + drip ─────────────────
def render_horror_face(eye_dx: int = 0, mouth_dy: int = 0,
                       face_style: str = "default") -> str:
    """Uniform horror face for the cast. Per-character variation in
    scary mode comes from the body color + crown silhouette (already
    drawn before this), so every horror sprunki is still recognizable
    even with the shared face."""
    s = ""
    eye_cx_L = BCX - EYE_DX + eye_dx
    eye_cx_R = BCX + EYE_DX + eye_dx
    for cx in (eye_cx_L, eye_cx_R):
        # Sunken socket
        s += (f'<ellipse cx="{cx}" cy="{EYE_Y}" rx="{EYE_RX+1}" ry="{EYE_RY}" '
              f'fill="#08020a" stroke="#000" stroke-width="2"/>')
        # Red glowing iris
        s += (f'<circle cx="{cx}" cy="{EYE_Y+2}" r="9.5" '
              f'fill="#ff1a1a" opacity="0.35"/>')
        s += f'<circle cx="{cx}" cy="{EYE_Y+2}" r="6" fill="#ff2828"/>'
        s += f'<circle cx="{cx}" cy="{EYE_Y+2}" r="2.6" fill="#ffe2a0"/>'
        # Drip from each eye
        s += (f'<path d="M{cx-1} {EYE_Y+EYE_RY-1} l-1 14 l3 0 z" '
              f'fill="#0a0203" opacity="0.85"/>')
    # Jagged fang mouth with sharp teeth
    my = MOUTH_Y + mouth_dy
    s += (f'<path d="M{BCX-26} {my-2} q26 22 52 0 q-26 -14 -52 0 Z" '
          f'fill="#0a0000" stroke="#000" stroke-width="2.4" '
          f'stroke-linejoin="round"/>')
    # Teeth row
    width = 52
    n = 7
    step = width / n
    base = BCX - 26
    for i in range(n):
        x0 = base + i * step
        x1 = x0 + step
        cx = (x0 + x1) / 2
        s += (f'<path d="M{x0:.1f} {my-2} L{cx:.1f} {my+7} L{x1:.1f} {my-2} Z" '
              f'fill="#f0d8c0"/>')
        if i < n - 1:
            xa = x0 + step / 2
            xb = xa + step
            cxb = (xa + xb) / 2
            s += (f'<path d="M{xa:.1f} {my+12} L{cxb:.1f} {my+4} '
                  f'L{xb:.1f} {my+12} Z" fill="#f0d8c0"/>')
    # Ooze from mouth corners
    s += (f'<path d="M{BCX-22} {my+10} q-2 14 4 18" '
          f'stroke="#0a0203" stroke-width="2.2" fill="none" stroke-linecap="round"/>')
    s += (f'<path d="M{BCX+22} {my+10} q2 14 -4 18" '
          f'stroke="#0a0203" stroke-width="2.2" fill="none" stroke-linecap="round"/>')
    return s


# ── palette icons ──────────────────────────────────────────────────
def render_icon(char) -> str:
    """80×80 palette tile. Shrinks the full body+crown+face into a
    compact portrait. The crown drives recognition at thumbnail size,
    so we render it at the same scale as the body."""
    cid, name, cat, role, body, crown_style = char[:6]
    face_style = char_face_style(char)
    mouth_style = char_mouth_style(char)
    eye_style = char_eye_style(char)
    phantom = cid == "black"
    eye_color = body if eye_style == "body" else "#fff"
    s = '<rect x="0" y="0" width="80" height="80" rx="14" fill="#101723"/>'
    s += '<g transform="translate(40 70) scale(0.38) translate(-100 -150)">'
    s += render_body(body)
    s += render_crown(crown_style, body)
    s += render_face(face_style=face_style, mouth_style=mouth_style,
                     phantom=phantom, body=body, eye_color=eye_color)
    s += "</g>"
    return svg_doc(s)


def render_icon_pressed(char) -> str:
    """Slightly darker portrait — used while dragging."""
    cid, name, cat, role, body, crown_style = char[:6]
    face_style = char_face_style(char)
    mouth_style = char_mouth_style(char)
    eye_style = char_eye_style(char)
    phantom = cid == "black"
    dim_body = darken(body, 0.35)
    eye_color = dim_body if eye_style == "body" else "#e5e5e5"
    s = '<rect x="0" y="0" width="80" height="80" rx="14" fill="#070b12"/>'
    s += '<g transform="translate(40 70) scale(0.38) translate(-100 -150)">'
    s += render_body(dim_body)
    s += render_crown(crown_style, dim_body)
    s += render_face(face_style=face_style, mouth_style=mouth_style,
                     phantom=phantom, body=dim_body, eye_color=eye_color)
    s += "</g>"
    return svg_doc(s)


def render_icon_dimmed(char) -> str:
    """Grayscale portrait — used in the palette while the character
    is on stage."""
    cid, name, cat, role, body, crown_style = char[:6]
    face_style = char_face_style(char)
    mouth_style = char_mouth_style(char)
    eye_style = char_eye_style(char)
    phantom = cid == "black"
    eye_color = body if eye_style == "body" else "#fff"
    s = ('<defs><filter id="g"><feColorMatrix type="matrix" '
         'values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  '
         '0.33 0.33 0.33 0 0  0 0 0 1 0"/></filter></defs>')
    s += '<rect x="0" y="0" width="80" height="80" rx="14" fill="#1a1a1a"/>'
    s += '<g filter="url(#g)" opacity="0.6">'
    s += '<g transform="translate(40 70) scale(0.38) translate(-100 -150)">'
    s += render_body(body)
    s += render_crown(crown_style, body)
    s += render_face(face_style=face_style, mouth_style=mouth_style,
                     phantom=phantom, body=body, eye_color=eye_color)
    s += "</g></g>"
    return svg_doc(s)


# ── shared sprites ──────────────────────────────────────────────────
def render_empty() -> str:
    """Empty slot Polo — same silhouette + polo-style face as the
    cast, but a near-white ash color clearly distinct from any
    populated body color, and the closed `blink` gaze so the slot
    reads as "asleep / waiting" vs "awake chill"."""
    EMPTY_COLOR = "#e8ecef"
    inner = render_body(EMPTY_COLOR)
    inner += render_face(
        face_style="default", mouth_style="flat",
        phantom=False, body=EMPTY_COLOR, gaze="blink",
        eye_color=EMPTY_COLOR,
    )
    return svg_doc(inner)


def render_empty_horror() -> str:
    """Horror empty slot — same near-white ash silhouette but with
    cracks + ooze + closed grim mouth."""
    EMPTY_COLOR = "#3a3340"
    inner = render_body(EMPTY_COLOR, horror=True)
    # Closed dark eye slits
    for sign in (-1, 1):
        cx = BCX + sign * EYE_DX
        inner += (f'<rect x="{cx-13}" y="{EYE_Y-1}" width="26" height="3" '
                  f'fill="#000"/>')
    # Thin mouth line
    inner += (f'<line x1="{BCX-12}" y1="{MOUTH_Y+6}" '
              f'x2="{BCX+12}" y2="{MOUTH_Y+6}" '
              f'stroke="#000" stroke-width="2.6" stroke-linecap="round"/>')
    return svg_doc(inner)


def render_backdrop() -> str:
    """Stage backdrop — 680×321 (same as OG backdropcute) so stage
    CSS aspect-ratio assumptions hold.

    GRASS LINE IS ANCHORED AT EXACTLY 78% FROM THE TOP (y=250 of
    321). The sprunki-stage clips the lower 22% of each character
    behind the grass, so as long as the grass silhouette sits at
    y=250 here, the seam between body and grass is invisible.
    If the stage's clip percentage changes, update this constant in
    lockstep — keep them in sync, or the cast floats / sinks."""
    GRASS_LINE_Y = int(321 * (100 - GRASS_CLIP_PCT) / 100)  # = 250
    s = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 321" '
         'preserveAspectRatio="xMidYMax slice">')
    s += ('<defs>'
          '<linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">'
          '<stop offset="0%" stop-color="#7fdcff"/>'
          '<stop offset="55%" stop-color="#a9efff"/>'
          '</linearGradient>'
          '<linearGradient id="grass" x1="0" x2="0" y1="0" y2="1">'
          '<stop offset="0%" stop-color="#39d54b"/>'
          '<stop offset="100%" stop-color="#0e7a1d"/>'
          '</linearGradient>'
          '</defs>')
    s += '<rect x="0" y="0" width="680" height="321" fill="url(#sky)"/>'
    # Back hill — peaks above the grass line, valleys land at it
    s += (f'<path d="M0 {GRASS_LINE_Y-22} q170 -50 340 -8 t340 -16 '
          f'L680 321 L0 321 Z" fill="#1ea03a"/>')
    # Front hill — grass surface, hills CREST AT y=GRASS_LINE_Y
    s += (f'<path d="M0 {GRASS_LINE_Y} q140 -36 280 -4 t340 -8 '
          f'L680 321 L0 321 Z" fill="url(#grass)"/>')
    # Solid grass strip just to seal the line cleanly
    s += (f'<rect x="0" y="{GRASS_LINE_Y}" width="680" height="2" '
          f'fill="#1ea03a" opacity="0.5"/>')
    # Clouds
    for (cx, cy, scale) in [(110, 70, 1.0), (340, 50, 1.3), (560, 80, 0.9)]:
        for (dx, dy, r) in [(-20, 0, 18), (0, -8, 22), (20, 0, 16), (0, 6, 24)]:
            s += (f'<ellipse cx="{cx+dx*scale}" cy="{cy+dy*scale}" '
                  f'rx="{r*scale}" ry="{(r-4)*scale}" fill="#fff"/>')
    # Trees on the back ridge
    for (tx, base_y) in [(80, GRASS_LINE_Y-6), (610, GRASS_LINE_Y-12),
                          (480, GRASS_LINE_Y-4)]:
        s += f'<rect x="{tx-3}" y="{base_y}" width="6" height="22" fill="#4a2a18"/>'
        s += f'<circle cx="{tx}" cy="{base_y-4}" r="20" fill="#2f7a2a"/>'
        s += f'<circle cx="{tx-12}" cy="{base_y+4}" r="14" fill="#2f7a2a"/>'
        s += f'<circle cx="{tx+12}" cy="{base_y+4}" r="14" fill="#2f7a2a"/>'
    s += "</svg>\n"
    return s


def render_backdrop_horror() -> str:
    """Horror backdrop — same composition + grass anchor, dread palette."""
    GRASS_LINE_Y = int(321 * (100 - GRASS_CLIP_PCT) / 100)
    s = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 321" '
         'preserveAspectRatio="xMidYMax slice">')
    s += ('<defs>'
          '<linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">'
          '<stop offset="0%" stop-color="#1a0c1f"/>'
          '<stop offset="55%" stop-color="#3a1a1e"/>'
          '</linearGradient>'
          '<linearGradient id="grass" x1="0" x2="0" y1="0" y2="1">'
          '<stop offset="0%" stop-color="#1f0a14"/>'
          '<stop offset="100%" stop-color="#0a0205"/>'
          '</linearGradient>'
          '</defs>')
    s += '<rect x="0" y="0" width="680" height="321" fill="url(#sky)"/>'
    s += '<circle cx="540" cy="76" r="36" fill="#a4221a"/>'
    s += '<circle cx="540" cy="76" r="36" fill="#5a0a08" opacity="0.55"/>'
    s += (f'<path d="M0 {GRASS_LINE_Y-22} q170 -50 340 -8 t340 -16 '
          f'L680 321 L0 321 Z" fill="#3a0a12"/>')
    s += (f'<path d="M0 {GRASS_LINE_Y} q140 -36 280 -4 t340 -8 '
          f'L680 321 L0 321 Z" fill="url(#grass)"/>')
    for (cx, cy, scale) in [(110, 70, 1.0), (340, 50, 1.3)]:
        for (dx, dy, r) in [(-20, 0, 18), (0, -8, 22), (20, 0, 16), (0, 6, 24)]:
            s += (f'<ellipse cx="{cx+dx*scale}" cy="{cy+dy*scale}" '
                  f'rx="{r*scale}" ry="{(r-4)*scale}" '
                  f'fill="#3a2030" opacity="0.65"/>')
    for (tx, base_y) in [(80, GRASS_LINE_Y-6), (610, GRASS_LINE_Y-12),
                          (480, GRASS_LINE_Y-4)]:
        s += f'<rect x="{tx-2}" y="{base_y-30}" width="4" height="56" fill="#000"/>'
        s += (f'<path d="M{tx} {base_y-30} l-12 -10 M{tx} {base_y-22} l14 -8 '
              f'M{tx} {base_y-12} l-10 -16" '
              f'stroke="#000" stroke-width="2.2" fill="none"/>')
    s += "</svg>\n"
    return s


def render_button(kind: str) -> str:
    """S/M/× button glyphs. Same 200×360 viewBox as character art so
    stage's <img> sizing rules apply uniformly."""
    if kind == "base":
        return svg_doc('<circle cx="100" cy="180" r="64" fill="#26303f" '
                       'stroke="#0a0e16" stroke-width="3"/>')
    if kind == "solo":
        s = ('<circle cx="100" cy="180" r="64" fill="#f7c948" '
             'stroke="#7a5500" stroke-width="3"/>')
        s += ('<path d="M62 178 q38 -52 76 0" stroke="#3a2400" '
              'stroke-width="6" fill="none"/>')
        s += ('<rect x="58" y="170" width="14" height="28" rx="4" fill="#3a2400"/>')
        s += ('<rect x="128" y="170" width="14" height="28" rx="4" fill="#3a2400"/>')
        return svg_doc(s)
    if kind == "mute":
        s = ('<circle cx="100" cy="180" r="64" fill="#d63030" '
             'stroke="#5a0d0d" stroke-width="3"/>')
        s += ('<path d="M68 168 L90 168 L108 152 L108 208 L90 192 L68 192 Z" '
              'fill="#fff" stroke="#5a0d0d" stroke-width="3" stroke-linejoin="round"/>')
        s += '<g stroke="#fff" stroke-width="6" stroke-linecap="round">'
        s += '<line x1="120" y1="166" x2="142" y2="194"/>'
        s += '<line x1="142" y1="166" x2="120" y2="194"/>'
        s += "</g>"
        return svg_doc(s)
    if kind == "remove":
        s = ('<circle cx="100" cy="180" r="64" fill="#3a3f50" '
             'stroke="#0a0e16" stroke-width="3"/>')
        s += '<rect x="74" y="150" width="52" height="10" rx="2" fill="#cfd6e2"/>'
        s += '<rect x="92" y="142" width="16" height="6" rx="2" fill="#cfd6e2"/>'
        s += ('<path d="M76 160 L80 218 L120 218 L124 160 Z" '
              'fill="#cfd6e2" stroke="#0a0e16" stroke-width="2"/>')
        s += '<line x1="88" y1="168" x2="90" y2="210" stroke="#0a0e16" stroke-width="2"/>'
        s += '<line x1="100" y1="168" x2="100" y2="210" stroke="#0a0e16" stroke-width="2"/>'
        s += '<line x1="112" y1="168" x2="110" y2="210" stroke="#0a0e16" stroke-width="2"/>'
        return svg_doc(s)
    return svg_doc("")


# ── svg wrapper ─────────────────────────────────────────────────────
def svg_doc(inner: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {VB_W} {VB_H}" '
            f'preserveAspectRatio="xMidYMax meet">{inner}</svg>\n')


# ── main ────────────────────────────────────────────────────────────
def main() -> None:
    CHAR_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 2,
        "label": "Foyer Originals",
        "source": ("Hand-authored Foyer Originals pack; rebuilt via "
                   "scripts/dev/build-foyer-originals.py."),
        "assetRoot": "",
        "fileNamingNote": ("All file values are pack-relative; served "
                           "at /ui-sprunkadoo/builtin-assets/. Same "
                           "shape as sprunki-assets.json so the consumer "
                           "at sprunki-assets.js handles both manifests "
                           "without conditionals."),
        "categories": {
            "drums":   "Rhythm-section characters (kick, snare, hat, kit, shaker).",
            "bass":    "Low-end character.",
            "melody":  "Tonal characters (piano, organ, music-box, brass, arp, square).",
            "vocal":   "Sung / spoken characters (hey, AI, choirs).",
            "fx":      "Non-pitched effect characters (whistle, glitch, riser).",
            "phantom": "Hidden 'evil' phantom — visible only with scary mode unlocked.",
        },
        "costumeBuckets": {
            "idle":           "Safe resting frame (default mode). One entry per character.",
            "idle_alternate": ("Horror-mode resting frame. Surfaced only when "
                               "scary mode is unlocked + enabled."),
            "play":           "Safe play cycle (3 frames per character).",
            "alternate":      ("Horror-mode play cycle (3 frames per character). "
                               "Surfaced only when scary mode is on."),
            "other":          "Reserved.",
        },
        "characters": [],
        "stage": {
            "backdrop":        "backdrop.svg",
            "backdrop_horror": "backdrop-horror.svg",
        },
        "empty_slot": {
            "file":        "empty.svg",
            "file_horror": "empty-horror.svg",
        },
        "buttons": {
            "base":   "button-base.svg",
            "solo":   "button-solo.svg",
            "mute":   "button-mute.svg",
            "remove": "button-remove.svg",
        },
    }

    for char in CHARACTERS:
        cid, name, cat, role, body, crown_style = char[:6]
        # Safe (default-mode) costumes
        for pose, fname in [
            ("idle",  f"{cid}-idle.svg"),
            ("play1", f"{cid}-play1.svg"),
            ("play2", f"{cid}-play2.svg"),
            ("play3", f"{cid}-play3.svg"),
        ]:
            (CHAR_DIR / fname).write_text(render_character_pose(char, pose))
        # Horror-mode costumes
        for pose, fname in [
            ("idle",  f"{cid}-horror-idle.svg"),
            ("play1", f"{cid}-horror-play1.svg"),
            ("play2", f"{cid}-horror-play2.svg"),
            ("play3", f"{cid}-horror-play3.svg"),
        ]:
            (CHAR_DIR / fname).write_text(
                render_character_pose(char, pose, horror=True))
        (CHAR_DIR / f"{cid}-icon.svg").write_text(render_icon(char))
        (CHAR_DIR / f"{cid}-icon-pressed.svg").write_text(render_icon_pressed(char))
        (CHAR_DIR / f"{cid}-icon-dimmed.svg").write_text(render_icon_dimmed(char))
        manifest["characters"].append({
            "id": cid,
            "displayName": name,
            "category": cat,
            "roleLabel": role,
            "color": body,
            "animation": animation_profile_for(cat),
            "costumes": {
                "idle": [{"name": "idle", "file": f"characters/{cid}-idle.svg"}],
                "idle_alternate": [
                    {"name": "idle2", "file": f"characters/{cid}-horror-idle.svg"},
                ],
                "play": [
                    {"name": "anim",  "file": f"characters/{cid}-play1.svg"},
                    {"name": "anim2", "file": f"characters/{cid}-play2.svg"},
                    {"name": "anim3", "file": f"characters/{cid}-play3.svg"},
                ],
                "alternate": [
                    {"name": "anim_h",  "file": f"characters/{cid}-horror-play1.svg"},
                    {"name": "anim_h2", "file": f"characters/{cid}-horror-play2.svg"},
                    {"name": "anim_h3", "file": f"characters/{cid}-horror-play3.svg"},
                ],
            },
            "icon": {
                "normal":  f"characters/{cid}-icon.svg",
                "pressed": f"characters/{cid}-icon-pressed.svg",
                "dimmed":  f"characters/{cid}-icon-dimmed.svg",
            },
        })

    (OUT / "empty.svg").write_text(render_empty())
    (OUT / "empty-horror.svg").write_text(render_empty_horror())
    (OUT / "backdrop.svg").write_text(render_backdrop())
    (OUT / "backdrop-horror.svg").write_text(render_backdrop_horror())
    (OUT / "button-base.svg").write_text(render_button("base"))
    (OUT / "button-solo.svg").write_text(render_button("solo"))
    (OUT / "button-mute.svg").write_text(render_button("mute"))
    (OUT / "button-remove.svg").write_text(render_button("remove"))

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(CHARACTERS)} characters + shared sprites + "
          f"manifest to {OUT}")


if __name__ == "__main__":
    main()
