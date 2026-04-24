// Session switcher chip — lives in the status bar when at least one
// real session is attached. Click to open a dropdown with all sessions
// currently held by the sidecar; click a row to switch focus; bottom
// actions open another project, close the current one, or leave it
// running in the background (which is just "switch off" — the
// backend stays alive).
//
// "Close" is gated by a single 3-choice unsaved flow:
//   * Save & close
//   * Close without saving
//   * Cancel

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { confirmChoice } from "./confirm-modal.js";
import { isAllowed, onRbacChange } from "../rbac.js";

export class SessionSwitcher extends LitElement {
  static properties = {
    _open: { state: true, type: Boolean },
    _sessions: { state: true },
    _currentId: { state: true, type: String },
    _rbacTick: { state: true, type: Number },
  };

  static styles = css`
    :host { position: relative; display: inline-flex; align-items: center; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      font: inherit; font-family: var(--font-sans);
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      cursor: pointer;
      max-width: 240px;
    }
    .chip:hover { border-color: var(--color-accent); }
    .chip .name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 600;
    }
    .chip .count {
      font-size: 9px;
      padding: 0 5px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-accent) 20%, transparent);
      color: var(--color-accent);
    }
    .chip .dirty {
      color: var(--color-warning, #fbbf24);
    }
    .drop {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 300px;
      max-width: 380px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 10px 36px rgba(0,0,0,0.5);
      padding: 4px 0;
      z-index: 5000;
    }
    .drop .heading {
      padding: 6px 12px;
      font-size: 9px;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .drop .sep { height: 1px; background: var(--color-border); margin: 4px 0; }
    .drop .row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px; align-items: center;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .drop .row:hover { background: color-mix(in oklab, var(--color-accent) 10%, transparent); }
    .drop .row.active { background: color-mix(in oklab, var(--color-accent) 18%, transparent); }
    .drop .row .name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 600;
    }
    .drop .row .path {
      grid-column: 2 / 3;
      font-size: 10px; color: var(--color-text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--font-mono);
    }
    .drop .row .tag {
      font-size: 9px;
      color: var(--color-warning);
    }
    .drop .action {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 8px; align-items: center;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      color: var(--color-text-muted);
    }
    .drop .action:hover { background: color-mix(in oklab, var(--color-accent) 8%, transparent); color: var(--color-text); }
    .drop .action.danger:hover { color: var(--color-danger, #ef4444); }
  `;

  constructor() {
    super();
    this._open = false;
    this._sessions = [];
    this._currentId = null;
    this._rbacTick = 0;
    this._onSessions = () => this._syncFromStore();
    this._onChange = () => this._syncFromStore();
    this._offRbac = null;
    this._onDocClick = (ev) => {
      if (!this._open) return;
      if (ev.composedPath().includes(this)) return;
      this._open = false;
    };
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    store?.addEventListener("sessions", this._onSessions);
    store?.addEventListener("change", this._onChange);
    this._offRbac = onRbacChange(() => { this._rbacTick++; });
    document.addEventListener("click", this._onDocClick, true);
    this._syncFromStore();
  }
  disconnectedCallback() {
    const store = window.__foyer?.store;
    store?.removeEventListener("sessions", this._onSessions);
    store?.removeEventListener("change", this._onChange);
    this._offRbac?.();
    document.removeEventListener("click", this._onDocClick, true);
    super.disconnectedCallback();
  }

  _syncFromStore() {
    const s = window.__foyer?.store?.state;
    this._sessions = s?.sessions || [];
    this._currentId = s?.currentSessionId || null;
  }

  _current() {
    return this._sessions.find((s) => s.id === this._currentId) || null;
  }

  _switch(id) {
    this._open = false;
    window.__foyer?.store?.setCurrentSession(id);
  }

  _browse() {
    this._open = false;
    import("./project-picker-modal.js").then((m) => {
      if (typeof m.openProjectPicker === "function") m.openProjectPicker();
      else window.dispatchEvent(new CustomEvent("foyer:open-project-picker"));
    });
  }

  async _close() {
    this._open = false;
    const cur = this._current();
    if (!cur) return;
    if (cur.dirty) {
      const kind = await unsavedGuard(cur);
      if (kind === "cancel") return;
      if (kind === "save") {
        window.__foyer?.ws?.send({ type: "save_session" });
      }
      // save + discard fall through to close_session below.
    }
    window.__foyer?.ws?.send({ type: "close_session", session_id: cur.id });
  }

  render() {
    const cur = this._current();
    const others = this._sessions.length;
    // Hide the chip entirely when there's nothing to switch — the
    // welcome screen takes over the whole workspace in that state
    // and a dead chip is just noise.
    if (!cur) return html``;
    return html`
      <button class="chip" title="Switch sessions"
              @click=${(e) => { e.stopPropagation(); this._open = !this._open; }}>
        ${icon("musical-note", 12)}
        <span class="name">${cur.name || "(unnamed)"}</span>
        ${cur.dirty ? html`<span class="dirty">•</span>` : null}
        ${others > 1 ? html`<span class="count">${others}</span>` : null}
        ${icon("chevron-down", 10)}
      </button>
      ${this._open ? html`
        <div class="drop" @click=${(e) => e.stopPropagation()}>
          <div class="heading">Open sessions</div>
          ${this._sessions.map((s) => html`
            <div class="row ${s.id === this._currentId ? "active" : ""}"
                 title="${s.path || ""}"
                 @click=${() => this._switch(s.id)}>
              <span>${icon("musical-note", 14)}</span>
              <div>
                <div class="name">${s.name || "(unnamed)"}</div>
                <div class="path">${s.path || "(no path)"}</div>
              </div>
              ${s.dirty ? html`<span class="tag">• dirty</span>` : html`<span></span>`}
            </div>
          `)}
          <div class="sep"></div>
          ${isAllowed("launch_project") ? html`
            <div class="action" @click=${() => this._browse()}>
              <span>${icon("folder-open", 14)}</span>
              <span>Open another project…</span>
            </div>
          ` : null}
          ${isAllowed("close_session") ? html`
            <div class="action danger" @click=${() => this._close()}>
              <span>${icon("x-mark", 14)}</span>
              <span>Close current session</span>
            </div>
          ` : null}
        </div>
      ` : null}
    `;
  }
}
customElements.define("foyer-session-switcher", SessionSwitcher);

/** Open a single-step unsaved-changes modal flow. Returns one of:
 *    "save"       — save + close
 *    "discard"    — close without saving
 *    "cancel"     — abort
 */
async function unsavedGuard(session) {
  const choice = await confirmChoice({
    title: "Unsaved changes",
    message:
      `"${session.name || "This session"}" has unsaved changes.\n\n`
      + `Save before closing?`,
    confirmLabel: "Save & close",
    altLabel: "Close without saving",
    altTone: "danger",
    cancelLabel: "Cancel",
    tone: "warning",
  });
  if (choice === "confirm") return "save";
  if (choice === "alt") return "discard";
  return "cancel";
}
