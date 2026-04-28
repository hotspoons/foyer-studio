// Scrub-drag numeric input.
//
// Replaces native `<input type=number>` for values like tempo / BPM / Hz / dB
// where a mouse user wants to nudge by 0.1 without hitting a 4-pixel spinner,
// or step through a wide range without dragging across the whole screen.
//
// Interaction model:
//
//   · Click-drag horizontally: scrub the value.
//       - No modifier: `step` per pixel (default 1)
//       - Shift:       `fineStep` per pixel (default step/10)
//       - Ctrl / Alt:  `coarseStep` per pixel (default step*10)
//       - Cursor becomes `ew-resize`; pointer is captured.
//   · Double-click: enter text-edit mode. Enter / blur commits, Esc cancels.
//   · Focus + ArrowUp/Down: step by `step` (Shift = fineStep, Ctrl = coarseStep).
//   · Wheel over the widget: step (same modifier rules).
//
// Events:
//   · @input  { value } — continuously while scrubbing / typing.
//   · @change { value } — once on commit (release, blur, Enter).

import { LitElement, html, css } from "lit";

export class NumberScrub extends LitElement {
  static properties = {
    value:      { type: Number },
    min:        { type: Number },
    max:        { type: Number },
    step:       { type: Number },
    fineStep:   { type: Number, attribute: "fine-step" },
    coarseStep: { type: Number, attribute: "coarse-step" },
    /** Decimal places to show when not editing. 0 = integer display. */
    precision:  { type: Number },
    /** Force integer-only values (rounds on commit). */
    integer:    { type: Boolean },
    unit:       { type: String },
    label:      { type: String },
    /** Pixels of horizontal drag per single `step`. Higher = less sensitive. */
    pxPerStep:  { type: Number, attribute: "px-per-step" },
    _editing:   { state: true, type: Boolean },
    _scrubbing: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-sans);
      color: var(--color-text-muted);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      user-select: none;
    }
    .label {
      color: var(--color-text-muted);
    }
    .unit {
      color: var(--color-text-muted);
    }
    .field {
      position: relative;
      min-width: 72px;
      padding: 4px 10px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 12px;
      text-align: right;
      cursor: ew-resize;
      text-transform: none;
      letter-spacing: 0;
      transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
      touch-action: none;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .field:hover {
      border-color: color-mix(in oklab, var(--color-accent) 60%, var(--color-border));
    }
    .field:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    :host([_scrubbing]) .field {
      background: color-mix(in oklab, var(--color-accent) 14%, var(--color-surface));
      border-color: var(--color-accent);
      cursor: ew-resize;
    }
    :host([_editing]) .field {
      cursor: text;
      background: var(--color-surface-elevated);
    }
    /* Subtle track beneath the value that indicates drag sensitivity. */
    .field::after {
      content: "";
      position: absolute;
      left: 4px; right: 4px; bottom: 2px;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, var(--color-accent) 30%, transparent),
        transparent);
      opacity: 0.5;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    :host([_scrubbing]) .field::after {
      opacity: 1;
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--color-accent-3) 80%, transparent),
        var(--color-accent),
        color-mix(in oklab, var(--color-accent-3) 80%, transparent));
    }
    input {
      font: inherit;
      font-family: var(--font-mono);
      font-size: 12px;
      width: 100%;
      background: transparent;
      color: var(--color-text);
      border: 0;
      outline: none;
      text-align: right;
      padding: 0;
    }
    input::-webkit-outer-spin-button,
    input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  `;

  constructor() {
    super();
    this.value = 0;
    this.min = -Infinity;
    this.max = Infinity;
    this.step = 1;
    this.fineStep = undefined;   // falls back to step/10
    this.coarseStep = undefined; // falls back to step*10
    this.precision = 1;
    this.integer = false;
    this.unit = "";
    this.label = "";
    this.pxPerStep = 2;
    this._editing = false;
    this._scrubbing = false;
    this._drag = null;
  }

  updated(changed) {
    // Reflect state props as attributes so `:host([_scrubbing])` CSS works.
    if (changed.has("_scrubbing")) this.toggleAttribute("_scrubbing", this._scrubbing);
    if (changed.has("_editing"))  this.toggleAttribute("_editing",  this._editing);
  }

  _stepFor(ev) {
    if (ev.shiftKey) return this.fineStep ?? this.step / 10;
    if (ev.ctrlKey || ev.altKey) return this.coarseStep ?? this.step * 10;
    return this.step;
  }

  _clamp(v) {
    if (Number.isFinite(this.min)) v = Math.max(this.min, v);
    if (Number.isFinite(this.max)) v = Math.min(this.max, v);
    if (this.integer) v = Math.round(v);
    return v;
  }

  _formatValue(v) {
    if (!Number.isFinite(v)) return "";
    if (this.integer) return String(Math.round(v));
    const p = Math.max(0, Math.min(6, this.precision ?? 1));
    return v.toFixed(p);
  }

  render() {
    const text = this._formatValue(this.value);
    return html`
      ${this.label ? html`<span class="label">${this.label}</span>` : null}
      <div
        class="field"
        role="spinbutton"
        tabindex="0"
        aria-valuemin=${Number.isFinite(this.min) ? this.min : ""}
        aria-valuemax=${Number.isFinite(this.max) ? this.max : ""}
        aria-valuenow=${this.value}
        title=${this._tooltip()}
        @pointerdown=${this._onPointerDown}
        @dblclick=${this._onDoubleClick}
        @keydown=${this._onKey}
        @wheel=${this._onWheel}
      >
        ${this._editing
          ? html`<input
              type="text"
              inputmode="decimal"
              .value=${text}
              @blur=${this._commitEdit}
              @keydown=${this._onEditKey}
            />`
          : html`<span>${text}</span>`}
      </div>
      ${this.unit ? html`<span class="unit">${this.unit}</span>` : null}
    `;
  }

  _tooltip() {
    const fine = this.fineStep ?? this.step / 10;
    const coarse = this.coarseStep ?? this.step * 10;
    return (
      `Drag horizontally to scrub · ` +
      `step ${this.step} · Shift ${fine} · Ctrl ${coarse} · ` +
      `double-click to type`
    );
  }

  // ── interactions ─────────────────────────────────────────────────────

  _onPointerDown(ev) {
    if (this._editing) return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    const base = Number(this.value);
    this._drag = {
      startX: ev.clientX,
      startValue: Number.isFinite(base) ? base : 0,
      moved: false,
      pointerId: ev.pointerId,
      target: ev.currentTarget,
    };
    this._scrubbing = true;
    const move = (e) => this._onDragMove(e);
    const up = (e) => this._onDragUp(e, move, up);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _onDragMove(ev) {
    if (!this._drag) return;
    const dx = ev.clientX - this._drag.startX;
    if (!this._drag.moved && Math.abs(dx) > 2) this._drag.moved = true;
    const stepSize = this._stepFor(ev);
    const px = Math.max(0.25, this.pxPerStep);
    const steps = dx / px;
    const raw = this._drag.startValue + steps * stepSize;
    // Quantize to step grid so the displayed value snaps cleanly.
    const snapped = Math.round(raw / stepSize) * stepSize;
    const next = this._clamp(snapped);
    if (next !== this.value) {
      this.value = next;
      this._emit("input");
    }
  }

  _onDragUp(ev, move, up) {
    const wasMoved = this._drag?.moved;
    try { this._drag?.target?.releasePointerCapture?.(this._drag?.pointerId); } catch {}
    this._drag = null;
    this._scrubbing = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (wasMoved) this._emit("change");
  }

  _onDoubleClick(ev) {
    ev.preventDefault();
    this._editing = true;
    requestAnimationFrame(() => {
      const input = this.renderRoot.querySelector("input");
      if (input) { input.focus(); input.select(); }
    });
  }

  _commitEdit = (ev) => {
    if (!this._editing) return;
    const raw = ev.currentTarget.value;
    const n = Number(raw);
    this._editing = false;
    if (!Number.isFinite(n)) return;
    const next = this._clamp(n);
    if (next !== this.value) {
      this.value = next;
      this._emit("change");
    }
    // Return focus to the field so chord keys (arrow keys) still work.
    requestAnimationFrame(() => {
      this.renderRoot.querySelector(".field")?.focus?.();
    });
  };

  _onEditKey = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      this._commitEdit(ev);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      this._editing = false;
    }
  };

  _onKey = (ev) => {
    if (this._editing) return;
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    const dir = ev.key === "ArrowUp" ? 1 : -1;
    const next = this._clamp(Number(this.value) + dir * this._stepFor(ev));
    if (next !== this.value) {
      this.value = next;
      this._emit("input");
      this._emit("change");
    }
  };

  _onWheel = (ev) => {
    if (this._editing) return;
    ev.preventDefault();
    const dir = ev.deltaY < 0 ? 1 : -1;
    const next = this._clamp(Number(this.value) + dir * this._stepFor(ev));
    if (next !== this.value) {
      this.value = next;
      this._emit("input");
      this._emit("change");
    }
  };

  _emit(name) {
    this.dispatchEvent(new CustomEvent(name, {
      detail: { value: this.value },
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define("foyer-number", NumberScrub);
