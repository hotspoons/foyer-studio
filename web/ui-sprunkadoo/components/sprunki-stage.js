// Sprunki Stage — the free-form 2D performance space.
//
// What makes the sprunkis feel alive:
//   * A blink + look-around loop. Each sprunki cycles through
//     the OG manifest's idle frames at randomized intervals so
//     the cast on stage never freezes into a still image. The
//     timing is staggered per-slot — no two sprunkis blink in
//     unison. (OG sprunki does the same; without this the
//     screen reads as dead even with a great patch picked.)
//   * Idle sway + meter-driven scale + glow. Sway runs whether
//     or not the transport is playing; the meter pulse layers
//     on top once audio starts flowing.
//   * Y-axis = level. The kid raises a sprunki to make them
//     louder (+ bigger) and lowers them to make them quieter
//     (+ smaller). Clamped to a ±15% range so the kid can't
//     accidentally bury everyone off-stage.
//
// Free-form drag with proper grab anchoring (the sprunki moves
// WITH the cursor, not jumping its foot to the cursor) lives in
// `_onPointerDown` / `_onPointerMove`.
//
// Two drop sources:
//   * `application/x-sprunki-patch` — palette tile dragged onto
//     a sprunki (assign patch) or onto empty stage (spawn new
//     sprunki carrying that patch).

import { LitElement, html, css } from "lit";
import { getPatch } from "../patches.js";
import {
  allIdleCostumeUrlsFor,
  allPlayCostumeUrlsFor,
  alternateIdleCostumeUrlsFor,
  allAlternatePlayCostumeUrlsFor,
  emptySprunkiUrl,
  backdropUrl,
  muteButtonUrl,
  animationProfileFor,
  idleVariantsFor,
  ogCharacterById,
} from "../sprunki-assets.js";

// On-stage sprunki size, expressed as PERCENT of the stage
// container so the cast scales with the backdrop. OG sprunki
// reads each character at roughly 14% of stage width and the
// SVG aspect is ~0.55, so 14% × 0.55 → ~25% wide is the
// art-bounding box; clipping handles the lower body. Tuned in
// the 2026-05-25 second design pass after Rich flagged the
// sprunkis as too small + floating above the grass.
const SPRUNKI_W_PCT = 12;       /* % of stage width. 17 → 15 → 12 over three passes; with wide crowns (wizard hat, antennae, rocket-top) the sprunki container's bbox needs room beyond the visible art so it doesn't clip at the stage edge */
const SPRUNKI_ASPECT = 1.82;    /* H/W — taller box so head reads bigger */
const SPRUNKI_H_PCT = SPRUNKI_W_PCT * SPRUNKI_ASPECT;  /* derived height % */

// Fixed stage aspect ratio. OG sprunki ships its backdropcute SVG
// at 680.18×321.69 (~2.115:1); we lock to 2.1:1 so the backdrop
// always fits the host without object-fit cropping at unexpected
// angles. The host scales up/down with the viewport but the
// internal aspect never changes, so the sprunkis (170×310 each)
// keep their relative spacing.
const STAGE_ASPECT = 2.1;

// Two baselines that are deliberately different:
//   * STAGE_BASELINE_Y is the *logical* anchor used by the level
//     math — slot.y == 0.85 means "neutral gain", and the gain /
//     scale ramps run symmetrically around that.
//   * STAGE_VISUAL_BASELINE_Y is the *visual* anchor — where the
//     sprunki's bottom-of-container would sit relative to stage
//     height (0..1). We pin it just past 1.0 and then translate
//     the container down by a fixed CLIP_OFFSET_PX so the lower
//     body falls past the stage bottom and the overflow:hidden
//     on the host crops it. Pixel-precise clip means the visual
//     ratio stays consistent across stage sizes.
const STAGE_BASELINE_Y = 0.85;
const STAGE_VISUAL_BASELINE_Y = 1.0;
const STAGE_LEVEL_RANGE = 0.15;
/** Fraction of the sprunki container that hangs past the stage
 *  bottom — clipped by overflow:hidden so the legs hide behind
 *  the OG SVG's grass hills. Set at 14% (Rich, 2026-05-25:
 *  "needs more of the neck exposed"). The remaining 14% covers
 *  the lower body / hips; necks + chests stay fully visible. */
const SPRUNKI_CLIP_PCT = 14;

/** Drag Y → normalized level in [-1, +1]. Raised → positive,
 *  lowered → negative; clamped at the LEVEL_RANGE limits. */
function levelT(y) {
  const dy = STAGE_BASELINE_Y - y;
  return Math.max(-1, Math.min(1, dy / STAGE_LEVEL_RANGE));
}
/** Y-position → visual scale. Raised = slightly bigger, lowered =
 *  slightly smaller. Tighter range (0.85x .. 1.15x) so the size
 *  change is felt as a "nudge" rather than the previous distracting
 *  ±40% pop. Rich's call 2026-05-25: gain-by-Y is a fine metaphor
 *  but the visual shouldn't dominate. */
function levelScale(y) {
  return 1 + levelT(y) * 0.15;
}
/** Default headroom trim, in dB. The floor any Y-drag is added on
 *  top of. AvlDrums Black Pearl peaks past 0 dBFS on a single hit,
 *  so without a trim a 7-strong cast (4-bar drum loop + bass +
 *  lead + …) keeps the master bus clipping. -15 dB also pushes
 *  the post-hit meter floor lower, which the bounce/frame-advance
 *  transient detector relies on to see the gap between hits. */
export const SLOT_GAIN_FLOOR_DB = -15;
/** Y-position → track gain in dBFS. Exposed so the parent app
 *  can `controlSet` the slot's track gain when the kid moves a
 *  sprunki. Bottom of stage → floor trim; top → floor + 6 dB.
 *  Below baseline ramps faster (slot at the very bottom is
 *  inaudible). */
