// Top-of-screen main menu — dropdowns grouped by action category, driven by
// the shim's action catalog (via `list_actions`). DAW-agnostic: any host that
// populates its menus into actions shows up here.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { getTransportPref, toggleTransportPref } from "../transport-settings.js";
import { showProjectPicker } from "./project-picker-modal.js";

// Category → menu label + order. Categories not listed are skipped.
const MENU_ORDER = [
  { cat: "session",   label: "Session"   },
  { cat: "edit",      label: "Edit"      },
  { cat: "transport", label: "Transport" },
  { cat: "view",      label: "View"      },
  { cat: "track",     label: "Track"     },
  { cat: "plugin",    label: "Plugin"    },
  { cat: "settings",  label: "Settings"  },
];

// A built-in "Launch" menu that spawns views into the workspace. Lives in
// the top menu bar (always reachable — can't be covered by a floating window
// because the top chrome has a higher z-index than floating tiles).
const LAUNCH_VIEWS = [
  { view: "mixer",    label: "Mixer",    icon: "adjustments-horizontal" },
  { view: "timeline", label: "Timeline", icon: "list-bullet" },
  { view: "plugins",  label: "Plugins",  icon: "puzzle-piece" },
  { view: "session",  label: "Projects", icon: "folder-open" },
  { view: "console",  label: "Console",  icon: "command-line" },
];

