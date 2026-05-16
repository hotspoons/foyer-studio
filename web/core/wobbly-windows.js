// SPDX-License-Identifier: Apache-2.0
//
// Compiz-style wobbly windows.
//
// One spring-mass mesh per draggable surface. Particles arranged in
// an 8×6 grid (configurable via viz prefs), springs along the axes
// between 4-neighbors, plus a soft anchor spring keeping each
// particle near its rest position so the surface doesn't permanently
// deform. Per-frame Euler integration with friction — same force
// model as the original Compiz plugin.
//
// CSS can't render a 48-particle mesh directly, so we use the four
// corner particles to drive a perspective `matrix3d` transform on
// the host element. The interior particles still matter — they
// propagate forces through the mesh, which is what gives the
// characteristic Compiz "opposite corner lags" feel when you grab
// one corner. Grab a corner: the spring chain has to travel
// diagonally before the far corner feels it. Grab the middle:
// stretch radiates symmetrically.
//
// Lifecycle:
//   - `installWobbly()` reads the `wobblyWindowsOn` viz pref. When
//     on, it installs a MutationObserver that auto-attaches
//     instances to every `foyer-window` (existing + future) AND
//     fires `attachWobble`/`detachWobble` on demand for components
//     that opt in (FAB-class panels, etc.).
//   - When the viz pref flips off, every instance detaches and
//     clears its transform.
//
// External components opt in by calling `attachWobble(el, handle)`
// from `connectedCallback` and `detachWobble(el)` from
// `disconnectedCallback`. The functions are no-ops when the viz pref
// is off, so callers can always call them — there's no need to gate
// at the call site.

import { getVizPref } from "/ui-core/viz/viz-settings.js";

/// Cursor pixel-distance threshold below which a gesture is treated
/// as a click (no wobble takeover). Matches QuadrantFab's own
/// `moved` threshold so the heuristics agree.
const DRAG_THRESHOLD = 4;

class Wobble {
  constructor(el, handle, opts) {
    this.el = el;
    this.handle = handle || el;
    /** Called on pointerup with `{ dx, dy, clientX, clientY }`
     *  so the caller can commit a new persisted position AND
     *  run any cursor-position-dependent logic (dock-zone
     *  check, snap to grid, …). Without a commit hook the
     *  wobble springs back to its original position. */
    this.commit = opts?.commit || null;
    /** Sibling elements that should translate by the same delta
     *  as this wobble's mesh. Used to keep FAB + panel moving
     *  together when the user drags either one. Followers get a
     *  simple `transform: translate(dx, dy)` rather than the
     *  full mesh deformation. */
    this.followers = Array.isArray(opts?.followers) ? opts.followers : [];
    /** When true, defer the wobble takeover until the cursor has
     *  moved more than `DRAG_THRESHOLD` px. Lets a click on the
     *  handle pass through to peer click handlers (FAB toggle,
     *  dock toggle) instead of being eaten by the wobble. The
     *  pre-takeover phase is read-only: we don't suppress any
     *  peer pointerdown / move handlers. Once threshold is
     *  crossed we cancel the peer's drag state and own the
     *  rest of the gesture. */
    this.passthroughClick = !!opts?.passthroughClick;
    this.gridW = Math.max(2, getVizPref("wobblyGridW") | 0 || 8);
    this.gridH = Math.max(2, getVizPref("wobblyGridH") | 0 || 6);
    this.k = Number(getVizPref("wobblySpringK")) || 0.2;
    this.friction = Math.min(0.99, Math.max(0.1, Number(getVizPref("wobblyFriction")) || 0.82));
    this.substeps = 2;
    this.N = this.gridW * this.gridH;
    this.x = new Float32Array(this.N);
    this.y = new Float32Array(this.N);
    this.vx = new Float32Array(this.N);
    this.vy = new Float32Array(this.N);
    this.ax = new Float32Array(this.N);
    this.ay = new Float32Array(this.N);
    this.pin = -1;
    this.pinDx = 0;
    this.pinDy = 0;
    this.dragging = false;
    this._raf = 0;
    this._w = 0;
    this._h = 0;
    // Track the box's CSS rect at gesture-start so pointer math
    // stays consistent if peer code (Lit, browser layout) tries
    // to reposition the box during the drag.
    this._origRect = null;
    // Cursor's position at the moment the drag started — needed so
    // pointermove deltas can be applied to the pin in stable coords
    // regardless of where the box ends up post-frame.
    this._startCursor = { x: 0, y: 0 };
    this._reseed();
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    // Capture-phase listener so we run BEFORE peer pointerdown
    // handlers (foyer-window's `_startDrag`, the FAB's drag
    // initiation). We `stopImmediatePropagation` to suppress
    // their drag entirely — when wobble is active, it owns the
    // drag end-to-end and commits the final position back on
    // pointerup. Without this, Lit's drag would track the cursor
    // 1:1 with the box, leaving zero relative motion between
    // cursor and box local coords → no spring force → no wobble.
    this.handle.addEventListener("pointerdown", this._onPointerDown, true);
  }

