// Top-of-screen main menu — dropdowns grouped by action category, driven by
// the shim's action catalog (via `list_actions`). DAW-agnostic: any host that
// populates its menus into actions shows up here.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { getTransportPref, toggleTransportPref } from "foyer-core/transport-settings.js";
import { t, tn, onLocaleChange } from "/core/i18n.js";
import { showProjectPicker } from "./project-picker-modal.js";
import { openSaveSessionAs } from "./save-session-as-modal.js";
import { openSettings } from "./settings-modal.js";
import { confirmChoice } from "foyer-ui-core/widgets/confirm-modal.js";
import { load as loadRecents, forget as forgetRecent, touch as touchRecent, clearAll as clearRecents } from "foyer-core/recents.js";
import { launchProjectGuarded } from "foyer-ui-core/session-launch.js";
import { isAllowed, isActionAllowed, isActionHiddenFromCatalog } from "foyer-core/rbac.js";

// Walk shadow roots to find a custom element. The timeline lives ≥2
// shadow roots deep (foyer-app → tile-container → tile-leaf →
// foyer-timeline-view), and `document.querySelector` doesn't pierce
// shadow boundaries — so client-side menu actions like Cut/Copy/Paste
// silently no-op'd before this helper. Mirrors `queryDeep` in
// ui-core/layout/keybinds.js so menu and keybind paths share the same
// resolution logic.
function findTimeline() {
  const walk = (root) => {
    const found = root.querySelector("foyer-timeline-view");
    if (found) return found;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const nested = walk(el.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(document);
}

// Category → menu label + order. Categories not listed are skipped.
//
// Transport is intentionally absent — every action there is already
// reachable from the always-visible transport bar, so a Transport menu
// just duplicates buttons two pixels apart. View is absent because the
// layout FAB owns view spawning and tile arrangement; the old View menu
// items hooked into a stub backend handler that never landed.
const MENU_ORDER = [
  { cat: "session",   label: "Session"   },
  { cat: "edit",      label: "Edit"      },
  { cat: "track",     label: "Track"     },
];

// `MENU_ORDER` carries its labels as plain strings so the menu code
// stays declarative. Translation happens at render time via
// `t(label)` — which means the `just i18n-extract` regex (it harvests
// string-literal first args only) never sees these. Park the
// literals here so the extractor picks them up and adds them to the
// catalog. The lambda is dead code; the call sites that matter live
// on the render path.
// eslint-disable-next-line no-unused-vars
const _i18nMenuLabels = () => [t("Session"), t("Edit"), t("Track")];

// Same trick for action-catalog labels coming off the wire. The
// backend's `list_actions` ships them as English strings; we
// translate them at render time via `t(a.label)`. Register them
// here so the extractor harvests them for the catalogs.
// eslint-disable-next-line no-unused-vars
const _i18nActionLabels = () => [
  t("New Session…"),
  t("Open Session…"),
  t("Save Session"),
  t("Save Session As…"),
  t("Export Project…"),
  t("Upload Project…"),
  t("Quantize"),
  t("Crop to selection"),
  t("Snap fades to overlap"),
  t("Clear fades"),
  t("Reset gain"),
  t("Glue"),
  t("Reverse audio"),
  t("Strip silence"),
  t("Pitch shift"),
  t("Bring to front"),
  t("Bring forward"),
  t("Send backward"),
  t("Send to back"),
  t("Group regions"),
  t("Add to group"),
  t("Ungroup"),
  t("Add track"),
  t("Add audio track"),
  t("Add MIDI track"),
  t("Add bus"),
  t("Add audio bus"),
  t("Add stereo audio track"),
  t("Add mono audio track"),
  t("Add stereo bus"),
  t("Add mono bus"),
  t("Delete selected tracks"),
  t("Duplicate selected tracks"),
  t("Add new region"),
  t("Add region at playhead"),
  t("Insert region"),
  t("Loop selection"),
  t("Loop region"),
  t("Toggle metronome"),
  t("Save snapshot"),
  t("Save snapshot (switch to copy)"),
  t("Save snapshot (stay on current)"),
  t("New from template"),
  t("New session from template"),
  t("Show/Hide editor list"),
];

// The "+ New" tile launcher used to live here — a button that
// spawned Mixer / Timeline as floating windows or tile splits. The
// layout FAB on the right rail now owns that affordance (preset
// layouts pin the same views), and the always-visible workspace
// already paints the mixer + timeline by default. The launcher's
// only effect was eating chrome real-estate; removed.

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
    this._onPrefsKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key !== ",") return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
          || (t && t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      openSettings();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocDown, true);
    document.addEventListener("keydown", this._onPrefsKey, true);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
    window.__foyer?.store?.addEventListener("rbac", this._onRbac);
    // Sessions add/remove flips Close Session between enabled and
    // disabled and changes the "Close Session — <name>" suffix; the
    // switcher dispatches "sessions" on every list/open/close event.
    this._onSessions = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("sessions", this._onSessions);
    // Open Recent submenu reads from the server-tracked recents
    // cache; re-render when the cache flips.
    this._onRecents = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("recents", this._onRecents);
    this._i18nDispose = onLocaleChange(() => this.requestUpdate());
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    document.removeEventListener("keydown", this._onPrefsKey, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.removeEventListener("rbac", this._onRbac);
    window.__foyer?.store?.removeEventListener("sessions", this._onSessions);
    window.__foyer?.store?.removeEventListener("recents", this._onRecents);
    this._i18nDispose?.();
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
    let list = this._actions.filter((a) => {
      if (!isActionAllowed(a.id) || isActionHiddenFromCatalog(a)) return false;
      // Preferences lives under Edit via a fixed menu row (see
      // `_renderMenu`), not from whatever categories the host lists.
      if (a.id === "session.preferences") return false;
      return a.category === cat;
    });
    if (cat === "session") {
      list = this._ensureSessionSaveAsInMenu(list);
    }
    return list;
  }

  /** Save As is client-driven (`save_session` + jail picker). The stub catalog
   *  omits it and older shims may too — keep the menu honest next to Save. */
  _ensureSessionSaveAsInMenu(list) {
    if (!isActionAllowed("session.save_as")) return list;
    if (list.some((a) => a.id === "session.save_as")) return list;
    const row = {
      id:           "session.save_as",
      label:        "Save Session As…",
      category:     "session",
      icon:         "document-duplicate",
      shortcut:     "Cmd+Shift+S",
      enabled:      true,
      description:  undefined,
    };
    const idx = list.findIndex((a) => a.id === "session.save");
    if (idx >= 0) {
      const out = [...list];
      out.splice(idx + 1, 0, row);
      return out;
    }
    return [...list, row];
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
      findTimeline()?.zoomToSelection?.();
      return;
    }
    if (a.id === "view.zoom_previous") {
      findTimeline()?.zoomPrevious?.();
      return;
    }
    // Client-orchestrated edit ops: walk the selection and fan out the
    // right per-region commands. cut/copy/paste are pure client-side
    // (the shim's edit.cut/copy/paste handlers are unreachable from
    // headless hardour, dispatch.cc:2761-2762), so we intercept here
    // rather than firing `invoke_action` to a no-op backend.
    if (a.id === "edit.cut") {
      findTimeline()?.cutRegionSelection?.();
      return;
    }
    if (a.id === "edit.copy") {
      findTimeline()?.copyRegionSelection?.();
      return;
    }
    if (a.id === "edit.paste") {
      findTimeline()?.pasteRegions?.({ at: "mouse" });
      return;
    }
    // Preferences is a client-side settings modal — no round trip.
    if (a.id === "session.preferences") {
      openSettings();
      return;
    }
    // Save As → jail browser + new folder name (cannot enter existing sessions).
    if (a.id === "session.save_as") {
      openSaveSessionAs();
      return;
    }
    // Export: save the open session, then download a tar.gz of its
    // jail-relative folder via `/sessions/export`.
    if (a.id === "session.export") {
      import("./project-archive-modal.js").then((m) => m.exportCurrentSession());
      return;
    }
    // Upload: dest-folder picker + archive picker → POST to
    // `/sessions/upload`. Resulting project is offered for one-click
    // open from the success card.
    if (a.id === "session.upload") {
      import("./project-archive-modal.js").then((m) => m.showUploadModal());
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
      ${MENU_ORDER.map(({ cat, label }) => {
        const items = this._byCategory(cat);
        // Session always has hard-coded rows; Edit always has Preferences
        // (codec, sample rate, etc.) even if `list_actions` omits it.
        const editHasPrefsOnly = cat === "edit" && items.length === 0;
        if (!items.length && cat !== "session" && !editHasPrefsOnly) return null;
        return this._renderMenu(cat, label, items);
      })}
    `;
  }

  _renderMenu(cat, label, items) {
    const open = this._openMenu === cat;
    return html`
      <button class="btn ${open ? 'open' : ''}"
              @click=${() => { this._openMenu = open ? "" : cat; }}
              @mouseenter=${() => { if (this._openMenu) this._openMenu = cat; }}>
        ${t(label)}
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
                <span class="label">${t(a.label)}</span>
                ${a.shortcut ? html`<span class="shortcut">${a.shortcut}</span>` : null}
              </div>
            `;
          })}
          ${cat === "edit" ? this._renderEditPreferencesItem(items.length > 0) : null}
          ${cat === "edit" ? this._renderEditRegionSection() : null}
          ${cat === "session" ? this._renderRecentSubmenu() : null}
          ${cat === "session" && isAllowed("list_audio_pool") ? html`
            <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
            <div class="item" @click=${() => {
              this._openMenu = "";
              import("./audio-pool-modal.js").then((m) => m.openAudioPoolModal());
            }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("musical-note", 11)}</span>
              <span class="label">${t("Audio pool…")}</span>
            </div>
            <div class="item" @click=${() => {
              this._openMenu = "";
              import("foyer-ui-core/widgets/window.js").then((m) => m.spawnWindowKind("midi-devices"));
            }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("musical-note", 11)}</span>
              <span class="label">${t("MIDI devices…")}</span>
            </div>
            <div class="item" @click=${() => {
              this._openMenu = "";
              import("foyer-ui-core/widgets/window.js").then((m) => m.spawnWindowKind("soft-keyboard"));
            }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("musical-note", 11)}</span>
              <span class="label">${t("On-screen keyboard…")}</span>
            </div>
          ` : null}
          ${cat === "session" ? this._renderCloseSessionItem() : null}
          ${cat === "session" && this._canManageTunnels() ? html`
            <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
            <div class="item" @click=${() => { this._openMenu = ""; import("./tunnel-manager-modal.js").then((m) => m.openTunnelManager()); }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("globe-alt", 11)}</span>
              <span class="label">${t("Remote Access…")}</span>
              <span class="shortcut">${t("Share")}</span>
            </div>
          ` : null}
          ${cat === "track" ? html`
            <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
            <div class="item" @click=${() => { this._openMenu = ""; import("./group-manager-modal.js").then((m) => m.openGroupManager()); }}>
              <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("users", 11)}</span>
              <span class="label">${t("Group Manager…")}</span>
            </div>
          ` : null}
        </div>
      ` : null}
    `;
  }

  /// Browser settings (codec, sample rate, …) — not tied to the shim's
  /// `list_actions` catalog because many hosts omit `session.preferences`.
  _renderEditPreferencesItem(withSep) {
    return html`
      ${withSep ? html`<div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>` : null}
      <div class="item" @click=${() => {
        this._openMenu = "";
        openSettings();
      }}>
        <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("cog-6-tooth", 11)}</span>
        <span class="label">${t("Preferences…")}</span>
        <span class="shortcut">⌘ ,</span>
      </div>
    `;
  }

  /**
   * Contextual "Region" section under the Edit menu. Appears only when
   * the timeline has at least one selected region — keeps the menu
   * lean otherwise. Each item dispatches against the same timeline
   * methods the toolbar/context menu use, so behavior is one source of
   * truth. (TODO #62 — surface region options outside the timeline
   * context menu so they're discoverable from the menu bar too.)
   */
  _renderEditRegionSection() {
    const tl = this._findTimeline();
    const ids = tl?.getSelectedRegionIds?.() || [];
    if (!ids.length) return null;
    const nSel = ids.length;
    const actions = tl?._regionEditMenuActions?.();
    if (!Array.isArray(actions) || !actions.length) return null;
    const close = () => { this._openMenu = ""; };
    return html`
      <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
      <div class="item disabled" style="opacity:0.55;pointer-events:none;font-size:10px;letter-spacing:0.05em;text-transform:uppercase">
        <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto"></span>
        <span class="label">${nSel === 1 ? t("Region") : tn("%{count} region", "%{count} regions", nSel)}</span>
      </div>
      ${actions.map((a) => a.separator
        ? html`<div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>`
        : html`
          <div class="item ${a.disabled ? "disabled" : ""}"
               title=${a.title || ""}
               @click=${() => { if (a.disabled) return; close(); a.action?.(); }}>
            <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">
              ${a.icon ? icon(a.icon, 11) : null}
            </span>
            <span class="label">${t(a.label)}</span>
          </div>
        `)}
    `;
  }

  /** Walk shadow roots once to find the active timeline-view. */
  _findTimeline() {
    const walk = (root) => {
      const hit = root.querySelector("foyer-timeline-view");
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const nested = walk(el.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    };
    return walk(document);
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
          <span class="label">${t("Open Recent…")}</span>
          <span class="shortcut">${t("empty")}</span>
        </div>
      `;
    }
    return html`
      <div class="item has-sub"
           @mouseenter=${(e) => { this._recentOpen = true; this.requestUpdate(); }}
           @mouseleave=${(e) => { this._recentOpen = false; this.requestUpdate(); }}>
        <span style="width:14px"></span>
        <span class="label">${t("Open Recent…")}</span>
        <span class="shortcut">▸</span>
        ${this._recentOpen ? html`
          <div class="sub-dropdown">
            ${recents.map((r) => html`
              <div class="item" title=${r.path}
                   @click=${(e) => { e.stopPropagation(); this._openRecent(r); }}>
                <span style="width:14px"></span>
                <span class="label">${r.name || r.path}</span>
                <button class="forget"
                        title=${t("Forget this entry")}
                        @click=${(e) => { e.stopPropagation(); forgetRecent(r.path); this.requestUpdate(); }}>×</button>
              </div>
            `)}
            <div class="sep"></div>
            <div class="item" @click=${(e) => { e.stopPropagation(); clearRecents(); this.requestUpdate(); }}>
              <span style="width:14px"></span>
              <span class="label" style="color:var(--color-danger,#ef4444)">${t("Clear list")}</span>
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

  /// "Close current session" tail-item on the Session menu. Hidden if
  /// the role can't issue close_session, disabled when no session is
  /// open. The session-switcher's dropdown carries the same affordance;
  /// duplicating it here is intentional — once a user covers the
  /// switcher with a floating window, the menu bar is the only always-
  /// reachable surface for session-level operations.
  _renderCloseSessionItem() {
    if (!isAllowed("close_session")) return null;
    const cur = window.__foyer?.store?.currentSession?.();
    const enabled = !!cur;
    return html`
      <div class="sep" style="height:1px;background:var(--color-border);margin:4px 0"></div>
      <div class="item ${enabled ? '' : 'disabled'}"
           @click=${() => enabled && this._closeCurrentSession()}>
        <span style="width:14px;display:inline-flex;justify-content:center;flex:0 0 auto">${icon("x-mark", 11)}</span>
        <span class="label">${enabled && cur?.name ? t("Close Session — %{name}", { name: cur.name }) : t("Close Session")}</span>
      </div>
    `;
  }

  async _closeCurrentSession() {
    this._openMenu = "";
    const cur = window.__foyer?.store?.currentSession?.();
    if (!cur) return;
    if (cur.dirty) {
      const choice = await confirmChoice({
        title: "Unsaved changes",
        message:
          `"${cur.name || "This session"}" has unsaved changes.\n\n`
          + `Save before closing?`,
        confirmLabel: "Save & close",
        altLabel: "Close without saving",
        altTone: "danger",
        cancelLabel: "Cancel",
        tone: "warning",
      });
      if (choice === "cancel") return;
      if (choice === "confirm") {
        // Fire-and-forget save; close_session below runs after the
        // shim's save handler queues. Same pattern session-switcher
        // uses — no guarantee of a sync save round-trip, just a best
        // effort before the IPC channel closes.
        window.__foyer?.ws?.send({ type: "save_session" });
      }
    }
    window.__foyer?.ws?.send({ type: "close_session", session_id: cur.id });
  }

  _menuLeftFor(cat) {
    // Measure each preceding button's width so the dropdown aligns.
    // Don't compare textContent to `cat` — that breaks the moment the
    // labels are translated (e.g. "세션".toLowerCase() !== "session"),
    // sending the dropdown way off to the right because the loop
    // never finds its match and sums every button's width. Index the
    // buttons by MENU_ORDER position instead, which is locale-stable.
    const btns = Array.from(this.renderRoot.querySelectorAll(".btn"));
    const targetIdx = MENU_ORDER.findIndex((m) => m.cat === cat);
    if (targetIdx < 0) return 0;
    let x = 0;
    for (let i = 0; i < targetIdx && i < btns.length; i++) {
      x += btns[i].offsetWidth;
    }
    return x;
  }
}
customElements.define("foyer-main-menu", MainMenu);
