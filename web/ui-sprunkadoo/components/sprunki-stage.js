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
} from "../sprunki-assets.js";

// On-stage sprunki size, expressed as PERCENT of the stage
// container so the cast scales with the backdrop. OG sprunki
// reads each character at roughly 14% of stage width and the
// SVG aspect is ~0.55, so 14% × 0.55 → ~25% wide is the
// art-bounding box; clipping handles the lower body. Tuned in
// the 2026-05-25 second design pass after Rich flagged the
// sprunkis as too small + floating above the grass.
const SPRUNKI_W_PCT = 15;       /* % of stage width — 17 crowded the cast and clipped wide crowns (wizard hat, antennae) at the stage edges */
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
    /* Empty (gray) sprunkis render via an inline SVG instead of
       the OG Polo img, so we can animate eye-level idle behaviour
       — blinking and looking around — by targeting individual eye
       parts. The body shape mimics the OG Polo (rounded head, tall
       trapezoid body, gray) so the visual swap is unobtrusive. */
    .empty-sprunki {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    /* Pupils translate horizontally on a long cycle = "looking
       around"; staggered per-slot via --sway-delay so a row of
       seven empty Polos doesn't blink in unison. */
    .empty-sprunki .pupil {
      transform-box: fill-box;
      transform-origin: center;
      animation: empty-look-around
                 calc(6.4s + var(--sway-delay, 0s) * 1.9)
                 ease-in-out infinite;
    }
    /* Eyelids (white rounded bars positioned over the eyes) squash
       to a hairline briefly for the blink. The animation lives on
       the lid scale so the pupil underneath stays put while the
       lid sweeps across — closest "real eyelid" effect we can do
       without per-frame asset swaps. */
    .empty-sprunki .lid {
      transform-box: fill-box;
      transform-origin: center;
      animation: empty-blink
                 calc(4.8s + var(--sway-delay, 0s) * 1.4)
                 ease-in-out infinite;
    }
    @keyframes empty-look-around {
      0%, 100% { transform: translateX(0); }
      18%      { transform: translateX(-3px); }
      36%, 64% { transform: translateX(0); }
      82%      { transform: translateX(3px); }
    }
    @keyframes empty-blink {
      0%, 90%, 100% { transform: scaleY(0); }
      93%, 97%      { transform: scaleY(1); }
    }
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
      /* Subtle meter coupling — small breathing scale + a soft halo.
         Tuned down from the previous 0.28 scale / 32 px halo (which
         read as flailing). */
      transform: scale(calc(var(--level-scale, 1) * (1 + var(--meter, 0) * 0.06)));
      filter: brightness(calc(1 + var(--meter, 0) * 0.18))
              drop-shadow(0 0 calc(var(--meter, 0) * 8px)
                           color-mix(in srgb, var(--cc, #fff) 80%, transparent));
      transition: transform 80ms cubic-bezier(0.2, 0.8, 0.2, 1.1),
                  filter   60ms ease-out;
      pointer-events: none;
    }
    /* Each character has its own idle animation, chosen by the
       manifest-declared animation.kind. Drums bob vertically;
       bass / melody sway horizontally; vocal / fx tilt-look. The
       per-slot --sway-delay staggers them so they never line up.
       Period and direction also vary by --sway-delay so adjacent
       slots are out of phase. */
    .sprunki-art[data-anim-kind="bob"]  > .sprunki-body {
      animation: kind-bob  calc(2.6s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    .sprunki-art[data-anim-kind="sway"] > .sprunki-body {
      animation: kind-sway calc(3.4s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    .sprunki-art[data-anim-kind="look"] > .sprunki-body {
      animation: kind-look calc(4.2s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    /* Hit reaction — driven by per-slot meter transient detection
       in updateLevels. Each kind has its own brief reaction layered
       on top of the idle motion. The .hit class is removed ~280 ms
       later, leaving the idle loop running. */
    .sprunki-art.hit[data-anim-kind="bob"]  > .sprunki-body {
      animation: hit-bob  280ms cubic-bezier(0.25, 1.4, 0.5, 1) 1,
                 kind-bob  calc(2.6s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    .sprunki-art.hit[data-anim-kind="sway"] > .sprunki-body {
      animation: hit-sway 320ms cubic-bezier(0.4, 0, 0.2, 1) 1,
                 kind-sway calc(3.4s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    .sprunki-art.hit[data-anim-kind="look"] > .sprunki-body {
      animation: hit-look 360ms cubic-bezier(0.4, 0, 0.2, 1) 1,
                 kind-look calc(4.2s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    @keyframes kind-bob {
      0%, 100% { translate: 0 0; }
      50%      { translate: 0 -2px; }
    }
    @keyframes kind-sway {
      0%, 100% { translate: 0 0; }
      33%      { translate: -2px 0; }
      66%      { translate:  2px 0; }
    }
    @keyframes kind-look {
      0%, 100% { transform: rotate(0deg); }
      30%      { transform: rotate(-1.2deg); }
      70%      { transform: rotate( 1.2deg); }
    }
    @keyframes hit-bob {
      0%   { translate: 0 0; }
      40%  { translate: 0 -5px; }
      70%  { translate: 0 -1px; }
      100% { translate: 0 0; }
    }
    @keyframes hit-sway {
      0%   { translate: 0 0; }
      25%  { translate: -4px 0; }
      60%  { translate:  3px 0; }
      100% { translate: 0 0; }
    }
    @keyframes hit-look {
      0%   { transform: rotate(0deg); }
      30%  { transform: rotate(-3deg); }
      65%  { transform: rotate( 2deg); }
      100% { transform: rotate(0deg); }
    }
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
    this._dragSlotId = null;
    this._dropTargetId = null;
    this._dragOver = false;
    this._playFrameIdx = {};        // slotId → current play frame (costumed)
    this._slotActiveUntil = {};     // slotId → ts (perf.now) until we revert to idle
    this._levels = {};
    this._animTimer = null;         // 80 ms animation tick — drives BPM-clock fallback frame advance
    this._zCounter = 1;             // monotonic stacking counter; incremented per pointerdown
    this._slotZ = {};               // slotId → z-index assigned when last touched
  }

  connectedCallback() {
    super.connectedCallback();
    this._startAnimationTick();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopAnimationTick();
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
    let touched = false;
    // Animation is now driven entirely off per-slot audio peaks in
    // `updateLevels` (transient detection + `.hit` class) — see that
    // method for the per-character reaction. We keep the BPM clock
    // around ONLY as a quiet-mode fallback: when transport is rolling
    // but the engine has been silent for a while (stub backend with
    // no audio, a slot whose patch hasn't loaded yet), tick the
    // play-frame forward on costumed slots so they don't appear
    // frozen. No bounce fires from here — the idle CSS animation
    // already keeps each character gently in motion.
    if (this._bpmTickShouldFire(now)) {
      this._lastBpmTickAt = now;
      for (const slot of (this.slots || [])) {
        if (!slot.patch_id) continue;
        // Only step the frame on slots that haven't seen a real
        // audio transient recently — otherwise the live meter path
        // owns the frame cadence.
        const lastHit = this._slotActiveUntil[slot.id] || 0;
        if (lastHit > now - 500) continue;
        const patch = getPatch(slot.patch_id);
        const frames = patch?.sprunki_id ? allPlayCostumeUrlsFor(patch.sprunki_id) : [];
        if (!frames.length) continue;
        this._playFrameIdx[slot.id] = ((this._playFrameIdx[slot.id] || 0) + 1) % frames.length;
        touched = true;
      }
    }
    // Costumed slots whose ACTIVE_HOLD_MS just elapsed need a
    // re-render so we drop back to idle[0].
    if (!touched && this._needsRenderForExpiry(now)) touched = true;
    if (touched) this.requestUpdate();
  }

  /** Fire the per-kind "hit" animation on a single slot. Idempotent
   *  within a frame — restarts the keyframe by toggling the class
   *  off and forcing a layout flush before adding it again, which
   *  is the standard CSS way to re-trigger a one-shot keyframe. */
  _fireHit(slotId) {
    const el = this.renderRoot?.querySelector(`[data-slot="${slotId}"] .sprunki-art`);
    if (!el) return;
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
    clearTimeout(this._hitTimers?.[slotId]);
    this._hitTimers ??= {};
    this._hitTimers[slotId] = setTimeout(() => {
      el.classList.remove("hit");
    }, 360);
  }

  /** True when the next beat boundary has passed AND transport is
   *  rolling. The interval is locked to **transport.position**, not
   *  wall clock, so the cast lines up with the actual playhead even
   *  if the JS event loop hiccups. Without this anchor a paused tab
   *  resumed mid-loop would drift its dance off the audio by hundreds
   *  of ms. Read BPM + sample rate each call so a tempo slide is
   *  followed immediately. Falls back to 120 BPM / 48k if foyer-core's
   *  clock isn't available (offline / boot-screen). */
  _bpmTickShouldFire(_now) {
    const f = globalThis.__foyer;
    const playing = !!f?.store?.get?.("transport.playing");
    if (!playing) return false;
    const bpm = Number(f?.store?.get?.("transport.tempo")) || 120;
    const sr = Number(f?.store?.get?.("audio.sample_rate")) || 48000;
    const pos = Number(f?.store?.get?.("transport.position")) || 0;
    // Quarter-note pulse — fires on every beat, so the cast bops in
    // time with the audible drum kick rather than running ahead at
    // eighth-notes. Rich's call 2026-05-25: "sprunkis don't 100%
    // correspond with the beats."
    const samplesPerBeat = (60 / bpm) * sr;
    const beatIdx = Math.floor(pos / samplesPerBeat);
    if (beatIdx === this._lastBeatIdx) return false;
    this._lastBeatIdx = beatIdx;
    return true;
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
      // hit animation only on THIS slot. Threshold tuned so a
      // single drum hit fires once (jumps ~0.4 of envelope) but a
      // held sustained level doesn't keep re-triggering. Each
      // sprunki bounces only when its own track produces audio.
      if (intensity > prev + 0.18 && intensity > 0.22) {
        this._fireHit(slotId);
        this._slotActiveUntil[slotId] = performance.now() + SprunkiStage.ACTIVE_HOLD_MS;
        // Advance to the next play frame so the character cycles
        // through its anim/anim2/anim3 costumes on each transient.
        const slot = slotById.get(slotId);
        const patch = slot?.patch_id ? getPatch(slot.patch_id) : null;
        const frames = patch?.sprunki_id ? allPlayCostumeUrlsFor(patch.sprunki_id) : [];
        if (frames.length) {
          this._playFrameIdx[slotId] = ((this._playFrameIdx[slotId] || 0) + 1) % frames.length;
          this.requestUpdate();
        }
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
      // Empty slot. Static empty Polo — droopy-eyed, hands-down
      // gray placeholder. Was cycling through gray's `play` frames
      // (hands raised) which read as cat ears on stage; Rich's
      // 2026-05-25 call: use the empty Polo, no cycling.
      return emptySprunkiUrl({ scary });
    }
    const now = performance.now();
    // Scary mode prefers the `alternate` play bucket (4 horror
    // frames per character in the new Foyer Originals pack) for
    // beat hits and `idle_alternate` for the rest pose. If the
    // current source doesn't have horror frames for this
    // character we silently fall back to the normal bucket so a
    // half-skinned pack doesn't render blanks.
    const playFrames = scary
      ? (allAlternatePlayCostumeUrlsFor(patch.sprunki_id).length
          ? allAlternatePlayCostumeUrlsFor(patch.sprunki_id)
          : allPlayCostumeUrlsFor(patch.sprunki_id))
      : allPlayCostumeUrlsFor(patch.sprunki_id);
    if (now < (this._slotActiveUntil[slot.id] || 0) && playFrames.length) {
      const idx = (this._playFrameIdx?.[slot.id] || 0) % playFrames.length;
      return playFrames[idx];
    }
    const idle = scary
      ? (alternateIdleCostumeUrlsFor(patch.sprunki_id).length
          ? alternateIdleCostumeUrlsFor(patch.sprunki_id)
          : allIdleCostumeUrlsFor(patch.sprunki_id))
      : allIdleCostumeUrlsFor(patch.sprunki_id);
    return idle[0] || null;
  }

  /** Inline empty-sprunki SVG with animatable eye parts. We render
   *  this instead of the OG empty Polo <img> for empty slots in
   *  normal (non-scary) mode so the kid sees real eye-blinks and
   *  pupils that look around — pure CSS animations target `.pupil`
   *  and `.lid` paths, staggered per slot via --sway-delay. The
   *  body shape mimics the OG Polo (rounded head, tall trapezoid
   *  body) so swapping it in isn't visually jarring. */
  _renderEmptyArt() {
    // Polo-style empty placeholder: same anatomy + chill half-shut
    // face as the cast (uniform eye color matching the gray body),
    // brows, flat mouth — but with two animatable eye parts:
    //   .pupil → the black pupil mass, translates LR for look-around
    //   .lid   → a chill body-color overlay; brief scaleY collapse for blink
    // The geometry mirrors render_face() in build-foyer-originals.py
    // at the 130×270 viewBox used for thumbnails.
    return html`
      <svg class="empty-sprunki" viewBox="0 0 130 270" preserveAspectRatio="xMidYMax meet"
           aria-hidden="true">
        <!-- Body trapezoid -->
        <path d="M44 175 L36 270 L94 270 L86 175 Z"
              fill="#808080" stroke="#1a1a1a" stroke-width="2"/>
        <!-- Neck shadow under the chin -->
        <path d="M40 178 Q65 192 90 178" stroke="#5a5a5a"
              stroke-width="7" fill="none" opacity="0.7"/>
        <!-- Head -->
        <ellipse cx="65" cy="100" rx="50" ry="46"
                 fill="#808080" stroke="#1a1a1a" stroke-width="2.4"/>
        <!-- Brows: thin arches, tilted outward -->
        <g transform="rotate(-12 42 70)">
          <path d="M33 70 Q42 64 51 70" stroke="#1a1a1a"
                stroke-width="2" fill="none" stroke-linecap="round"/>
        </g>
        <g transform="rotate(12 88 70)">
          <path d="M79 70 Q88 64 97 70" stroke="#1a1a1a"
                stroke-width="2" fill="none" stroke-linecap="round"/>
        </g>
        <!-- Eyes: body-color sclera (eye blends with head like OG
             gray polo), big black pupil masked by a chill lid -->
        <g>
          <ellipse cx="42" cy="100" rx="19" ry="19"
                   fill="#808080" stroke="#1a1a1a" stroke-width="2"/>
          <defs>
            <clipPath id="empty-eye-L"><ellipse cx="42" cy="100" rx="18" ry="18"/></clipPath>
          </defs>
          <g clip-path="url(#empty-eye-L)">
            <circle class="pupil" cx="42" cy="100" r="13" fill="#000"/>
            <!-- chill half-shut lid: top half of eye in body color -->
            <path d="M21 100 Q42 102 63 100 L63 78 L21 78 Z" fill="#808080"/>
            <path d="M22 100 Q42 102 62 100" stroke="#1a1a1a"
                  stroke-width="1.5" fill="none"/>
          </g>
          <!-- Blink lid: full-eye body-color overlay collapsed flat
               by default (scaleY 0); a brief CSS keyframe pops it to
               scaleY 1 for the blink instant. -->
          <ellipse class="lid" cx="42" cy="100" rx="18" ry="18"
                   fill="#808080"/>
        </g>
        <g>
          <ellipse cx="88" cy="100" rx="19" ry="19"
                   fill="#808080" stroke="#1a1a1a" stroke-width="2"/>
          <defs>
            <clipPath id="empty-eye-R"><ellipse cx="88" cy="100" rx="18" ry="18"/></clipPath>
          </defs>
          <g clip-path="url(#empty-eye-R)">
            <circle class="pupil" cx="88" cy="100" r="13" fill="#000"/>
            <path d="M67 100 Q88 102 109 100 L109 78 L67 78 Z" fill="#808080"/>
            <path d="M68 100 Q88 102 108 100" stroke="#1a1a1a"
                  stroke-width="1.5" fill="none"/>
          </g>
          <ellipse class="lid" cx="88" cy="100" rx="18" ry="18"
                   fill="#808080"/>
        </g>
        <!-- Flat mouth — horizontal line, no smile curve -->
        <line x1="55" y1="136" x2="75" y2="136"
              stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
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
          ${isEmpty && !this.scaryMode
            ? this._renderEmptyArt()
            : url
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