export class MainMenu extends LitElement {
  static properties = {
    _actions: { state: true, type: Array },
    _openMenu: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      position: relative;
      /* Above floating tiles (z-index:900+) AND above the transport bar
       * (z-index:1200) so dropdowns from Session/Edit/etc. hang down OVER
       * the transport instead of getting clipped behind it. Siblings in
       * the top chrome at the same z-index were losing the tie to the
       * later-rendered transport bar. */
      z-index: 1300;
    }
    .btn {
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 500;
      padding: 6px 10px;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .btn:hover, .btn.open {
      color: var(--color-text);
      background: var(--color-surface-elevated);
    }
    .dropdown {
      position: absolute;
      top: 100%;
      min-width: 220px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-top: 0;
      box-shadow: var(--shadow-panel);
      padding: 4px;
      z-index: 600;
      border-radius: 0 0 var(--radius-md) var(--radius-md);
    }
    .item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      font-family: var(--font-sans);
      font-size: 12px;
      color: var(--color-text);
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .item:hover { background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2)); color: #fff; }
    .item .label { flex: 1; }
    .item .shortcut {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .item:hover .shortcut { color: rgba(255,255,255,0.85); }
    .item.disabled { opacity: 0.4; cursor: default; }

    .btn.launch {
      display: inline-flex; align-items: center;
      color: var(--color-accent-3);
      font-weight: 600;
    }
    .btn.launch:hover, .btn.launch.open {
      background: color-mix(in oklab, var(--color-accent) 12%, transparent);
      color: #fff;
    }
    .dropdown.launch-drop { min-width: 260px; }
    .menu-heading {
      padding: 6px 10px 2px;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .launch-item .icon-chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      border-radius: 6px;
      background: color-mix(in oklab, var(--color-accent) 15%, transparent);
      color: var(--color-accent-3);
      flex: 0 0 auto;
    }
    .launch-item .hint {
      font-size: 9px;
      color: var(--color-text-muted);
      opacity: 0.6;
    }
    .launch-item:hover .icon-chip {
      background: rgba(255,255,255,0.18);
      color: #fff;
    }
    .launch-item:hover .hint { color: rgba(255,255,255,0.8); opacity: 1; }
  `;

  constructor() {
    super();
    this._actions = [];
    this._openMenu = "";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._onDocDown = (e) => {
      if (!this._openMenu) return;
      // We live inside foyer-app's shadow root; at document level `ev.target`
      // retargets past OUR shadow boundary and lands on <foyer-app>, which
      // isn't a descendant of this element. `composedPath()` still contains
      // every real node between target and document — if *we* are on the
      // path, the click was inside our menu and we should stay open.
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(this)) return;
      this._openMenu = "";
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocDown, true);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") {
      this._actions = body.actions || [];
    }
  }

  _byCategory(cat) {
    return this._actions.filter(a => a.category === cat);
  }

  _invoke(a) {
    if (!a.enabled) return;
    this._openMenu = "";
    // Client-side preferences that look like actions in the catalog — we
    // intercept them before forwarding to the backend so a toggle flips
    // localStorage instead of firing a DAW command.
    if (a.id === "transport.return_on_stop") {
      toggleTransportPref("returnOnStop");
      this.requestUpdate();
      return;
    }
    // Session-level actions that deserve a picker rather than a blind
    // `invoke_action` dispatch. The backend's action handler for these
    // either isn't implemented yet or doesn't know where the file is —
    // both flows need the user to name a path first.
    if (a.id === "session.open") {
      showProjectPicker("open");
      return;
    }
    if (a.id === "session.new") {
      showProjectPicker("new");
      return;
    }
    window.__foyer?.ws?.send({ type: "invoke_action", id: a.id });
  }

  /** True if an action is a client-side toggle and currently on. */
  _isChecked(id) {
    if (id === "transport.return_on_stop") return !!getTransportPref("returnOnStop");
    return false;
  }

  render() {
    return html`
      ${this._renderLaunchMenu()}
      ${MENU_ORDER.map(({ cat, label }) => {
        const items = this._byCategory(cat);
        if (!items.length) return null;
        return this._renderMenu(cat, label, items);
      })}
    `;
  }

  /**
   * Built-in "Launch" menu. Always present, never obscured by floating
   * windows — the answer to "where's the button to make a new tile when the
   * one that spawned this window is covered?"
   *
   * Click an item: open that view as a floating window at the user's sticky
   * slot (or center if no sticky). Shift-click: open as a tile split below
   * the currently focused tile. Drag an item out to tear it into a floating
   * window at the cursor.
   */
  _renderLaunchMenu() {
    const open = this._openMenu === "__launch__";
    return html`
      <button class="btn launch ${open ? 'open' : ''}"
              title="Launch a view — click to open, shift-click to tile"
              @click=${() => { this._openMenu = open ? "" : "__launch__"; }}>
        ${icon("plus", 12)}
        <span style="margin-left:4px">New</span>
      </button>
      ${open ? html`
        <div class="dropdown launch-drop" style="left:0">
          <div class="menu-heading">Launch view</div>
          ${LAUNCH_VIEWS.map(v => html`
            <div class="item launch-item"
                 @click=${(ev) => this._launchView(v.view, ev)}
                 @contextmenu=${(ev) => this._launchWithPicker(v.view, ev)}>
              <span class="icon-chip">${icon(v.icon, 12)}</span>
              <span class="label">${v.label}</span>
              <span class="hint">click · shift-click tiles · right-click picks slot</span>
            </div>
          `)}
        </div>
      ` : null}
    `;
  }

  _launchView(view, ev) {
    this._openMenu = "";
    const layout = window.__foyer?.layout;
    if (!layout) return;
    if (ev?.shiftKey) {
      // Shift-click → split the focused tile below with this view.
      layout.split("column", view);
      return;
    }
    // Default → float at the view's sticky slot, or center if none.
    layout.openFloating(view);
  }

  _launchWithPicker(view, ev) {
    ev.preventDefault();
    this._openMenu = "";
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const id = layout.openFloating(view);
    setTimeout(() => {
      const ft = window.__foyer?.floatingTiles;
      if (ft) ft._slotPickerFor = id;
    }, 0);
  }

  _renderMenu(cat, label, items) {
    const open = this._openMenu === cat;
    return html`
      <button class="btn ${open ? 'open' : ''}"
              @click=${() => { this._openMenu = open ? "" : cat; }}
              @mouseenter=${() => { if (this._openMenu) this._openMenu = cat; }}>
        ${label}
      </button>
      ${open ? html`
        <div class="dropdown" style="left:${this._menuLeftFor(cat)}px">
          ${items.map(a => {
            const checked = this._isChecked(a.id);
            return html`
              <div class="item ${a.enabled ? '' : 'disabled'}"
                   @click=${() => this._invoke(a)}>
                <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">
                  ${checked ? icon("check", 11) : null}
                </span>
                <span class="label">${a.label}</span>
                ${a.shortcut ? html`<span class="shortcut">${a.shortcut}</span>` : null}
              </div>
            `;
          })}
        </div>
      ` : null}
    `;
  }

  _menuLeftFor(cat) {
    // Measure each preceding button's width so the dropdown aligns.
    const btns = Array.from(this.renderRoot.querySelectorAll(".btn"));
    let x = 0;
    for (const b of btns) {
      if (b.textContent.trim().toLowerCase() === cat) break;
      x += b.offsetWidth;
    }
    return x;
  }
}
customElements.define("foyer-main-menu", MainMenu);
