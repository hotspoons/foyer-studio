// Generic parameter control — dispatches on the parameter's `kind` to the
// right widget. This is the single place plugin UIs, the mixer, and the
// transport all route through so a single change to how "continuous floats"
// render propagates everywhere.
//
// Event contract:
//   @input  { id, value }   fired during interactive changes (throttleable)
//   @change { id, value }   fired on release / commit
// Both bubble and compose so a plugin panel can delegate ws writes.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { coerceValue, formatValue } from "../param-scale.js";

import "./knob.js";
import "./toggle.js";

export class ParamControl extends LitElement {
  static properties = {
    param: { type: Object },
    value: {},
    /** Prefer "knob" | "fader" | "toggle" | "auto". Continuous kinds default
     *  to "knob" inside plugin panels, "fader" on the mixer strip. */
    widget: { type: String },
    /** Size of the knob in px, when `widget=knob`. */
    size: { type: Number },
  };

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      color: var(--color-text);
      font-family: var(--font-sans);
    }
    .ctl-wrap { display: flex; align-items: center; justify-content: center; }

    select {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 10px;
      padding: 3px 6px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm);
      cursor: pointer;
      min-width: 70px;
    }
    select:focus {
      outline: none;
      border-color: var(--color-accent);
    }

    input[type="text"], input[type="number"] {
      font: inherit;
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 3px 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm);
      min-width: 80px;
    }
    input:focus {
      outline: none;
      border-color: var(--color-accent);
    }

    .meter {
      width: 10px; height: 36px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 2px;
      position: relative;
      overflow: hidden;
    }
    .meter .fill {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      background: linear-gradient(
        0deg,
        var(--color-accent) 0%,
        var(--color-accent-3) 70%,
        var(--color-warning) 92%,
        var(--color-danger) 100%
      );
    }

    .stepper {
      display: inline-flex; align-items: stretch;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .stepper button {
      background: var(--color-surface-elevated);
      border: 0;
      color: var(--color-text-muted);
      padding: 0 6px;
      font: inherit;
      font-size: 10px;
      cursor: pointer;
    }
    .stepper button:hover { color: var(--color-accent-3); }
    .stepper .v {
      padding: 3px 8px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      min-width: 28px;
      text-align: center;
      color: var(--color-text);
    }

    .label {
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .readout {
      font-family: var(--font-mono);
      font-size: 9px;
      font-variant-numeric: tabular-nums;
      color: var(--color-text-muted);
      min-height: 12px;
    }
  `;

  constructor() {
    super();
    this.param = null;
    this.value = undefined;
    this.widget = "auto";
    this.size = 44;
  }

  render() {
    if (!this.param) return html``;
    const p = this.param;
    const kind = p.kind;
    const effective = this._effectiveValue();

    switch (kind) {
      case "continuous":
        return this._renderContinuous(effective);
      case "discrete":
        return this._renderDiscrete(effective);
      case "enum":
        return this._renderEnum(effective);
      case "trigger":
        return this._renderToggle(!!effective);
      case "meter":
        return this._renderMeter(effective);
      case "text":
        return this._renderText(effective);
      default:
        return html`<span class="label">${p.label}</span>
          <span class="readout">${String(effective ?? "")}</span>`;
    }
  }

  _effectiveValue() {
    if (this.value !== undefined && this.value !== null) return this.value;
    const raw = this.param?.value;
    if (raw && typeof raw === "object" && "Float" in raw) return raw.Float;
    return raw;
  }

  // ── widgets ──────────────────────────────────────────────────────────

  _renderContinuous(v) {
    const p = this.param;
    const widget = this.widget === "auto" ? "knob" : this.widget;
    if (widget === "knob") {
      return html`
        <foyer-knob
          .value=${Number(v) || 0}
          .range=${p.range || [0, 1]}
          .scale=${p.scale || "linear"}
          .unit=${p.unit || ""}
          .label=${p.label || ""}
          .size=${this.size}
          @input=${(e) => this._emit("input", e.detail.value)}
          @change=${(e) => this._emit("change", e.detail.value)}
        ></foyer-knob>
      `;
    }
    // Fallback horizontal slider (used by discrete too).
    const min = p.range?.[0] ?? 0;
    const max = p.range?.[1] ?? 1;
    return html`
      <div class="label">${p.label}</div>
      <div class="ctl-wrap">
        <input
          type="range"
          min=${min}
          max=${max}
          step=${(max - min) / 200}
          .value=${String(v ?? 0)}
          @input=${(e) => this._emit("input", Number(e.target.value))}
          @change=${(e) => this._emit("change", Number(e.target.value))}
        />
      </div>
      <div class="readout">${formatValue(v, p.unit, p.scale)}</div>
    `;
  }

  _renderDiscrete(v) {
    const p = this.param;
    const min = Math.round(p.range?.[0] ?? 0);
    const max = Math.round(p.range?.[1] ?? 10);
    const n = Math.round(Number(v) || 0);
    return html`
      <div class="label">${p.label}</div>
      <div class="stepper">
        <button @click=${() => this._step(n, -1, min, max)} title="Decrement">
          ${icon("minus", 10)}
        </button>
        <span class="v">${n}${p.unit ? ` ${p.unit}` : ""}</span>
        <button @click=${() => this._step(n, +1, min, max)} title="Increment">
          ${icon("plus", 10)}
        </button>
      </div>
    `;
  }

  _step(cur, dir, min, max) {
    const next = Math.max(min, Math.min(max, cur + dir));
    this._emit("input", next);
    this._emit("change", next);
  }

  _renderEnum(v) {
    const p = this.param;
    const opts = p.enum_labels || [];
    const selected = Number(v) || 0;
    return html`
      <div class="label">${p.label}</div>
      <select
        @change=${(e) => {
          const n = Number(e.target.value);
          this._emit("input", n);
          this._emit("change", n);
        }}
      >
        ${opts.map(
          (label, i) => html`
            <option value=${i} ?selected=${i === selected}>${label}</option>
          `
        )}
      </select>
    `;
  }

  _renderToggle(on) {
    const p = this.param;
    return html`
      <foyer-toggle
        .label=${p.label || "On"}
        ?on=${on}
        @input=${(e) => {
          this._emit("input", !!e.detail.value);
          this._emit("change", !!e.detail.value);
        }}
      ></foyer-toggle>
    `;
  }

  _renderMeter(v) {
    const p = this.param;
    const [lo, hi] = p.range || [-60, 0];
    const n = Number(v);
    const pct = Number.isFinite(n)
      ? Math.max(0, Math.min(1, (n - lo) / (hi - lo)))
      : 0;
    return html`
      <div class="label">${p.label}</div>
      <div class="meter"><div class="fill" style="height:${pct * 100}%"></div></div>
      <div class="readout">${formatValue(v, p.unit, p.scale)}</div>
    `;
  }

  _renderText(v) {
    const p = this.param;
    return html`
      <div class="label">${p.label}</div>
      <input
        type="text"
        .value=${String(v ?? "")}
        @change=${(e) => this._emit("change", e.target.value)}
      />
    `;
  }

  _emit(name, value) {
    const coerced = coerceValue(value, this.param?.kind);
    this.dispatchEvent(
      new CustomEvent(name, {
        detail: { id: this.param?.id, value: coerced },
        bubbles: true,
        composed: true,
      })
    );
  }
}
customElements.define("foyer-param-control", ParamControl);
