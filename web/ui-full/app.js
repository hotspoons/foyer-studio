// SPDX-License-Identifier: Apache-2.0
// Foyer Studio — top-level app shell with tiling layout.
//
// This is the shipping Foyer UI (`foyer-ui`). It consumes foyer-core
// (state + ws + registries) and foyer-ui-core (tiling + widgets).
// Alternate UIs replace this entry and its components; core and
// ui-core stay as-is.

import { LitElement, html, css } from "lit";

import { FoyerWs } from "foyer-core/ws.js";
import { Store } from "foyer-core/store.js";
import { applyTheme } from "foyer-ui-core/theme.js";
import { installTransportReturn } from "foyer-core/transport-return.js";

import { LayoutStore } from "foyer-ui-core/layout/layout-store.js";
import { Keybinds } from "foyer-ui-core/layout/keybinds.js";
import "foyer-ui-core/layout/tile-container.js";
import "foyer-ui-core/layout/tile-leaf.js";
import "foyer-ui-core/layout/floating-tiles.js";
import "foyer-ui-core/layout/plugin-layer.js";

// View tags — these register themselves via side-effect import.
// nav-bar.js also publishes them to foyer-core's view registry, and
// tile-leaf creates them on-demand by tag at render time.
import "./components/nav-bar.js";
import "./components/mixer.js";
import "./components/timeline-view.js";
import "./components/plugins-view.js";
import "./components/session-view.js";
import "./components/console-view.js";
import "./components/diagnostics.js";

import "./components/status-bar.js";
import "./components/transport-bar.js";
import "./components/main-menu.js";
import "./components/right-dock.js";
import "./components/agent-panel.js";
import "./components/chat-panel.js";
import "./components/actions-fab.js";
import "./components/session-info-fab.js";
import "./components/windows-fab.js";
import "./components/command-palette.js";
import "./components/layout-fab.js";
import "./components/automation-panel.js";
import "./components/startup-errors.js";
import "./components/backend-lost-modal.js";
import "./components/login-modal.js";
import "./components/welcome-screen.js";
// Plugin UI tag — ui-core's plugin-layer + floating-tiles render
// `<foyer-plugin-panel>` but don't import it (the tag belongs to the
// UI layer). Without this side-effect import the plugin float's
// body shows up as an empty black rectangle.
import "./components/plugin-panel.js";
import { bootAutomation } from "./components/automation-panel.js";
import { installBindingsRuntime } from "foyer-ui-core/layout/layout-bindings.js";
import { installSlotKeybinds } from "foyer-ui-core/layout/slot-keybinds.js";

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
    _projectLaunching: { state: true },
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
    .launch-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: color-mix(in oklab, var(--color-surface) 92%, transparent);
      backdrop-filter: blur(10px);
      color: var(--color-text);
      font-family: var(--font-sans);
      pointer-events: auto;
    }
    .launch-overlay .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid color-mix(in oklab, var(--color-accent) 30%, transparent);
      border-top-color: var(--color-accent);
      border-radius: 50%;
      animation: foyer-app-launch-spin 0.85s linear infinite;
    }
    .launch-overlay .title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.06em;
      color: var(--color-text-muted);
    }
    .launch-overlay .path {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-accent-3);
      max-width: min(560px, 90vw);
      text-align: center;
      word-break: break-all;
    }
    @keyframes foyer-app-launch-spin {
      to { transform: rotate(360deg); }
    }
  `;

  constructor() {
    super();
    this._projectLaunching = false;
    this._launchPath = "";

    // Core already created store + ws and wired them via bootFoyerCore
    // (see /boot.js). Reuse them so we don't double-subscribe or
    // double-connect. When running the app standalone (tests), fall
    // back to building our own so existing test harnesses keep working.
    this.windowIndex = this._resolveWindowIndex();
    const originTag = `web-${this.windowIndex}`;
    if (globalThis.__foyer?.store && globalThis.__foyer?.ws) {
      this.ws = globalThis.__foyer.ws;
      this.store = globalThis.__foyer.store;
    } else {
      const wsUrl = this._resolveWsUrl();
      this.ws = new FoyerWs({ url: wsUrl, origin: originTag });
      this.store = new Store({ selfOrigin: originTag });
      this.store.attach(this.ws);
      installTransportReturn({ store: this.store, ws: this.ws });
    }
    // Prime from the store's current state — bootstrap creates the
    // store + ws before mounting this element, so greeting +
    // session_list can land *before* our listener attaches and fire
    // `sessions` into the void. Over a tunnel where the greeting is
    // a few hundred ms slower than the render-ready signal, this is
    // the common path. Without priming, `hasSessions` is `false`
    // even with sessions open and the welcome screen gets stuck.
    this._status = this.store.state.status || "idle";
    this._session = this.store.state.session || null;
    this._sessions = this.store.state.sessions || [];
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

    this._onProjectLaunchStart = () => {
      this._projectLaunching = true;
      this.requestUpdate();
    };
    this._onWsEnvelope = (ev) => {
      const b = ev.detail?.body;
      if (!b) return;
      if (
        b.type === "backend_swapped"
        || (b.type === "error" && b.code === "launch_failed")
      ) {
        this._projectLaunching = false;
        this._launchPath = "";
        this.requestUpdate();
      }
    };
    this.ws.addEventListener("project_launch_start", (ev) => {
      this._launchPath = ev.detail?.project_path || "";
      this._onProjectLaunchStart();
    });
    this.ws.addEventListener("envelope", this._onWsEnvelope);

    // Extend the global __foyer (bootstrap populated ws+store already;
    // we attach the UI-owned handles — layout store, workspace rect,
    // window index). Use Object.assign so we don't clobber what core
    // set up.
    Object.assign(window.__foyer = window.__foyer || {}, {
      ws: this.ws,
      store: this.store,
      layout: this.layout,
      workspaceRect: () => this._workspaceRect(),
      windowIndex: this.windowIndex,
    });
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
    // When this element was created by the bootstrap the ws is already
    // connected (or connecting). Only dial when we built our own ws as
    // a standalone fallback.
    const ownedWs = !(globalThis.__foyer?.ws === this.ws && this.ws._ws);
    if (ownedWs) this.ws.connect();
  }
  disconnectedCallback() {
    this.ws.removeEventListener("envelope", this._onWsEnvelope);
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
      ${this._projectLaunching ? html`
        <div class="launch-overlay" aria-busy="true" aria-live="polite">
          <div class="spinner"></div>
          <div class="title">Opening project…</div>
          ${this._launchPath
            ? html`<div class="path">${this._launchPath}</div>`
            : null}
        </div>
      ` : null}
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
      <foyer-chat-panel></foyer-chat-panel>
      <foyer-actions-fab></foyer-actions-fab>
      <foyer-session-fab></foyer-session-fab>
      <foyer-windows-fab></foyer-windows-fab>
      <foyer-layout-fab .store=${this.layout}></foyer-layout-fab>
      <foyer-command-palette></foyer-command-palette>
      <foyer-automation-panel></foyer-automation-panel>
      <foyer-startup-errors></foyer-startup-errors>
      <foyer-backend-lost-modal></foyer-backend-lost-modal>
      <foyer-login-modal></foyer-login-modal>
    `;
  }
}
customElements.define("foyer-app", FoyerApp);