  _reseed() {
    const rect = this.el.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this._w = w;
    this._h = h;
    const dx = w / (this.gridW - 1);
    const dy = h / (this.gridH - 1);
    for (let j = 0; j < this.gridH; j++) {
      for (let i = 0; i < this.gridW; i++) {
        const idx = j * this.gridW + i;
        this.ax[idx] = i * dx;
        this.ay[idx] = j * dy;
        this.x[idx] = this.ax[idx];
        this.y[idx] = this.ay[idx];
        this.vx[idx] = 0;
        this.vy[idx] = 0;
      }
    }
    this.dx = dx;
    this.dy = dy;
  }

  _onPointerDown(ev) {
    if (ev.button !== 0) return;
    // Buttons inside the handle (close, settings, …) shouldn't fire
    // a wobble drag. The walk through composedPath catches buttons
    // even when the handle's a shadow-rooted node.
    const path = ev.composedPath?.() || [];
    for (const n of path) {
      if (n === this.handle) break;
      const tag = n.tagName?.toLowerCase?.();
      if (tag === "button") return;
    }
    if (this.el.maximized) return;

    const cur = this.el.getBoundingClientRect();
    if (Math.abs(this._w - cur.width) > 1 || Math.abs(this._h - cur.height) > 1) {
      this._reseed();
    }
    this._origRect = { left: cur.left, top: cur.top, width: cur.width, height: cur.height };
    this._startCursor = { x: ev.clientX, y: ev.clientY };

    if (this.passthroughClick) {
      // Deferred takeover: do NOT suppress peer pointerdown
      // handlers. The FAB's _onFabDown / panel's _onGripDown
      // run normally and set up Lit's own drag state. We only
      // intercept once the cursor has moved beyond the click
      // threshold — at which point we cancel Lit's drag and
      // take over with the wobble.
      this._pendingTakeover = true;
      window.addEventListener("pointermove", this._onPointerMove);
      window.addEventListener("pointerup", this._onPointerUp, { once: true });
      return;
    }

    // Immediate takeover (foyer-window case): suppress peer
    // pointerdown handlers. When wobble is on, it owns the drag
    // end-to-end.
    ev.stopImmediatePropagation();
    ev.preventDefault();
    this._beginDrag(ev);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp, { once: true });
  }

  /// Pin the closest particle to the cursor and start the rAF tick.
  /// Split out from `_onPointerDown` so the deferred-takeover path
  /// can also call it once the user crosses the drag threshold.
  _beginDrag(ev) {
    const cur = this._origRect;
    const lx = ev.clientX - cur.left;
    const ly = ev.clientY - cur.top;
    let best = 0, bestD = Infinity;
    for (let idx = 0; idx < this.N; idx++) {
      const d = (this.x[idx] - lx) ** 2 + (this.y[idx] - ly) ** 2;
      if (d < bestD) { bestD = d; best = idx; }
    }
    this.pin = best;
    this.pinDx = this.x[best] - lx;
    this.pinDy = this.y[best] - ly;
    this.dragging = true;
    this._pendingTakeover = false;
    this._startRaf();
  }

  _onPointerMove(ev) {
    // Deferred-takeover phase: monitor for the drag threshold.
    if (this._pendingTakeover) {
      const dx = ev.clientX - this._startCursor.x;
      const dy = ev.clientY - this._startCursor.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      // Threshold crossed → take over.
      ev.stopImmediatePropagation();
      // Cancel peer drag state so Lit's drag handler stops
      // mutating position behind our back. QuadrantFab /
      // AgentPanel both use `_dragState` for tracking; clearing
      // it makes their pointermove a no-op.
      this._cancelPeerDrag();
      this._beginDrag(ev);
      // Fall through to the active-drag branch so the same
      // pointermove also seeds the pin position.
    }
    if (this.pin < 0 || !this._origRect) return;
    // Translate cursor into box-local coords using the box's
    // ORIGINAL rect at drag start. The box's CSS position stays
    // frozen during the drag (we suppressed peer drag handlers),
    // so origRect is the authoritative reference frame.
    const lx = ev.clientX - this._origRect.left;
    const ly = ev.clientY - this._origRect.top;
    this.x[this.pin] = lx + this.pinDx;
    this.y[this.pin] = ly + this.pinDy;
    this.vx[this.pin] = 0;
    this.vy[this.pin] = 0;
  }

  /// Reach up the composed path from the handle and clear any
  /// `_dragState` we find on a peer host. Both QuadrantFab and
  /// AgentPanel store their drag tracking in that field; nulling
  /// it makes their `_onMove` / `_onUp` a no-op so they don't
  /// fight our matrix3d transform.
  _cancelPeerDrag() {
    // Walk up from the handle through shadow boundaries to find
    // the host custom element (foyer-* tag) that owns the drag.
    let n = this.handle;
    while (n) {
      const tag = n.tagName?.toLowerCase?.();
      if (tag?.startsWith?.("foyer-") && ("_dragState" in n)) {
        try { n._dragState = null; } catch {}
        break;
      }
      n = n.parentNode || n.host;
    }
  }

  _onPointerUp(ev) {
    this.dragging = false;
    window.removeEventListener("pointermove", this._onPointerMove);
    // Deferred-takeover that never crossed the threshold: this
    // was a click, not a drag. Leave the host to handle it.
    if (this._pendingTakeover) {
      this._pendingTakeover = false;
      return;
    }
    if (this.pin >= 0 && this.commit && this._origRect) {
      const dx = this.x[this.pin] - this.ax[this.pin];
      const dy = this.y[this.pin] - this.ay[this.pin];
      try {
        this.commit({
          dx, dy,
          clientX: ev?.clientX ?? this._startCursor.x + dx,
          clientY: ev?.clientY ?? this._startCursor.y + dy,
        });
      } catch (e) { console.warn("wobble commit failed", e); }
      const baseDx = dx;
      const baseDy = dy;
      for (let idx = 0; idx < this.N; idx++) {
        this.x[idx] = this.x[idx] - baseDx;
        this.y[idx] = this.y[idx] - baseDy;
      }
      this._origRect.left += baseDx;
      this._origRect.top  += baseDy;
    }
    this.pin = -1;
    // Clear follower translates — they've now been promoted to
    // real CSS positions via the host's commit.
    for (const el of this.followers) {
      try { el.style.transform = ""; el.style.transformOrigin = ""; } catch {}
    }
  }

  _startRaf() {
    if (this._raf) return;
    const tick = () => {
      this._raf = 0;
      this._step();
      this._applyTransform();
      const settled = !this.dragging && this._energy() < 0.01;
      if (settled) {
        this.el.style.transform = "";
        for (const el of this.followers) {
          try { el.style.transform = ""; } catch {}
        }
        for (let idx = 0; idx < this.N; idx++) {
          this.x[idx] = this.ax[idx];
          this.y[idx] = this.ay[idx];
          this.vx[idx] = 0; this.vy[idx] = 0;
        }
        return;
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _step() {
    for (let s = 0; s < this.substeps; s++) this._stepOnce();
  }

  _stepOnce() {
    // Compiz's spring model is the vector form of Hooke's law: the
    // force on particle P from neighbor N is k × ((N.pos - P.pos) -
    // (N.rest - P.rest)), evaluated independently per axis. That's
    // numerically more stable than a magnitude-based formulation
    // (no sqrt, no near-zero divides) AND produces the
    // characteristic "opposite-corner lags" feel because forces
    // along x and y decouple per particle.
    const N = this.N;
    const W = this.gridW;
    const H = this.gridH;
    const k = this.k;
    // Anchor spring stays weak regardless of k so high spring values
    // don't lock the mesh near rest. Compiz uses a fixed 0.04; we
    // do the same for stability across the slider range.
    const anchorK = 0.04;
    const fx = new Float32Array(N);
    const fy = new Float32Array(N);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const idx = j * W + i;
        if (i < W - 1) {
          const r = idx + 1;
          const ddx = this.x[r] - this.x[idx] - (this.ax[r] - this.ax[idx]);
          const ddy = this.y[r] - this.y[idx] - (this.ay[r] - this.ay[idx]);
          fx[idx] += k * ddx;
          fy[idx] += k * ddy;
          fx[r]   -= k * ddx;
          fy[r]   -= k * ddy;
        }
        if (j < H - 1) {
          const d = idx + W;
          const ddx = this.x[d] - this.x[idx] - (this.ax[d] - this.ax[idx]);
          const ddy = this.y[d] - this.y[idx] - (this.ay[d] - this.ay[idx]);
          fx[idx] += k * ddx;
          fy[idx] += k * ddy;
          fx[d]   -= k * ddx;
          fy[d]   -= k * ddy;
        }
      }
    }
    // Anchor each particle softly toward its rest position. The
    // KEY trick from Compiz: when something is pinned, the entire
    // rest pose translates so the pinned particle's anchor sits at
    // the cursor. That gives every other particle a MOVING target
    // to chase via its anchor spring — which is what makes the
    // far corner follow during a drag instead of waiting for
    // spring chain propagation alone. Without this, anchors hold
    // the far corner at its original spot and the mesh only
    // releases on mouseup (which is the bug we're fixing).
    let originX = 0, originY = 0;
    if (this.pin >= 0) {
      originX = this.x[this.pin] - this.ax[this.pin];
      originY = this.y[this.pin] - this.ay[this.pin];
    }
    for (let idx = 0; idx < N; idx++) {
      const restX = originX + this.ax[idx];
      const restY = originY + this.ay[idx];
      fx[idx] += (restX - this.x[idx]) * anchorK;
      fy[idx] += (restY - this.y[idx]) * anchorK;
    }
    const f = this.friction;
    for (let idx = 0; idx < N; idx++) {
      if (idx === this.pin) continue;
      this.vx[idx] = (this.vx[idx] + fx[idx]) * f;
      this.vy[idx] = (this.vy[idx] + fy[idx]) * f;
      this.x[idx] += this.vx[idx];
      this.y[idx] += this.vy[idx];
    }
  }

  _energy() {
    let e = 0;
    for (let idx = 0; idx < this.N; idx++) {
      const dx = this.x[idx] - this.ax[idx];
      const dy = this.y[idx] - this.ay[idx];
      e += dx * dx + dy * dy + this.vx[idx] * this.vx[idx] + this.vy[idx] * this.vy[idx];
    }
    return e / this.N;
  }

  _applyTransform() {
    const W = this.gridW, H = this.gridH;
    const tl = { x: this.x[0],                     y: this.y[0] };
    const tr = { x: this.x[W - 1],                 y: this.y[W - 1] };
    const bl = { x: this.x[(H - 1) * W],           y: this.y[(H - 1) * W] };
    const br = { x: this.x[(H - 1) * W + W - 1],   y: this.y[(H - 1) * W + W - 1] };
    const m = projectiveQuadMatrix(this._w, this._h, tl, tr, bl, br);
    if (!m) return;
    this.el.style.transformOrigin = "0 0";
    this.el.style.transform = `matrix3d(${m.join(",")})`;
    // Followers: translate by the pin's displacement from rest so
    // they stay glued to the wobble-driven surface visually.
    // Plain `translate(dx, dy)` rather than a full mesh deform —
    // followers (like the FAB button when the panel is being
    // dragged) don't need their own jelly; they just need to
    // ride the same vector.
    if (this.followers.length > 0 && this.pin >= 0) {
      const fdx = this.x[this.pin] - this.ax[this.pin];
      const fdy = this.y[this.pin] - this.ay[this.pin];
      for (const el of this.followers) {
        try { el.style.transform = `translate(${fdx}px, ${fdy}px)`; } catch {}
      }
    }
  }

  detach() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener("pointermove", this._onPointerMove);
    this.handle.removeEventListener("pointerdown", this._onPointerDown);
    this.el.style.transform = "";
    this.el.style.transformOrigin = "";
  }
}

