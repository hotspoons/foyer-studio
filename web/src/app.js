// Foyer Studio — top-level app shell with tiling layout.

import { LitElement, html, css } from "lit";

import { FoyerWs } from "./ws.js";
import { Store } from "./store.js";
import { applyTheme } from "./theme.js";

import { LayoutStore } from "./layout/layout-store.js";
import { Keybinds } from "./layout/keybinds.js";
import "./layout/tile-container.js";
import "./layout/tile-leaf.js";
import "./layout/floating-tiles.js";

import "./components/status-bar.js";
import "./components/transport-bar.js";
import "./components/main-menu.js";
import "./components/right-dock.js";
import "./components/agent-panel.js";
import "./components/command-palette.js";
import "./components/layout-fab.js";
import "./components/automation-panel.js";
import { bootAutomation } from "./components/automation-panel.js";
import { installBindingsRuntime } from "./layout/layout-bindings.js";

applyTheme();

// Desktop-environment mindset: hijack the browser's context menu everywhere
// so we can route right-click gestures to our own descriptor-driven menu (or
// suppress them on chrome surfaces). Individual components that WANT a
// context menu listen for `contextmenu` themselves and `preventDefault` to
// call `showContextMenu(event, items)`.
document.addEventListener("contextmenu", (ev) => {
  const t = ev.target;
  // Text-bearing surfaces keep the native menu so users can copy/paste.
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      || (t && t.isContentEditable)) {
    return;
  }
  ev.preventDefault();
});

// Boot-time: install whatever automation script the user has saved.
bootAutomation();

export class FoyerApp extends LitElement {
  static properties = {
    _status:  { state: true },
    _session: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .main {
      flex: 1 1 auto;
      display: flex;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    .workspace {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      overflow: hidden;
    }
  `;

  constructor() {
    super();
    this._status = "idle";
    this._session = null;

    const wsUrl = this._resolveWsUrl();
    this.ws = new FoyerWs({ url: wsUrl, origin: "web" });
    this.store = new Store({ selfOrigin: "web" });
    this.store.attach(this.ws);
    this.store.addEventListener("change", () => {
      this._status = this.store.state.status;
      this._session = this.store.state.session;
      // Re-render tile leaves (they read session from window.__foyer.store).
      const root = this.renderRoot.querySelector("foyer-tile-container");
      root?.requestUpdate();
    });

    this.layout = new LayoutStore();
    this.layout.addEventListener("change", () => this.requestUpdate());

    // User-defined chords for layouts (preset or named) fire before Keybinds.
    installBindingsRuntime(this.layout);

    this.keybinds = new Keybinds(this.layout, () => this._collectRects());

    window.__foyer = {
      ws: this.ws,
      store: this.store,
      layout: this.layout,
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this.keybinds.install();
    this.ws.connect();
  }
  disconnectedCallback() {
    this.keybinds.uninstall();
    super.disconnectedCallback();
  }

  /** Collect all leaf DOM rects for keyboard neighbor search. */
  _collectRects() {
    const out = new Map();
    const leaves = this.renderRoot.querySelectorAll("foyer-tile-leaf");
    for (const el of leaves) {
      if (el.leaf?.id) out.set(el.leaf.id, el.getBoundingClientRect());
    }
    return out;
  }

  _resolveWsUrl() {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc.host}/ws`;
  }

  render() {
    return html`
      <foyer-status-bar .status=${this._status}></foyer-status-bar>
      <foyer-main-menu></foyer-main-menu>
      <foyer-transport-bar></foyer-transport-bar>
      <div class="main">
        <div class="workspace">
          <foyer-tile-container
            .node=${this.layout.tree}
            .store=${this.layout}
          ></foyer-tile-container>
        </div>
        <foyer-right-dock @resize=${() => this.requestUpdate()}></foyer-right-dock>
      </div>
      <foyer-floating-tiles .store=${this.layout}></foyer-floating-tiles>
      <foyer-agent-panel></foyer-agent-panel>
      <foyer-layout-fab .store=${this.layout}></foyer-layout-fab>
      <foyer-command-palette></foyer-command-palette>
      <foyer-automation-panel></foyer-automation-panel>
    `;
  }
}
customElements.define("foyer-app", FoyerApp);
