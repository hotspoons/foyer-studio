// Agent settings modal — LLM configuration. Two provider tabs (WebLLM /
// External), mirrors Patapsco's shape except the Kubernetes deployed-stack
// path. Persists to localStorage via agent-settings.js.

import { LitElement, html, css, nothing } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { loadSettings, saveSettings, WEBLLM_MODELS } from "foyer-core/agent-settings.js";

export class AgentSettingsModal extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    _settings: { state: true, type: Object },
    _tab: { state: true, type: String },
    _showKey: { state: true, type: Boolean },
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
      width: 520px; max-width: 94vw; max-height: 90vh;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--color-border);
    }
    h2 {
      flex: 1;
      margin: 0;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .close {
      background: transparent; border: 0; padding: 4px;
      color: var(--color-text-muted); cursor: pointer; border-radius: var(--radius-sm);
    }
    .close:hover { color: var(--color-text); background: var(--color-surface); }

    .body { padding: 16px; overflow: auto; }
    .intro { color: var(--color-text-muted); font-size: 12px; margin-bottom: 12px; }

    .tabs {
      display: flex; gap: 4px;
      padding: 0 16px;
      border-bottom: 1px solid var(--color-border);
    }
    .tab {
      font: inherit; font-family: var(--font-sans);
      font-size: 12px; font-weight: 500;
      color: var(--color-text-muted);
      background: transparent;
      border: 0; border-bottom: 2px solid transparent;
      padding: 8px 12px;
      cursor: pointer;
      margin-bottom: -1px;
    }
    .tab:hover { color: var(--color-text); }
    .tab.active {
      color: var(--color-text);
      border-bottom-color: var(--color-accent);
    }

    label {
      display: flex; flex-direction: column; gap: 4px;
      margin-bottom: 12px;
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--color-text-muted);
    }
    input[type="text"], input[type="url"], input[type="password"],
    input[type="number"], select {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      color: var(--color-text);
      padding: 6px 8px;
      font-family: var(--font-sans);
      font-size: 12px;
      transition: border-color 0.15s ease;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .input-group { position: relative; }
    .input-group input { width: 100%; padding-right: 34px; }
    .input-group .reveal {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      background: transparent; border: 0; padding: 4px;
      color: var(--color-text-muted); cursor: pointer;
    }

    footer {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--color-border);
    }
    footer button {
      font: inherit; font-family: var(--font-sans);
      font-size: 12px; font-weight: 500;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .cancel {
      background: transparent;
      color: var(--color-text-muted);
      border: 1px solid var(--color-border);
    }
    .cancel:hover { color: var(--color-text); border-color: var(--color-text-muted); }
    .primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: 0;
    }
    .primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
  `;

  constructor() {
    super();
    this.open = false;
    this._settings = loadSettings();
    this._tab = this._settings.kind || "external";
    this._showKey = false;
  }

  updated(changed) {
    if (changed.has("open") && this.open) {
      // Re-load on open so any external mutation shows up.
      this._settings = loadSettings();
      this._tab = this._settings.kind || "external";
    }
  }

  _set(patch) {
    this._settings = { ...this._settings, ...patch };
  }

  _save() {
    const s = { ...this._settings, kind: this._tab };
    saveSettings(s);
    this.dispatchEvent(new CustomEvent("save", {
      detail: s, bubbles: true, composed: true,
    }));
    this.open = false;
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Agent Settings</h2>
          <button class="close" @click=${() => { this.open = false; }} title="Close">
            ${icon("close", 14)}
          </button>
        </header>
        <div class="tabs">
          ${this._renderTab("webllm",   "WebLLM (in browser)")}
          ${this._renderTab("external", "External endpoint")}
        </div>
        <div class="body">
          <div class="intro">
            ${this._tab === "webllm"
              ? "Runs the model directly in the browser via WebGPU. No network, private. First load downloads the model (GBs)."
              : "Connect to any OpenAI-compatible endpoint. Use this for Anthropic, OpenAI, a local LM Studio / Ollama server, or an in-studio gateway."}
          </div>
          ${this._tab === "webllm" ? this._renderWebllm() : this._renderExternal()}
        </div>
        <footer>
          <button class="cancel" @click=${() => { this.open = false; }}>Cancel</button>
          <button class="primary" @click=${this._save}>Save</button>
        </footer>
      </div>
    `;
  }

  _renderTab(id, label) {
    return html`
      <button class="tab ${id === this._tab ? 'active' : ''}"
              @click=${() => { this._tab = id; }}>
        ${label}
      </button>
    `;
  }

  _renderWebllm() {
    const s = this._settings;
    return html`
      <label>
        Model
        <select @change=${(e) => this._set({ webllmModel: e.currentTarget.value })}>
          ${WEBLLM_MODELS.map(m => html`
            <option value=${m.id} ?selected=${m.id === s.webllmModel}>
              ${m.label} (~${m.sizeGB} GB)
            </option>
          `)}
        </select>
      </label>
      <label>
        Context window (tokens)
        <input type="number" min="2048" max="131072" step="1024"
               .value=${String(s.webllmContextSize || 16384)}
               @input=${(e) => this._set({ webllmContextSize: Number(e.currentTarget.value) })}>
      </label>
    `;
  }

  _renderExternal() {
    const s = this._settings;
    return html`
      <label>
        Endpoint URL
        <input type="url" placeholder="https://api.openai.com/v1"
               .value=${s.externalEndpoint || ""}
               @input=${(e) => this._set({ externalEndpoint: e.currentTarget.value })}>
      </label>
      <label>
        API key (optional)
        <div class="input-group">
          <input type=${this._showKey ? "text" : "password"}
                 autocomplete="off"
                 .value=${s.externalApiKey || ""}
                 @input=${(e) => this._set({ externalApiKey: e.currentTarget.value })}>
          <button class="reveal" type="button"
                  @click=${() => { this._showKey = !this._showKey; }}
                  title=${this._showKey ? "Hide" : "Show"}>
            ${icon(this._showKey ? "eye-slash" : "eye", 14)}
          </button>
        </div>
      </label>
      <label>
        Model
        <input type="text" placeholder="claude-sonnet-4-6, gpt-4o-mini, llama-3:70b…"
               .value=${s.externalModel || ""}
               @input=${(e) => this._set({ externalModel: e.currentTarget.value })}>
      </label>
    `;
  }

  firstUpdated() {
    this.addEventListener("click", (e) => {
      if (e.target === this) this.open = false;
    });
  }
}
customElements.define("foyer-agent-settings-modal", AgentSettingsModal);