// Standard 4-point projective transform (Heckbert). Returns the
// 16-element column-major matrix3d ready for the CSS `transform`
// property, mapping the source rect [0..w] × [0..h] onto the four
// destination corner points.
function projectiveQuadMatrix(w, h, tl, tr, bl, br) {
  const x0 = tl.x, y0 = tl.y;
  const x1 = tr.x, y1 = tr.y;
  const x2 = bl.x, y2 = bl.y;
  const x3 = br.x, y3 = br.y;
  const sx = x0 - x1 - x2 + x3;
  const sy = y0 - y1 - y2 + y3;
  let g, hh;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    g = 0; hh = 0;
  } else {
    const dx1 = x1 - x3, dy1 = y1 - y3;
    const dx2 = x2 - x3, dy2 = y2 - y3;
    const denom = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denom) < 1e-9) return null;
    g = (sx * dy2 - sy * dx2) / denom;
    hh = (sy * dx1 - sx * dy1) / denom;
  }
  const a = x1 - x0 + g * x1;
  const b = x2 - x0 + hh * x2;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y2 - y0 + hh * y2;
  const f = y0;
  const iw = 1 / w, ih = 1 / h;
  const A = a * iw, B = b * ih, C = c;
  const D = d * iw, E = e * ih, F = f;
  const G = g * iw, H = hh * ih;
  return [
    A, D, 0, G,
    B, E, 0, H,
    0, 0, 1, 0,
    C, F, 0, 1,
  ];
}

