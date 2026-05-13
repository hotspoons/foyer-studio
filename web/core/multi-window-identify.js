// SPDX-License-Identifier: Apache-2.0
// Transient "this is Window N" overlay, analogous to the
// "Identify Displays" affordance in macOS / Windows monitor
// preferences.
//
// When the user is about to act on a sibling window from a context
// menu — "Send pane to Window 2", "Open this in Window 3" — every
// window in the family flashes a big number so they can map the
// label in the menu to the physical window on their desk. The
// trigger is one BroadcastChannel message; every sibling that hears
// it paints locally and clears after a few seconds (or sooner if a
// follow-up `identify-stop` arrives).
//
// Implementation: a single absolutely-positioned `<div>` attached
// to `document.body` from the module's own bootstrap. The element
// is a sibling of the Lit app shell — no shadow-root boundaries to
// cross, and z-index sits above every modal we ship.

import { multiWindow } from "./multi-window.js";

const OVERLAY_ID = "foyer-window-identify-overlay";
const DEFAULT_DURATION_MS = 4000;

let _bootstrapped = false;
let _overlayEl = null;
let _hideTimer = null;

function ensureOverlay() {
  if (typeof document === "undefined") return null;
  if (_overlayEl && _overlayEl.isConnected) return _overlayEl;
  _overlayEl = document.createElement("div");
  _overlayEl.id = OVERLAY_ID;
  Object.assign(_overlayEl.style, {
    position: "fixed",
    inset: "0",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    gap: "16px",
    pointerEvents: "none",
    // Above modals (1300), context menus (~1500), and even the
    // maximized window chrome (1400) so the label is never hidden.
    zIndex: "99999",
    background:
      "radial-gradient(circle at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 70%, transparent 100%)",
    color: "white",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    transition: "opacity 0.18s ease-out",
    opacity: "0",
  });
  const numberEl = document.createElement("div");
  numberEl.dataset.role = "number";
  Object.assign(numberEl.style, {
    fontSize: "clamp(120px, 28vmin, 320px)",
    fontWeight: "800",
    lineHeight: "1",
    letterSpacing: "-0.04em",
    textShadow: "0 4px 32px rgba(0,0,0,0.7)",
    color: "var(--color-accent, #6cf)",
  });
  const labelEl = document.createElement("div");
  labelEl.dataset.role = "label";
  Object.assign(labelEl.style, {
    fontSize: "clamp(16px, 2.5vmin, 28px)",
    fontWeight: "500",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    opacity: "0.85",
  });
  _overlayEl.appendChild(numberEl);
  _overlayEl.appendChild(labelEl);
  document.body.appendChild(_overlayEl);
  return _overlayEl;
}

function paint(windowNumber, role) {
  const el = ensureOverlay();
  if (!el) return;
  const num = windowNumber == null ? "•" : String(windowNumber);
  el.querySelector('[data-role="number"]').textContent = num;
  el.querySelector('[data-role="label"]').textContent =
    `Window ${num}${role === "primary" ? " · Primary" : ""}`;
  el.style.display = "flex";
  // Force a reflow before flipping opacity so the transition runs
  // from 0 each invocation.
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.style.opacity = "1";
}

function hide() {
  if (_hideTimer) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
  if (!_overlayEl) return;
  _overlayEl.style.opacity = "0";
  // Match the CSS transition; if a new show fires meanwhile,
  // `paint` re-flips opacity and the display stays "flex".
  setTimeout(() => {
    if (_overlayEl && _overlayEl.style.opacity === "0") {
      _overlayEl.style.display = "none";
    }
  }, 200);
}

/**
 * Show the identifier overlay on this window AND broadcast to every
 * sibling so the user can map menu items to physical windows.
 * Idempotent — repeated calls extend the dismissal timer.
 *
 * @param {object} [opts]
 * @param {number} [opts.durationMs=4000]
 */
export function identifyAllWindows({ durationMs = DEFAULT_DURATION_MS } = {}) {
  paintSelf();
  multiWindow.broadcast({ kind: "identify-show", durationMs });
  scheduleHide(durationMs);
}

/**
 * Stop the overlay early — for context menus that close on selection
 * we want the label to vanish the moment the user has decided.
 */
export function hideAllWindowIdentifiers() {
  hide();
  multiWindow.broadcast({ kind: "identify-hide" });
}

function paintSelf() {
  paint(multiWindow.windowNumber, multiWindow.role);
}

function scheduleHide(durationMs) {
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    hide();
  }, durationMs);
}

/**
 * Wire the receiver side. Called once from bootstrap; idempotent.
 * Listens for `identify-show` / `identify-hide` messages on the
 * multi-window channel and paints / clears accordingly.
 */
export function attachWindowIdentify() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  multiWindow.addEventListener("message", (ev) => {
    const msg = ev.detail;
    if (!msg) return;
    if (msg.kind === "identify-show") {
      paintSelf();
      scheduleHide(msg.durationMs || DEFAULT_DURATION_MS);
    } else if (msg.kind === "identify-hide") {
      hide();
    }
  });
}
