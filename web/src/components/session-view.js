// Session picker — jailed file browser. Shows a breadcrumb path, lists entries
// with folder/session/file distinction, and lets the user "open" a session dir.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { showPreview } from "./preview-modal.js";

/** Parent of a jail-relative path. `""` and `"/"` return `""`. */
function parentPath(p) {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "";
  return trimmed.slice(0, idx);
}

export class SessionView extends LitElement {
  static properties = {
    _listing:           { state: true, type: Object },
    _error:             { state: true, type: String },
    _opening:           { state: true, type: String },
    _backends:          { state: true, type: Array },
    _activeBackend:     { state: true, type: String },
    _selectedBackendId: { state: true, type: String },
    _showHidden:        { state: true, type: Boolean },
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
    .navbtn {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      cursor: pointer;
      display: inline-flex; align-items: center;
    }
    .navbtn:hover:not([disabled]) {
      color: var(--color-text);
      border-color: var(--color-accent);
      background: var(--color-surface-elevated);
    }
    .navbtn[disabled] { opacity: 0.35; cursor: default; }
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
    .empty {
      padding: 32px 24px;
      text-align: center;
      color: var(--color-text-muted);
      max-width: 520px;
      margin: 0 auto;
    }
    .empty-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text);
      margin-bottom: 10px;
    }
    .empty-sub {
      font-size: 11px;
      line-height: 1.6;
    }
    .empty-sub code {
      font-family: var(--font-mono);
      padding: 1px 5px;
      background: var(--color-surface-elevated);
      border-radius: var(--radius-sm);
      color: var(--color-accent-3);
      font-size: 10px;
    }
    .toggle-hidden {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font: inherit;
      font-family: var(--font-sans);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 3px 8px;
      margin-right: 4px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .toggle-hidden:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .toggle-hidden.on {
      color: var(--color-accent-3);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 12%, transparent);
    }
    .tog-label { display: inline-flex; align-items: center; gap: 5px; }
    .tog-count {
      font-family: var(--font-mono);
      font-size: 9px;
      padding: 0 5px;
      border-radius: 8px;
      background: color-mix(in oklab, var(--color-accent) 22%, transparent);
      color: var(--color-accent-3);
    }

    /* Backend picker — a strip of chips, one per configured backend.
     * Selected chip overrides the path-extension inference that used to
     * decide whether to spawn Ardour or the stub. The chip matching the
     * currently-active backend gets a small "live" dot. */
    .picker {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      font-size: 10px;
      color: var(--color-text-muted);
      flex-wrap: wrap;
    }
    .picker .label {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-right: 2px;
    }
    .chip {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color 0.1s, border-color 0.1s, background 0.1s;
    }
    .chip:hover { color: var(--color-text); border-color: var(--color-accent); }
    .chip.selected {
      color: var(--color-accent-3);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .chip.disabled { opacity: 0.45; cursor: not-allowed; }
    .chip .live-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--color-success);
      box-shadow: 0 0 6px color-mix(in oklab, var(--color-success) 60%, transparent);
    }

    /* "Spawning… Waiting for shim…" feedback while a launch is in flight. */
    .launching {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-border);
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .launching .spinner {
      width: 10px; height: 10px;
      border: 2px solid color-mix(in oklab, var(--color-accent) 40%, transparent);
      border-top-color: var(--color-accent-3);
      border-radius: 50%;
      animation: foyer-spin 0.8s linear infinite;
    }
    @keyframes foyer-spin { to { transform: rotate(360deg); } }
  `;

  constructor() {
    super();
    this._listing = null;
    this._error = "";
    this._opening = "";
    this._backends = [];
    this._activeBackend = null;
    // `null` means "infer from path at click time". A user click on a
    // chip pins it explicitly until they click another chip.
    this._selectedBackendId = null;
    this._showHidden = false;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);

    // Internal browser history for file navigation. Replaces the old
    // `location.hash`-based approach (2026-04-22 rework): hash routes
    // were cluttering the URL and couldn't distinguish "I went up a
    // level" from "I followed a link to a path". We keep a plain
    // array + cursor here, remember the last visited path in
    // localStorage, and bind mouse 3/4 + Alt+←/Alt+→ for back/forward.
    this._history = [];      // stack of visited paths, oldest → newest
    this._histCursor = -1;   // index into _history; -1 = uninitialized
    this._keyHandler = (e) => this._onKey(e);
    this._mouseHandler = (e) => this._onMouseButton(e);
  }

  connectedCallback() {
    super.connectedCallback();
    // Tab into the keydown handler so Alt+← / Alt+→ work as
    // soon as the user clicks anywhere inside the picker.
    this.tabIndex = 0;
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_backends" });
    }
    // Start at the user's last-visited folder (remembered across
    // sessions in localStorage). First-run falls through to the jail
    // root. The path is dispatched immediately so the initial listing
    // shows up without needing to pick an item first.
    const last = this._loadLastPath();
    this._pushHistory(last);
    this._sendBrowse(last);

    // Keyboard + mouse back/forward. Bound on the element so we only
    // consume the events while the picker is visible; mouse button
    // 3/4 bubble through normally when the user isn't over us.
    this.addEventListener("keydown", this._keyHandler);
    this.addEventListener("mousedown", this._mouseHandler);
    // Focus once the element is in the DOM so keyboard shortcuts
    // fire without an explicit click first.
    requestAnimationFrame(() => { try { this.focus?.(); } catch {} });
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    this.removeEventListener("keydown", this._keyHandler);
    this.removeEventListener("mousedown", this._mouseHandler);
    super.disconnectedCallback();
  }

  // ── Navigation history ────────────────────────────────────────────
  _loadLastPath() {
    try {
      return localStorage.getItem("foyer.picker.last-path") || "";
    } catch {
      return "";
    }
  }
  _saveLastPath(path) {
    try { localStorage.setItem("foyer.picker.last-path", path || ""); }
    catch { /* quota / disabled storage — nav still works, no persistence */ }
  }

  /** Append a path to history, dropping any forward entries past
   *  the current cursor (standard browser semantics). */
  _pushHistory(path) {
    // Truncate forward entries so a new nav kills the redo stack.
    if (this._histCursor >= 0) {
      this._history = this._history.slice(0, this._histCursor + 1);
    }
    // Collapse consecutive duplicates.
    if (this._history[this._history.length - 1] !== path) {
      this._history.push(path);
    }
    this._histCursor = this._history.length - 1;
    this._saveLastPath(path);
  }

  _navBack() {
    if (this._histCursor <= 0) return;
    this._histCursor -= 1;
    const p = this._history[this._histCursor];
    this._sendBrowse(p);
    this._saveLastPath(p);
  }
  _navForward() {
    if (this._histCursor >= this._history.length - 1) return;
    this._histCursor += 1;
    const p = this._history[this._histCursor];
    this._sendBrowse(p);
    this._saveLastPath(p);
  }

  _onMouseButton(ev) {
    // Mouse "back" button (4) / "forward" button (5). Different
    // browsers number these differently; MouseEvent.button gives 3
    // and 4 on most gaming mice + trackballs on Linux/Chromium.
    if (ev.button === 3 || ev.button === 4) {
      ev.preventDefault();
      if (ev.button === 3) this._navBack();
      else this._navForward();
    }
  }

  _onKey(ev) {
    // Alt+← / Alt+→ for back/forward (matches the browser's global
    // shortcut — we swallow it while focused inside the picker so
    // users don't accidentally navigate the tab). Backspace also
    // acts as "up one level" if we're not inside a text input.
    const tag = (ev.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (ev.altKey && ev.key === "ArrowLeft") {
      ev.preventDefault();
      this._navBack();
      return;
    }
    if (ev.altKey && ev.key === "ArrowRight") {
      ev.preventDefault();
      this._navForward();
      return;
    }
    if (ev.key === "Backspace") {
      ev.preventDefault();
      const parent = parentPath(this._listing?.path || "");
      this._navigate(parent);
    }
  }

  /**
   * User-driven navigation entry point (folder click, breadcrumb click,
   * "go home"). Appends to the internal history + fires the listing.
   */
  _navigate(path) {
    const target = path || "";
    if (target === (this._listing?.path || "")) {
      // Same path — just a refresh (e.g. after toggling show-hidden).
      this._sendBrowse(target);
      return;
    }
    this._pushHistory(target);
    this._sendBrowse(target);
  }

  _sendBrowse(path) {
    window.__foyer?.ws?.send({
      type: "browse_path",
      path: path || "",
      show_hidden: !!this._showHidden,
    });
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
    } else if (body.type === "error" && body.code === "launch_failed") {
      this._error = body.message;
      this._opening = "";
    } else if (body.type === "session_changed") {
      // Another client (or the agent) opened a session — surface briefly.
      this._opening = body.path || "";
    } else if (body.type === "backend_swapped") {
      // Sidecar finished spawning the DAW for us. Clear the opening-state
      // and ask for a fresh snapshot — the existing store-attach wiring
      // will repopulate every view from the new backend.
      this._opening = "";
      window.__foyer?.ws?.requestSnapshot?.();
    } else if (body.type === "backends_listed") {
      this._backends = body.backends || [];
      this._activeBackend = body.active || null;
    }
  }

  _browse(path) {
    this._navigate(path || "");
  }

  _toggleHidden() {
    this._showHidden = !this._showHidden;
    // Same path, different filter — re-send directly (navigate would
    // no-op because the hash is unchanged).
    this._sendBrowse(this._listing?.path || "");
  }

  _open(entry) {
    if (entry.kind !== "session_dir") return;
    // Guard against spam-click while a launch is still in flight — the
    // sidecar would queue two swaps racing each other.
    if (this._opening) return;
    this._opening = entry.path;
    // Pick a backend: use the active one if set; otherwise the first
    // project-capable entry; otherwise the first enabled entry. For
    // Ardour sessions we prefer an ardour-kind backend so picking an
    // .ardour file actually spawns Ardour rather than the stub.
    const backend = this._pickBackendForPath(entry.path);
    window.__foyer?.ws?.send({
      type: "launch_project",
      backend_id: backend,
      project_path: entry.path,
    });
  }

  _pickBackendForPath(path) {
    const list = this._backends || [];
    // Explicit user pick wins — they clicked a chip, honor it.
    if (this._selectedBackendId) {
      const sel = list.find((b) => b.id === this._selectedBackendId && b.enabled);
      if (sel) return sel.id;
    }
    const looksArdour = /\.ardour$/i.test(path) || /\.ardour\//i.test(path);
    if (looksArdour) {
      const ard = list.find((b) => b.kind === "ardour" && b.enabled);
      if (ard) return ard.id;
    }
    // Respect the active backend if the user hasn't signalled otherwise.
    if (this._activeBackend) return this._activeBackend;
    const preferred = list.find((b) => b.requires_project && b.enabled)
      || list.find((b) => b.enabled);
    return preferred?.id || "stub";
  }

  _selectBackend(id) {
    // Toggle: clicking the already-selected chip goes back to inference.
    this._selectedBackendId = this._selectedBackendId === id ? null : id;
  }

  _renderPicker() {
    const backends = (this._backends || []).filter((b) => b.enabled);
    if (backends.length <= 1) return null;
    return html`
      <div class="picker">
        <span class="label">Open with</span>
        ${backends.map((b) => {
          const selected = this._selectedBackendId === b.id
            || (!this._selectedBackendId && this._activeBackend === b.id);
          return html`
            <button
              class=${`chip ${selected ? "selected" : ""}`}
              title=${b.requires_project
                ? `${b.label} — needs a project`
                : `${b.label} — demo / no DAW`}
              @click=${() => this._selectBackend(b.id)}
            >
              ${b.label}
              ${this._activeBackend === b.id
                ? html`<span class="live-dot" title="currently active"></span>`
                : null}
            </button>
          `;
        })}
      </div>
    `;
  }

  _renderLaunching() {
    if (!this._opening) return null;
    const id = this._selectedBackendId
      || this._pickBackendForPath(this._opening);
    const label = (this._backends || []).find((b) => b.id === id)?.label || id;
    return html`
      <div class="launching">
        <div class="spinner"></div>
        <span>Launching <strong>${label}</strong> for ${this._opening}…</span>
      </div>
    `;
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
      ${this._renderPicker()}
      ${this._renderLaunching()}
      <div class="toolbar">
        <button class="navbtn"
                ?disabled=${this._histCursor <= 0}
                title="Back (Alt+← or mouse back button)"
                @click=${() => this._navBack()}>
          ${icon("chevron-left", 12)}
        </button>
        <button class="navbtn"
                ?disabled=${this._histCursor >= this._history.length - 1}
                title="Forward (Alt+→ or mouse forward button)"
                @click=${() => this._navForward()}>
          ${icon("chevron-right", 12)}
        </button>
        <div class="crumbs">
          <button @click=${() => this._browse("")}>${icon("folder-open", 12)} jail</button>
          ${crumbs.map((c, i) => {
            const path = crumbs.slice(0, i + 1).join("/");
            return html`<span class="sep">/</span><button @click=${() => this._browse(path)}>${c}</button>`;
          })}
        </div>
        <span style="flex:1"></span>
        <button
          class=${`toggle-hidden ${this._showHidden ? "on" : ""}`}
          title=${this._showHidden ? "Hide dotfiles" : "Show dotfiles"}
          @click=${() => this._toggleHidden()}
        >
          ${icon(this._showHidden ? "eye" : "eye-slash", 12)}
          <span class="tog-label">
            ${this._showHidden ? "Hidden" : "Hidden"}
            ${this._listing.hidden_count > 0 && !this._showHidden
              ? html`<span class="tog-count">${this._listing.hidden_count}</span>`
              : null}
          </span>
        </button>
        ${this._listing.is_root ? null : html`<button @click=${() => this._up()}>..</button>`}
      </div>
      ${this._error ? html`<div class="error">${this._error}</div>` : null}
      <div class="list">
        ${this._listing.entries.length === 0
          ? this._renderEmpty()
          : this._listing.entries.map(e => this._renderRow(e))}
      </div>
    `;
  }

  _renderEmpty() {
    const hidden = this._listing?.hidden_count || 0;
    const path = this._listing?.path || "(jail root)";
    if (hidden > 0) {
      return html`
        <div class="empty">
          <div class="empty-title">Nothing visible in ${path || "the jail"}</div>
          <div class="empty-sub">
            ${hidden} hidden ${hidden === 1 ? "entry is" : "entries are"} being
            filtered. Toggle the <em>Hidden</em> button in the toolbar, or edit
            <code>launcher.jail</code> in <code>config.yaml</code> to point
            at a directory with projects.
          </div>
        </div>
      `;
    }
    return html`
      <div class="empty">
        <div class="empty-title">This jail is empty</div>
        <div class="empty-sub">
          No files or folders at <code>${path || "jail root"}</code>.
          Drop an Ardour session here, or edit
          <code>launcher.jail</code> in <code>config.yaml</code> to browse
          somewhere else. Run <code>foyer config-path</code> to find the file.
        </div>
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
    // Previews are transient — open them as a scrim modal rather than
    // splitting the focused tile (which made for cramped strips on any
    // layout that wasn't already wide).
    showPreview(entry.path);
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

customElements.define("foyer-session-view", SessionView);