let _enabled = false;
let _mo = null;
// Per-element instance map. Strong refs OK — `detachWobble` removes
// them and a WeakMap doesn't gain us anything when the element is
// the key. Each entry can hold MULTIPLE wobbles on the same element
// (foyer-window's host has only one; opted-in components may have
// distinct wobbles on their inner panel + FAB children).
const _instances = new Map(); // el → Wobble

/// Attach a Wobble instance to `el`, listening for pointerdown on
/// `handle` (or `el` itself when omitted). `opts.commit({dx, dy})`
/// is called on pointerup with the net pixel translation so the
/// caller can update its persisted position (foyer-window._x/_y,
/// FAB._fabRight/_fabBottom, …). No-op when the viz pref is off
/// or `el` already has an instance. Returns the instance.
export function attachWobble(el, handle, opts) {
  if (!_enabled || !el) return null;
  if (_instances.has(el)) return _instances.get(el);
  const w = new Wobble(el, handle, opts);
  _instances.set(el, w);
  return w;
}

/// Detach the Wobble from `el`, clearing any active transform.
export function detachWobble(el) {
  const w = _instances.get(el);
  if (!w) return;
  w.detach();
  _instances.delete(el);
}

function _enableObserver() {
  for (const el of document.querySelectorAll("foyer-window")) {
    _attachFoyerWindow(el);
  }
  if (_mo) return;
  _mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes || []) {
        if (node?.tagName === "FOYER-WINDOW") _attachFoyerWindow(node);
      }
      for (const node of m.removedNodes || []) {
        if (node?.tagName === "FOYER-WINDOW") detachWobble(node);
      }
    }
  });
  _mo.observe(document.body, { childList: true, subtree: true });
}

