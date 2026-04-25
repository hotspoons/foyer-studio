// Top-of-screen main menu — dropdowns grouped by action category, driven by
// the shim's action catalog (via `list_actions`). DAW-agnostic: any host that
// populates its menus into actions shows up here.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { getTransportPref, toggleTransportPref } from "foyer-core/transport-settings.js";
import { showProjectPicker } from "./project-picker-modal.js";
import { openSettings } from "./settings-modal.js";
import { promptText } from "foyer-ui-core/widgets/prompt-modal.js";
import { load as loadRecents, forget as forgetRecent, touch as touchRecent, clearAll as clearRecents } from "foyer-core/recents.js";
import { launchProjectGuarded } from "../session-launch.js";
import { isAllowed, isActionAllowed } from "foyer-core/rbac.js";

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
//
// Only the two core tile-class views (mixer + timeline) belong here.
// Everything else lives in the widgets layer and is spawned via the
// right-dock's widget "+" menu — see `right-dock.js` SPAWNABLE_WIDGETS.
// Project picking is reachable through the Session menu (Open) and the
// welcome screen, both of which open `<foyer-project-picker-modal>`.
const LAUNCH_VIEWS = [
  { view: "mixer",       label: "Mixer",       icon: "adjustments-horizontal" },
  { view: "timeline",    label: "Timeline",    icon: "list-bullet" },
];

export class MainMenu extends LitElement {
  static properties = {
    _actions: { state: true, type: Array },
    _openMenu: { state: true, type: String },
    _rbacTick: { state: true, type: Number },
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
    .item.has-sub { position: relative; }
    .sub-dropdown {
      position: absolute;
      top: -4px;
      left: 100%;
      min-width: 260px;
      max-width: 420px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      box-shadow: var(--shadow-panel);
      padding: 4px;
      border-radius: var(--radius-md);
      z-index: 610;
    }
    .sub-dropdown .item { max-width: 100%; }
    .sub-dropdown .item .label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sub-dropdown .item .forget {
      background: transparent;
      border: 0;
      color: rgba(255,255,255,0.5);
      font-family: var(--font-sans);
      font-size: 14px; line-height: 1;
      padding: 0 4px;
      cursor: pointer;
    }
    .sub-dropdown .item:hover .forget { color: rgba(255,255,255,0.85); }
    .sub-dropdown .sep {
      height: 1px;
      background: var(--color-border);
      margin: 4px 0;
    }

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
    this._rbacTick = 0;
    this._onRbac = () => { this._rbacTick++; };
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
    window.__foyer?.store?.addEventListener("rbac", this._onRbac);
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.removeEventListener("rbac", this._onRbac);
    super.disconnectedCallback();
  }

