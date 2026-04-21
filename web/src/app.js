// Foyer Studio — top-level app shell with tiling layout.

import { LitElement, html, css } from "lit";

import { FoyerWs } from "./ws.js";
import { Store } from "./store.js";
import { applyTheme } from "./theme.js";
import { installTransportReturn } from "./transport-return.js";

import { LayoutStore } from "./layout/layout-store.js";
import { Keybinds } from "./layout/keybinds.js";
import "./layout/tile-container.js";
import "./layout/tile-leaf.js";
import "./layout/floating-tiles.js";
import "./layout/plugin-layer.js";

import "./components/status-bar.js";
import "./components/transport-bar.js";
import "./components/main-menu.js";
import "./components/right-dock.js";
import "./components/agent-panel.js";
import "./components/command-palette.js";
import "./components/layout-fab.js";
import "./components/automation-panel.js";
import "./components/startup-errors.js";
import "./components/backend-lost-modal.js";
import "./components/welcome-screen.js";
import { bootAutomation } from "./components/automation-panel.js";
import { installBindingsRuntime } from "./layout/layout-bindings.js";
import { installSlotKeybinds } from "./layout/slot-keybinds.js";

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
    _sessions: { state: true },
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
    this._sessions = [];

    const wsUrl = this._resolveWsUrl();
    // Window index: today Foyer runs in a single browser window so the
    // index is always 0 and the origin string ends up as "web-0". The
    // indexed shape is in place so when multi-monitor pop-out windows
    // land (TODO.md — "Multi-monitor / multi-window support") each window
    // claims its own slot via `?window=N` without any wire-format change.
    this.windowIndex = this._resolveWindowIndex();
    const originTag = `web-${this.windowIndex}`;
    this.ws = new FoyerWs({ url: wsUrl, origin: originTag });
    this.store = new Store({ selfOrigin: originTag });
    this.store.attach(this.ws);
    // Cross-cutting play/stop post-transport behavior (leave / zero /
    // play_start). Watches the store for transport.playing transitions
    // and issues a `transport.position` controlSet when stop fires —
    // consolidated in one place so transport-bar and the Space keybind
    // don't each need their own copy.
    installTransportReturn({ store: this.store, ws: this.ws });
    this.store.addEventListener("change", () => {
      this._status = this.store.state.status;
      this._session = this.store.state.session;
      this._sessions = this.store.state.sessions;
      // Re-render tile leaves (they read session from window.__foyer.store).
      const root = this.renderRoot.querySelector("foyer-tile-container");
      root?.requestUpdate();
    });
    this.store.addEventListener("sessions", () => {
      this._sessions = this.store.state.sessions;
      this.requestUpdate();
    });

    this.layout = new LayoutStore();
    this.layout.addEventListener("change", () => this.requestUpdate());

    // User-defined chords for layouts (preset or named) fire before Keybinds.
    installBindingsRuntime(this.layout);
    // Rectangle-style slot chords (Ctrl+Alt+Shift+<key>) snap the focused
    // window to a named slot. See web/src/layout/slots.js SLOT_SHORTCUTS
    // for the default map.
    installSlotKeybinds(this.layout);

    this.keybinds = new Keybinds(this.layout, () => this._collectRects());

    window.__foyer = {
      ws: this.ws,
      store: this.store,
      layout: this.layout,
      // Usable area for docking/slot placement: below the top chrome and to
      // the left of the right-dock. Called by slots.js + drop-zones.js so
      // docked windows never overlap the top bars or the right rail.
      workspaceRect: () => this._workspaceRect(),
      // Zero-indexed browser-window slot. Today this is always 0 (one
      // browser window per sidecar); future multi-monitor pop-outs will
      // get 1, 2, … via `?window=N` in the URL.
      windowIndex: this.windowIndex,
    };
  }

  /**
   * Returns the rectangle inside which floating windows should live when
   * docked to a slot. Fallbacks to the full viewport if the DOM isn't
   * ready yet (pre-first-paint).
   */
  _workspaceRect() {
    const main = this.renderRoot?.querySelector(".main");
    if (main) {
      const r = main.getBoundingClientRect();
      // Reserve the FULL right-dock width — rail + any expanded panel +
      // any docked-FAB pop-out that's currently visible. The right-dock is
      // "hallowed ground" (per Rich's framing): a window clamped to
      // left-half must shrink if the right-dock grows. Using the dock's
      // host bounding rect captures rail-only, rail+panel, rail+panel+
      // docked-FAB-sheet — whatever is open at the moment.
      const rd = window.__foyer?.rightDock;
      const dockRect = rd?.outerRect ? rd.outerRect() : null;
      const rightEdge = dockRect ? dockRect.left : r.right;
      return {
        top: r.top,
        left: r.left,
        right: rightEdge,
        bottom: r.bottom,
        width: rightEdge - r.left,
        height: r.bottom - r.top,
      };
    }
    return {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
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

  /**
   * Resolve the zero-indexed window slot for this browser window. Default
   * 0. Override by loading `?window=N` in the URL. Used as the suffix in
   * the WS `origin` tag (`web-0`, `web-1`, …) so the sidecar can tell
   * multiple Foyer windows apart — e.g. one per monitor in a future
   * multi-monitor setup. Non-integer or negative values collapse to 0.
   */
  _resolveWindowIndex() {
    try {
      const raw = new URLSearchParams(window.location.search).get("window");
      if (raw == null || raw === "") return 0;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      return n;
    } catch {
      return 0;
    }
  }

  render() {
    // Welcome screen replaces the tile workspace whenever no real
    // session is attached. We check `sessions.length` (the
    // authoritative multi-session list from the sidecar) rather than
    // `this._session` because the launcher-mode stub backend emits
    // an empty SessionSnapshot that would otherwise look like a
    // valid session. Any orphans + recents still render inside the
    // welcome screen so the user can resolve them without leaving
    // this view.
    const hasSessions = (this._sessions || []).length > 0;
    return html`
      <foyer-status-bar .status=${this._status}></foyer-status-bar>
      <foyer-transport-bar></foyer-transport-bar>
      <div class="main">
        <div class="workspace">
          ${hasSessions ? html`
            <foyer-tile-container
              .node=${this.layout.tree}
              .store=${this.layout}
            ></foyer-tile-container>
          ` : html`
            <foyer-welcome-screen></foyer-welcome-screen>
          `}
        </div>
        <foyer-right-dock @resize=${() => this.requestUpdate()}></foyer-right-dock>
      </div>
      <foyer-plugin-layer .store=${this.layout}></foyer-plugin-layer>
      <foyer-floating-tiles .store=${this.layout}></foyer-floating-tiles>
      <foyer-agent-panel></foyer-agent-panel>
      <foyer-layout-fab .store=${this.layout}></foyer-layout-fab>
      <foyer-command-palette></foyer-command-palette>
      <foyer-automation-panel></foyer-automation-panel>
      <foyer-startup-errors></foyer-startup-errors>
      <foyer-backend-lost-modal></foyer-backend-lost-modal>
    `;
  }
}
customElements.define("foyer-app", FoyerApp);