function _disableObserver() {
  if (_mo) { _mo.disconnect(); _mo = null; }
  for (const [el] of [..._instances]) detachWobble(el);
}

function _attachFoyerWindow(el) {
  // Target the inner `.win` div (the actual rounded-border window
  // surface) NOT the foyer-window host — the host fills the viewport
  // and transforming it would warp child stacking. The header sits
  // inside `.win` and is our drag handle.
  const tryAttach = (tries = 0) => {
    const win = el.renderRoot?.querySelector?.(".win");
    const header = win?.querySelector?.("header");
    if (!win || !header) {
      if (tries > 30) return; // give up after ~0.5s
      requestAnimationFrame(() => tryAttach(tries + 1));
      return;
    }
    if (_instances.has(el)) return;
    // Commit a wobble drag back to the host element's reactive
    // position props so it persists across re-renders and survives
    // a reload via `_persist`. The pin's displacement IS the
    // translation the user wanted, so we just add it to `_x/_y`.
    const commit = ({ dx, dy }) => {
      el._x = (el._x || 0) + dx;
      el._y = (el._y || 0) + dy;
      el._clampToViewport?.();
      el.requestUpdate?.();
      el._persist?.();
      // Also do the click-to-raise that Lit's `_startDrag` would
      // have triggered via the document-level pointerdown listener
      // we suppressed.
      el._bumpGlobalZIndex?.();
    };
    const w = new Wobble(win, header, { commit });
    _instances.set(el, w);
  };
  tryAttach();
}

