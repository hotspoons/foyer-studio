// Welcome screen — replaces the workspace when no real session is open.
//
// Three call-to-actions:
//   1. Recent projects — browser-local list (see recents.js). Click to
//      reopen via `launch_project`.
//   2. Browse projects… — opens the project picker modal for ad-hoc
//      project discovery under the sidecar's jail.
//   3. New session… — opens the project picker in "new" mode (same
//      flow as File → New Session in the main menu); the picker
//      routes the chosen path through `launch_project`, and the
//      foyer-cli launcher bootstraps the on-disk .ardour file via
//      `ardour9-new_empty_session` before exec'ing hardour.
//
// Also renders any orphans from `store.state.orphans` as a banner at
// the top — the user can reattach (stub for now), reopen (same as
// clicking recents with a crashed entry's path), or dismiss.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { load as loadRecents, touch as touchRecent, forget as forgetRecent, clearAll } from "foyer-core/recents.js";
import { launchProjectGuarded } from "../session-launch.js";
import { isAllowed, onRbacChange } from "foyer-core/rbac.js";

export class WelcomeScreen extends LitElement {
  static properties = {
    _recents: { state: true },
    _orphans: { state: true },
    _sessions: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 60px 32px;
      width: 100%;
      height: 100%;
      overflow: auto;
      background: linear-gradient(180deg,
        color-mix(in oklab, var(--color-accent) 6%, var(--color-surface)),
        var(--color-surface));
      color: var(--color-text);
      font-family: var(--font-sans);
      box-sizing: border-box;
    }
    .panel {
      width: 100%; max-width: 880px;
      display: flex; flex-direction: column; gap: 22px;
    }
    header {
      display: flex; align-items: flex-end; gap: 14px;
      margin-bottom: 8px;
    }
    header .brand {
      font-size: 28px; font-weight: 700;
      letter-spacing: 0.02em;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header .sub {
      color: var(--color-text-muted);
      font-size: 12px;
      line-height: 1.5;
    }

    .actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .cta {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 16px;
      border-radius: 10px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
      transition: all 0.12s ease;
    }
    .cta:hover {
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 8%, var(--color-surface-elevated));
      transform: translateY(-1px);
    }
    .cta[disabled] {
      opacity: 0.5; cursor: not-allowed;
      transform: none;
    }
    .cta .icon {
      flex: 0 0 28px;
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .cta .title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
    .cta .desc { color: var(--color-text-muted); font-size: 11px; line-height: 1.4; }

    section.recents h3, section.orphans h3, section.open h3 {
      margin: 0 0 8px;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .recent-list, .orphan-list, .open-list {
      display: flex; flex-direction: column;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface-elevated);
      overflow: hidden;
    }
    .recent-row, .orphan-row, .open-row {
      display: grid;
      grid-template-columns: 28px 1fr auto auto;
      gap: 10px; align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .recent-row:last-child, .orphan-row:last-child, .open-row:last-child { border-bottom: 0; }
    .recent-row:hover, .open-row:hover { background: color-mix(in oklab, var(--color-accent) 6%, transparent); }
    .recent-row .icon, .orphan-row .icon, .open-row .icon { color: var(--color-text-muted); }
    .recent-row .name, .orphan-row .name, .open-row .name {
      font-weight: 600; font-size: 13px; color: var(--color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .recent-row .path, .orphan-row .path, .open-row .path {
      grid-column: 2 / 3;
      grid-row: 2;
      font-size: 10px; color: var(--color-text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--font-mono);
    }
    .recent-row .when, .orphan-row .tag, .open-row .tag {
      font-size: 10px; color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
    }
    .recent-row .x, .orphan-row .x, .open-row .x {
      background: transparent;
      border: 1px solid transparent;
      color: var(--color-text-muted);
      padding: 3px 8px; border-radius: 4px;
      font: inherit; font-size: 10px;
      cursor: pointer;
    }
    .recent-row .x:hover, .orphan-row .x:hover, .open-row .x:hover {
      border-color: var(--color-border);
      color: var(--color-text);
    }

    section.orphans {
      border-radius: 10px;
      padding: 14px;
      border: 1px solid color-mix(in oklab, #fbbf24 40%, var(--color-border));
      background: color-mix(in oklab, #fbbf24 10%, var(--color-surface-elevated));
    }
    section.orphans h3 { color: #fbbf24; }
    .orphan-row .reattach {
      background: #fbbf24; color: #000;
      border: 1px solid #fbbf24;
      font-weight: 600; font-size: 10px;
      padding: 3px 8px; border-radius: 4px;
      cursor: pointer;
    }
    .orphan-row .reattach:hover { filter: brightness(1.08); }
    .orphan-row .badge {
      font-size: 9px; font-weight: 600;
      padding: 2px 6px;
      border-radius: 999px;
      background: color-mix(in oklab, #fbbf24 30%, transparent);
      color: #fbbf24;
      margin-right: 6px;
    }
    .orphan-row .expand {
      background: transparent;
      border: 1px solid transparent;
      color: var(--color-text-muted);
      font: inherit; font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    .orphan-row .expand:hover { border-color: var(--color-border); color: var(--color-text); }
    .orphan-detail {
      padding: 4px 14px 10px 46px;
      background: color-mix(in oklab, #fbbf24 4%, transparent);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 10px;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
    }
    .orphan-detail .attempt {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      gap: 10px;
      padding: 3px 0;
      align-items: center;
    }
    .orphan-detail .attempt .when { color: var(--color-text); }
    .orphan-detail .attempt .kind.running { color: var(--color-success, #22c55e); }
    .orphan-detail .attempt .kind.crashed { color: var(--color-danger, #ef4444); }

    .empty {
      padding: 24px;
      color: var(--color-text-muted);
      font-size: 12px;
      text-align: center;
    }

    .recents-footer {
      display: flex; justify-content: flex-end;
      padding: 6px 8px 0;
    }
    .recents-footer button {
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      font: inherit; font-size: 10px;
      cursor: pointer;
      padding: 2px 6px;
    }
    .recents-footer button:hover { color: var(--color-danger, #ef4444); }
  `;

  constructor() {
    super();
    this._recents = loadRecents();
    this._orphans = [];
    this._sessions = [];
    this._expandedGroups = new Set();
    this._onStore = () => this._refresh();
    this._onOrphans = () => this._refresh();
    this._onSessions = () => this._refresh();
  }

  /** Group orphans so duplicate entries for the same project path
   *  collapse into a single row with "N attempts" metadata. Same
   *  .ardour file opened multiple times before the user ever saved
   *  — each open got a fresh UUID because the session's extra_xml
   *  never hit disk — produces a registry entry per attempt. The
   *  grouping is by `path` (or `id` as a fallback when the shim
   *  didn't record a path, e.g. launcher-stub sessions).
   *
   *  Entries within a group are sorted newest-first. The "primary"
   *  entry — used for the headline name/kind/action — is the most
   *  recent running one if any, else the most recent crashed one.
   *  Dismiss and Reopen apply to the whole group. */
  _groupOrphans(orphans) {
    const byKey = new Map();
    for (const o of orphans) {
      const key = o.path && o.path.length > 0 ? o.path : `id:${o.id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(o);
    }
    const groups = [];
    for (const [key, list] of byKey) {
      list.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
      const primary = list.find((o) => o.kind === "running") || list[0];
      groups.push({
        key,
        primary,
        count: list.length,
        entries: list,
      });
    }
    // Surface running groups first (reattachable), then crashed by
    // most-recent-attempt.
    groups.sort((a, b) => {
      const aRun = a.primary.kind === "running" ? 0 : 1;
      const bRun = b.primary.kind === "running" ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return (b.primary.started_at || 0) - (a.primary.started_at || 0);
    });
    return groups;
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    store?.addEventListener("change", this._onStore);
    store?.addEventListener("orphans", this._onOrphans);
    store?.addEventListener("sessions", this._onSessions);
    this._offRbac = onRbacChange(() => this.requestUpdate());
    this._refresh();
  }
  disconnectedCallback() {
    const store = window.__foyer?.store;
    store?.removeEventListener("change", this._onStore);
    store?.removeEventListener("orphans", this._onOrphans);
    store?.removeEventListener("sessions", this._onSessions);
    this._offRbac?.();
    super.disconnectedCallback();
  }

  _refresh() {
    this._recents = loadRecents();
    this._orphans = window.__foyer?.store?.state?.orphans || [];
    this._sessions = window.__foyer?.store?.state?.sessions || [];
  }

  _openRecent(entry) {
    if (!entry?.path) return;
    const ws = window.__foyer?.ws;
    if (!ws) return;
    // Touch first so even if the launch fails the user sees their
    // click promote the entry.
    touchRecent(entry);
    launchProjectGuarded({
      backend_id: entry.backend_id || "ardour",
      project_path: entry.path,
      ws,
    });
  }

  _forget(path, ev) {
    ev.stopPropagation();
    forgetRecent(path);
    this._refresh();
  }

  _clearAll() {
    clearAll();
    this._refresh();
  }

  _browse() {
    // Dynamic import so the welcome-screen module isn't forced to
    // pull in the whole project picker bundle on first paint.
    import("./project-picker-modal.js").then((m) => {
      if (typeof m.openProjectPicker === "function") m.openProjectPicker();
      else window.dispatchEvent(new CustomEvent("foyer:open-project-picker"));
    });
  }

  _newSession() {
    // Same picker the main menu uses for File → New Session; the
    // "new" mode reuses the project-picker UI but routes a chosen
    // path through `launch_project` with the bootstrap-empty-session
    // path in foyer-cli's launcher. Lazy-import so the picker bundle
    // isn't on the welcome-screen first-paint critical path.
    import("./project-picker-modal.js").then((m) => {
      if (typeof m.showProjectPicker === "function") m.showProjectPicker("new");
      else window.dispatchEvent(new CustomEvent("foyer:open-project-picker", { detail: { mode: "new" } }));
    });
  }

  _reattachGroup(group) {
    const ws = window.__foyer?.ws;
    if (!ws || !group) return;
    const primary = group.primary;
    if (primary.kind === "running") {
      // Reattach the single live shim. All other entries in the
      // group are by definition crashed copies — dismiss them.
      ws.send({ type: "reattach_orphan", orphan_id: primary.id });
      for (const o of group.entries) {
        if (o.id !== primary.id) {
          ws.send({ type: "dismiss_orphan", orphan_id: o.id });
        }
      }
    } else {
      // Crashed — relaunch the project. Any of the group's entries
      // carries the same path; use the primary. Then clear every
      // entry in the group since a successful relaunch makes them
      // all moot.
      launchProjectGuarded({
        backend_id: primary.backend_id || "ardour",
        project_path: primary.path,
        ws,
      });
      for (const o of group.entries) {
        ws.send({ type: "dismiss_orphan", orphan_id: o.id });
      }
    }
    for (const o of group.entries) {
      window.__foyer?.store?.forgetOrphan(o.id);
    }
  }

  _dismissGroup(group) {
    const ws = window.__foyer?.ws;
    if (!ws || !group) return;
    for (const o of group.entries) {
      ws.send({ type: "dismiss_orphan", orphan_id: o.id });
      window.__foyer?.store?.forgetOrphan(o.id);
    }
    this._expandedGroups.delete(group.key);
  }

  _toggleGroup(group) {
    if (this._expandedGroups.has(group.key)) this._expandedGroups.delete(group.key);
    else this._expandedGroups.add(group.key);
    this.requestUpdate();
  }

  _pickAttempt(group, orphan) {
    // User picked a specific attempt from the expanded list.
    // Treat identically to reattaching the group's primary but
    // with this entry as the primary (so reattach targets its
    // specific socket / pid if running).
    const synthetic = { ...group, primary: orphan };
    this._reattachGroup(synthetic);
  }

  _switchToOpen(info) {
    if (!info?.id) return;
    window.__foyer?.store?.setCurrentSession(info.id);
  }

  render() {
    const recents = this._recents || [];
    const orphanGroups = this._groupOrphans(this._orphans || []);
    const openSessions = this._sessions || [];
    const canLaunch = isAllowed("launch_project");
    // Tunnel guests without project-launch rights can't drive the
    // welcome screen forward — the project picker, orphan recovery,
    // and recents all end in a launch. Show them a passive "waiting"
    // state instead so the app doesn't look broken.
    if (!canLaunch) {
      return html`
        <div class="panel">
          <header>
            <span class="brand">Foyer Studio</span>
            <span class="sub">
              Waiting for the host to open a session. Once they do, the
              workspace will appear here automatically.
            </span>
          </header>
          ${openSessions.length > 0 ? html`
            <section class="open">
              <h3>Open sessions</h3>
              <div class="open-list">
                ${openSessions.map((s) => html`
                  <div class="open-row" @click=${() => this._switchToOpen(s)}>
                    <span class="icon">${icon("musical-note", 18)}</span>
                    <div>
                      <div class="name">${s.name || "(unnamed)"}${s.dirty ? " •" : ""}</div>
                      <div class="path">${s.path || "(no path)"}</div>
                    </div>
                    <span class="tag">${s.backend_id}</span>
                    <span></span>
                  </div>
                `)}
              </div>
            </section>
          ` : null}
        </div>
      `;
    }
    return html`
      <div class="panel">
        <header>
          <span class="brand">Foyer Studio</span>
          <span class="sub">Open a project to start mixing, or pick up where you left off.</span>
        </header>

        ${orphanGroups.length > 0 ? html`
          <section class="orphans">
            <h3>⚠ Unfinished sessions found</h3>
            <div class="orphan-list">
              ${orphanGroups.map((g) => {
                const p = g.primary;
                const multi = g.count > 1;
                const expanded = this._expandedGroups.has(g.key);
                return html`
                  <div class="orphan-row" title=${p.path || ""}>
                    <span class="icon">${icon("archive-box", 18)}</span>
                    <div>
                      <div class="name">
                        ${multi ? html`<span class="badge">${g.count} attempts</span>` : null}
                        ${p.name || "(unnamed)"}
                      </div>
                      <div class="path">${p.path || ""}</div>
                    </div>
                    <span class="tag">${p.kind === "running" ? "Still running" : "Crashed"}${multi ? ` · ${formatWhen(p.started_at)}` : ""}</span>
                    <div>
                      ${multi ? html`
                        <button class="expand" @click=${() => this._toggleGroup(g)}>
                          ${expanded ? "Hide" : "Details"}
                        </button>
                      ` : null}
                      <button class="reattach" @click=${() => this._reattachGroup(g)}>
                        ${p.kind === "running" ? "Reattach" : "Reopen"}
                      </button>
                      <button class="x" @click=${() => this._dismissGroup(g)}>
                        ${multi ? "Dismiss all" : "Dismiss"}
                      </button>
                    </div>
                  </div>
                  ${expanded ? html`
                    <div class="orphan-detail">
                      ${g.entries.map((o) => html`
                        <div class="attempt">
                          <span class="kind ${o.kind}">${o.kind === "running" ? "●" : "×"}</span>
                          <span class="when">${formatWhen(o.started_at)}</span>
                          <span>${o.pid ? `pid ${o.pid}` : "no pid"}</span>
                          <button class="expand"
                                  title="Pick this specific attempt"
                                  @click=${() => this._pickAttempt(g, o)}>
                            ${o.kind === "running" ? "Reattach" : "Reopen"}
                          </button>
                        </div>
                      `)}
                    </div>
                  ` : null}
                `;
              })}
            </div>
          </section>
        ` : null}

        <div class="actions">
          <button class="cta" @click=${() => this._browse()}>
            <span class="icon">${icon("folder-open", 18)}</span>
            <div>
              <div class="title">Browse projects…</div>
              <div class="desc">Navigate the sidecar's project directory to find an Ardour session.</div>
            </div>
          </button>
          <button class="cta" @click=${() => this._newSession()}>
            <span class="icon">${icon("plus-circle", 18)}</span>
            <div>
              <div class="title">New session…</div>
              <div class="desc">Start from scratch. Pick a template and a destination folder.</div>
            </div>
          </button>
        </div>

        ${openSessions.length > 0 ? html`
          <section class="open">
            <h3>Open sessions</h3>
            <div class="open-list">
              ${openSessions.map((s) => html`
                <div class="open-row" @click=${() => this._switchToOpen(s)}>
                  <span class="icon">${icon("musical-note", 18)}</span>
                  <div>
                    <div class="name">${s.name || "(unnamed)"}${s.dirty ? " •" : ""}</div>
                    <div class="path">${s.path || "(no path)"}</div>
                  </div>
                  <span class="tag">${s.backend_id}</span>
                  <span></span>
                </div>
              `)}
            </div>
          </section>
        ` : null}

        <section class="recents">
          <h3>Recent projects</h3>
          ${recents.length === 0 ? html`
            <div class="recent-list">
              <div class="empty">No recent projects yet. Browse to open your first one.</div>
            </div>
          ` : html`
            <div class="recent-list">
              ${recents.map((r) => html`
                <div class="recent-row" @click=${() => this._openRecent(r)}>
                  <span class="icon">${icon("clock", 18)}</span>
                  <div>
                    <div class="name">${r.name || "(unnamed)"}</div>
                    <div class="path">${r.path}</div>
                  </div>
                  <span class="when">${formatWhen(r.opened_at)}</span>
                  <button class="x" @click=${(e) => this._forget(r.path, e)}>Forget</button>
                </div>
              `)}
            </div>
            <div class="recents-footer">
              <button @click=${() => this._clearAll()}>Clear all</button>
            </div>
          `}
        </section>
      </div>
    `;
  }
}

function formatWhen(unixSec) {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - unixSec);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  if (delta < 7 * 86400) return `${Math.round(delta / 86400)} d ago`;
  return d.toLocaleDateString();
}

customElements.define("foyer-welcome-screen", WelcomeScreen);
