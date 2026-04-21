// Styled replacement for `window.confirm()`.
//
// Same justification as prompt-modal.js: Foyer is a desktop environment,
// not a web page, so the browser's native chrome is a visual mismatch
// and breaks the "everything in one surface" feel.
//
// Usage:
//
//   import { confirmAction } from "./confirm-modal.js";
//   const ok = await confirmAction({
//     title: "Delete track?",
//     message: "This will remove all regions on the track.",
//     confirmLabel: "Delete",
//     tone: "danger",
//   });
//   if (ok) doDestructiveThing();
//
// Returns a Promise<boolean> — true on confirm, false on cancel/Esc/
// backdrop click. Multiple modals stack, Esc dismisses the top one.
//
// `tone` controls the confirm button's color:
//   - default (undefined) → accent gradient, for neutral actions
//   - "danger"             → red, for destructive actions
//   - "warning"            → amber, for "this overwrites work" actions

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class ConfirmModal extends LitElement {
  static properties = {
    title:        { type: String },
    message:      { type: String },
    confirmLabel: { type: String },
    cancelLabel:  { type: String },
    tone:         { type: String },
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
      min-width: 400px;
      max-width: 560px;
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
    :host([data-tone="danger"]) header .title {
      background: linear-gradient(135deg, #f87171, #ef4444);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    :host([data-tone="warning"]) header .title {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header button.close {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
      font-size: 14px;
    }
    header button.close:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }

    .body {
      padding: 16px;
      font-size: 13px;
      color: var(--color-text);
      line-height: 1.5;
      white-space: pre-wrap;
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
    button.btn.danger {
      background: linear-gradient(135deg, #f87171, #ef4444);
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    button.btn.danger:hover { filter: brightness(1.1); }
    button.btn.warning {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      color: #000;
      border-color: transparent;
      font-weight: 600;
    }
    button.btn.warning:hover { filter: brightness(1.05); }
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
    this.title = "Confirm";
    this.message = "";
    this.confirmLabel = "OK";
    this.cancelLabel = "Cancel";
    this.tone = "";
    this._resolve = null;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.tone) this.setAttribute("data-tone", this.tone);
    this._onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); this._cancel(); }
      else if (ev.key === "Enter") { ev.preventDefault(); this._commit(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    requestAnimationFrame(() => {
      const btn = this.renderRoot.querySelector("button.primary, button.danger, button.warning");
      if (btn) btn.focus();
    });
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  render() {
    const toneClass =
      this.tone === "danger" ? "danger"
      : this.tone === "warning" ? "warning"
      : "primary";
    return html`
      <div class="scrim" @click=${this._cancel}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">${this.title}</span>
          <button class="close" title="Close" @click=${this._cancel}>${icon("x-mark", 12)}</button>
        </header>
        <div class="body">${this.message}</div>
        <footer>
          <button class="btn" @click=${this._cancel}>
            ${this.cancelLabel}<span class="kbd">Esc</span>
          </button>
          <button class="btn ${toneClass}" @click=${this._commit}>
            ${this.confirmLabel}<span class="kbd">⏎</span>
          </button>
        </footer>
      </div>
    `;
  }

  _commit = () => {
    const r = this._resolve;
    this._resolve = null;
    if (r) r(true);
    this.remove();
  };
  _cancel = () => {
    const r = this._resolve;
    this._resolve = null;
    if (r) r(false);
    this.remove();
  };
}
customElements.define("foyer-confirm-modal", ConfirmModal);

/**
 * Open a styled confirm dialog. Returns a Promise that resolves to
 * true on confirm or false on cancel / Esc / backdrop click.
 */
export function confirmAction(options = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("foyer-confirm-modal");
    el.title = options.title || "Confirm";
    el.message = options.message || "";
    el.confirmLabel = options.confirmLabel || "OK";
    el.cancelLabel = options.cancelLabel || "Cancel";
    el.tone = options.tone || "";
    el._resolve = resolve;
    document.body.appendChild(el);
  });
}
