// Scrim modal wrapping a text-preview widget.
//
// Session view used to split the focused tile horizontally and shove a
// text-preview pane into it, which made for narrow awkward strips on
// any layout that wasn't already wide. Previews are transient — "peek
// at notes.txt" — not a workspace citizen, so they belong in a modal.
//
// Same pattern as prompt-modal.js: mount on demand, Esc dismisses, click
// the scrim to close. The <foyer-text-preview> does the actual rendering.

import { LitElement, html, css } from "lit";

import "foyer-ui-core/layout/text-preview.js";
import { icon } from "foyer-ui-core/icons.js";

export class PreviewModal extends LitElement {
  static properties = {
    path: { type: String },
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 5400;
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
      width: min(880px, 92vw);
      height: min(720px, 86vh);
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
      padding: 10px 14px;
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
    header .path {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 60%;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
    }
    header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
    }
    .body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    foyer-text-preview {
      flex: 1;
      min-height: 0;
    }
  `;

  constructor() {
    super();
    this.path = "";
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); this._close(); }
    };
    window.addEventListener("keydown", this._onKey, true);
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  render() {
    const basename = (this.path || "").split("/").filter(Boolean).slice(-1)[0] || "";
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">Preview</span>
          <span class="path" title=${this.path}>${basename || this.path}</span>
          <button title="Close (Esc)" @click=${this._close}>${icon("x-mark", 14)}</button>
        </header>
        <div class="body">
          <foyer-text-preview .path=${this.path}></foyer-text-preview>
        </div>
      </div>
    `;
  }

  _close = () => {
    this.remove();
  };
}
customElements.define("foyer-preview-modal", PreviewModal);

/** Open a modal preview of the given jail-relative path. */
export function showPreview(path) {
  if (!path) return null;
  const el = document.createElement("foyer-preview-modal");
  el.path = path;
  document.body.appendChild(el);
  return el;
}