  /// Only show the Remote Access (tunnel manager) menu item when the
  /// current user can actually invite + revoke tokens. LAN users see
  /// it always; tunnel admins see it; everyone else (viewer/performer/
  /// session_controller) doesn't.
  _canManageTunnels() {
    return isAllowed("tunnel_create_token")
      && isAllowed("tunnel_revoke_token")
      && isAllowed("tunnel_start");
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") {
      this._actions = body.actions || [];
    }
  }

  _byCategory(cat) {
    // Filter by role: actions the current connection can't invoke are
    // hidden from every menu. LAN users see everything; tunnel guests
    // only see what their role permits. See web/src/rbac.js for the
    // per-action mapping.
    return this._actions.filter(a =>
      a.category === cat && isActionAllowed(a.id),
    );
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
    // Client-only view actions — the zoom stack + time-range selection
    // live in the browser, so we handle these without a round trip.
    if (a.id === "view.zoom_selection") {
      document.querySelector("foyer-timeline-view")?.zoomToSelection?.();
      return;
    }
    if (a.id === "view.zoom_previous") {
      document.querySelector("foyer-timeline-view")?.zoomPrevious?.();
      return;
    }
    // Client-orchestrated edit ops: walk the selection and fan out the
    // right per-region commands.
    if (a.id === "edit.delete_selection") {
      document.querySelector("foyer-timeline-view")?.deleteSelection?.();
      return;
    }
    if (a.id === "edit.mute_selection") {
      document.querySelector("foyer-timeline-view")?.muteSelection?.();
      return;
    }
    // Preferences is a client-side settings modal — no round trip.
    if (a.id === "settings.preferences") {
      openSettings();
      return;
    }
    // Save As → prompt for filename, emit the richer `save_session`
    // command (carries the path). Plain Save falls through to the
    // InvokeAction path below, where the shim's `session.save`
    // handler calls `save_state("")` (save-in-place).
    if (a.id === "session.save_as") {
      (async () => {
        const ws = window.__foyer?.ws;
        if (!ws) return;
        const name = await promptText({
          title: "Save session as",
          label: "Filename (relative to session dir, or absolute path)",
          placeholder: "my-session.ardour",
          confirmLabel: "Save As",
        });
        if (name == null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        ws.send({ type: "save_session", as_path: trimmed });
      })();
      return;
    }
    // Export: not wired end-to-end yet. Surface a short toast-style
    // hint instead of silence so the user knows the verb is known
    // but the pipeline is still TODO.
    if (a.id === "session.export") {
      const toast = document.createElement("div");
      toast.textContent = "Export isn't wired yet — use Ardour's native Export dialog for now.";
      toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--color-surface);border:1px solid var(--color-border);color:var(--color-text);padding:10px 16px;border-radius:6px;z-index:9999;font-family:var(--font-sans);font-size:12px;box-shadow:0 4px 18px rgba(0,0,0,.5)";
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3200);
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
          ${cat === "session" ? this._renderRecentSubmenu() : null}
          ${cat === "session" && this._canManageTunnels() ? html`
            <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
            <div class="item" @click=${() => { this._openMenu = ""; import("./tunnel-manager-modal.js").then((m) => m.openTunnelManager()); }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("globe-alt", 11)}</span>
              <span class="label">Remote Access…</span>
              <span class="shortcut">Share</span>
            </div>
          ` : null}
          ${cat === "track" ? html`
            <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
            <div class="item" @click=${() => { this._openMenu = ""; import("./group-manager-modal.js").then((m) => m.openGroupManager()); }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("users", 11)}</span>
              <span class="label">Group Manager…</span>
            </div>
          ` : null}
        </div>
      ` : null}
    `;
  }

  /** Client-side "Open Recent" cascade appended to the Session menu.
   *  Reads the per-browser recents list (recents.js) and turns each
   *  entry into a LaunchProject dispatch. Recents are tracked by
   *  `SessionOpened` in the store, so opening an entry here
   *  automatically promotes it to the top next time the menu opens. */
  _renderRecentSubmenu() {
    // Opening a recent project invokes `launch_project` server-side;
    // hide the whole submenu if the current role can't swap sessions
    // (tunnel guests of any non-admin role).
    if (!isAllowed("launch_project")) return null;
    const recents = loadRecents();
    if (recents.length === 0) {
      return html`
        <div class="item disabled" style="opacity:0.55">
          <span style="width:14px"></span>
          <span class="label">Open Recent…</span>
          <span class="shortcut">empty</span>
        </div>
      `;
    }
    return html`
      <div class="item has-sub"
           @mouseenter=${(e) => { this._recentOpen = true; this.requestUpdate(); }}
           @mouseleave=${(e) => { this._recentOpen = false; this.requestUpdate(); }}>
        <span style="width:14px"></span>
        <span class="label">Open Recent…</span>
        <span class="shortcut">▸</span>
        ${this._recentOpen ? html`
          <div class="sub-dropdown">
            ${recents.map((r) => html`
              <div class="item" title=${r.path}
                   @click=${(e) => { e.stopPropagation(); this._openRecent(r); }}>
                <span style="width:14px"></span>
                <span class="label">${r.name || r.path}</span>
                <button class="forget"
                        title="Forget this entry"
                        @click=${(e) => { e.stopPropagation(); forgetRecent(r.path); this.requestUpdate(); }}>×</button>
              </div>
            `)}
            <div class="sep"></div>
            <div class="item" @click=${(e) => { e.stopPropagation(); clearRecents(); this.requestUpdate(); }}>
              <span style="width:14px"></span>
              <span class="label" style="color:var(--color-danger,#ef4444)">Clear list</span>
            </div>
          </div>
        ` : null}
      </div>
    `;
  }

  _openRecent(entry) {
    this._openMenu = "";
    this._recentOpen = false;
    if (!entry?.path) return;
    touchRecent(entry);
    launchProjectGuarded({
      backend_id: entry.backend_id || "ardour",
      project_path: entry.path,
    });
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
