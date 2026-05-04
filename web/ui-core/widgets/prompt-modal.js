// Styled replacement for `window.prompt()`.
//
// Native prompt() is the kind of browser artifact we've sworn off (see
// docs/DECISIONS.md #8 — Foyer is a desktop environment, not a web page).
// This is a tiny scrim-modal that takes a title + placeholder + default
// value, shows a text input styled with the app palette, and resolves a
// Promise with the entered text (or null on cancel).
//
// Usage:
//
//   import { promptText } from "foyer-ui-core/widgets/prompt-modal.js";
//   const name = await promptText({
//     title: "Save layout as",
//     defaultValue: "my-layout",
//     confirmLabel: "Save",
//     placeholder: "layout name…",
//   });
//   if (name) layout.saveNamed(name);
//
// The modal mounts into document.body on demand and cleans itself up on
// resolve. Multiple simultaneous prompts stack — each one gets its own
// modal, Esc dismisses the top one.
//
// Numeric entry with a slider:
//
//   const st = await promptText({
//     title: "Pitch shift",
//     inputKind: "slider",
//     sliderMin: -24,
//     sliderMax: 24,
//     sliderStep: 0.1,
//     defaultValue: "0",
//   });
//
// Resolves to a string representation of the value (same as plain text mode).

import { LitElement, html, css } from "lit";

export class PromptModal extends LitElement {
  static properties = {
    title:        { type: String },
    message:      { type: String },
    placeholder:  { type: String },
    defaultValue: { type: String },
    /** `"text"` (default) or `"slider"` — slider shows range + number inputs. */
    inputKind:    { type: String },
    sliderMin:    { type: Number },
    sliderMax:    { type: Number },
    sliderStep:   { type: Number },
    confirmLabel: { type: String },
    cancelLabel:  { type: String },
    _value:       { state: true, type: String },
    _num:         { state: true, type: Number },
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 5500;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      font-family: var(--font-sans);
      color: var(--color-text);
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      min-width: 380px;
      max-width: 92vw;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    header .title {
      flex: 1;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 700;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
      font-size: 14px;
    }
    header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }

