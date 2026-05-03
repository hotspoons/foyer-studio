// Session sheet — bottom-up overlay listing the open sessions and
// the server-tracked recents list. Tap a session to switch focus;
// tap a recent to launch (RBAC-gated by `launch_project`).
//
// Why a sheet, not a modal: phones reach for thumb-zone affordances,
// and a bottom-anchored panel beats a centered card. Tap outside the
// sheet to dismiss, swipe-to-dismiss is intentionally NOT wired up
// for v1 — gestural dismissal makes accidental swipes (during a
// scroll) close the sheet, and a recovery scenario isn't worth the
// affordance.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed } from "foyer-core/rbac.js";
import { load as loadRecents, forget as forgetRecent } from "foyer-core/recents.js";
import { launchProjectGuarded } from "foyer-ui-core/session-launch.js";

export class PhoneSessionSheet extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    _tick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      z-index: 200;
      display: none;
      align-items: flex-end;
      justify-content: stretch;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      font-family: var(--font-sans);
    }
    :host([open]) { display: flex; }
    .sheet {
      width: 100%;
      max-height: 88vh;
      background: var(--color-surface);
      border-top-left-radius: 16px;
      border-top-right-radius: 16px;
      border-top: 1px solid var(--color-border);
      box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.5);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .grip {
      width: 40px; height: 4px;
      background: var(--color-border);
      border-radius: 2px;
      margin: 8px auto 4px;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 16px 12px;
      border-bottom: 1px solid var(--color-border);
    }
    header h2 {
      flex: 1;
      margin: 0;
      font-size: 14px; font-weight: 600;
      color: var(--color-text);
    }
    header .x {
      flex: 0 0 auto;
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .body { overflow-y: auto; padding: 4px 0 24px; }
    section { padding: 12px 0; }
    section h3 {
      margin: 0 16px 6px;
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .row {
      display: grid;
      grid-template-columns: 28px 1fr auto;
      gap: 10px; align-items: center;
      padding: 10px 16px;
      cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .row:active { background: color-mix(in oklab, var(--color-accent) 10%, transparent); }
    .row.active {
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .row .icon { color: var(--color-text-muted); }
    .row .meta { min-width: 0; }
    .row .name {
      font-size: 14px; font-weight: 600;
      color: var(--color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .row .path {
      font-size: 10px; font-family: var(--font-mono);
      color: var(--color-text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .row .when, .row .tag {
      font-size: 10px; color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
      flex: 0 0 auto;
    }
    .forget {
      flex: 0 0 auto;
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      font: inherit; font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    .forget:active { background: var(--color-surface-elevated); }
    .empty {
      padding: 24px 16px;
      color: var(--color-text-muted);
      font-size: 12px;
      text-align: center;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this._tick = 0;
    this._onChange = () => { this._tick++; };
    this._onBackdrop = (ev) => {
      if (ev.target === this) this._close();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._onChange);
    window.__foyer?.store?.addEventListener("sessions", this._onChange);
    window.__foyer?.store?.addEventListener("recents", this._onChange);
    this.addEventListener("click", this._onBackdrop);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onChange);
    window.__foyer?.store?.removeEventListener("sessions", this._onChange);
    window.__foyer?.store?.removeEventListener("recents", this._onChange);
    this.removeEventListener("click", this._onBackdrop);
    super.disconnectedCallback();
  }

  _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _switchTo(id) {
    window.__foyer?.store?.setCurrentSession?.(id);
    this._close();
  }

  _openRecent(entry) {
    if (!entry?.path) return;
    if (!isAllowed("launch_project")) return;
    launchProjectGuarded({
      backend_id: entry.backend_id || "ardour",
      project_path: entry.path,
    });
    this._close();
  }

  _forget(path, ev) {
    ev.stopPropagation();
    forgetRecent(path);
  }

  _formatWhen(unixSec) {
    if (!unixSec) return "";
    const delta = Math.max(0, Date.now() / 1000 - unixSec);
    if (delta < 60) return "just now";
    if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
    if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
    if (delta < 7 * 86400) return `${Math.round(delta / 86400)} d ago`;
    return new Date(unixSec * 1000).toLocaleDateString();
  }

  render() {
    void this._tick;
    const sessions = window.__foyer?.store?.state?.sessions || [];
    const currentId = window.__foyer?.store?.state?.currentSessionId || null;
    const recents = loadRecents();
    const canLaunch = isAllowed("launch_project");
    return html`
      <div class="sheet" @click=${(e) => e.stopPropagation()}>
        <div class="grip"></div>
        <header>
          <h2>Sessions</h2>
          <button class="x" title="Close" @click=${() => this._close()}>
            ${icon("x-mark", 16)}
          </button>
        </header>
        <div class="body">
          ${sessions.length > 0 ? html`
            <section>
              <h3>Open</h3>
              ${sessions.map((s) => html`
                <div class="row ${s.id === currentId ? "active" : ""}"
                     title=${s.path || ""}
                     @click=${() => this._switchTo(s.id)}>
                  <span class="icon">${icon("musical-note", 18)}</span>
                  <div class="meta">
                    <div class="name">${s.name || "(unnamed)"}${s.dirty ? " •" : ""}</div>
                    <div class="path">${s.path || "(no path)"}</div>
                  </div>
                  <span class="tag">${s.backend_id}</span>
                </div>
              `)}
            </section>
          ` : null}

          ${canLaunch ? html`
            <section>
              <h3>Recent</h3>
              ${recents.length === 0 ? html`
                <div class="empty">No recent projects yet.</div>
              ` : recents.map((r) => html`
                <div class="row" title=${r.path}
                     @click=${() => this._openRecent(r)}>
                  <span class="icon">${icon("clock", 18)}</span>
                  <div class="meta">
                    <div class="name">${r.name || "(unnamed)"}</div>
                    <div class="path">${r.path}</div>
                  </div>
                  <button class="forget" @click=${(e) => this._forget(r.path, e)}>
                    Forget
                  </button>
                </div>
              `)}
            </section>
          ` : html`
            <div class="empty">
              You don't have permission to open new projects from this device.
              Wait for the host to switch sessions.
            </div>
          `}
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-phone-session-sheet", PhoneSessionSheet);
