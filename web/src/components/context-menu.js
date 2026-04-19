// Generic descriptor-driven context menu.
//
// Usage — declarative:
//   import { showContextMenu } from "./context-menu.js";
//   element.addEventListener("contextmenu", (ev) => {
//     ev.preventDefault();
//     showContextMenu(ev, [
//       { label: "Edit", icon: "pencil-square", action: () => ... },
//       { separator: true },
//       { label: "Delete", icon: "trash", tone: "danger", action: () => ... },
//     ]);
//   });
//
// The menu is a single `<foyer-context-menu>` mounted at `document.body` and
// reused for every invocation. Submenus are rendered inline on hover.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class ContextMenu extends LitElement {
  static properties = {
    _open: { state: true, type: Boolean },
    _items: { state: true, type: Array },
    _x: { state: true, type: Number },
    _y: { state: true, type: Number },
    _submenu: { state: true, type: Number },
  };

  static styles = css`
    :host {
      position: fixed;
      z-index: 5000;
      pointer-events: none;
    }
    :host([open]) { pointer-events: auto; }

    .menu {
      position: absolute;
      min-width: 180px;
      max-width: 320px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-panel);
      padding: 4px;
      font-family: var(--font-sans);
      font-size: 11px;
      color: var(--color-text);
      user-select: none;
    }

    .item {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    .item:hover {
      background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      color: var(--color-text);
    }
    .item[data-disabled] {
      opacity: 0.45;
      cursor: default;
    }
    .item[data-disabled]:hover {
      background: transparent;
    }
    .item[data-tone="danger"]:hover {
      background: color-mix(in oklab, var(--color-danger) 30%, transparent);
    }
    .item .label { flex: 1; }
    .item .chord {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .item .caret {
      color: var(--color-text-muted);
      font-size: 10px;
    }
    .separator {
      height: 1px;
      margin: 4px 4px;
      background: var(--color-border);
      opacity: 0.6;
    }
    .heading {
      padding: 4px 8px 2px;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
  `;

  constructor() {
    super();
    this._open = false;
    this._items = [];
    this._x = 0;
    this._y = 0;
    this._submenu = -1;
    this._onDoc = (ev) => {
      if (!this._open) return;
      if (!this.renderRoot.querySelector(".menu")?.contains(ev.target)) this.hide();
    };
    this._onKey = (ev) => {
      if (!this._open) return;
      if (ev.key === "Escape") this.hide();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDoc, true);
    document.addEventListener("keydown", this._onKey, true);
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDoc, true);
    document.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  show(items, x, y) {
    this._items = items || [];
    this._x = x;
    this._y = y;
    this._submenu = -1;
    this._open = true;
    this.setAttribute("open", "");
    // After one frame, flip the menu away from viewport edges if it overflows.
    requestAnimationFrame(() => this._adjust());
  }

  hide() {
    this._open = false;
    this.removeAttribute("open");
    this._submenu = -1;
  }

  _adjust() {
    const m = this.renderRoot.querySelector(".menu");
    if (!m) return;
    const r = m.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = this._x;
    let y = this._y;
    if (x + r.width > vw - 6) x = Math.max(6, vw - r.width - 6);
    if (y + r.height > vh - 6) y = Math.max(6, vh - r.height - 6);
    m.style.left = x + "px";
    m.style.top = y + "px";
  }

  render() {
    if (!this._open) return html``;
    const style = `left:${this._x}px;top:${this._y}px`;
    return html`
      <div class="menu" style=${style}>
        ${this._items.map((it, i) => this._renderItem(it, i))}
      </div>
    `;
  }

  _renderItem(it, i) {
    if (it.separator) return html`<div class="separator"></div>`;
    if (it.heading) return html`<div class="heading">${it.heading}</div>`;
    return html`
      <div
        class="item"
        ?data-disabled=${!!it.disabled}
        data-tone=${it.tone || ""}
        @click=${(ev) => this._activate(ev, it)}
        @mouseenter=${() => (this._submenu = i)}
      >
        ${it.icon ? icon(it.icon, 12) : html`<span style="width:12px"></span>`}
        <span class="label">${it.label}</span>
        ${it.shortcut ? html`<span class="chord">${it.shortcut}</span>` : null}
        ${it.submenu ? html`<span class="caret">▸</span>` : null}
      </div>
    `;
  }

  _activate(ev, it) {
    if (it.disabled) return;
    if (it.submenu) return; // submenus would open a child menu — deferred
    this.hide();
    try {
      it.action?.(ev);
    } catch (err) {
      console.error("context-menu action failed", err);
    }
  }
}
customElements.define("foyer-context-menu", ContextMenu);

/** Lazily mount a single global context menu and expose it. */
let _singleton = null;
function ensureMenu() {
  if (_singleton) return _singleton;
  _singleton = document.createElement("foyer-context-menu");
  document.body.appendChild(_singleton);
  return _singleton;
}

/** Open the shared context menu at the event's position. */
export function showContextMenu(event, items) {
  const m = ensureMenu();
  const x = event.clientX ?? (event.pageX || 0);
  const y = event.clientY ?? (event.pageY || 0);
  m.show(items, x, y);
}

/** Hide the shared context menu if open. */
export function hideContextMenu() {
  if (_singleton) _singleton.hide();
}
