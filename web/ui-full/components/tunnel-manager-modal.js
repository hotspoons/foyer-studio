import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { confirmAction } from "foyer-ui-core/widgets/confirm-modal.js";

const ROLES = [
  { id: "viewer", label: "Viewer / Listener", desc: "Watch and listen only" },
  { id: "performer", label: "Performer", desc: "Send live audio or MIDI into the session" },
  { id: "session_controller", label: "Session Controller", desc: "Control transport, levels, mute/solo" },
  { id: "admin", label: "Admin", desc: "Full control — same as owner" },
];

export class TunnelManagerModal extends LitElement {
  static properties = {
    _state: { state: true, type: Object },
    _starting: { state: true, type: Boolean },
    _showCopied: { state: true, type: String },
    _showCreate: { state: true, type: Boolean },
    // Rows in the invite form: [{ email: string, role: string }]
    _newRows: { state: true, type: Array },
    // Keyed by connection.id — holds clear-text password + url for
    // connections minted in THIS session. Cleared on dismiss. Values
    // disappear on reload because the server never stores the password.
    _justCreated: { state: true, type: Object },
    // When set, the QR overlay is shown for this URL.
    _qrUrl: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      font-family: var(--font-sans);
    }
    .card {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--color-border);
      flex: 0 0 auto;
    }
    header h2 { margin: 0; font-size: 13px; color: var(--color-text); font-weight: 600; }
    .body {
      flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px;
    }
    .section {
      margin-bottom: 14px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-elevated);
      padding: 12px;
    }
    .section h3 {
      margin: 0 0 10px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--color-text-muted);
      font-weight: 600;
    }
    .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    .row .flex { flex: 1; }
    .row label { font-size: 11px; color: var(--color-text-muted); min-width: 70px; }
    input[type=text], select {
      width: 100%;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 5px 8px;
      font: inherit;
      font-size: 12px;
      box-sizing: border-box;
    }
    input[type=text]:focus, select:focus {
      outline: none;
      border-color: var(--color-accent);
    }
    .btn {
      display: inline-flex; align-items: center; gap: 5px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border: 0; border-radius: var(--radius-sm);
      color: #fff; font: inherit; font-size: 11px; font-weight: 600;
      padding: 6px 14px; cursor: pointer;
    }
    .btn.secondary {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
    }
    .btn.danger {
      background: var(--color-danger);
    }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .toggle {
      display: inline-flex; align-items: center; gap: 6px;
      cursor: pointer; font-size: 12px; color: var(--color-text);
    }
    .toggle .pill {
      width: 32px; height: 18px; border-radius: 9px;
      background: var(--color-border); position: relative;
      transition: background 0.2s ease;
    }
    .toggle .pill.on { background: var(--color-accent); }
    .toggle .pill::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: #fff; transition: transform 0.2s ease;
    }
    .toggle .pill.on::after { transform: translateX(14px); }
    .conn-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      margin-bottom: 6px;
      background: var(--color-surface);
    }
    .conn-row .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--color-accent);
      flex-shrink: 0;
    }
    .conn-row .label { flex: 1; font-size: 12px; }
    .conn-row .role {
      font-size: 10px; color: var(--color-text-muted);
      background: color-mix(in oklab, var(--color-accent) 12%, transparent);
      padding: 2px 8px; border-radius: 999px;
    }
    .conn-row .actions { display: flex; gap: 4px; }
    .conn-row .actions button {
      background: transparent; border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); color: var(--color-text-muted);
      font-size: 10px; padding: 3px 8px; cursor: pointer;
    }
    .conn-row .actions button:hover { color: var(--color-text); border-color: var(--color-accent); }
    .conn-row .actions button.danger:hover { color: var(--color-danger); border-color: var(--color-danger); }
    .token-box {
      background: color-mix(in oklab, var(--color-accent) 8%, transparent);
      border: 1px dashed var(--color-accent);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      word-break: break-all;
      position: relative;
    }
    .token-box .copied {
      position: absolute; top: 4px; right: 6px;
      font-family: var(--font-sans); font-size: 9px;
      color: var(--color-accent-3); background: var(--color-surface);
      padding: 2px 5px; border-radius: 4px;
    }
    .empty { color: var(--color-text-muted); font-size: 11px; padding: 12px; text-align: center; }
    .hint { font-size: 10px; color: var(--color-text-muted); margin-top: 6px; }
    .role-desc { font-size: 10px; color: var(--color-text-muted); margin-top: 2px; }
    /* Any text a user would reasonably want to copy/select gets this. */
    .selectable {
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }
    .url-mono {
      font-family: var(--font-mono);
      font-size: 11px;
      word-break: break-all;
      color: var(--color-text);
    }
    .pw-mono {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--color-accent-3);
      letter-spacing: 0.02em;
    }
    .credentials-card {
      margin-top: 6px;
      padding: 8px 10px;
      border: 1px dashed var(--color-accent);
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-accent) 8%, transparent);
    }
    .credentials-card .pair {
      display: grid;
      grid-template-columns: 72px 1fr auto;
      align-items: center;
      gap: 6px 10px;
      margin: 3px 0;
      font-size: 11px;
    }
    .credentials-card .pair .k {
      color: var(--color-text-muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .credentials-card .pair .v {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .credentials-card .pair button {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .credentials-card .pair button:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .credentials-card .dismiss {
      margin-top: 4px;
      display: flex;
      justify-content: flex-end;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 3px 6px;
      cursor: pointer;
    }
    .icon-btn:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .icon-btn.danger:hover {
      color: var(--color-danger);
      border-color: var(--color-danger);
    }
    .qr-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }
    .qr-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 320px;
      align-items: center;
    }
    .qr-card img {
      width: 256px;
      height: 256px;
      background: var(--color-surface-elevated);
      border-radius: var(--radius-sm);
    }
    .qr-card .qr-url {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
      word-break: break-all;
      text-align: center;
      max-width: 256px;
    }
    .row-form .row-cell {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .row-form input[type=text],
    .row-form select {
      padding: 4px 8px;
      font-size: 12px;
    }
    .row-form .email-col { flex: 1; }
    .row-form .role-col { flex: 0 0 180px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  constructor() {
    super();
    // Enabled state is browser-sticky: localStorage is the source of
    // truth. The server's in-memory manifest starts fresh on each boot,
    // so without this the toggle would flip back to off on every reload.
    const storedEnabled = localStorage.getItem("foyer.tunnel.enabled") === "true";
    this._state = { enabled: storedEnabled, active_provider: null, active_provider_url: null, connections: [] };
    // Default to cloudflare — zero-config, auto-downloads binary.
    this._provider = localStorage.getItem("foyer.tunnel.provider") || "cloudflare";
    this._starting = false;
    this._showCopied = "";
    this._showCreate = false;
    this._newRows = [{ email: "", role: "viewer" }];
    this._justCreated = {};
    this._qrUrl = "";
    this._onEnvelope = (ev) => this._onEnv(ev.detail);
    this._onKey = (e) => {
      if (e.key !== "Escape") return;
      // Escape closes the QR overlay first, then the modal.
      if (this._qrUrl) { this._qrUrl = ""; return; }
      this._close();
    };
  }

  _persistProvider(v) {
    this._provider = v;
    localStorage.setItem("foyer.tunnel.provider", v);
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    document.addEventListener("keydown", this._onKey);
    window.__foyer?.ws?.send({ type: "tunnel_request_state" });
    // Sync the server to our browser-stored enabled preference.
    // Harmless no-op if they already match; flips the server in sync
    // with our local decision if the server was restarted and lost state.
    window.__foyer?.ws?.send({
      type: "tunnel_set_enabled",
      enabled: this._state.enabled,
    });
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    document.removeEventListener("keydown", this._onKey);
    super.disconnectedCallback();
  }

  _onEnv(env) {
    const body = env?.body;
    if (body?.type === "tunnel_state") {
      // Preserve our locally-stored enabled preference — we pushed it
      // to the server in connectedCallback, so the echo should already
      // agree, but trusting localStorage here keeps the toggle from
      // flickering if a stale state arrives mid-sync.
      this._state = {
        ...body.state,
        enabled: localStorage.getItem("foyer.tunnel.enabled") === "true",
      };
      // Only clear the throbber when a tunnel is actually UP. The
      // server emits `tunnel_state` with no active_provider from
      // `stop_tunnel` — which `tunnel_start` runs *first* to clear
      // any existing tunnel before spinning up cloudflared. Without
      // this gate, we'd clear the spinner instantly and the user
      // would stare at a dead "Start tunnel" button for 30s while
      // cloudflared negotiates with the edge. Failures land in the
      // Event::Error branch below.
      if (this._starting && body.state.active_provider_url) {
        this._starting = false;
        clearTimeout(this._startingTimeout);
      }
    }
    if (body?.type === "tunnel_up") {
      // Belt-and-braces: tunnel_up also signals success, in case
      // tunnel_state hasn't arrived yet (broadcast ordering).
      this._starting = false;
      clearTimeout(this._startingTimeout);
    }
    if (body?.type === "tunnel_token_created") {
      // Keep a clear-text password + url by connection id so the UI can
      // display them once before the user dismisses the "just created"
      // highlight. Server never re-broadcasts the password; if the user
      // reloads the tab before copying, they lose it.
      this._justCreated = {
        ...this._justCreated,
        [body.connection.id]: {
          password: body.password,
          url: body.url,
          recipient: body.connection.recipient,
        },
      };
    }
    if (body?.type === "error" && body?.code?.startsWith?.("tunnel_")) {
      this._starting = false;
      clearTimeout(this._startingTimeout);
    }
  }

  _toggleEnabled() {
    const next = !this._state.enabled;
    // Persist the preference in localStorage at click time so it
    // sticks even if the server echo is lost or the tab reloads
    // before the round-trip completes.
    localStorage.setItem("foyer.tunnel.enabled", next ? "true" : "false");
    // Optimistically flip UI so the form appears immediately.
    this._state = { ...this._state, enabled: next };
    this._send({ type: "tunnel_set_enabled", enabled: next });
  }

  _send(cmd) { window.__foyer?.ws?.send(cmd); }

  _startTunnel() {
    this._starting = true;
    this._send({ type: "tunnel_start", provider: this._provider });
    // Safety net: if nothing answers in 60s (cloudflared gives up at
    // 30s + a bit of slack), drop the throbber ourselves so the user
    // can retry. Cleared on tunnel_up / Event::Error.
    clearTimeout(this._startingTimeout);
    this._startingTimeout = setTimeout(() => {
      if (this._starting) {
        this._starting = false;
      }
    }, 60000);
  }

  _openCreate() {
    this._showCreate = true;
    this._newRows = [{ email: "", role: "viewer" }];
  }

  _cancelCreate() {
    this._showCreate = false;
    this._newRows = [{ email: "", role: "viewer" }];
  }

  _addRow() {
    this._newRows = [...this._newRows, { email: "", role: "viewer" }];
  }

  _removeRow(idx) {
    const next = this._newRows.filter((_, i) => i !== idx);
    this._newRows = next.length ? next : [{ email: "", role: "viewer" }];
  }

  _updateRow(idx, patch) {
    this._newRows = this._newRows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
  }

  _submitCreate() {
    // Submit one tunnel_create_token per row with a non-blank email.
    // The server assigns each a unique password + URL and echoes back
    // a TunnelTokenCreated event per creation.
    const rows = this._newRows.filter((r) => r.email.trim().length > 0);
    if (rows.length === 0) return;
    for (const r of rows) {
      this._send({
        type: "tunnel_create_token",
        recipient: r.email.trim(),
        role: r.role,
      });
    }
    this._showCreate = false;
    this._newRows = [{ email: "", role: "viewer" }];
  }

  async _revoke(id, recipient) {
    const ok = await confirmAction({
      title: "Revoke connection",
      message: `Revoke "${recipient}"?\nThey will be disconnected immediately.`,
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    this._send({ type: "tunnel_revoke_token", id });
    // Also drop the local clear-text cache for this connection.
    if (this._justCreated[id]) {
      const next = { ...this._justCreated };
      delete next[id];
      this._justCreated = next;
    }
  }

  _copy(key, value) {
    navigator.clipboard?.writeText?.(value);
    this._showCopied = key;
    setTimeout(() => {
      if (this._showCopied === key) this._showCopied = "";
    }, 1500);
  }

  /// Open a QR code overlay rendering the recipient's share URL. The
  /// /qr endpoint on the server produces the SVG; we just point an
  /// <img> at it and let the browser fetch.
  _openQr(url) {
    this._qrUrl = url;
  }

  _closeQr() {
    this._qrUrl = "";
  }

  _dismissJustCreated(id) {
    if (!this._justCreated[id]) return;
    const next = { ...this._justCreated };
    delete next[id];
    this._justCreated = next;
  }

  /// Build a mailto: URL with subject + body prefilled. Body contains
  /// the direct-login URL (sufficient on its own) PLUS username +
  /// password when we still have the clear-text locally (the just-
  /// created rows). Older connections get just the URL — the password
  /// isn't recoverable once the tab has reloaded.
  _mailto(recipient, url, password) {
    const subject = "Foyer Studio — remote session invitation";
    const lines = [
      `You've been invited to join a Foyer Studio session.`,
      ``,
      `Direct link (auto-logs you in):`,
      url,
    ];
    if (password) {
      lines.push(
        ``,
        `If the link doesn't auto-log you in, sign in with:`,
        `  Username: ${recipient}`,
        `  Password: ${password}`,
      );
    }
    const body = lines.join("\n");
    const mailto =
      `mailto:${encodeURIComponent(recipient)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    window.open(mailto, "_blank");
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  render() {
    const st = this._state;
    const hasTunnel = !!st.active_provider;
    const anyJustCreated = Object.keys(this._justCreated).length > 0;
    return html`
      <div class="card" style="position:relative;">
        <div class="body">
          <!-- Enable toggle + high-level status (no URL here — URL
               lives in the tunnel-control card to avoid duplication) -->
          <div class="section">
            <div class="row">
              <label class="toggle" @click=${this._toggleEnabled}>
                <div class="pill ${st.enabled ? "on" : ""}"></div>
                <span>Enable remote access</span>
              </label>
            </div>
            ${!st.enabled
              ? html`<div class="hint">Enable to show tunnel controls and invite guests.</div>`
              : !hasTunnel
                ? html`<div class="hint" style="color:var(--color-accent-3)">Start the tunnel below to get a public URL.</div>`
                : html`<div class="hint" style="color:#22c55e">Tunnel is active — you can now invite guests.</div>`
            }
          </div>

          ${st.enabled ? html`
          <!-- Tunnel control: start/stop + the single canonical URL display -->
          <div class="section">
            ${!hasTunnel
              ? html`<div style="display:flex;flex-direction:column;gap:8px;">
                  <div class="row" style="margin-bottom:4px;">
                    <label style="min-width:auto;font-size:12px;">Provider</label>
                    <select style="flex:1" ?disabled=${this._starting}
                            .value=${this._provider}
                            @change=${(e) => this._persistProvider(e.currentTarget.value)}>
                      <option value="cloudflare">Cloudflare</option>
                      <option value="ngrok">Ngrok</option>
                    </select>
                  </div>
                  <button class="btn" ?disabled=${this._starting} @click=${this._startTunnel}>
                    ${this._starting ? html`<span style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></span>` : icon("globe-alt", 12)}
                    ${this._starting ? "Starting…" : "Start tunnel"}
                  </button>
                  ${this._provider === "cloudflare"
                    ? html`<div class="hint">Downloads <code>cloudflared</code> automatically if missing. Auth token read from <code>tunnels.cloudflare.api_token</code> in config.yaml.</div>`
                    : html`<div class="hint">Pure Rust — no external binary. Auth token read from <code>tunnels.ngrok.auth_token</code> in config.yaml.</div>`}
                </div>`
              : html`<div class="row" style="margin-bottom:0;">
                  <span class="dot" style="background:#22c55e;flex-shrink:0;"></span>
                  <div style="flex:1;min-width:0;">
                    <div class="url-mono selectable" style="word-break:break-all;">
                      ${st.active_provider_url || "(tunnel active)"}
                    </div>
                    <div class="hint" style="margin-top:2px;">${st.active_provider || ""}</div>
                  </div>
                  <button class="icon-btn" title="Copy URL"
                          @click=${() => this._copy("public-url", st.active_provider_url || "")}>
                    ${this._showCopied === "public-url" ? icon("check", 12) : icon("document-duplicate", 12)}
                  </button>
                  <button class="btn secondary" @click=${() => this._send({ type: "tunnel_stop" })}>
                    ${icon("stop", 12)} Stop
                  </button>
                </div>`}
          </div>

          <!-- Connections list + invite form -->
          <div class="section">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
              <h3 style="margin:0;flex:1">Active connections</h3>
              ${!this._showCreate
                ? html`<button class="btn"
                         ?disabled=${!st.enabled || !hasTunnel}
                         @click=${this._openCreate}>
                         ${icon("plus", 12)} Invite guests
                       </button>`
                : null}
            </div>

            ${this._showCreate ? this._renderInviteForm() : null}

            ${st.connections.length === 0
              ? html`<div class="empty">No active connections.</div>`
              : st.connections.map((c) => this._renderConnRow(c))}
          </div>
          ` : null}
        </div>

        ${this._qrUrl ? this._renderQrOverlay() : null}
      </div>
    `;
  }

  _renderInviteForm() {
    return html`
      <div class="row-form" style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:10px;background:var(--color-surface);margin-bottom:10px;">
        <div class="hint" style="margin:0 0 8px 0;">
          Enter one email per row. Each guest gets a unique password and auto-login link.
        </div>
        ${this._newRows.map((row, idx) => html`
          <div class="row-cell">
            <input
              class="email-col"
              type="text"
              placeholder="name@example.com"
              .value=${row.email}
              @input=${(e) => this._updateRow(idx, { email: e.currentTarget.value })}
              @keydown=${(e) => {
                if (e.key === "Enter") {
                  if (idx === this._newRows.length - 1) this._addRow();
                  else this._submitCreate();
                }
              }}
            >
            <select
              class="role-col"
              .value=${row.role}
              @change=${(e) => this._updateRow(idx, { role: e.currentTarget.value })}
            >
              ${ROLES.map((r) => html`<option value=${r.id}>${r.label}</option>`)}
            </select>
            <button class="icon-btn danger" title="Remove row"
                    @click=${() => this._removeRow(idx)}>
              ${icon("x-mark", 12)}
            </button>
          </div>
        `)}
        <div class="row" style="justify-content:space-between;margin-top:8px;">
          <button class="btn secondary" @click=${this._addRow}>
            ${icon("plus", 12)} Add another
          </button>
          <div style="display:flex;gap:6px;">
            <button class="btn secondary" @click=${this._cancelCreate}>Cancel</button>
            <button class="btn"
                    ?disabled=${!this._newRows.some((r) => r.email.trim().length > 0)}
                    @click=${this._submitCreate}>
              ${icon("check", 12)}
              Create ${this._newRows.filter((r) => r.email.trim().length > 0).length || ""} link${this._newRows.filter((r) => r.email.trim().length > 0).length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderConnRow(c) {
    const fresh = this._justCreated[c.id];
    // Always prefer the server's `tunnel_url` — it's rewritten onto
    // the current tunnel hostname after a tunnel restart. The
    // `_justCreated` cache only exists so we can show the clear-text
    // password once (which the server never re-broadcasts), so we
    // never trust its `url` snapshot over the authoritative one.
    const url = c.tunnel_url || "";
    const copyKey = `url-${c.id}`;
    return html`
      <div class="conn-row">
        <div class="dot"></div>
        <span class="label selectable">${c.recipient}</span>
        <span class="role">${c.role}</span>
        <div class="actions">
          ${url ? html`
            <button class="icon-btn" title="Copy URL"
                    @click=${() => this._copy(copyKey, url)}>
              ${this._showCopied === copyKey ? icon("check", 12) : icon("document-duplicate", 12)}
            </button>
            <button class="icon-btn" title="Show QR code"
                    @click=${() => this._openQr(url)}>
              ${icon("qr-code", 12)}
            </button>
            <button class="icon-btn" title="Email connection info"
                    @click=${() => this._mailto(c.recipient, url, fresh && fresh.password)}>
              ${icon("envelope", 12)}
            </button>
          ` : null}
          <button class="icon-btn danger" title="Revoke"
                  @click=${() => this._revoke(c.id, c.recipient)}>
            ${icon("trash", 12)}
          </button>
        </div>
      </div>
      ${fresh ? this._renderFreshCredentials(c, fresh) : null}
    `;
  }

  _renderFreshCredentials(c, fresh) {
    const urlKey = `fresh-url-${c.id}`;
    const pwKey = `fresh-pw-${c.id}`;
    // Read the link from the server's `tunnel_url` so a tunnel
    // restart (which rewrites every connection's URL onto the new
    // hostname) reflects here too. Falls back to the one-shot
    // `fresh.url` only if the connection hasn't landed in state yet.
    const link = c.tunnel_url || fresh.url;
    return html`
      <div class="credentials-card">
        <div class="hint" style="margin:0 0 6px 0;color:var(--color-accent-3);">
          New connection — copy these now. The password is not saved on the server.
        </div>
        <div class="pair">
          <span class="k">Username</span>
          <span class="v selectable">${c.recipient}</span>
          <span></span>
        </div>
        <div class="pair">
          <span class="k">Password</span>
          <span class="v pw-mono selectable">${fresh.password}</span>
          <button title="Copy password"
                  @click=${() => this._copy(pwKey, fresh.password)}>
            ${this._showCopied === pwKey ? "Copied" : "Copy"}
          </button>
        </div>
        <div class="pair">
          <span class="k">Link</span>
          <span class="v url-mono selectable">${link}</span>
          <button title="Copy URL"
                  @click=${() => this._copy(urlKey, link)}>
            ${this._showCopied === urlKey ? "Copied" : "Copy"}
          </button>
        </div>
        <div class="dismiss">
          <button class="btn secondary"
                  @click=${() => this._dismissJustCreated(c.id)}>
            ${icon("check", 12)} Got it
          </button>
        </div>
      </div>
    `;
  }

  _renderQrOverlay() {
    const src = `/qr?data=${encodeURIComponent(this._qrUrl)}`;
    return html`
      <div class="qr-overlay" @click=${this._closeQr}>
        <div class="qr-card" @click=${(e) => e.stopPropagation()}>
          <div style="display:flex;align-items:center;gap:8px;width:100%;">
            <span style="flex:1;font-size:12px;color:var(--color-text);">Scan with a phone</span>
            <button class="icon-btn" @click=${this._closeQr} title="Close">
              ${icon("x-mark", 12)}
            </button>
          </div>
          <img src=${src} alt="QR code">
          <div class="qr-url selectable">${this._qrUrl}</div>
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-tunnel-manager-modal", TunnelManagerModal);

export function openTunnelManager() {
  return import("foyer-ui-core/widgets/window.js").then((wm) => {
    const el = document.createElement("foyer-tunnel-manager-modal");
    return wm.openWindow({
      title: "Remote Access",
      icon: "globe-alt",
      storageKey: "tunnel-manager",
      content: el,
      width: 520,
      height: 520,
    });
  });
}