    .body {
      padding: 14px 16px 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      font-size: 12px;
      color: var(--color-text-muted);
      line-height: 1.4;
    }
    input {
      font: inherit;
      font-size: 14px;
      padding: 8px 10px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      outline: none;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    input:focus {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }

    .slider-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .slider-row input[type="range"] {
      flex: 1 1 auto;
      min-width: 0;
      height: 6px;
      -webkit-appearance: none;
      appearance: none;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
      cursor: pointer;
    }
    .slider-row input[type="range"]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
    }
    .slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin-top: -4px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .slider-row input[type="range"]::-moz-range-track {
      height: 6px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-border) 70%, var(--color-surface));
    }
    .slider-row input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--color-accent);
      border: 2px solid var(--color-surface-elevated);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    .slider-row input.num {
      flex: 0 0 auto;
      width: 5.5rem;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 16px 14px;
    }
    button.btn {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 11px;
      letter-spacing: 0.06em;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      transition: all 0.12s ease;
    }
    button.btn:hover {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
    }
    button.btn.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    button.btn.primary:hover { filter: brightness(1.1); }
    .kbd {
      font-family: var(--font-mono);
      font-size: 9px;
      padding: 1px 4px;
      margin-left: 6px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 3px;
      color: rgba(255,255,255,0.9);
    }
  `;

  constructor() {
    super();
    this.title = "Input";
    this.message = "";
    this.placeholder = "";
    this.defaultValue = "";
    this.inputKind = "text";
    this.sliderMin = -24;
    this.sliderMax = 24;
    this.sliderStep = 0.1;
    this.confirmLabel = "OK";
    this.cancelLabel = "Cancel";
    this._value = "";
    this._num = 0;
    this._resolve = null;
  }

  _isSlider() {
    return this.inputKind === "slider";
  }

  _clampNum(v) {
    const lo = this.sliderMin;
    const hi = this.sliderMax;
    return Math.min(hi, Math.max(lo, v));
  }

  connectedCallback() {
    super.connectedCallback();
    if (this._isSlider()) {
      let v = Number.parseFloat(String(this.defaultValue ?? "0"));
      if (!Number.isFinite(v)) v = 0;
      v = this._clampNum(v);
      this._num = v;
      this._value = String(v);
    } else {
      this._value = this.defaultValue || "";
    }
    this._onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); this._cancel(); }
      else if (ev.key === "Enter") { ev.preventDefault(); this._commit(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    // Autofocus the primary control after first paint.
    requestAnimationFrame(() => {
      const num = this.renderRoot.querySelector("input.num");
      const text = this.renderRoot.querySelector('input[type="text"]');
      const range = this.renderRoot.querySelector('input[type="range"]');
      const input = this._isSlider() ? (num || range) : text;
      if (input) {
        input.focus();
        if (input.select) input.select();
      }
    });
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  render() {
    return html`
      <div class="scrim" @click=${this._cancel}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">${this.title}</span>
        </header>
        <div class="body">
          ${this.message
            ? html`<div class="message">${this.message}</div>`
            : null}
          ${this._isSlider()
            ? html`
              <div class="slider-row">
                <input
                  type="range"
                  min=${this.sliderMin}
                  max=${this.sliderMax}
                  step=${this.sliderStep}
                  .value=${String(this._num)}
                  @input=${(e) => {
                    const v = Number(e.currentTarget.value);
                    if (!Number.isFinite(v)) return;
                    this._num = v;
                    this._value = String(v);
                  }}
                />
                <input
                  type="number"
                  class="num"
                  min=${this.sliderMin}
                  max=${this.sliderMax}
                  step=${this.sliderStep}
                  placeholder=${this.placeholder}
                  .value=${this._num}
                  @input=${(e) => {
                    const v = e.currentTarget.valueAsNumber;
                    if (!Number.isFinite(v)) return;
                    this._num = this._clampNum(v);
                    this._value = String(this._num);
                  }}
                />
              </div>
            `
            : html`
              <input
                type="text"
                .value=${this._value}
                placeholder=${this.placeholder}
                @input=${(e) => { this._value = e.target.value; }}
              />
            `}
        </div>
        <footer>
          <button class="btn" @click=${this._cancel}>
            ${this.cancelLabel}<span class="kbd">Esc</span>
          </button>
          <button class="btn primary" @click=${this._commit}>
            ${this.confirmLabel}<span class="kbd">⏎</span>
          </button>
        </footer>
      </div>
    `;
  }

  _commit = () => {
    const r = this._resolve;
    this._resolve = null;
    if (r) {
      r(
        this._isSlider()
          ? String(this._num)
          : (this._value || null),
      );
    }
    this.remove();
  };
  _cancel = () => {
    const r = this._resolve;
    this._resolve = null;
    if (r) r(null);
    this.remove();
  };
}
customElements.define("foyer-prompt-modal", PromptModal);

/**
 * Open a styled prompt. Returns a Promise that resolves to the entered
 * string (or `null` if the user cancelled / hit Esc).
 */
export function promptText(options = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("foyer-prompt-modal");
    el.title = options.title || "Input";
    el.message = options.message || "";
    el.placeholder = options.placeholder || "";
    el.defaultValue = options.defaultValue || "";
    el.inputKind = options.inputKind || "text";
    if (options.sliderMin != null) el.sliderMin = options.sliderMin;
    if (options.sliderMax != null) el.sliderMax = options.sliderMax;
    if (options.sliderStep != null) el.sliderStep = options.sliderStep;
    el.confirmLabel = options.confirmLabel || "OK";
    el.cancelLabel = options.cancelLabel || "Cancel";
    el._resolve = resolve;
    document.body.appendChild(el);
  });
}