export function levelDb(y) {
  const t = levelT(y);
  const delta = t >= 0 ? t * 6 : t * 12;
  return SLOT_GAIN_FLOOR_DB + delta;
}
/** Drag Y → on-screen Y. Pointer travel mostly drives size, not
 *  position — the sprunki only nudges a sliver above/below the
 *  visual baseline. The visual baseline is past 100% so the
 *  lower body falls below the stage and gets clipped (matching
 *  OG, where sprunkis hide behind the grass strip from the chest
 *  down). The nudge range is small enough that the head never
 *  leaves the stage and the bottom edge never lifts above it. */
function visualY(y) {
  // levelT > 0 when raised; subtract so a raise lifts the head
  // a sliver, a lower drops it a sliver. Visual baseline is 1.0
  // (container bottom at stage bottom) plus a constant pixel
  // clip-offset handled in CSS, so the visible bottom always
  // falls right at the stage edge / grass line.
  return STAGE_VISUAL_BASELINE_Y - levelT(y) * STAGE_LEVEL_RANGE * 0.10;
}

export class SprunkiStage extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      /* Fixed aspect ratio — the stage scales with viewport but the
         internal aspect never changes, so the OG backdrop SVG sits
         flush with no object-fit jitter and the 7 sprunkis keep
         their relative spacing across viewport sizes. */
      aspect-ratio: ${STAGE_ASPECT} / 1;
      width: 100%;
      max-width: 100%;
      max-height: 100%;
      margin: auto;
      /* Establish a size container so the sprunkis inside can
         size themselves in cqw/cqh against the STAGE dimensions
         (not the .sprunki-main wrapper, which has padding). */
      container-type: size;
      container-name: sprunki-stage;
      /* OG sprunki's backdropcute SVG fills the stage. The SVG
         itself is transparent except for the hill / cloud / character
         shapes — so the gradient here is the *actual* sky and grass
         the OG hills sit on. Colors picked to match the OG palette
         exactly: brightest hill = #00e613, back hill = #00800b,
         cyan accent = #00eaff. Without this match a seam shows
         where the SVG hills meet the gradient. */
      background:
        linear-gradient(180deg,
          #66e6ff 0%,      /* OG sky cyan */
          #88f0ff 45%,     /* horizon glow */
          #00e613 55%,     /* grass — matches OG bright hill */
          #00800b 100%);   /* grass shadow — matches OG back hill */
      border-radius: 10px;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center bottom;
      pointer-events: none;
      z-index: 0;
    }

    .stage-surface {
      position: absolute;
      inset: 0;
      z-index: 1;
    }
    .stage-surface.drag-over {
      box-shadow: inset 0 0 0 3px rgba(255,255,255,0.5);
    }
    /* Brief red flash when a drop lands but the stage is already
       full — visual confirmation that nothing was created. */
    .stage-surface.full-reject {
      animation: full-reject-pulse 480ms ease-out;
    }
    @keyframes full-reject-pulse {
      0%   { box-shadow: inset 0 0 0 4px rgba(255, 80, 80, 0.75); }
      100% { box-shadow: inset 0 0 0 0  rgba(255, 80, 80, 0); }
    }

    .sprunki {
      position: absolute;
      /* % of stage container so the cast scales with the
         backdrop. Width is a fraction of stage width; height
         is derived from the OG SVG aspect ratio
         (taller-than-wide). */
      width: ${SPRUNKI_W_PCT}cqw;
      height: ${SPRUNKI_H_PCT}cqw;
      /* translate-(-50%,-100%) anchors the container's bottom-
         center at the (slot.x, slot.y) point; the extra
         translateY pushes that anchor below the stage by a
         percent of stage height so the lower body always clips
         against overflow:hidden, regardless of stage size. */
      transform: translate(-50%, -100%) translateY(${SPRUNKI_CLIP_PCT}cqh);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      cursor: grab;
      touch-action: none;
    }
    .sprunki.dragging {
      cursor: grabbing;
      z-index: 1000;
    }
    /* z-index follows last-touched. The CSS var --z is updated on
       pointerdown so the kid's last interaction stacks above its
       neighbors — crucial for reaching the send-home X without
       another sprunki overlapping it. Default 1 so a fresh stage
       has predictable order. */
    .sprunki { z-index: var(--z, 1); }
    .sprunki.empty .sprunki-art {
      opacity: 0.78;     /* slightly faded but not ghostly — they're
                            still alive characters on stage, just
                            without a sound assigned yet */
      filter: saturate(0.55) brightness(0.95);
    }
    /* Empty slots render as a plain <img> like the costumed cast.
       Idle blink + look-around come from the same per-slot variant
       scheduler — see _tickIdleSlot — which swaps the img src
       between empty.svg / empty-idle-blink.svg / empty-idle-look-*.
       Hard sprite swaps, no inline SVG, no CSS keyframes. */
    .sprunki.drop-target .sprunki-art {
      animation: pop 200ms ease-out;
    }
    @keyframes pop {
      from { transform: scale(0.92); }
      to   { transform: scale(1.06); }
    }

    .sprunki-art {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      /* Anchor scale around the visible bottom of the character
         — the spot where the body emerges from the grass after
         the container's lower clip. The clipped band is a fixed
         percent of stage height; in CONTAINER UNITS that maps to
         the same percent of the sprunki's own height because the
         container is sized off the same stage. Anchor at
         (100% - clip%) keeps the visible-bottom planted on scale
         changes. */
      transform-origin: center calc(100% - ${SPRUNKI_CLIP_PCT}cqh);
      /* Scale is set ONCE by the slot's y-position via --level-scale;
         no meter-driven scale interpolation. The previous formula
         multiplied by (1 + meter * 0.06) which inherited audio-meter
         noise from the 30 Hz meter stream, causing constant micro-
         vibration at idle even though the meter wasn't above the
         transient threshold. The brightness/halo retain the meter
         coupling (low magnitude, visually graceful). */
      transform: scale(var(--level-scale, 1));
      filter: brightness(calc(1 + var(--meter, 0) * 0.18))
              drop-shadow(0 0 calc(var(--meter, 0) * 8px)
                           color-mix(in srgb, var(--cc, #fff) 80%, transparent));
      transition: filter 60ms ease-out;
      pointer-events: none;
    }
    /* No body-level animation at all. "Looking alive" comes from
       the JS-driven per-slot blink + look-around scheduler that
       swaps the idle <img src>. Music-time reactions are a brief
       FACE TWITCH (variant swap to blink / look-left / look-right)
       on each step — not a body translate. The previous
       hit-bob/sway/look keyframes were translating the whole body
       through left/right/up poses, which Rich called "Terrance
       and Phillip" — gone now. */
    /* Inner body layer — receives the per-character idle motion +
       on-hit reaction. Layered inside .sprunki-art so the outer
       layer can still hold the meter-driven scale/halo without
       fighting with the kinetic animations. transform-origin
       pinned to the visible feet so a vertical bob/horizontal
       sway never lifts the character off the grass line. */
    .sprunki-body {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      transform-origin: center calc(100% - ${SPRUNKI_CLIP_PCT}cqh);
    }
    .sprunki-art img {
      /* Full character visible, contained to the box; the (x, y)
         anchor lands the sprunki's feet just above the grass
         line so the lower-body "stands in" the grass strip. */
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center bottom;
    }
    /* No-art fallback chip — colored circle keyed to the patch
       accent with the label's first letter. Shown only when the
       OG asset pack hasn't resolved (or isn't installed). */
    .sprunki-chip {
      width: 110px;
      height: 110px;
      border-radius: 999px;
      background: var(--cc, #888);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 44px system-ui, sans-serif;
      line-height: 1;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35),
                  inset 0 0 0 2px rgba(255,255,255,0.18);
      text-shadow: 0 1px 2px rgba(0,0,0,0.4);
    }

    /* S / M / × ribbon — OG sprunki has these as a 3-up pill of
       SVG icons sitting on top of each on-stage character. We
       use the OG asset pack's Mute Buttons costumes directly
       (solo = headphones, mute = speaker-X, remove = trash X)
       so the visual language matches the source game exactly.
       The buttons live INSIDE the .sprunki container so
       pointer-down on a button doesn't propagate to the drag
       handler. */
    .ribbon {
      position: absolute;
      bottom: 6px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 3px;
      padding: 3px 5px;
      border-radius: 12px;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      opacity: 0.92;
      transition: opacity 120ms ease;
      z-index: 3;
      pointer-events: auto;
    }
    .sprunki:hover .ribbon { opacity: 1; }
    .ribbon button {
      width: 22px; height: 22px;
      border: none;
      border-radius: 999px;
      background: transparent;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 100ms ease, transform 100ms ease;
    }
    .ribbon button img {
      width: 18px;
      height: 18px;
      pointer-events: none;
      filter: drop-shadow(0 1px 1px rgba(0,0,0,0.4));
    }
    .ribbon button:hover { background: rgba(255,255,255,0.18); transform: translateY(-1px); }
    .ribbon button.active.solo { background: rgba(247,201,72,0.85); }
    .ribbon button.active.mute { background: rgba(214,48,49,0.85); }
    /* Fallback glyphs for the moments before the asset pack is
       resolved or when it's unavailable. */
    .ribbon .glyph {
      font-size: 11px;
      font-weight: 800;
      color: #fff;
      letter-spacing: 0.03em;
    }

    /* Send-home red X — top-right corner of each costumed sprunki.
       Replaces the prior drag-down-to-palette gesture (which kids
       triggered accidentally while reaching to drag a sprunki for
       volume). Hidden by default, fades in on sprunki hover. Click
       drops the costume; the slot returns to empty Polo. Sized big
       enough to read on touch screens. */
    .send-home {
      position: absolute;
      /* Pull in from the corner — the OG hover target was sitting on
         the absolute edge of the sprunki container, which on a
         scaled-up (volume drag) sprunki put it right at the bobbing
         edge of the hover region. With these inset values the X
         lives a comfortable ~14% in from each edge so the cursor
         can sit inside the body and still trigger hover. */
      top: 14%;
      right: 14%;
      width: 32px;
      height: 32px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.85);
      background: #e54d3a;
      color: #fff;
      font: 800 16px/1 system-ui, sans-serif;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
      opacity: 0;
      pointer-events: none;
      transform: scale(0.7);
      transition: opacity 120ms ease, transform 120ms ease;
      z-index: 4;
      padding: 0;
      user-select: none;
      -webkit-user-select: none;
    }
    /* Invisible hit-shim around the button. Lets the kid hit the
       X even if their cursor undershoots by a few pixels — common
       on touchscreens and during a wobbling sprunki sway. */
    .send-home::before {
      content: "";
      position: absolute;
      inset: -10px;
      border-radius: 999px;
    }
    .sprunki:hover .send-home,
    .sprunki:focus-within .send-home {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    .send-home:hover { background: #c33a28; transform: scale(1.12); }
    .send-home:active { transform: scale(0.94); }

    /* Solo halo + mute fade — visual confirmation that S/M is
       engaged on a sprunki (DAW says so via control_update). */
    .sprunki.is-solo .sprunki-art {
      filter: brightness(1.15)
              drop-shadow(0 0 12px rgba(247,201,72,0.7));
    }
    .sprunki.is-muted .sprunki-art {
      opacity: 0.35;
      filter: grayscale(0.7);
    }
  `;

  static properties = {
    slots: { type: Array },
    assetsReady: { type: Boolean },
    /** Per-slot `{ muted: bool, solo: bool }`. Updated from the
     *  parent app on control_update events for the slot's track. */
    slotControls: { type: Object },
    /** True when scaryMode is unlocked. App pushes this down so the
     *  stage can swap to horror-variant costumes + backdrop + empty
     *  Polo. Gated server-side by parental unlock — by the time it
     *  arrives here the kid has already passed the gate. */
    scaryMode: { type: Boolean },
    /** Active arrangement / pattern id — used to pick which board
     *  out of `slot.boards` is currently playing so the per-slot
     *  step-fire detector knows which cell grid to watch. */
    activeArrangementId: { type: String },
    _dragSlotId: { state: true },
    _dropTargetId: { state: true },
    _dragOver: { state: true },
    /** Per-slot current idle-frame index — bumped by the idle
     *  cycler so Lit re-renders the right `<img src>`. */
    _idleFrameIdx: { type: Object, state: true },
  };

  constructor() {
    super();
    this.slots = [];
    this.assetsReady = false;
    this.slotControls = {};
    this.scaryMode = false;
    this.activeArrangementId = null;
    this._lastFiredStep = {};  // slotId → last sequencer step we triggered a hit for
    this._dragSlotId = null;
    this._dropTargetId = null;
    this._dragOver = false;
    this._playFrameIdx = {};        // slotId → current play frame (costumed)
    this._slotActiveUntil = {};     // slotId → ts (perf.now) until we revert to idle
    this._levels = {};
    this._animTimer = null;         // 80 ms animation tick — drives BPM-clock fallback frame advance
    this._idleAction = {};          // slotId → "blink"|"look-left"|"look-right"|null
    this._idleTimers = {};          // slotId → setTimeout handle for next idle action
    this._idleEndTimers = {};       // slotId → setTimeout handle for clearing current action
    this._zCounter = 1;             // monotonic stacking counter; incremented per pointerdown
    this._slotZ = {};               // slotId → z-index assigned when last touched
  }

  connectedCallback() {
    super.connectedCallback();
    this._startAnimationTick();
    this._startIdleSchedulers();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopAnimationTick();
    this._stopIdleSchedulers();
  }
  updated(changed) {
    super.updated?.(changed);
    if (changed.has("slots") || changed.has("assetsReady")) {
      this._reconcileIdleSchedulers();
    }
  }

  // ── per-slot idle scheduler ────────────────────────────────────────
  //
  // While a sprunki has no audio peaks of its own (silent transport,
  // empty board, between drum hits), it cycles through three idle
  // gaze variants — blink, look-left, look-right — on a randomized
  // per-slot timer so the cast stays alive without ever moving in
  // unison.
  //
  // Each slot's next-action time is drawn fresh from a [2, 7] second
  // band whenever its current action ends, so adjacent slots stay
  // permanently out of phase. The action itself is held briefly
  // (180 ms for blink, 600 ms for a look) before reverting to the
  // resting idle frame.
  _startIdleSchedulers() {
    this._reconcileIdleSchedulers();
  }
  _stopIdleSchedulers() {
    for (const id of Object.keys(this._idleTimers))
      clearTimeout(this._idleTimers[id]);
    for (const id of Object.keys(this._idleEndTimers))
      clearTimeout(this._idleEndTimers[id]);
    this._idleTimers = {};
    this._idleEndTimers = {};
  }
  _reconcileIdleSchedulers() {
    const liveIds = new Set((this.slots || []).map((s) => s.id));
    // Cancel timers for slots that no longer exist.
    for (const id of Object.keys(this._idleTimers)) {
      if (!liveIds.has(id)) {
        clearTimeout(this._idleTimers[id]);
        delete this._idleTimers[id];
        delete this._idleAction[id];
      }
    }
    // Seed timers for new slots — staggered first-fire so the first
    // round of blinks is already spread out.
    for (const slot of (this.slots || [])) {
      if (this._idleTimers[slot.id]) continue;
      const initialDelay = 1500 + Math.random() * 4000;
      this._idleTimers[slot.id] = setTimeout(
        () => this._tickIdleSlot(slot.id), initialDelay,
      );
    }
  }
  _tickIdleSlot(slotId) {
    const slot = (this.slots || []).find((s) => s.id === slotId);
    if (!slot) return;
    // Only fire idle gaze changes if the slot is NOT currently in a
    // play-frame burst from an audio peak — that path owns the look
    // for ACTIVE_HOLD_MS after each hit.
    const now = performance.now();
    const playingUntil = this._slotActiveUntil[slotId] || 0;
    const skip = playingUntil > now;
    if (!skip) {
      // Pick the next action with a bias toward blinks (most common).
      const r = Math.random();
      const action = r < 0.55 ? "blink"
                   : r < 0.78 ? "look-left"
                   : "look-right";
      this._idleAction[slotId] = action;
      this.requestUpdate();
      const holdMs = action === "blink" ? 180 : 600;
      clearTimeout(this._idleEndTimers[slotId]);
      this._idleEndTimers[slotId] = setTimeout(() => {
        this._idleAction[slotId] = null;
        this.requestUpdate();
      }, holdMs);
    }
    // Schedule the next idle action; band randomized per call so no
    // two slots fall into lockstep.
    const nextDelay = 2000 + Math.random() * 5000;
    this._idleTimers[slotId] = setTimeout(
      () => this._tickIdleSlot(slotId), nextDelay,
    );
  }

  // ── animation tick ──────────────────────────────────────────────
  // Behavior model (per the 2026-05-25 research pass into the OG
  // Scratch project's animation blocks):
  //
  //   * GRAY (empty slot) — continuously cycles through GRAY's play
  //     frames (anim/anim2…anim11 in OG = 11 frames) at ~180 ms
  //     intervals. This is the "alive but waiting" look the OG
  //     game has on every uninhabited Polo. Without this the
  //     empty slots freeze solid and read as dead pixels.
  //
  //   * COSTUMED (patch assigned) — advance ONE play frame per
  //     audio transient on the slot's own track. NOT a continuous
  //     cycle. OG fires its "Loop 1/2" broadcast on each sampled
  //     hit, which the character's frame-step block consumes once.
  //     Cross-talk from other tracks doesn't move this character's
  //     frame; only its own audio.
  //
  // Combined with `updateLevels` (which detects transients via
  // delta-on-intensity), this gives the OG-like "each character
  // dances on its own beats" feel.
  //
  // BACKSTOP: when the audio engine is silent or glitchy (e.g.
  // fluidsynth missing a preset, region hasn't loaded yet, mute
  // engaged) the meter-driven path produces nothing visible — but
  // the kid still wants to see their sprunkis move. We advance
  // every costumed slot ONCE PER BAR off the BPM clock so the
  // cast keeps dancing even with no audio. This is a separate
  // ticker that runs only when transport.playing && nothing has
  // bumped the slot's frame for `BPM_TICK_FALLBACK_MS` — so live
  // meters always win.
  static get ACTIVE_THRESHOLD_DB() { return -38; }
  static get ACTIVE_HOLD_MS() { return 250; }   // freeze-on-play-frame hold after a hit
  static get BPM_TICK_FALLBACK_MS() { return 600; }  // how long without a meter hit before BPM ticks step in
  /** Minimum gap between consecutive hit-animation triggers on the
   *  same slot. Keeps the CSS keyframe from being re-restarted
   *  inside its own running window, which would otherwise read as
   *  rapid vibration rather than discrete dance beats. Tuned to
   *  longer than the longest hit-keyframe (360 ms) plus a small
   *  safety margin. */
  static get HIT_REFRACTORY_MS() { return 420; }
  /** Below this dB the slot is treated as silent for animation
   *  purposes — the BPM tick won't bounce or advance the frame.
   *  Keeps populated sprunkis still when transport is rolling but
   *  the slot has no audible output (empty boards, on-pattern silence
   *  between hits, etc.). Bug from 2026-05-26: populated sprunkis
   *  twitched per beat even with no music coming out. */
  static get SILENT_FLOOR_DB() { return -50; }

  _startAnimationTick() {
    if (this._animTimer) return;
    this._animTimer = setInterval(() => this._animTick(), 80);
  }
  _stopAnimationTick() {
    if (this._animTimer) clearInterval(this._animTimer);
    this._animTimer = null;
  }
  _animTick() {
    const now = performance.now();
    // Hit reactions fire from TWO independent per-slot sources:
    //
    //   1. Audio-peak transients (live engine) — `updateLevels`.
    //   2. Sequencer step-fires (works in stub mode too) — here.
    //
    // The sequencer driver checks the active pattern for each
    // costumed slot, computes the current 16th-note step from
    // transport.position, and fires a hit when the slot's pattern
    // has a cell on the step we haven't fired yet. Each slot's
    // pattern is unique, so the cast naturally syncopates — drums
    // on their hit pattern, bass on theirs, etc. — no unison.
    // _fireHit's refractory window prevents over-trigger from
    // dense patterns (16ths on every step).
    this._fireSequencerSteps(now);
    if (this._needsRenderForExpiry(now)) this.requestUpdate();
  }

  /** Per-slot MIDI/sequencer step driver. Walks each costumed
   *  slot's active board and fires a hit when the transport's
   *  current 16th-note step crosses a cell we haven't fired yet.
   *  No-op when transport isn't rolling or the active arrangement
   *  isn't seeded — the audio-meter path remains the canonical
   *  driver when the live engine is producing real peaks. */
  _fireSequencerSteps(_now) {
    const f = globalThis.__foyer;
    const playing = !!f?.store?.get?.("transport.playing");
    if (!playing) {
      this._lastFiredStep = {};
      return;
    }
    const bpm = Number(f?.store?.get?.("transport.tempo")) || 120;
    const sr = Number(f?.store?.get?.("audio.sample_rate")) || 48000;
    const pos = Number(f?.store?.get?.("transport.position")) || 0;
    // Steps-per-second at 16th-note resolution (DEFAULT_RESOLUTION=4 → 4 steps/beat).
    const samplesPerStep = (60 / bpm) * sr / 4;
    if (!Number.isFinite(samplesPerStep) || samplesPerStep <= 0) return;
    const currentStep = Math.floor(pos / samplesPerStep);
    const activeKey = this.activeArrangementId;
    for (const slot of (this.slots || [])) {
      if (!slot.patch_id) continue;
      const board = activeKey
        ? slot.boards?.[activeKey]
        : (slot.boards && slot.boards[Object.keys(slot.boards)[0]]);
      if (!board) continue;
      // Pattern length: bar-aligned (1 bar = 16 steps at the
      // sprunkadoo resolution). We pick the smallest multiple of 16
      // that contains every cell on this slot's board, so the
      // sprunki's dance cycle stays aligned to the sequencer's
      // pattern playback. Empty board → default to one bar (16).
      let maxStep = 0;
      for (const rowId of Object.keys(board)) {
        const steps = board[rowId];
        if (!Array.isArray(steps)) continue;
        for (const s of steps) if (s > maxStep) maxStep = s;
      }
      const STEPS_PER_BAR = 16;
      const patternSteps = Math.max(
        STEPS_PER_BAR,
        Math.ceil((maxStep + 1) / STEPS_PER_BAR) * STEPS_PER_BAR,
      );
      const stepInPattern = ((currentStep % patternSteps) + patternSteps) % patternSteps;
      if (this._lastFiredStep[slot.id] === stepInPattern) continue;
      // Does ANY row of this slot's pattern fire on this step?
      let fires = false;
      for (const rowId of Object.keys(board)) {
        const steps = board[rowId];
        if (!Array.isArray(steps)) continue;
        if (steps.includes(stepInPattern)) { fires = true; break; }
      }
      this._lastFiredStep[slot.id] = stepInPattern;
      if (fires) this._triggerHit(slot.id);
    }
  }

  /** Single hit reaction: brief FACE TWITCH on the slot. Swaps the
   *  idle gaze variant to "blink" (60 %), "look-left" (20 %) or
   *  "look-right" (20 %) for ~140 ms then reverts. No body
   *  translate, no play-frame swap, no CSS keyframe — just an eye
   *  flicker matching the OG "characters react to their own
   *  track" behavior.
   *  Guarded by HIT_REFRACTORY_MS so dense patterns (16ths every
   *  step) don't restart the twitch faster than the eye can read. */
  _triggerHit(slotId) {
    const now = performance.now();
    this._hitFiredAt ??= {};
    if (this._hitFiredAt[slotId] &&
        now - this._hitFiredAt[slotId] < SprunkiStage.HIT_REFRACTORY_MS) {
      return;
    }
    this._hitFiredAt[slotId] = now;
    const r = Math.random();
    const action = r < 0.6 ? "blink"
                 : r < 0.8 ? "look-left"
                 : "look-right";
    this._idleAction[slotId] = action;
    this.requestUpdate();
    clearTimeout(this._idleEndTimers[slotId]);
    this._idleEndTimers[slotId] = setTimeout(() => {
      this._idleAction[slotId] = null;
      this.requestUpdate();
    }, action === "blink" ? 140 : 220);
  }

  /** Quarter-note beat index from transport.position, or null when
   *  the transport isn't rolling. Locked to position (not wall
   *  clock) so the cast lines up with the audible playhead even
   *  if the JS event loop hiccups. Falls back to 120 BPM / 48 kHz
   *  if the foyer-core clock isn't available. */
  _bpmTickBeatIdx(_now) {
    const f = globalThis.__foyer;
    const playing = !!f?.store?.get?.("transport.playing");
    if (!playing) return null;
    const bpm = Number(f?.store?.get?.("transport.tempo")) || 120;
    const sr = Number(f?.store?.get?.("audio.sample_rate")) || 48000;
    const pos = Number(f?.store?.get?.("transport.position")) || 0;
    const samplesPerBeat = (60 / bpm) * sr;
    return Math.floor(pos / samplesPerBeat);
  }

  /** Per-category beat phase for the BPM-clock fallback. Returns
   *  `{ period, offset }` so the fallback fires on
   *  `beatIdx % period === offset`. Tuned so the cast NEVER hits
   *  the same beat together — drums on quarters with offsets that
   *  cycle per slot index, melody/bass on half-time, vocal/fx on
   *  fourth-note offsets. */
  _beatPhaseFor(category, slotIndex) {
    switch (category) {
      case "drums":
        // Quarter pulses, but offset per slot so two drum sprunkis
        // never bounce on the same beat (kick on 1+3, snare on 2+4
        // type pattern — emergent from offsets, not hardcoded).
        return { period: 2, offset: slotIndex % 2 };
      case "bass":
        // Half-time, anchored to beat 1.
        return { period: 4, offset: (slotIndex % 4) };
      case "melody":
        return { period: 4, offset: (slotIndex % 4) };
      case "vocal":
        return { period: 8, offset: (slotIndex % 8) };
      case "fx":
        return { period: 6, offset: (slotIndex % 6) };
      default:
        return { period: 4, offset: slotIndex % 4 };
    }
  }
  _needsRenderForExpiry(now) {
    for (const slotId in this._slotActiveUntil) {
      const t = this._slotActiveUntil[slotId];
      if (t && t <= now && now - t < 100) return true;
    }
    return false;
  }

  /** Per-slot dB envelopes from the WS meter_batch. Drives a
   *  *fast-decay* CSS `--meter` pulse on each sprunki — bright +
   *  large at the moment of a hit, fading back to neutral over
   *  the next ~300 ms even if the audio meter sustains high.
   *  Ardour's PeakMeter has a built-in falloff that's too gentle
   *  for kid-facing visual feedback (drums look pumped-up for
   *  500 ms after a single hit, then the next hit can't show a
   *  rising edge because the meter is still high). The
   *  client-side envelope here strictly tracks rises but decays
   *  faster than the source so each beat shows a fresh bump.
   *  Bounce + play-frame advance now run from the BPM clock in
   *  `_animTick` (more reliable than delta-on-intensity); this
   *  function exists for the continuous glow/scale visual. */
  updateLevels(bySlot) {
    this._levels = bySlot || {};
    const root = this.renderRoot;
    if (!root) return;
    this._displayedMeter ??= {};
    // Index slots by id so we can gate meter feedback on patch
    // presence — an empty/gray slot must NOT pulse from a phantom
    // signal even if the track underneath is still emitting. Bug
    // from 2026-05-26: cleared sprunkis twitched up and down even
    // with no music playing, because the slot's old track was
    // still feeding meter dB into here.
    const slotById = new Map((this.slots || []).map((s) => [s.id, s]));
    for (const [slotId, db] of Object.entries(this._levels)) {
      const slot = slotById.get(slotId);
      const el = root.querySelector(`[data-slot="${slotId}"] .sprunki-art`);
      if (!el) continue;
      if (!slot?.patch_id) {
        // Empty slot — force the displayed meter to 0 so any held
        // value from before the clear decays away immediately, and
        // skip the rising-edge update entirely.
        if (this._displayedMeter[slotId] !== 0) {
          this._displayedMeter[slotId] = 0;
          el.style.setProperty("--meter", "0");
        }
        continue;
      }
      // -60 dB → 0, +6 dB → 1. AvlDrums Black Pearl peaks past
      // 0 dBFS on a single hit, so we leave headroom above 0.
      const lin = Math.max(0, Math.min(1, (db + 60) / 66));
      const intensity = Math.pow(lin, 1.4);
      // Fast-attack, fast-release envelope. Rises immediately to
      // the new value; falls 12% of remaining gap per ~33 ms tick
      // (the meter rate). At 30 Hz a held high settles to <0.05
      // in ~600 ms, fast enough to see each beat as a fresh pulse.
      const prev = this._displayedMeter[slotId] ?? 0;
      const next = intensity > prev ? intensity : prev * 0.88;
      this._displayedMeter[slotId] = next;
      el.style.setProperty("--meter", next.toFixed(3));
      // Rising-edge transient detection — fires the per-character
      // hit animation only on THIS slot. Threshold tuned permissive
      // enough to dance on real drum hits but loose enough that
      // small meter wobbles don't retrigger. The HIT_REFRACTORY_MS
      // guard in _fireHit is the real safety net.
      if (intensity > prev + 0.20 && intensity > 0.25) {
        this._triggerHit(slotId);
      }
    }
  }

  // (The original delta-on-intensity transient detector lived
  // here. Retired 2026-05-25 in favor of the BPM-clocked beat
  // tick in `_animTick` — Ardour's PeakMeter sustains too long
  // between drum hits for delta-detection to fire reliably, so
  // the beat clock is the better signal for kid-facing visual
  // feedback.)

  // ── pointer drag (sprunkis around the stage) ──────────────────
  //
  // Listeners attach to WINDOW, not the sprunki div, so a Lit re-
  // render during the drag (each stage-move dispatch can trigger
  // one) doesn't disconnect the captured element and strand the
  // pointerup. Bug from 2026-05-26: sprunki kept following the
  // pointer after the kid released the mouse button because the
  // dragged element had been recreated mid-drag and the original
  // pointerup listener was on the disposed instance.
  _onPointerDown(e, slot) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.closest?.(".send-home, .ribbon")) return;
    // Defensive: if a previous drag never cleaned up (browser ate
    // the pointerup) the cleanup function survives; run it now so
    // this new gesture starts fresh.
    if (this._dragCleanup) this._dragCleanup();
    // Bring the touched sprunki to the top of the stack so its
    // send-home X isn't occluded by neighbors. Monotonic counter
    // means the most recently touched always wins.
    this._slotZ[slot.id] = ++this._zCounter;
    this.requestUpdate();
    e.preventDefault();
    e.stopPropagation();
    this._dragSlotId = slot.id;
    this._dragSlot = slot;
    this._dragPointerId = e.pointerId;
    this._dragStartClientX = e.clientX;
    this._dragStartClientY = e.clientY;
    this._dragMoved = false;
    // Grab anchor: capture the delta between where the pointer
    // landed and the slot's logical (x, y). On move we add that
    // back so the sprunki tracks the cursor naturally instead of
    // jumping its foot to the cursor (which made them shoot up
    // off-screen).
    const stage = this.renderRoot.querySelector(".stage-surface");
    if (stage) {
      const rect = stage.getBoundingClientRect();
      const clickXn = (e.clientX - rect.left) / rect.width;
      const clickYn = (e.clientY - rect.top) / rect.height;
      this._dragGrabDx = slot.x - clickXn;
      this._dragGrabDy = slot.y - clickYn;
    } else {
      this._dragGrabDx = 0;
      this._dragGrabDy = 0;
    }
    const onMove = (ev) => {
      // Belt-and-suspenders: if the browser missed the pointerup
      // (focus change, popup, etc.) the next move arrives with
      // buttons === 0. Treat that as an implicit release.
      if (ev.buttons === 0 && ev.pointerType === "mouse") {
        endDrag(ev);
        return;
      }
      this._onPointerMove(ev);
    };
    const endDrag = (ev) => this._onPointerUp(ev, slot);
    const onBlur = () => this._onPointerUp(null, slot);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", onBlur);
    this._dragCleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", onBlur);
      this._dragCleanup = null;
    };
  }
  _onPointerMove(e) {
    if (this._dragSlotId == null) return;
    const stage = this.renderRoot.querySelector(".stage-surface");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const pointerXn = (e.clientX - rect.left) / rect.width;
    const pointerYn = (e.clientY - rect.top) / rect.height;
    const x = pointerXn + (this._dragGrabDx || 0);
    const y = pointerYn + (this._dragGrabDy || 0);
    const dx = Math.abs(e.clientX - this._dragStartClientX);
    const dy = Math.abs(e.clientY - this._dragStartClientY);
    if (!this._dragMoved && (dx > 4 || dy > 4)) this._dragMoved = true;
    this.dispatchEvent(new CustomEvent("stage-move", {
      detail: { slotId: this._dragSlotId, x, y },
      bubbles: true, composed: true,
    }));
  }
  _onPointerUp(e, slot) {
    if (this._dragSlotId == null) return;
    const wasMoved = this._dragMoved;
    this._dragSlotId = null;
    this._dragSlot = null;
    this._dragPointerId = null;
    this._dragMoved = false;
    if (this._dragCleanup) this._dragCleanup();
    // Drag-to-palette retired 2026-05-25 (Rich's call). The
    // costume-corner red-X badge handles "send back to drawer"
    // explicitly so kids don't trigger a clear by accident while
    // moving a sprunki around for volume. Only the click-to-open
    // and pure position-update gestures remain here.
    if (!wasMoved && slot.patch_id) {
      this.dispatchEvent(new CustomEvent("stage-click-slot", {
        detail: { slotId: slot.id },
        bubbles: true, composed: true,
      }));
    }
  }

  // ── HTML5 DnD drop from the patch palette ─────────────────────
  _onDragOver(e) {
    if (!e.dataTransfer?.types.includes("application/x-sprunki-patch")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    this._dragOver = true;
    const slotEl = e.target.closest?.("[data-slot]");
    this._dropTargetId = slotEl?.dataset.slot || null;
  }
  _onDragLeave() {
    this._dragOver = false;
    this._dropTargetId = null;
  }
  _onDrop(e) {
    e.preventDefault();
    const patchId = e.dataTransfer?.getData("application/x-sprunki-patch");
    if (!patchId) return;
    const surface = this.renderRoot.querySelector(".stage-surface");
    if (this._dropTargetId) {
      // Drop landed on an existing sprunki — assign the patch.
      this.dispatchEvent(new CustomEvent("stage-assign-patch", {
        detail: { slotId: this._dropTargetId, patchId },
        bubbles: true, composed: true,
      }));
    } else {
      // Bare-stage drop is invalid — the cast is fixed at 7
      // performers. The kid has to drop the costume directly
      // onto someone (a gray empty Polo is a valid target).
      // Flash the stage border so the no-op is visible.
      surface.classList.remove("full-reject");
      void surface.offsetWidth;
      surface.classList.add("full-reject");
      setTimeout(() => surface.classList.remove("full-reject"), 500);
    }
    this._dragOver = false;
    this._dropTargetId = null;
  }

  _onClear(e, slot) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("stage-clear", {
      detail: { slotId: slot.id },
      bubbles: true, composed: true,
    }));
  }
  _onSolo(e, slot) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("stage-toggle-solo", {
      detail: { slotId: slot.id },
      bubbles: true, composed: true,
    }));
  }
  _onMute(e, slot) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("stage-toggle-mute", {
      detail: { slotId: slot.id },
      bubbles: true, composed: true,
    }));
  }
  _onRemove(e, slot) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("stage-remove-slot", {
      detail: { slotId: slot.id },
      bubbles: true, composed: true,
    }));
  }

  /** Resolve the right SVG URL for a slot in the current frame.
   *  Modes (in order, per the OG project's animation logic):
   *   - empty slot              → CYCLE gray's anim frames continuously
   *                                (the "alive but waiting" idle the
   *                                empty Polos have in OG)
   *   - audio-active            → current play frame (frozen on the
   *                                step we last advanced to on a hit)
   *   - idle                    → patch's resting idle frame */
  _currentIdleUrl(slot) {
    if (!this.assetsReady) return null;
    const scary = !!this.scaryMode;
    const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
    if (!patch) {
      // Empty slot — cycles through the same idle-gaze variants as
      // the costumed cast (blink / look-left / look-right) via the
      // _idleAction map populated by _tickIdleSlot. No inline SVG /
      // CSS animation: hard sprite swap, single source of truth in
      // build-foyer-originals.py's render_empty(gaze=...).
      const emptyGaze = !scary ? (this._idleAction?.[slot.id] || null) : null;
      return emptySprunkiUrl({ scary, gaze: emptyGaze });
    }
    // No play-frame cycling — the OG play1/play2/play3 poses were
    // big body lean/jump frames that read as "Terrance and Phillip"
    // bobbing left/right/up. The on-beat reaction now lives entirely
    // in the idle gaze variant (face twitch via _triggerHit) so the
    // body stays planted and only the face responds to music.
    // The per-slot scheduler may have flipped this slot into one of
    // the idle gaze variants (blink / look-left / look-right) — honor
    // that. Falls back to the base idle frame.
    const idleAction = !scary ? this._idleAction?.[slot.id] : null;
    if (idleAction) {
      const variants = idleVariantsFor(patch.sprunki_id);
      const url = (
        idleAction === "blink"      ? variants.blink :
        idleAction === "look-left"  ? variants.lookLeft :
        idleAction === "look-right" ? variants.lookRight : null
      );
      if (url) return url;
    }
    const idle = scary
      ? (alternateIdleCostumeUrlsFor(patch.sprunki_id).length
          ? alternateIdleCostumeUrlsFor(patch.sprunki_id)
          : allIdleCostumeUrlsFor(patch.sprunki_id))
      : allIdleCostumeUrlsFor(patch.sprunki_id);
    return idle[0] || null;
  }

  _renderRibbonButton(kind, isActive, label, handler) {
    const url = this.assetsReady ? muteButtonUrl(kind) : null;
    const glyph = kind === "solo" ? "S" : kind === "mute" ? "M" : "×";
    return html`
      <button class=${`${kind} ${isActive ? "active" : ""}`}
              title=${label}
              @click=${handler}>
        ${url
          ? html`<img src=${url} alt=${label} draggable="false" />`
          : html`<span class="glyph">${glyph}</span>`}
      </button>
    `;
  }

  _renderSprunki(slot, idx) {
    const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
    const isEmpty = !patch;
    const isDrop = this._dropTargetId === slot.id;
    const isDragging = this._dragSlotId === slot.id;
    const swayDelay = `${(idx * 0.41) % 2}s`;
    const ccColor = patch?.color || "#888";
    const left = `${(slot.x * 100).toFixed(2)}%`;
    const top  = `${(visualY(slot.y) * 100).toFixed(2)}%`;
    const scale = levelScale(slot.y).toFixed(3);
    const url = this._currentIdleUrl(slot);
    const controls = this.slotControls?.[slot.id] || {};
    const isSolo = !!controls.solo;
    const isMuted = !!controls.muted;
    const animKind = patch?.sprunki_id
      ? (animationProfileFor(patch.sprunki_id)?.kind || "bob")
      : "bob";
    return html`
      <div
        class="sprunki ${isEmpty ? "empty" : ""} ${isDrop ? "drop-target" : ""} ${isDragging ? "dragging" : ""} ${isSolo ? "is-solo" : ""} ${isMuted ? "is-muted" : ""}"
        data-slot=${slot.id}
        style="left:${left};top:${top};--cc:${ccColor};--sway-delay:${swayDelay};--level-scale:${scale};--z:${this._slotZ[slot.id] || (idx + 1)};"
        @pointerdown=${(e) => this._onPointerDown(e, slot)}
      >
        <div class="sprunki-art" data-anim-kind=${animKind}>
          <div class="sprunki-body">
          ${url
            ? html`<img src=${url} alt=${patch?.label || ""} draggable="false" />`
            : html`<span class="sprunki-chip">${((patch?.label) || "·").charAt(0).toUpperCase()}</span>`}
          </div>
        </div>
        ${patch ? html`
          <div class="ribbon" @pointerdown=${(e) => e.stopPropagation()}>
            ${this._renderRibbonButton("solo", isSolo, "Solo this sprunki", (e) => this._onSolo(e, slot))}
            ${this._renderRibbonButton("mute", isMuted, "Mute this sprunki", (e) => this._onMute(e, slot))}
          </div>
          <button
            class="send-home"
            title="Send back to the costume drawer"
            aria-label="Remove costume"
            @pointerdown=${(e) => e.stopPropagation()}
            @click=${(e) => this._onClear(e, slot)}
          >×</button>
        ` : ""}
      </div>
    `;
  }

  render() {
    const bg = this.assetsReady ? backdropUrl({ scary: !!this.scaryMode }) : null;
    return html`
      ${bg ? html`<img class="backdrop" src=${bg} alt="" draggable="false" />` : ""}
      <div
        class="stage-surface ${this._dragOver ? "drag-over" : ""}"
        @dragover=${this._onDragOver}
        @dragleave=${this._onDragLeave}
        @drop=${this._onDrop}
      >
        ${(this.slots || []).map((s, i) => this._renderSprunki(s, i))}
      </div>
    `;
  }
}

customElements.define("sprunki-stage", SprunkiStage);
