// Session picker — jailed file browser. Shows a breadcrumb path, lists entries
// with folder/session/file distinction, and lets the user "open" a session dir.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export class SessionView extends LitElement {
  static properties = {
    _listing: { state: true, type: Object },
    _error:   { state: true, type: String },
    _opening: { state: true, type: String },
  };

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .crumbs {
      display: flex; align-items: center; gap: 4px;
      flex-wrap: wrap;
    }
    .crumbs button {
      font: inherit; font-family: var(--font-sans);
      color: var(--color-text-muted);
      background: transparent;
      border: 0;
      padding: 2px 4px;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .crumbs button:hover { color: var(--color-text); background: var(--color-surface-elevated); }
    .crumbs .sep { color: var(--color-border); }
    .list { flex: 1; overflow: auto; padding: 8px 14px; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .row:hover { background: var(--color-surface-elevated); }
    .row .name { flex: 1; font-family: var(--font-sans); font-size: 12px; color: var(--color-text); }
    .row .meta { font-size: 10px; color: var(--color-text-muted); font-family: var(--font-mono); }
    .row.session .name { font-weight: 600; }
    .row.session { color: var(--color-accent-3); }
    .row.session:hover { background: color-mix(in oklab, var(--color-accent) 15%, transparent); }
    .error {
      padding: 12px 14px;
      color: var(--color-danger);
      font-family: var(--font-mono);
      font-size: 11px;
      background: color-mix(in oklab, var(--color-danger) 8%, transparent);
      border-bottom: 1px solid var(--color-border);
    }
    .hint {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted);
    }
  `;

  constructor() {
    super();
    this._listing = null;
    this._error = "";
    this._opening = "";
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      this._browse("");
    }
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "path_listed") {
      this._listing = body.listing;
      this._error = "";
    } else if (body.type === "error" && body.code?.startsWith("browse_")) {
      this._error = body.message;
    } else if (body.type === "error" && body.code === "no_jail") {
      this._error = body.message;
    } else if (body.type === "session_changed") {
      // Another client (or the agent) opened a session — surface briefly.
      this._opening = body.path || "";
    }
  }

  _browse(path) {
    window.__foyer?.ws?.send({ type: "browse_path", path });
  }

  _open(entry) {
    if (entry.kind !== "session_dir") return;
    this._opening = entry.path;
    window.__foyer?.ws?.send({ type: "open_session", path: entry.path });
  }

  _up() {
    const p = this._listing?.path || "";
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    this._browse(parts.join("/"));
  }

  render() {
    if (this._error && !this._listing) {
      return html`
        <div class="error">${this._error}</div>
        <div class="hint">
          Start foyer-cli with <code>--jail &lt;dir&gt;</code> to enable the session picker.
        </div>
      `;
    }
    if (!this._listing) {
      return html`<div class="hint">Loading…</div>`;
    }
    const crumbs = this._listing.path
      ? this._listing.path.split("/").filter(Boolean)
      : [];
    return html`
      <div class="toolbar">
        <div class="crumbs">
          <button @click=${() => this._browse("")}>${icon("folder-open", 12)} jail</button>
          ${crumbs.map((c, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            return html`<span class="sep">/</span><button @click=${() => this._browse(path)}>${c}</button>`;
          })}
        </div>
        <span style="flex:1"></span>
        ${this._listing.is_root ? null : html`<button @click=${() => this._up()}>..</button>`}
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : null}
      <div class="list">
        ${this._listing.entries.map(e => this._renderRow(e))}
      </div>
    `;
  }

  _renderRow(e) {
    const iconName = e.kind === "session_dir" ? "music-note"
      : e.kind === "dir" ? "folder"
      : "document";
    const meta = e.kind === "file" && e.size_bytes != null
      ? fmtBytes(e.size_bytes)
      : e.kind === "session_dir" ? "session" : "";
    const click = e.kind === "dir"
      ? () => this._browse(e.path)
      : e.kind === "session_dir"
        ? () => this._open(e)
        : () => this._preview(e);
    return html`
      <div class="row ${e.kind === 'session_dir' ? 'session' : ''}"
           @click=${click}>
        ${icon(iconName, 16)}
        <div class="name">${e.session_name || e.name}</div>
        <div class="meta">${meta}</div>
      </div>
    `;
  }

  _preview(entry) {
    const layout = window.__foyer?.layout;
    if (!layout) return;
    // Split the focused tile to the right with a preview of the chosen file.
    layout.split("row", "preview", "after");
    // After split, focus moved to the new leaf. Patch its props.
    const { tree, focusId } = layout;
    const withProps = (n) => {
      if (n.kind === "leaf" && n.id === focusId) {
        return { ...n, view: "preview", props: { path: entry.path } };
      }
      if (n.kind === "split") return { ...n, children: n.children.map(withProps) };
      return n;
    };
    layout.setTree(withProps(tree));
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

customElements.define("foyer-session-view", SessionView);
