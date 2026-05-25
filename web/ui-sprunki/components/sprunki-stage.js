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
  emptySprunkiUrl,
  backdropUrl,
  muteButtonUrl,
} from "../sprunki-assets.js";

// Match OG sprunki on-stage character size — they read as
// roughly 60% of stage height in the OG game. The container is
// the art-bounding box (object-fit: contain inside), so the
// actual SVG fills almost the full box minus a sliver of
// letterbox. Width-to-height aspect mirrors the OG SVG aspect
// (≈ 0.55) so contain-fit barely letterboxes.
const SPRUNKI_W_PX = 170;
const SPRUNKI_H_PX = 310;

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
/** Pixel amount of the sprunki container that hangs past the
 *  stage bottom — clipped by overflow:hidden so the legs hide in
 *  the grass. Tuned so ~30% of a 320 px-tall sprunki is hidden,
 *  matching the upper-body-only silhouette in OG sprunki. */
const SPRUNKI_CLIP_OFFSET_PX = 100;

/** Drag Y → normalized level in [-1, +1]. Raised → positive,
 *  lowered → negative; clamped at the LEVEL_RANGE limits. */
function levelT(y) {
  const dy = STAGE_BASELINE_Y - y;
  return Math.max(-1, Math.min(1, dy / STAGE_LEVEL_RANGE));
}
/** Y-position → visual scale. Raised = bigger, lowered = smaller.
 *  Wide range (0.6x .. 1.4x) so the kid sees a clear size change
 *  even with vertical motion mostly damped away. */
function levelScale(y) {
  return 1 + levelT(y) * 0.40;
}
/** Y-position → dBFS. Exposed so the parent app can `controlSet`
 *  the slot's track gain when the kid moves a sprunki. */
