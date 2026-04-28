// Vertical fader. Continuous control with dB-style curve handled in parent.
// Accent-gradient fill on the track, with a lozenge cap in the signature palette.

import { LitElement, html, css } from "lit";

export class Fader extends LitElement {
  static properties = {
    value: { type: Number },
    label: { type: String },
    dragging: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .track {
      width: 20px;
      height: 150px;
      position: relative;
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.9), rgba(15, 23, 42, 0.7));
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      cursor: ns-resize;
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.35);
    }
    .fill {
      position: absolute;
      left: 2px; right: 2px; bottom: 2px;
      background: linear-gradient(180deg,
        color-mix(in oklab, var(--color-accent) 60%, transparent) 0%,
        color-mix(in oklab, var(--color-accent-2) 50%, transparent) 100%);
      border-radius: 2px 2px 0 0;
      transition: opacity 0.08s linear;
    }
    :host([dragging]) .fill { opacity: 0.9; }
    .cap {
      position: absolute;
      left: -5px; right: -5px;
      height: 10px;
      background: linear-gradient(180deg, #f1f5f9, #cbd5e1);
      border: 1px solid var(--color-border);
      border-radius: 2px;
      pointer-events: none;
      box-shadow:
        0 1px 3px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }
    :host([dragging]) .cap {
      background: linear-gradient(180deg, var(--color-accent-3), var(--color-accent-2));
      border-color: var(--color-accent);
    }
    .label {
      color: var(--color-text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      min-height: 12px;
    }
  `;

  constructor() {
    super();
    this.value = 0;
    this.label = "";
    this.dragging = false;
  }

  render() {
    const v = Math.max(0, Math.min(1, this.value || 0));
    const pct = v * 100;
    return html`
      <div class="track"
           @pointerdown=${this._down}
           @pointermove=${this._move}
           @pointerup=${this._up}
           @pointercancel=${this._up}
           @dblclick=${this._reset}>
        <div class="fill" style="height:${pct}%"></div>
        <div class="cap" style="bottom:calc(${pct}% - 5px)"></div>
      </div>
      <div class="label">${this.label}</div>
    `;
  }

  _down(ev) {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.dragging = true;
    this.setAttribute("dragging", "");
    this._update(ev);
  }
  _move(ev) {
    if (!this.dragging) return;
    this._update(ev);
  }
  _up(ev) {
    this.dragging = false;
    this.removeAttribute("dragging");
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch {}
  }
  _reset() {
    this.dispatchEvent(new CustomEvent("reset", { bubbles: true, composed: true }));
  }
  _update(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const v = 1 - Math.max(0, Math.min(1, y / rect.height));
    this.value = v;
    this.dispatchEvent(new CustomEvent("input", {
      detail: { value: v },
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define("foyer-fader", Fader);