let _installed = false;

/// Push the current viz prefs into every live Wobble instance.
/// Spring + friction are cheap to update live (just override the
/// fields the next physics tick reads); grid size requires a
/// re-seed (different particle count) so a host re-attach is the
/// cleaner path there. Called on every `foyer:viz-prefs-changed`
/// event so the viz-picker sliders move the wobble in real time.
function _liveTune() {
  const k = Number(getVizPref("wobblySpringK")) || 0.2;
  const friction = Math.min(0.99, Math.max(0.1,
    Number(getVizPref("wobblyFriction")) || 0.82));
  const gw = Math.max(2, getVizPref("wobblyGridW") | 0 || 8);
  const gh = Math.max(2, getVizPref("wobblyGridH") | 0 || 6);
  for (const [, w] of _instances) {
    w.k = k;
    w.friction = friction;
    if (w.gridW !== gw || w.gridH !== gh) {
      // Grid resolution change → re-seed. Skip mid-drag (avoid
      // particle-count mismatch with the active pin index).
      if (!w.dragging) {
        w.gridW = gw;
        w.gridH = gh;
        w.N = gw * gh;
        w.x = new Float32Array(w.N);
        w.y = new Float32Array(w.N);
        w.vx = new Float32Array(w.N);
        w.vy = new Float32Array(w.N);
        w.ax = new Float32Array(w.N);
        w.ay = new Float32Array(w.N);
        w._reseed();
      }
    }
  }
}

/// Bootstrap entry point. Idempotent. Reads the `wobblyWindowsOn`
/// viz pref + listens for changes; flips enable/disable accordingly.
export function installWobbly() {
  if (_installed) return;
  _installed = true;
  const apply = () => {
    const want = !!getVizPref("wobblyWindowsOn");
    if (want !== _enabled) {
      _enabled = want;
      if (_enabled) {
        _enableObserver();
        window.dispatchEvent(new CustomEvent("foyer:wobbly-enabled"));
      } else {
        _disableObserver();
        window.dispatchEvent(new CustomEvent("foyer:wobbly-disabled"));
      }
    }
    // Always push the latest spring / friction / grid into live
    // instances — the on/off toggle isn't the only pref change
    // that should affect rendering.
    if (_enabled) _liveTune();
  };
  apply();
  window.addEventListener("foyer:viz-prefs-changed", apply);
}

/// True when the viz pref is currently on. Components that
/// auto-attach to specific children query this on connect.
export function wobblyEnabled() {
  return _enabled;
}