export function levelDb(y) {
  const t = levelT(y);
  return t >= 0 ? t * 6 : t * 12;
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
      /* OG sprunki's backdropcute SVG fills the stage. The CSS
         gradient sits underneath as a safety fallback (used
         briefly during boot before the asset pack resolves, or
         if the OG pack is missing). */
      background:
        linear-gradient(180deg, #67c0ed 0%, #87ceeb 50%, #6bbf6b 50%, #4ea854 100%);
      border-radius: 10px;
      overflow: hidden;
      width: 100%;
      height: 100%;
      min-height: 360px;
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

    .sprunki {
      position: absolute;
      width: ${SPRUNKI_W_PX}px;
      height: ${SPRUNKI_H_PX}px;
      /* translate-(-50%,-100%) anchors the container's bottom-
         center at the (slot.x, slot.y) point; the extra
         translateY pushes that anchor below the stage by a
         fixed pixel offset so the lower body always clips
         against overflow:hidden, regardless of stage size. */
      transform: translate(-50%, -100%) translateY(${SPRUNKI_CLIP_OFFSET_PX}px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      cursor: grab;
      touch-action: none;
    }
    .sprunki.dragging {
      cursor: grabbing;
      z-index: 100;
    }
    .sprunki.empty .sprunki-art {
      opacity: 0.78;     /* slightly faded but not ghostly — they're
                            still alive characters on stage, just
                            without a sound assigned yet */
      filter: saturate(0.55) brightness(0.95);
    }
    .sprunki.drop-target .sprunki-art {
      animation: pop 200ms ease-out;
    }
    @keyframes pop {
      from { transform: scale(0.92); }
      to   { transform: scale(1.06); }
    }

    .sprunki-art {
      width: ${SPRUNKI_W_PX}px;
      height: ${SPRUNKI_H_PX}px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      /* Anchor scale around the visible bottom of the character
         — the spot where the body emerges from the grass after
         the container's lower clip. That spot is at element-y =
         (height - clip) / height of the container; with 320 px
         height and ~100 px clipped, anchor lands at ~69%, so
         shrinking pulls the head down toward the visible torso
         and the visible-bottom stays planted. */
      transform-origin: center calc(100% - ${SPRUNKI_CLIP_OFFSET_PX}px);
      transform: scale(calc(var(--level-scale, 1) * (1 + var(--meter, 0) * 0.28)));
      filter: brightness(calc(1 + var(--meter, 0) * 0.55))
              drop-shadow(0 0 calc(var(--meter, 0) * 32px)
                           color-mix(in srgb, var(--cc, #fff) 80%, transparent));
      transition: transform 80ms cubic-bezier(0.2, 0.8, 0.2, 1.1),
                  filter   60ms ease-out;
      animation: idle-sway calc(2.8s + var(--sway-delay, 0s)) ease-in-out infinite;
      pointer-events: none;
    }
    /* When the meter passes a transient threshold (set imperatively
       from updateLevels), play a short "bounce" — that's the
       discrete hop OG sprunkis make every drum hit. */
    .sprunki-art.bounce {
      animation: sprunki-bounce 280ms cubic-bezier(0.25, 1.4, 0.5, 1) 1,
                 idle-sway calc(2.8s + var(--sway-delay, 0s)) ease-in-out infinite;
    }
    @keyframes sprunki-bounce {
      0%   { translate: 0 0; }
      35%  { translate: 0 -14px; }
      70%  { translate: 0 -4px; }
      100% { translate: 0 0; }
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
    .sprunki-emoji {
      font-size: 110px;
      line-height: 1;
      filter: drop-shadow(0 4px 6px rgba(0,0,0,0.25));
    }

    @keyframes idle-sway {
      0%, 100% { translate: 0 0; }
      50%      { translate: 0 -3px; }
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
      opacity: 0;
      transition: opacity 120ms ease, transform 120ms ease;
      z-index: 3;
      pointer-events: auto;
    }
    .sprunki:hover .ribbon,
    .sprunki.is-solo .ribbon,
    .sprunki.is-muted .ribbon { opacity: 1; }
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
    this._dragSlotId = null;
    this._dropTargetId = null;
    this._dragOver = false;
    this._idleFrameIdx = {};       // slotId → idle frame index (≈ blink)
    this._playFrameIdx = {};       // slotId → play frame index (active cycle)
    this._cycling = false;         // is transport playing? drives the play cycle
    this._levels = {};
    this._idleTimers = new Map();  // slotId → timeout handle
  }

  connectedCallback() {
    super.connectedCallback();
    this._restartAllBlinkTimers();
    this._subscribeToTransport();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    for (const t of this._idleTimers.values()) clearTimeout(t);
    this._idleTimers.clear();
    this._unsubscribeFromTransport();
    this._stopPlayCycle();
  }
  updated(changed) {
    super.updated(changed);
    if (changed.has("slots") || changed.has("assetsReady")) {
      this._restartAllBlinkTimers();
    }
  }

  // ── play-frame cycler ───────────────────────────────────────────
  // OG sprunki cycles each slot's `anim`, `anim2`, … frames at ~25
  // FPS while the slot is "active" — that's where the dancing /
  // arms-up / mouth-open feel comes from. We tie cycling to the
  // backend's `transport.playing` control: if the song is playing,
  // every occupied slot animates; when it stops, every slot
  // snaps back to its idle frame. Per-slot mute could later pause
  // cycling individually, but the simple global tie matches OG.
  _subscribeToTransport() {
    const store = globalThis.__foyer?.store;
    if (!store) return;
    this._storeRef = store;
    // foyer-core's `control` event fires with `ev.detail` set to the
    // CONTROL ID (string) — value isn't on the event. Re-read the
    // current value from the store on every notification.
    this._onControl = (ev) => {
      if (ev?.detail !== "transport.playing") return;
      this._applyTransportPlaying(!!store.get?.("transport.playing"));
    };
    store.addEventListener?.("control", this._onControl);
    // Pick up whatever the current state is at mount time.
    this._applyTransportPlaying(!!store.get?.("transport.playing"));
  }
  _unsubscribeFromTransport() {
    this._storeRef?.removeEventListener?.("control", this._onControl);
    this._storeRef = null;
  }
  _applyTransportPlaying(playing) {
    if (playing) this._startPlayCycle();
    else this._stopPlayCycle();
  }
  _startPlayCycle() {
    if (this._cycling) return;
    this._cycling = true;
    // 80 ms / ~12 FPS — half OG's 25 FPS. Still clearly animated
    // and keeps img-swap pressure off the renderer when 20 slots
    // are eventually on stage. Bump down to 40 ms if it ever feels
    // sluggish; up to 120 ms if the inspector ever shows churn.
    const TICK_MS = 80;
    this._playCycleTimer = setInterval(() => this._tickPlayCycle(), TICK_MS);
    this.requestUpdate();
  }
  _stopPlayCycle() {
    if (this._playCycleTimer) clearInterval(this._playCycleTimer);
    this._playCycleTimer = null;
    if (!this._cycling) return;
    this._cycling = false;
    this._playFrameIdx = {};
    this.requestUpdate();
  }
  _tickPlayCycle() {
    let touched = false;
    const next = { ...this._playFrameIdx };
    for (const slot of (this.slots || [])) {
      if (!slot.patch_id) continue;
      const patch = getPatch(slot.patch_id);
      if (!patch?.sprunki_id) continue;
      const frames = allPlayCostumeUrlsFor(patch.sprunki_id);
      if (frames.length < 2) continue;
      next[slot.id] = ((next[slot.id] || 0) + 1) % frames.length;
      touched = true;
    }
    if (touched) {
      this._playFrameIdx = next;
      this.requestUpdate();
    }
  }

  /** Schedule the next idle-frame swap for one slot. Uses
   *  randomized intervals so the cast doesn't blink in unison —
   *  that's what gives OG sprunki its "alive" quality.
   *
   *  Inert when there's only one safe idle frame (the OG project
   *  ships exactly one — the second `idle2` costume is the
   *  scary-mode pose and lives in a separate bucket). Drop more
   *  safe frames into `costumes.idle` in the manifest to wake it
   *  up. */
  _scheduleBlink(slotId) {
    const prev = this._idleTimers.get(slotId);
    if (prev) clearTimeout(prev);
    const slot = (this.slots || []).find((s) => s.id === slotId);
    if (!slot) return;
    const frameCount = this._frameCountFor(slot);
    if (frameCount <= 1) return; // nothing to cycle through, save the wakeup
    // Mostly 1.5–4.5 s between frame swaps; ~10% chance of a
    // quick double-flick (the actual blink). Spread per-slot.
    const baseDelay = 1500 + Math.random() * 3000;
    const isQuickBlink = Math.random() < 0.10;
    const delay = isQuickBlink ? 180 + Math.random() * 200 : baseDelay;
    const t = setTimeout(() => {
      const next = { ...this._idleFrameIdx };
      next[slotId] = ((next[slotId] || 0) + 1);
      this._idleFrameIdx = next;
      this.requestUpdate();
      this._scheduleBlink(slotId);
    }, delay);
    this._idleTimers.set(slotId, t);
  }
  _frameCountFor(slot) {
    if (!this.assetsReady) return 0;
    const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
    if (!patch) return 1; // empty slot has a single static gray frame
    return allIdleCostumeUrlsFor(patch.sprunki_id).length;
  }
  _restartAllBlinkTimers() {
    for (const slot of (this.slots || [])) {
      if (!this._idleTimers.has(slot.id)) this._scheduleBlink(slot.id);
    }
    // Drop timers for slots that no longer exist.
    const known = new Set((this.slots || []).map((s) => s.id));
    for (const [id, t] of this._idleTimers.entries()) {
      if (!known.has(id)) { clearTimeout(t); this._idleTimers.delete(id); }
    }
  }

  /** Per-slot dB envelopes from the WS meter_batch. Drives the
   *  `--meter` CSS var → scale boost + glow + brightness in the
   *  art's transform. The discrete bounce keyframe is triggered
   *  on transient peaks so individual drum hits register
   *  visually even when the loop average stays moderate. */
  updateLevels(bySlot) {
    this._levels = bySlot || {};
    const root = this.renderRoot;
    if (!root) return;
    const now = performance.now();
    this._lastLevel = this._lastLevel || {};
    this._lastBounceAt = this._lastBounceAt || {};
    for (const [slotId, db] of Object.entries(this._levels)) {
      // -40 dB → 0, 0 dB → 1, sharpened so quiet ticks stay
      // quiet but a real hit pops the character.
      const lin = Math.max(0, Math.min(1, (db + 40) / 40));
      const intensity = Math.pow(lin, 1.4);
      const el = root.querySelector(`[data-slot="${slotId}"] .sprunki-art`);
      if (!el) continue;
      el.style.setProperty("--meter", intensity.toFixed(3));
      const prev = this._lastLevel[slotId] || 0;
      const delta = intensity - prev;
      this._lastLevel[slotId] = intensity;
      if (delta > 0.30 && intensity > 0.40) {
        const lastAt = this._lastBounceAt[slotId] || 0;
        if (now - lastAt > 140) {
          this._lastBounceAt[slotId] = now;
          el.classList.remove("bounce");
          void el.offsetWidth;
          el.classList.add("bounce");
          setTimeout(() => el.classList.remove("bounce"), 300);
        }
      }
    }
  }

  // ── pointer drag (sprunkis around the stage) ──────────────────
  _onPointerDown(e, slot) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.classList.contains("clear-x")) return;
    e.preventDefault();
    e.stopPropagation();
    this._dragSlotId = slot.id;
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
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    this._dragHandlers = {
      move: (ev) => this._onPointerMove(ev),
      up:   (ev) => this._onPointerUp(ev, slot),
    };
    target.addEventListener("pointermove", this._dragHandlers.move);
    target.addEventListener("pointerup",   this._dragHandlers.up);
    target.addEventListener("pointercancel", this._dragHandlers.up);
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
    const target = e.currentTarget;
    target.releasePointerCapture?.(e.pointerId);
    target.removeEventListener("pointermove", this._dragHandlers.move);
    target.removeEventListener("pointerup",   this._dragHandlers.up);
    target.removeEventListener("pointercancel", this._dragHandlers.up);
    const wasMoved = this._dragMoved;
    this._dragSlotId = null;
    this._dragMoved = false;
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
    const rect = this.renderRoot.querySelector(".stage-surface").getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (this._dropTargetId) {
      this.dispatchEvent(new CustomEvent("stage-assign-patch", {
        detail: { slotId: this._dropTargetId, patchId },
        bubbles: true, composed: true,
      }));
    } else {
      this.dispatchEvent(new CustomEvent("stage-spawn", {
        detail: { x, y, patchId },
        bubbles: true, composed: true,
      }));
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
   *  Three cases:
   *   - empty slot              → plain-gray Polo silhouette;
   *   - cycling + has patch     → next anim frame (the dance);
   *   - idle                    → patch's resting idle frame. */
  _currentIdleUrl(slot) {
    if (!this.assetsReady) return null;
    const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
    if (!patch) return emptySprunkiUrl();
    if (this._cycling) {
      const play = allPlayCostumeUrlsFor(patch.sprunki_id);
      if (play.length) {
        const idx = (this._playFrameIdx?.[slot.id] || 0) % play.length;
        return play[idx];
      }
    }
    const idle = allIdleCostumeUrlsFor(patch.sprunki_id);
    if (!idle.length) return null;
    const idx = (this._idleFrameIdx?.[slot.id] || 0) % idle.length;
    return idle[idx];
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
    const swayDelay = `${(idx * 0.41) % 2}s`;
    const ccColor = patch?.color || "#888";
    const left = `${(slot.x * 100).toFixed(2)}%`;
    const top  = `${(visualY(slot.y) * 100).toFixed(2)}%`;
    const scale = levelScale(slot.y).toFixed(3);
    const url = this._currentIdleUrl(slot);
    const controls = this.slotControls?.[slot.id] || {};
    const isSolo = !!controls.solo;
    const isMuted = !!controls.muted;
    return html`
      <div
        class="sprunki ${isEmpty ? "empty" : ""} ${isDrop ? "drop-target" : ""} ${isSolo ? "is-solo" : ""} ${isMuted ? "is-muted" : ""}"
        data-slot=${slot.id}
        style="left:${left};top:${top};--cc:${ccColor};--sway-delay:${swayDelay};--level-scale:${scale};"
        @pointerdown=${(e) => this._onPointerDown(e, slot)}
      >
        <div class="sprunki-art">
          ${url
            ? html`<img src=${url} alt=${patch?.label || ""} draggable="false" />`
            : html`<span class="sprunki-emoji" style="color:${patch?.color || "#bbb"}">${patch?.emoji || "🙂"}</span>`}
        </div>
        ${patch ? html`
          <div class="ribbon" @pointerdown=${(e) => e.stopPropagation()}>
            ${this._renderRibbonButton("solo", isSolo, "Solo this sprunki", (e) => this._onSolo(e, slot))}
            ${this._renderRibbonButton("mute", isMuted, "Mute this sprunki", (e) => this._onMute(e, slot))}
            ${this._renderRibbonButton("remove", false, "Send off stage (clear patch)", (e) => this._onClear(e, slot))}
          </div>
        ` : ""}
      </div>
    `;
  }

  render() {
    const bg = this.assetsReady ? backdropUrl() : null;
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
