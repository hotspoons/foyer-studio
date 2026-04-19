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
//   import { promptText } from "./prompt-modal.js";
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

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class PromptModal extends LitElement {
  static properties = {
    title:        { type: String },
    message:      { type: String },
    placeholder:  { type: String },
    defaultValue: { type: String },
    confirmLabel: { type: String },
    cancelLabel:  { type: String },
    _value:       { state: true, type: String },
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
      background: rgba(2, 6, 23, 0.55);
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
    this.confirmLabel = "OK";
    this.cancelLabel = "Cancel";
    this._value = "";
    this._resolve = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._value = this.defaultValue || "";
    this._onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); this._cancel(); }
      else if (ev.key === "Enter") { ev.preventDefault(); this._commit(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    // Autofocus the input after first paint.
    requestAnimationFrame(() => {
      const input = this.renderRoot.querySelector("input");
      if (input) {
        input.focus();
        input.select();
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
          <button title="Close" @click=${this._cancel}>${icon("x-mark", 12)}</button>
        </header>
        <div class="body">
          ${this.message
            ? html`<div class="message">${this.message}</div>`
            : null}
          <input
            type="text"
            .value=${this._value}
            placeholder=${this.placeholder}
            @input=${(e) => { this._value = e.target.value; }}
          />
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
    if (r) r(this._value || null);
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
    el.confirmLabel = options.confirmLabel || "OK";
    el.cancelLabel = options.cancelLabel || "Cancel";
    el._resolve = resolve;
    document.body.appendChild(el);
  });
}
