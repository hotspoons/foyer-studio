import { LitElement, html, css } from "lit";

import { icon } from "foyer-ui-core/icons.js";
import { cycleTheme, getTheme, onThemeChange, THEME_META } from "foyer-ui-core/theme.js";
import { promptText } from "foyer-ui-core/widgets/prompt-modal.js";
import { showShareModal } from "foyer-ui-core/widgets/share-modal.js";
import "./main-menu.js";
import "./session-switcher.js";

export class StatusBar extends LitElement {
  static properties = {
    status: { type: String },
    _theme: { state: true, type: String },
    _fullscreen: { state: true, type: Boolean },
    _peers: { state: true, type: Array },
    _layoutTick: { state: true, type: Number },
    _greeting: { state: true, type: Object },
    _rbac: { state: true, type: Object },
    _peersOpen: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
      gap: 10px;
      padding: 0 14px;
      font-size: 11px;
      color: var(--color-text-muted);
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      position: relative;
      /* Above floating tiles AND transport bar so the embedded
       * <foyer-main-menu>'s dropdowns paint over everything below. */
      z-index: 1300;
      min-height: 34px;
    }
    .pad { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
    foyer-main-menu {
      align-self: stretch;
      /* Dropdowns inside main-menu use position:absolute relative to their
       * own row and inherit our z-index stacking context. */
    }
    .brand {
      font-family: var(--font-sans);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.14em;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--color-text-muted);
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.3);
    }
    .dot.open   { background: var(--color-success); box-shadow: 0 0 10px rgba(34, 197, 94, 0.45); }
    .dot.closed { background: var(--color-text-muted); }
    .dot.error  { background: var(--color-danger);  box-shadow: 0 0 10px rgba(239, 68, 68, 0.45); }
    .label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
    .conn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
    }
    .conn.local { color: var(--color-success); border-color: color-mix(in oklab, var(--color-success) 40%, transparent); }
    .conn.remote { color: var(--color-warning); border-color: color-mix(in oklab, var(--color-warning) 40%, transparent); }
    .conn .tag { text-transform: uppercase; letter-spacing: 0.08em; font-size: 9px; }
    .share-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-family: var(--font-sans);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      cursor: pointer;
    }
    .share-btn:hover {
      color: var(--color-accent-3);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 12%, transparent);
    }
    .spacer { flex: 1; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-size: 10px;
      font-family: var(--font-sans);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
      background: var(--color-surface-elevated);
    }
    .peers {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--color-accent-3);
      padding: 2px 8px;
      border: 1px solid color-mix(in oklab, var(--color-accent) 40%, var(--color-border));
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
      position: relative;
      cursor: pointer;
    }
    .peer-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--color-accent-3);
      box-shadow: 0 0 6px color-mix(in oklab, var(--color-accent) 40%, transparent);
    }
    .peers-popover {
      position: absolute; bottom: 100%; left: 0; margin-bottom: 4px;
      min-width: 220px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      z-index: 100;
      text-transform: none; letter-spacing: normal;
    }
    .peers-popover .pl-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 6px;
      font-size: 11px;
      color: var(--color-text);
    }
    .peers-popover .pl-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }
    .peers-popover .pl-dot.remote { background: var(--color-accent-3); }
    .peers-popover .pl-label {
      flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .peers-popover .pl-role {
      font-size: 9px; color: var(--color-text-muted);
      text-transform: uppercase; letter-spacing: 0.1em;
    }
    .role-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
      padding: 2px 8px;
      border: 1px solid var(--color-border);
      border-radius: 999px;
    }
    .role-chip.unauthenticated {
      color: var(--color-danger);
      border-color: color-mix(in oklab, var(--color-danger) 60%, var(--color-border));
    }
    .layout-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; letter-spacing: 0.06em;
      padding: 2px 8px;
      border: 1px solid var(--color-border);
      border-radius: 999px;
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.12s ease;
      font-family: var(--font-sans);
    }
    .layout-chip:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
    }
    .layout-chip.dirty {
      color: var(--color-warning);
      border-color: color-mix(in oklab, var(--color-warning) 60%, var(--color-border));
      background: color-mix(in oklab, var(--color-warning) 10%, transparent);
    }
    .layout-chip.dirty::before {
      content: "";
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--color-warning);
      box-shadow: 0 0 6px color-mix(in oklab, var(--color-warning) 60%, transparent);
    }
    .ingress-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: transparent; border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); color: var(--color-text-muted);
      padding: 2px 8px; font: inherit; font-size: 10px;
      letter-spacing: 0.06em; text-transform: uppercase;
      cursor: pointer; transition: all 0.15s ease;
    }
    .ingress-chip.on {
      color: var(--color-danger);
      border-color: color-mix(in oklab, var(--color-danger) 50%, transparent);
      background: color-mix(in oklab, var(--color-danger) 10%, transparent);
    }
    .ingress-chip:hover { border-color: var(--color-accent); }
  `;

  constructor() {
    super();
    this._theme = getTheme();
    this._fullscreen = !!document.fullscreenElement;
    this._peers = [];
    this._layoutTick = 0;
    this._offThemeChange = null;
    this._onFsChange = () => { this._fullscreen = !!document.fullscreenElement; };
    this._onPeers = () => {
      const store = window.__foyer?.store;
      this._peers = store?.activePeers?.() || [];
    };
    this._onLayoutChange = () => { this._layoutTick++; };
    this._greeting = null;
    this._rbac = { isTunnel: false, isAuthenticated: true, roleId: null, recipient: null };
    this._peersOpen = false;
    this._onRbac = () => {
      this._rbac = window.__foyer?.store?.rbac?.() || this._rbac;
    };
    this._onDocClick = () => { if (this._peersOpen) this._peersOpen = false; };
    this._onEnvelope = (ev) => {
      const body = ev.detail?.body;
      if (body?.type === "client_greeting") {
        this._greeting = {
          remoteAddr: body.remote_addr,
          isLocal: !!body.is_local,
          serverHost: body.server_host || "",
          serverPort: body.server_port || 0,
          serverUrls: body.server_urls || [],
        };
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._offThemeChange = onThemeChange(() => { this._theme = getTheme(); });
    document.addEventListener("fullscreenchange", this._onFsChange);
    window.__foyer?.store?.addEventListener("peers", this._onPeers);
    window.__foyer?.store?.addEventListener("rbac", this._onRbac);
    window.__foyer?.layout?.addEventListener("change", this._onLayoutChange);
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    // Re-render on any store change so the "Unsaved" chip reflects
    // Session.dirty flips without polling.
    this._onStoreChange = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("change", this._onStoreChange);
    document.addEventListener("pointerdown", this._onDocClick);
    // Hydrate from whatever the store already knows (modal opened
    // after greeting arrived).
    this._onPeers();
    this._onRbac();
  }
  disconnectedCallback() {
    this._offThemeChange?.();
    document.removeEventListener("fullscreenchange", this._onFsChange);
    window.__foyer?.store?.removeEventListener("peers", this._onPeers);
    window.__foyer?.store?.removeEventListener("rbac", this._onRbac);
    window.__foyer?.layout?.removeEventListener("change", this._onLayoutChange);
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    window.__foyer?.store?.removeEventListener("change", this._onStoreChange);
    document.removeEventListener("pointerdown", this._onDocClick);
    super.disconnectedCallback();
  }

  _toggleTheme() {
    this._theme = cycleTheme();
  }

  _renderConnChip() {
    const g = this._greeting;
    if (!g) return null;
    const cls = g.isLocal ? "local" : "remote";
    const tag = g.isLocal ? "local" : "remote";
    const title = g.isLocal
      ? `Connected from ${g.remoteAddr}${g.serverHost ? ` (sidecar @ ${g.serverHost})` : ""}`
      : `Remote session — client at ${g.remoteAddr}${g.serverHost ? `, sidecar @ ${g.serverHost}` : ""}`;
    const canShare = g.isLocal && (g.serverUrls?.length > 0);
    return html`
      <span class="conn ${cls}" title=${title}>
        <span class="tag">${tag}</span>
      </span>
      ${canShare ? html`
        <button
          class="share-btn"
          title="Share this session with another device on the LAN"
          @click=${() => showShareModal(g.serverUrls)}
        >
          ${icon("arrow-top-right-on-square", 12)}
          <span>Share</span>
        </button>
      ` : null}
    `;
  }

  _renderSessionDirty() {
    const s = window.__foyer?.store?.state?.session;
    if (!s?.dirty) return null;
    return html`
      <span class="conn" title="Session has unsaved changes"
            style="color: var(--color-warning); border-color: color-mix(in oklab, var(--color-warning) 60%, var(--color-border));">
        <span style="width:6px; height:6px; border-radius:50%; background: var(--color-warning);
                     box-shadow: 0 0 6px color-mix(in oklab, var(--color-warning) 60%, transparent);"></span>
        <span>Unsaved</span>
      </span>
    `;
  }

  _renderLayoutChip() {
    void this._layoutTick; // touch the tick prop so Lit re-renders on change
    const layout = window.__foyer?.layout;
    if (!layout) return null;
    const dirty = layout.isDirty?.();
    const id = layout.currentLayoutIdentity?.();
    // Hide entirely when the user hasn't diverged from their last load.
    if (!dirty && !id) return null;
    const label = dirty
      ? (id ? `Save "${id.name}"` : "Save layout")
      : `layout: ${id.name}`;
    const title = dirty
      ? (id
          ? `Current layout differs from "${id.name}" — click to save`
          : "You have an unsaved layout — click to save")
      : `Loaded ${id.kind} "${id.name}"`;
    return html`
      <button
        class="layout-chip ${dirty ? "dirty" : ""}"
        title=${title}
        @click=${this._saveLayout}
      >
        ${label}
      </button>
    `;
  }

  _saveLayout = async () => {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    const id = layout.currentLayoutIdentity?.();
    // If the active baseline is a named layout, default to overwriting it.
    // If it's a preset, suggest `<preset>-custom`. Otherwise freeform.
    let suggestion;
    let message;
    if (id?.kind === "named") {
      suggestion = id.name;
      message = `Press Save to overwrite "${id.name}", or give it a new name to create a copy.`;
    } else if (id?.kind === "preset") {
      suggestion = `${id.name}-custom`;
      message = `You've modified the "${id.name}" preset. Save as a new named layout:`;
    } else {
      suggestion = "my-layout";
      message = "Name your current tile arrangement so you can recall it from the layout FAB.";
    }
    const name = (await promptText({
      title: "Save layout",
      message,
      placeholder: "layout name…",
      defaultValue: suggestion,
      confirmLabel: "Save",
    }))?.trim();
    if (!name) return;
    layout.saveNamed(name);
  };

  _toggleFullscreen() {
    if (this._fullscreen) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }

  render() {
    const s = this.status || "idle";
    const meta = THEME_META[this._theme] || THEME_META.dim;
    return html`
      <div class="pad">
        <span class="brand">FOYER</span>
        <span class="dot ${s}"></span>
        <span class="label">${s}</span>
        ${this._peers.length
          ? html`<span
              class="peers"
              @click=${(e) => { e.stopPropagation(); this._peersOpen = !this._peersOpen; }}
            >
              <span class="peer-dot"></span>
              ${this._peers.length} peer${this._peers.length === 1 ? "" : "s"}
              ${this._peersOpen ? html`
                <div class="peers-popover" @click=${(e) => e.stopPropagation()}>
                  ${this._peers.map((p) => html`
                    <div class="pl-row">
                      <span class="pl-dot ${p.is_local ? "" : "remote"}"></span>
                      <span class="pl-label">${p.label || p.remote_addr || "—"}</span>
                      <span class="pl-role">${p.role_id || (p.is_local ? "host" : "guest")}</span>
                    </div>
                  `)}
                </div>
              ` : null}
            </span>`
          : null}
        ${this._rbac.isTunnel ? html`
          <span class="role-chip ${this._rbac.isAuthenticated ? "" : "unauthenticated"}">
            ${this._rbac.isAuthenticated
              ? html`${this._rbac.recipient || "guest"} · ${this._rbac.roleId || "?"}`
              : html`not signed in`}
          </span>
        ` : null}
        ${this._renderConnChip()}
        <foyer-session-switcher></foyer-session-switcher>
        ${this._renderSessionDirty()}
        ${this._renderLayoutChip()}
      </div>
      <!-- DAW application menus (Session / Edit / Transport / Track / Plugin /
           Settings) and the "New view" launcher share this row so we don't
           burn a second row of chrome on a handful of buttons. -->
      <foyer-main-menu></foyer-main-menu>
      <div class="pad" style="margin-left:auto">
        <button
          title=${this._fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          @click=${this._toggleFullscreen}
        >
          ${icon(this._fullscreen ? "arrow-collapse" : "arrow-expand", 14)}
          <span>${this._fullscreen ? "Restore" : "Full"}</span>
        </button>
        <button title="Theme: ${meta.label}" @click=${this._toggleTheme}>
          ${icon(meta.icon, 14)}
          <span>${meta.label}</span>
        </button>
      </div>
    `;
  }
}
customElements.define("foyer-status-bar", StatusBar);
