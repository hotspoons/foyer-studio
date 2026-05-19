// SPDX-License-Identifier: Apache-2.0
// Combined Timeline tab — track list (left, ~1/3) + the timeline
// surface (right, ~2/3) with a draggable divider. The desktop UI
// keeps tracks inline with the timeline; touch wants a slightly
// roomier list with bigger M/S/R targets, so we embed the existing
// touch tracks panel on the left and the full foyer-timeline-view
// on the right. The divider position persists per-client in
// localStorage; per CLAUDE.md that's the right home for layout
// prefs (not the backend).

import { LitElement, html, css } from "lit";

import "./touch-tracks-panel.js";
// foyer-timeline-view is registered at app boot via app.js's side-
// effect import, so just reference it by tag here.

const STORAGE_KEY = "foyer.ui.touch.timeline-split.fraction.v1";
const MIN_FRACTION = 0.18;
const MAX_FRACTION = 0.55;

function readFraction() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= MIN_FRACTION && n <= MAX_FRACTION) return n;
  } catch { /* private mode — fine */ }
  return 1 / 3;
}

function writeFraction(n) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(n));
  } catch { /* private mode — fine */ }
}

export class TouchTimelineSplit extends LitElement {
  static properties = {
    _fraction: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: row;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .pane {
      min-width: 0;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .left {
      flex: 0 0 var(--split-frac, 33%);
      border-right: 1px solid var(--color-border);
      overflow: hidden;
    }
    .right { flex: 1 1 auto; }
    .grip {
      flex: 0 0 8px;
      align-self: stretch;
      cursor: col-resize;
      background: var(--color-bg);
      position: relative;
      touch-action: none;
    }
    .grip::after {
      content: "";
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 2px; height: 32px;
      border-radius: 1px;
      background: color-mix(in oklab, var(--color-border) 80%, transparent);
    }
    .grip:active::after,
    .grip.dragging::after { background: var(--color-accent); }
    foyer-touch-tracks-panel,
    foyer-timeline-view {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  constructor() {
    super();
    this._fraction = readFraction();
    this._dragging = false;
    this._tick = 0;
    this._onStoreChange = () => { this._tick++; this.requestUpdate(); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onStoreChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onStoreChange);
  }

  _onGripDown(ev) {
    ev.preventDefault();
    this._dragging = true;
    const host = this.renderRoot.querySelector(".host") || this.renderRoot.host || this;
    const rect = this.getBoundingClientRect();
    const move = (e) => {
      const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
      const next = Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, x / Math.max(1, rect.width)));
      this._fraction = next;
    };
    const up = () => {
      this._dragging = false;
      writeFraction(this._fraction);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      this.requestUpdate();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  }

  render() {
    const session = window.__foyer?.store?.state?.session ?? null;
    const pct = `${(this._fraction * 100).toFixed(2)}%`;
    return html`
      <div class="pane left" style=${`flex-basis:${pct}`}>
        <foyer-touch-tracks-panel></foyer-touch-tracks-panel>
      </div>
      <div class="grip ${this._dragging ? "dragging" : ""}"
           @pointerdown=${this._onGripDown}></div>
      <div class="pane right">
        <foyer-timeline-view .session=${session}></foyer-timeline-view>
      </div>
    `;
  }
}

customElements.define("foyer-touch-timeline-split", TouchTimelineSplit);
