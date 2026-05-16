// Agent settings modal — LLM transport + autonomy + skills/memory.
// WebLLM and External tabs are a faithful port of the patapsco-ai-
// platform agent modal (see ext/patapsco-ai-platform/modules/
// platform-agent/static/pages/platform-agent-panel.js); the
// Autonomy + Skills tab is foyer-specific.

import { LitElement, html, css, nothing } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { loadSettings, saveSettings, WEBLLM_MODELS } from "foyer-core/agent-settings.js";
import { startWebLLM, stopWebLLM, getWebLLMClient } from "foyer-core/webllm-client.js";

const MODELS_FETCH_DEBOUNCE_MS = 600;

export class AgentSettingsModal extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    _settings: { state: true, type: Object },
    _tab: { state: true, type: String },
    _showApiKey: { state: true, type: Boolean },
    _autonomy: { state: true, type: String },
    _skills: { state: true, type: Array },
    _memories: { state: true, type: Array },
    _webllmStatus: { state: true, type: String },
    _webllmProgress: { state: true, type: Number },
    _webllmProgressText: { state: true, type: String },
    _availableModels: { state: true, type: Array },
    _modelsFetchState: { state: true, type: String },
    _memName: { state: true, type: String },
    _memBody: { state: true, type: String },
    _memOpen: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: none;
      z-index: 2100;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
    }
    :host([open]) { display: flex; }

    .modal {
      width: 580px; max-width: 94vw; max-height: 90vh;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .modal-header {
      display: flex; align-items: center; gap: 8px;
      padding: 14px 18px 4px;
    }
    .modal-title {
      flex: 1;
      margin: 0;
      font-family: var(--font-sans);
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text);
    }
    .close {
      background: transparent; border: 0; padding: 4px;
      color: var(--color-text-muted); cursor: pointer; border-radius: var(--radius-sm);
    }
    .close:hover { color: var(--color-text); background: var(--color-surface); }
    .modal-subtitle {
      padding: 0 18px 12px;
      font-size: 12px;
      color: var(--color-text-muted);
    }

    .tabs {
      display: flex; gap: 0;
      padding: 0 18px;
      border-bottom: 1px solid var(--color-border);
    }
    .tab {
      font: inherit; font-family: var(--font-sans);
      font-size: 12px; font-weight: 500;
      color: var(--color-text-muted);
      background: transparent;
      border: 0; border-bottom: 2px solid transparent;
      padding: 8px 14px;
      cursor: pointer;
      margin-bottom: -1px;
    }
    .tab:hover { color: var(--color-text); }
    .tab.active {
      color: var(--color-text);
      border-bottom-color: var(--color-accent);
    }

    .body { padding: 16px 18px; overflow: auto; }

    .field {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: 14px;
      font-size: 12px;
      color: var(--color-text);
    }
    .field > input, .field > select, .field > textarea,
    .input-group input {
      width: 100%; box-sizing: border-box;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text);
      padding: 8px 10px;
      font-family: var(--font-sans);
      font-size: 13px;
    }
    textarea { font-family: var(--font-mono, monospace); resize: vertical; }
    .field input:focus, .field select:focus, .field textarea:focus,
    .input-group input:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .input-group {
      display: flex; align-items: stretch; gap: 6px;
    }
    .input-group input { flex: 1; }
    .input-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .input-toggle:hover { color: var(--color-text); }

    .help {
      font-size: 12px;
      color: var(--color-text-muted);
      line-height: 1.45;
    }
    .help code {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 3px;
      padding: 0 4px;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }

    button.btn {
      font: inherit; font-family: var(--font-sans);
      font-size: 12px; font-weight: 500;
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: filter 0.15s ease, transform 0.15s ease;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
    }
    button.btn:hover:not(:disabled) { filter: brightness(1.1); }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
    button.btn.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: 0;
    }
    button.btn.primary:hover:not(:disabled) { transform: translateY(-1px); }
    button.btn.danger {
      background: var(--color-danger, #ef4444);
      color: #fff;
      border: 0;
    }

    .progress {
      height: 6px;
      background: var(--color-surface);
      border-radius: 3px;
      overflow: hidden;
      border: 1px solid var(--color-border);
      margin-top: 8px;
    }
    .progress .bar {
      height: 100%;
      background: linear-gradient(90deg, var(--color-accent), var(--color-accent-2));
      width: 0%;
      transition: width 0.2s ease;
    }
    .status-line {
      font-size: 12px;
      color: var(--color-text-muted);
      margin-top: 6px;
    }
    .status-line.err { color: var(--color-danger, #c44); }

    .seg {
      display: flex;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      align-self: flex-start;
    }
    .seg button {
      background: transparent; border: 0;
      color: var(--color-text-muted);
      padding: 8px 18px;
      font: inherit; font-size: 12px;
      cursor: pointer;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .seg button.active {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .seg button + button { border-left: 1px solid var(--color-border); }

    .section-header {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
      margin: 18px 0 8px;
    }
    .section-header .grow { flex: 1; }

    .list { display: flex; flex-direction: column; gap: 6px; }
    .list .item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .list .item .name { font-weight: 600; }
    .list .item .summary {
      color: var(--color-text-muted); flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .list .item button {
      background: transparent; border: 0;
      color: var(--color-text-muted); cursor: pointer;
      padding: 2px 4px;
    }
    .list .item button:hover { color: var(--color-text); }
    .list .empty {
      font-size: 12px; color: var(--color-text-muted);
      padding: 8px 0;
    }

    .inline-form {
      display: flex; flex-direction: column; gap: 6px;
      padding: 10px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      margin-bottom: 8px;
    }
    .inline-form .actions {
      display: flex; gap: 6px; justify-content: flex-end;
    }

    .modal-actions {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 18px;
      border-top: 1px solid var(--color-border);
    }

    /* Decoy autofill traps — keep them off-screen */
    .decoy { display: none; }
  `;

  constructor() {
    super();
    this.open = false;
    this._settings = loadSettings();
    this._tab = this._settings.kind || "external";
    this._showApiKey = false;
    this._autonomy = "ask";
    this._skills = [];
    this._memories = [];
    this._webllmStatus = getWebLLMClient()?.status || "idle";
    this._webllmProgress = 0;
    this._webllmProgressText = "";
    this._availableModels = [];
    this._modelsFetchState = "idle";
    this._memName = "";
    this._memBody = "";
    this._memOpen = false;
    this._onEnvelope = this._onEnvelope.bind(this);
    this._onWebllmStatus = this._onWebllmStatus.bind(this);
    this._onWebllmProgress = this._onWebllmProgress.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    const c = getWebLLMClient();
    c?.addEventListener("status", this._onWebllmStatus);
    c?.addEventListener("progress", this._onWebllmProgress);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    const c = getWebLLMClient();
    c?.removeEventListener("status", this._onWebllmStatus);
    c?.removeEventListener("progress", this._onWebllmProgress);
    if (this._modelsTimer) clearTimeout(this._modelsTimer);
    super.disconnectedCallback();
  }

  _onEnvelope(ev) {
    const body = ev.detail?.body;
    if (!body) return;
    if (body.type === "agent_state") {
      if (body.config?.autonomy) this._autonomy = body.config.autonomy;
    } else if (body.type === "agent_skills_listed") {
      this._skills = body.skills || [];
    } else if (body.type === "agent_memories_listed") {
      this._memories = body.memories || [];
    }
  }
  _onWebllmStatus(ev) { this._webllmStatus = ev.detail?.status || "idle"; }
  _onWebllmProgress(ev) {
    this._webllmProgress = ev.detail?.progress || 0;
    this._webllmProgressText = ev.detail?.text || "";
  }

  updated(changed) {
    if (changed.has("open") && this.open) {
      this._settings = loadSettings();
      this._tab = this._settings.kind || "external";
      this._memOpen = false;
      window.__foyer?.ws?.send({ type: "agent_list_skills" });
      window.__foyer?.ws?.send({ type: "agent_list_memories" });
      this._scheduleModelsFetch();
    }
  }

  _set(patch) {
    this._settings = { ...this._settings, ...patch };
    if ("externalEndpoint" in patch) this._scheduleModelsFetch();
  }
  _setKind(kind) { this._tab = kind; this._set({ kind }); }

  _scheduleModelsFetch() {
    if (this._modelsTimer) clearTimeout(this._modelsTimer);
    this._modelsTimer = setTimeout(() => this._fetchModels(), MODELS_FETCH_DEBOUNCE_MS);
  }
  async _fetchModels() {
    const endpoint = (this._settings.externalEndpoint || "").trim();
    if (!endpoint) {
      this._availableModels = [];
      this._modelsFetchState = "idle";
      return;
    }
    this._modelsFetchState = "loading";
    try {
      const url = endpoint.replace(/\/+$/, "") + "/models";
      const headers = { "Content-Type": "application/json" };
      const key = this._settings.externalApiKey || "";
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const ids = Array.isArray(json?.data)
        ? json.data.map((m) => m?.id).filter((id) => typeof id === "string")
        : [];
      this._availableModels = ids;
      this._modelsFetchState = "ok";
      if (!this._settings.externalModel && ids.length > 0) {
        this._set({ externalModel: ids[0] });
      }
    } catch {
      this._availableModels = [];
      this._modelsFetchState = "error";
    }
  }

  _save() {
    const s = { ...this._settings, kind: this._tab === "agent" ? this._settings.kind : this._tab };
    saveSettings(s);
    const ws = window.__foyer?.ws;
    if (ws) {
      let endpoint, model, apiKey;
      if (s.kind === "webllm") {
        endpoint = new URL("/llm/v1", window.location.href).toString();
        model = s.webllmModel || "Llama-3.2-3B-Instruct-q4f32_1-MLC";
        apiKey = "";
      } else {
        endpoint = s.externalEndpoint || "";
        model = s.externalModel || "";
        apiKey = s.externalApiKey || "";
      }
      if (endpoint) {
        ws.send({ type: "agent_set_config", endpoint, model, api_key: apiKey });
      }
      ws.send({ type: "agent_set_autonomy", autonomy: this._autonomy });
    }
    this.dispatchEvent(new CustomEvent("save", {
      detail: s, bubbles: true, composed: true,
    }));
    this.open = false;
  }

  async _loadWebllm() {
    const model = this._settings.webllmModel || "Llama-3.2-3B-Instruct-q4f32_1-MLC";
    const client = await startWebLLM(model);
    client.addEventListener("status", this._onWebllmStatus);
    client.addEventListener("progress", this._onWebllmProgress);
  }
  async _stopWebllm() { await stopWebLLM(); }

  async _clearWebllmCache() {
    // WebLLM stores model shards in the browser Cache Storage under
    // a `webllm/` prefix. Remove all matching caches; the next Load
    // re-downloads. Patapsco does the same.
    let count = 0;
    try {
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        for (const name of names) {
          if (/web[-_]?llm/i.test(name)) {
            await caches.delete(name);
            count++;
          }
        }
      }
    } catch (e) {
      console.warn("[webllm] cache clear failed:", e);
    }
    alert(count > 0 ? `Cleared ${count} cached model(s).` : "No cached models found.");
  }

  _isAdminish() {
    const rbac = window.__foyer?.store?.state?.rbac;
    if (!rbac) return true;
    if (!rbac.isTunnel) return true;
    return rbac.roleId === "admin";
  }

  _addMemory() {
    const name = (this._memName || "").trim();
    const body = (this._memBody || "").trim();
    if (!name) return;
    window.__foyer?.ws?.send({ type: "agent_save_memory", name, body });
    this._memName = "";
    this._memBody = "";
    this._memOpen = false;
  }
  _forgetMemory(name) {
    window.__foyer?.ws?.send({ type: "agent_forget_memory", name });
  }
  _toggleSkill(name, enabled) {
    window.__foyer?.ws?.send({
      type: enabled ? "agent_enable_skill" : "agent_disable_skill",
      name,
    });
  }
  async _uploadSkillFile(file) {
    if (!file) return;
    const text = await file.text();
    const name = file.name.replace(/\.md$/i, "");
    window.__foyer?.ws?.send({ type: "agent_upload_skill", name, body: text });
  }
  _pickSkillFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown,text/plain";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) this._uploadSkillFile(f);
    });
    input.click();
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2 class="modal-title">Agent Settings</h2>
          <button class="close" @click=${() => { this.open = false; }} title="Close">
            ${icon("x-mark", 14)}
          </button>
        </div>
        <div class="modal-subtitle">Choose where the LLM runs.</div>
        <div class="tabs">
          ${this._renderTab("webllm",   "WebLLM (browser)")}
          ${this._renderTab("external", "External endpoint")}
          ${this._renderTab("agent",    "Autonomy + Skills")}
        </div>
        <div class="body">
          ${this._tab === "webllm"   ? this._renderWebllm() :
            this._tab === "external" ? this._renderExternal() :
                                       this._renderAgent()}
        </div>
        <div class="modal-actions">
          <button class="btn" @click=${() => { this.open = false; }}>Cancel</button>
          <button class="btn primary" @click=${this._save}>Save</button>
        </div>
      </div>
    `;
  }

  _renderTab(kind, label) {
    const active = (kind === "agent" ? this._tab === "agent" : this._tab === kind);
    return html`
      <button class="tab ${active ? 'active' : ''}"
              @click=${() => kind === "agent" ? (this._tab = "agent") : this._setKind(kind)}>
        ${label}
      </button>
    `;
  }

  _renderWebllm() {
    const s = this._settings;
    const modelValid = s.webllmModel && WEBLLM_MODELS.some((m) => m.id === s.webllmModel);
    const running = this._webllmStatus === "ready" || this._webllmStatus === "loading";
    const pct = Math.round((this._webllmProgress || 0) * 100);
    return html`
      <label class="field">
        Model
        <select @change=${(e) => this._set({ webllmModel: e.target.value })}>
          ${!modelValid ? html`<option value="" disabled selected>— Select a model —</option>` : nothing}
          ${WEBLLM_MODELS.map((m) => html`
            <option value=${m.id} ?selected=${m.id === s.webllmModel}>
              ${m.label} (~${m.sizeGB} GB)
            </option>
          `)}
        </select>
      </label>
      <label class="field">
        Context window (tokens)
        <input type="number" min="1024" max="131072" step="1024"
               .value=${String(s.webllmContextSize || 10240)}
               @input=${(e) => {
                 const v = parseInt(e.target.value, 10);
                 if (v > 0) this._set({ webllmContextSize: v });
               }}>
      </label>
      <div class="help">
        WebLLM downloads a quantized model and runs it locally via WebGPU.
        Higher context windows use more VRAM. Reload the model after changing.
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
        ${running
          ? html`<button class="btn" @click=${this._stopWebllm}>Unload</button>`
          : html`<button class="btn primary" @click=${this._loadWebllm}>Load model</button>`}
        <button class="btn danger" @click=${this._clearWebllmCache}>Clear cached models</button>
        <span class="status-line" style="margin:0;">
          ${this._webllmStatus}${this._webllmStatus === "loading" ? html` · ${pct}%` : nothing}
        </span>
      </div>
      ${this._webllmStatus === "loading" ? html`
        <div class="progress"><div class="bar" style="width:${pct}%"></div></div>
        ${this._webllmProgressText
          ? html`<div class="status-line">${this._webllmProgressText}</div>`
          : nothing}
      ` : nothing}
      ${this._webllmStatus === "error" ? html`
        <div class="status-line err">model failed to load — check the console</div>
      ` : nothing}
    `;
  }

  _renderExternal() {
    const s = this._settings;
    const fetchState = this._modelsFetchState;
    return html`
      <form autocomplete="off" @submit=${(e) => e.preventDefault()}>
        <input class="decoy" type="text" name="username" autocomplete="username" tabindex="-1" aria-hidden="true">
        <input class="decoy" type="password" name="password" autocomplete="current-password" tabindex="-1" aria-hidden="true">

        <label class="field">
          Endpoint URL
          <input type="url" name="foyer-llm-endpoint" autocomplete="off"
                 spellcheck="false" autocapitalize="none"
                 placeholder="https://api.openai.com/v1"
                 .value=${s.externalEndpoint || ""}
                 @input=${(e) => this._set({ externalEndpoint: e.target.value })}>
        </label>
        <label class="field">
          API key (optional)
          <div class="input-group">
            <input type=${this._showApiKey ? "text" : "password"}
                   name="foyer-llm-api-key" autocomplete="off" spellcheck="false"
                   placeholder="sk-…"
                   .value=${s.externalApiKey || ""}
                   @input=${(e) => this._set({ externalApiKey: e.target.value })}>
            <button type="button" class="input-toggle"
                    @click=${() => { this._showApiKey = !this._showApiKey; }}
                    title=${this._showApiKey ? "Hide API key" : "Show API key"}>
              ${icon(this._showApiKey ? "eye-slash" : "eye", 14)}
            </button>
          </div>
        </label>
        <label class="field">
          Model
          ${this._availableModels.length > 0
            ? html`
                <select @change=${(e) => this._set({ externalModel: e.target.value })}>
                  ${this._availableModels.map((m) => html`
                    <option value=${m} ?selected=${m === s.externalModel}>${m}</option>
                  `)}
                </select>
              `
            : html`
                <input type="text" name="foyer-llm-model" autocomplete="off"
                       spellcheck="false"
                       placeholder="gpt-4o-mini, claude-sonnet-4-6, llama3.2:3b…"
                       .value=${s.externalModel || ""}
                       @input=${(e) => this._set({ externalModel: e.target.value })}>
              `}
        </label>
        <div class="help">
          ${fetchState === "loading" ? "Checking /v1/models…" : nothing}
          ${fetchState === "ok" && this._availableModels.length > 0
            ? `Loaded ${this._availableModels.length} model(s) from the endpoint.`
            : nothing}
          ${fetchState === "error" ? "Endpoint doesn't expose /v1/models — type the model name manually." : nothing}
          ${fetchState === "idle" ? "Requests are routed through the foyer server to the configured endpoint." : nothing}
        </div>
      </form>
    `;
  }

  _renderAgent() {
    const isAdmin = this._isAdminish();
    return html`
      <label class="field">
        Autonomy
        <div class="seg">
          <button class=${this._autonomy === "ask" ? "active" : ""}
                  @click=${() => { this._autonomy = "ask"; }}>Ask</button>
          <button class=${this._autonomy === "auto" ? "active" : ""}
                  @click=${() => { this._autonomy = "auto"; }}>Auto</button>
        </div>
      </label>
      <div class="help">
        ${this._autonomy === "ask"
          ? "Destructive tools (delete / replace / clear) pause for your approval. Read-only tools run freely."
          : "Every tool runs without confirmation. Ardour's undo is the safety net."}
      </div>

      <div class="section-header">
        <span class="grow">Skills (${this._skills.length})</span>
        ${isAdmin ? html`
          <button class="btn" @click=${this._pickSkillFile}>Upload .md</button>
        ` : nothing}
      </div>
      <div class="list">
        ${this._skills.length === 0
          ? html`<div class="empty">
              ${isAdmin
                ? html`Drop a markdown file to teach the agent a task, persona, or shortcut. Files land in <code>~/.local/share/foyer/agent/skills/</code>.`
                : html`Skill management is admin-only on tunneled connections.`}
            </div>`
          : this._skills.map((sk) => html`
              <div class="item">
                <input type="checkbox" ?checked=${sk.enabled}
                       @change=${(e) => this._toggleSkill(sk.name, e.currentTarget.checked)}>
                <span class="name">${sk.name}</span>
                <span class="summary">${sk.summary}</span>
                <span style="color:var(--color-text-muted); font-size:10px;">~${sk.tokens_approx}t</span>
              </div>
            `)}
      </div>

      <div class="section-header">
        <span class="grow">Memory (${this._memories.length})</span>
        <button class="btn" @click=${() => { this._memOpen = !this._memOpen; }}>
          ${this._memOpen ? "Cancel" : "+ Add"}
        </button>
      </div>
      ${this._memOpen ? html`
        <div class="inline-form">
          <input type="text" placeholder="memory name"
                 .value=${this._memName}
                 @input=${(e) => { this._memName = e.target.value; }}>
          <textarea rows="4" placeholder="markdown body"
                    .value=${this._memBody}
                    @input=${(e) => { this._memBody = e.target.value; }}></textarea>
          <div class="actions">
            <button class="btn primary" @click=${this._addMemory}
                    ?disabled=${!(this._memName || "").trim()}>Save memory</button>
          </div>
        </div>
      ` : nothing}
      <div class="list">
        ${this._memories.length === 0
          ? html`<div class="empty">
              The agent saves snippets here as it learns. You can also drop <code>*.md</code> files in <code>~/.local/share/foyer/agent/memory/</code>.
            </div>`
          : this._memories.map((m) => html`
              <div class="item">
                <span class="name">${m.name}</span>
                <span class="summary">${m.body}</span>
                <button @click=${() => this._forgetMemory(m.name)} title="Forget">
                  ${icon("trash", 12)}
                </button>
              </div>
            `)}
      </div>
    `;
  }

  firstUpdated() {
    this.addEventListener("click", (e) => {
      if (e.target === this) this.open = false;
    });
  }
}
customElements.define("foyer-agent-settings-modal", AgentSettingsModal);
