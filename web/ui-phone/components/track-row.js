// One track per row on the phone surface. Layout:
//
//   ┌──────────────────────────────────────────────┐
//   │ [R] [S] [M]  Track name                       │
//   │ ─────────●─── Fader (gain)        −3.0 dB     │
//   └──────────────────────────────────────────────┘
//
// The chip row is fixed-height so the eye can scan a list of tracks
// for arm/solo/mute state at a glance; the fader sits below at full
// row width so the thumb has somewhere to land.
//
// Pan / I/O / plugins / sends are intentionally absent. This is a
// monitor-mix surface, not a tracking session — see ui-phone/package.js.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed } from "foyer-core/rbac.js";
import "./horizontal-fader.js";
import { dbToNorm, normToDb } from "./horizontal-fader.js";

export class PhoneTrackRow extends LitElement {
  static properties = {
    track: { type: Object },
    _gainDb: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      padding: 14px 16px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .name {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    /* Big chip-style toggles. Larger than desktop because thumbs are
     * thumbs. The hit target is 38×38 even though the visible chip
     * is 36×36 — the extra 2px is invisible padding from the host. */
    .chip {
      flex: 0 0 auto;
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 10px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
    }
    .chip:active { transform: scale(0.94); }
    .chip.rec.on {
      color: #fff;
      background: var(--color-danger, #ef4444);
      border-color: var(--color-danger, #ef4444);
      box-shadow: 0 0 12px color-mix(in oklab, var(--color-danger, #ef4444) 50%, transparent);
    }
    .chip.solo.on {
      color: #1f1300;
      background: #fbbf24;
      border-color: #fbbf24;
    }
    .chip.mute.on {
      color: #fff;
      background: #64748b;
      border-color: #64748b;
    }
    .chip.disabled {
      opacity: 0.35;
      pointer-events: none;
    }
    /* Faded look for tracks the user can't drive — keeps the row
     * visible (so the engineer knows the track exists) but signals
     * "view only." */
    :host([readonly]) .name { color: var(--color-text-muted); }
    .gainline {
      display: flex; align-items: center; gap: 12px;
    }
    .gainline foyer-phone-hfader { flex: 1; min-width: 0; }
    .db {
      flex: 0 0 56px;
      text-align: right;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--color-text);
      font-variant-numeric: tabular-nums;
    }
  `;

  constructor() {
    super();
    this.track = null;
    this._gainDb = 0;
    this._unsub = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Track gain echoes back as ControlUpdate events on the
    // gain.id wire-control. We don't get a per-control subscription
    // here — just re-render on any store change and read.
    this._onChange = () => this._syncFromStore();
    window.__foyer?.store?.addEventListener("change", this._onChange);
    this._syncFromStore();
    const ro = !isAllowed("control_set");
    this.toggleAttribute("readonly", ro);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onChange);
    super.disconnectedCallback();
  }

  updated(changed) {
    super.updated?.(changed);
    if (changed.has("track")) this._syncFromStore();
  }

  _syncFromStore() {
    const t = this.track;
    if (!t?.gain?.id) return;
    const v = window.__foyer?.store?.get?.(t.gain.id);
    const num = Number(v);
    if (Number.isFinite(num)) this._gainDb = num;
  }

  _setBool(id, v) {
    if (!id) return;
    if (!isAllowed("control_set")) return;
    window.__foyer?.ws?.controlSet(id, v ? 1 : 0);
  }

  _onFaderInput = (ev) => {
    const db = ev.detail?.db;
    this._gainDb = db;
    if (!this.track?.gain?.id) return;
    if (!isAllowed("control_set")) return;
    window.__foyer?.ws?.controlSet(this.track.gain.id, db);
  };

  render() {
    const t = this.track;
    if (!t) return html``;
    const rec  = !!Number(window.__foyer?.store?.get?.(t.record_arm?.id));
    const solo = !!Number(window.__foyer?.store?.get?.(t.solo?.id));
    const mute = !!Number(window.__foyer?.store?.get?.(t.mute?.id));
    const canControl = isAllowed("control_set");
    const armable = !!t.record_arm?.id;
    const fmtDb = (db) => {
      if (db <= -60) return "−∞";
      const sign = db > 0 ? "+" : (db < 0 ? "−" : "");
      return `${sign}${Math.abs(db).toFixed(1)}`;
    };
    return html`
      <div class="head">
        <button class="chip rec ${rec ? "on" : ""} ${(!armable || !canControl) ? "disabled" : ""}"
                title="Arm for record"
                @click=${() => this._setBool(t.record_arm?.id, !rec)}>R</button>
        <button class="chip solo ${solo ? "on" : ""} ${!canControl ? "disabled" : ""}"
                title="Solo"
                @click=${() => this._setBool(t.solo?.id, !solo)}>S</button>
        <button class="chip mute ${mute ? "on" : ""} ${!canControl ? "disabled" : ""}"
                title="Mute"
                @click=${() => this._setBool(t.mute?.id, !mute)}>M</button>
        <span class="name">${t.name || "(unnamed)"}</span>
      </div>
      <div class="gainline">
        <foyer-phone-hfader
          .value=${dbToNorm(this._gainDb)}
          @input=${this._onFaderInput}
        ></foyer-phone-hfader>
        <span class="db">${fmtDb(this._gainDb)} dB</span>
      </div>
    `;
  }
}
customElements.define("foyer-phone-track-row", PhoneTrackRow);
