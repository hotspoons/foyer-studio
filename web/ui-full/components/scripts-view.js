// SPDX-License-Identifier: Apache-2.0
//
// Script Manager + Editor.
//
// Two-column panel mounted by the right-dock as the "Scripts" widget:
//
//   ┌────────────┬─────────────────────────────────────────────────┐
//   │ list of    │  metadata + editor for the selected script      │
//   │ scripts    │                                                 │
//   │ + "New"    │  - name / description / type / language / hook  │
//   │ + "Recover"│  - args grid (when type.takes_args)             │
//   │            │  - foyer-code-editor (syntax-highlighted body)  │
//   │            │  - Save / Run / Output log                      │
//   └────────────┴─────────────────────────────────────────────────┘
//
// Capabilities (types, languages, hooks) come from
// `store.state.session.scripting`. Nothing about the shim is hard
// coded — a future Logic/Reaper shim that advertises JS instead of Lua
// and a different type list renders here unchanged.

import { LitElement, html, css, nothing } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import "foyer-ui-core/widgets/code-editor.js";

export class ScriptsView extends LitElement {
  static properties = {
    _scripts: { state: true, type: Array },
    _caps: { state: true },
    _selectedId: { state: true, type: String },
    _draft: { state: true },
    _runOutput: { state: true, type: String },
    _running: { state: true, type: Boolean },
    _saving: { state: true, type: Boolean },
    _dirty: { state: true, type: Boolean },
    _error: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
      background: transparent;
      color: var(--color-text);
      font-size: 12px;
    }
    .empty-caps {
      flex: 1; display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted); padding: 24px; text-align: center;
    }
    .body {
      display: grid;
      grid-template-columns: 260px 1fr;
      flex: 1;
      min-height: 0;
    }
    .list {
      display: flex; flex-direction: column;
      border-right: 1px solid var(--color-border);
      background: var(--color-surface);
      min-width: 0; min-height: 0;
    }
    .list-head {
      display: flex; gap: 6px; padding: 6px 8px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .list-head button {
      display: inline-flex; align-items: center; gap: 4px;
      font: inherit; font-size: 10px;
      padding: 3px 8px; border-radius: var(--radius-sm);
      background: transparent; color: var(--color-text-muted);
      border: 1px solid var(--color-border); cursor: pointer;
    }
    .list-head button svg { flex: 0 0 auto; }
    .list-head button:hover {
      color: var(--color-text); border-color: var(--color-accent);
    }
    .list-head button.primary {
      color: var(--color-accent-3); border-color: var(--color-accent);
    }
    .list-rows { flex: 1; overflow: auto; min-height: 0; }
    .row {
      display: flex; flex-direction: column;
      padding: 6px 10px; gap: 2px;
      border-bottom: 1px solid var(--color-border);
      cursor: pointer; user-select: none;
    }
    .row:hover { background: var(--color-surface-elevated); }
    .row.selected {
      background: color-mix(in oklab, var(--color-accent) 18%, transparent);
    }
    .row .row-top { display: flex; align-items: center; gap: 6px; }
    .row .name { flex: 1; font-weight: 500; color: var(--color-text); }
    .row .name.disabled { color: var(--color-text-muted); text-decoration: line-through; }
    .row .pill {
      font-size: 9px; padding: 1px 5px; border-radius: 999px;
      background: var(--color-surface-deep); color: var(--color-text-muted);
      border: 1px solid var(--color-border);
    }
    .row .pill.warn {
      color: var(--color-warning, #d8a13b);
      border-color: var(--color-warning, #d8a13b);
    }
    .row .desc {
      color: var(--color-text-muted); font-size: 10px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pane {
      display: flex; flex-direction: column;
      min-height: 0; min-width: 0;
      padding: 10px; gap: 8px;
      overflow: auto;
    }
    .pane h4 {
      margin: 0; font-size: 11px; text-transform: uppercase;
      color: var(--color-text-muted); letter-spacing: 0.5px;
    }
    .grid {
      display: grid; grid-template-columns: 90px 1fr;
      gap: 6px 10px; align-items: center;
    }
    .grid label { color: var(--color-text-muted); font-size: 11px; }
    .grid input[type="text"], .grid input:not([type]), .grid select, .grid textarea {
      font: inherit; padding: 4px 6px; background: var(--color-surface-deep);
      border: 1px solid var(--color-border); border-radius: var(--radius-sm);
      color: var(--color-text); width: 100%;
    }
    .grid input:focus, .grid select:focus, .grid textarea:focus {
      outline: none; border-color: var(--color-accent);
    }
    /* Checkbox sits left-justified — the width:100% rule above
       intentionally excludes the checkbox so we don't stretch
       the box across the column. */
    .grid input[type="checkbox"] {
      width: auto;
      margin: 0;
      accent-color: var(--color-accent);
      justify-self: start;
    }
    .grid .checkbox-cell { display: flex; align-items: center; }
    .args { display: flex; flex-direction: column; gap: 6px; }
    .args .args-row { display: flex; gap: 6px; align-items: center; }
    .args .args-row input {
      flex: 1; font: inherit; padding: 4px 6px;
      background: var(--color-surface-deep);
      border: 1px solid var(--color-border); border-radius: var(--radius-sm);
      color: var(--color-text);
    }
    .args .args-row input:focus { outline: none; border-color: var(--color-accent); }
    .args button {
      display: inline-flex; align-items: center; gap: 4px;
      font: inherit; font-size: 11px;
      padding: 3px 8px; border-radius: var(--radius-sm);
      background: transparent; color: var(--color-text-muted);
      border: 1px solid var(--color-border); cursor: pointer;
    }
    .args button:hover {
      color: var(--color-text); border-color: var(--color-accent);
    }
    .args button svg { flex: 0 0 auto; }
    .editor-wrap {
      flex: 1; display: flex; flex-direction: column; gap: 4px;
      min-height: 220px;
    }
    foyer-code-editor { flex: 1; min-height: 220px; }
    .actions { display: flex; gap: 6px; align-items: center; }
    .actions .spacer { flex: 1; }
    .actions button {
      display: inline-flex; align-items: center; gap: 4px;
      font: inherit; font-size: 11px;
      padding: 4px 10px; border-radius: var(--radius-sm);
      background: transparent; color: var(--color-text-muted);
      border: 1px solid var(--color-border); cursor: pointer;
    }
    .actions button svg { flex: 0 0 auto; }
    .actions button:hover {
      color: var(--color-text); border-color: var(--color-accent);
    }
    .actions button.primary {
      color: var(--color-accent-3); border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .actions button.danger:hover {
      color: var(--color-error); border-color: var(--color-error);
    }
    .actions button:disabled {
      opacity: 0.4; cursor: default;
    }
    .banner {
      padding: 6px 8px; border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-warning, #d8a13b) 14%, transparent);
      border: 1px solid var(--color-warning, #d8a13b);
      color: var(--color-warning, #d8a13b);
      font-size: 11px;
    }
    .banner.error {
      background: color-mix(in oklab, var(--color-error) 14%, transparent);
      border-color: var(--color-error); color: var(--color-error);
    }
    .output {
      background: var(--color-surface-deep);
      border: 1px solid var(--color-border); border-radius: var(--radius-sm);
      padding: 6px 8px;
      font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap;
      max-height: 160px; overflow: auto; color: var(--color-text);
    }
    .output.error { color: var(--color-error); }
    .empty-pane {
      flex: 1; display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted); font-style: italic;
    }
  `;

  constructor() {
    super();
    this._scripts = [];
    this._caps = null;
    this._selectedId = "";
    this._draft = null;
    this._runOutput = "";
    this._running = false;
    this._saving = false;
    this._dirty = false;
    this._error = "";
  }

  connectedCallback() {
    super.connectedCallback();
    this._onStore = () => this._syncFromStore();
    this._onEnvelope = (ev) => this._handleEnvelope(ev);
    window.__foyer?.store?.addEventListener?.("state", this._onStore);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    this._syncFromStore();
    // Explicit refresh — covers the "first mount, snapshot already
    // landed" case where the listener above won't fire again until the
    // next change.
    try {
      window.__foyer?.ws?.send?.({ type: "list_scripts" });
    } catch {}
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("state", this._onStore);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
  }

  _syncFromStore() {
    const caps = window.__foyer?.store?.state?.session?.scripting || null;
    if (caps !== this._caps) this._caps = caps;
  }

  _handleEnvelope(ev) {
    const body = ev.detail?.body;
    if (!body?.type) return;
    switch (body.type) {
      case "script_list":
        this._scripts = body.scripts || [];
        // Preserve current selection across refreshes.
        if (this._selectedId && !this._scripts.find((s) => s.id === this._selectedId)) {
          this._selectedId = "";
          this._draft = null;
        }
        return;
      case "script_saved": {
        const s = body.script;
        const idx = this._scripts.findIndex((x) => x.id === s.id);
        const next = this._scripts.slice();
        if (idx >= 0) next[idx] = s; else next.push(s);
        this._scripts = next;
        // Adopt the echo when it matches the draft we're saving.
        // Two flow shapes:
        //   1. Update of an existing script  → draft.id === s.id.
        //   2. Create from a fresh "New"      → draft.id was empty;
        //      backend allocates and echoes the new id, and we
        //      promote the draft to that id so the Run button
        //      lights up + subsequent saves target the right row.
        // Without case 2, `_selectedId` stayed "" and `_saving`
        // never cleared, leaving Create / Run stuck.
        const matchesDraft =
          this._draft && (
            this._draft.id === s.id ||
            (!this._draft.id && this._draft.name === s.name)
          );
        if (matchesDraft && !this._dirty) {
          this._draft = cloneScript(s);
          this._selectedId = s.id;
        } else if (this._selectedId === s.id && !this._dirty) {
          this._draft = cloneScript(s);
        }
        if (this._saving && matchesDraft) {
          this._saving = false;
          this._dirty = false;
          this._selectedId = s.id;
        }
        return;
      }
      case "script_removed": {
        const id = body.id?.toString?.() || body.id;
        this._scripts = this._scripts.filter((s) => s.id !== id);
        if (this._selectedId === id) {
          this._selectedId = "";
          this._draft = null;
        }
        return;
      }
      case "script_run_result": {
        const r = body.result;
        if (!r || r.id !== this._selectedId) return;
        const head = `[${new Date().toLocaleTimeString()}] ${r.ok ? "ok" : "error"}`;
        const elapsed = Number.isFinite(r.elapsed_ms) ? ` (${r.elapsed_ms} ms)` : "";
        const tail = r.error ? `\nerror: ${r.error}` : "";
        this._runOutput = `${head}${elapsed}\n${r.stdout || ""}${tail}`.trimEnd();
        this._running = false;
        return;
      }
      case "scripting_capabilities_changed":
        this._caps = body.capabilities || null;
        return;
      case "error": {
        // Codes specific to scripts surface here so the user sees them.
        const code = body.code || "";
        if (code.startsWith("save_script") || code.startsWith("run_script") ||
            code.startsWith("delete_script") || code.startsWith("enable_script") ||
            code.startsWith("recover_disabled")) {
          this._error = body.message || code;
          this._saving = false;
          this._running = false;
        }
        return;
      }
    }
  }

  _typeDescriptor(id) {
    return this._caps?.script_types?.find?.((t) => t.id === id) || null;
  }

  _select(id) {
    if (this._dirty && !confirm("Discard unsaved changes?")) return;
    this._selectedId = id;
    this._error = "";
    this._runOutput = "";
    const s = this._scripts.find((x) => x.id === id);
    this._draft = s ? cloneScript(s) : null;
    this._dirty = false;
  }

  _newScript() {
    const caps = this._caps;
    if (!caps?.script_types?.length || !caps?.languages?.length) return;
    if (this._dirty && !confirm("Discard unsaved changes?")) return;
    const firstType = caps.script_types[0];
    this._draft = {
      id: "",
      name: "Untitled",
      description: "",
      script_type: firstType.id,
      language: caps.languages[0].id,
      enabled: true,
      body: "",
      args: {},
      hook: firstType.hookable ? (firstType.hooks?.[0] || null) : null,
      disabled_on_upload: false,
      updated_at: 0,
    };
    this._selectedId = "";
    this._dirty = true;
    this._error = "";
    this._runOutput = "";
  }

  _recover() {
    try {
      window.__foyer?.ws?.send?.({ type: "recover_disabled_scripts" });
    } catch {}
  }

  _updateDraft(patch) {
    if (!this._draft) return;
    this._draft = { ...this._draft, ...patch };
    this._dirty = true;
  }

  _save() {
    if (!this._draft) return;
    this._saving = true;
    this._error = "";
    try {
      window.__foyer?.ws?.send?.({ type: "save_script", script: this._draft });
    } catch (e) {
      this._saving = false;
      this._error = String(e?.message || e);
    }
  }

  _delete() {
    if (!this._draft || !this._draft.id) return;
    if (!confirm(`Delete "${this._draft.name}"?`)) return;
    try {
      window.__foyer?.ws?.send?.({ type: "delete_script", id: this._draft.id });
    } catch (e) {
      this._error = String(e?.message || e);
    }
  }

  _run() {
    if (!this._draft || !this._draft.id) {
      this._error = "Save the script before running it.";
      return;
    }
    if (this._dirty && !confirm("You have unsaved changes; run the saved version?")) return;
    this._running = true;
    this._runOutput = "running…";
    this._error = "";
    try {
      window.__foyer?.ws?.send?.({
        type: "run_script",
        id: this._draft.id,
        args_override: this._draft.args || {},
      });
    } catch (e) {
      this._running = false;
      this._error = String(e?.message || e);
    }
  }

  _toggleEnabled(s) {
    try {
      window.__foyer?.ws?.send?.({
        type: "enable_script",
        id: s.id,
        enabled: !s.enabled,
      });
    } catch (e) {
      this._error = String(e?.message || e);
    }
  }

  _addArg() {
    const args = { ...(this._draft?.args || {}) };
    let i = 1;
    while (args[`arg${i}`] !== undefined) i++;
    args[`arg${i}`] = "";
    this._updateDraft({ args });
  }

  _setArgKey(oldKey, newKey) {
    const args = { ...(this._draft?.args || {}) };
    if (newKey === oldKey || !newKey) return;
    if (args[newKey] !== undefined) return; // collision; ignore
    args[newKey] = args[oldKey];
    delete args[oldKey];
    this._updateDraft({ args });
  }

  _setArgValue(k, v) {
    const args = { ...(this._draft?.args || {}) };
    args[k] = v;
    this._updateDraft({ args });
  }

  _removeArg(k) {
    const args = { ...(this._draft?.args || {}) };
    delete args[k];
    this._updateDraft({ args });
  }

  render() {
    if (!this._caps) {
      return html`
        <div class="empty-caps">
          The active backend doesn't advertise a scripting surface.
          ${typeof window.__foyer?.store?.state?.session === "undefined"
            ? html`<br />Waiting for the session snapshot…`
            : ""}
        </div>
      `;
    }
    return html`
      <div class="body">
        ${this._renderList()}
        ${this._draft ? this._renderEditor() : html`
          <div class="empty-pane">Select a script — or click "New" to start fresh.</div>
        `}
      </div>
    `;
  }

  _renderList() {
    const caps = this._caps;
    // Only surface Recover when the backend has actually flagged
    // disabled-on-upload entries in the current script set — Rich's
    // rule: don't show the affordance speculatively, only when there's
    // something to recover. The agent can still call
    // `scripts.recover_disabled` over MCP at any time.
    const hasRecoverable = this._scripts.some((s) => s.disabled_on_upload);
    return html`
      <div class="list">
        <div class="list-head">
          <button class="primary" @click=${() => this._newScript()}>${icon("plus")} New</button>
          ${caps?.features?.can_recover_disabled && hasRecoverable
            ? html`<button @click=${() => this._recover()}>${icon("arrow-path")} Recover…</button>`
            : nothing}
        </div>
        <div class="list-rows">
          ${this._scripts.map((s) => this._renderRow(s))}
          ${this._scripts.length === 0
            ? html`<div style="padding:12px;color:var(--color-text-muted);font-style:italic">
                No scripts yet.
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }

  _renderRow(s) {
    const td = this._typeDescriptor(s.script_type);
    return html`
      <div class="row ${this._selectedId === s.id ? "selected" : ""}"
           @click=${() => this._select(s.id)}
           title=${s.description || ""}>
        <div class="row-top">
          <div class="name ${s.enabled ? "" : "disabled"}">${s.name}</div>
          <span class="pill">${td?.label || s.script_type}</span>
          ${s.disabled_on_upload
            ? html`<span class="pill warn">disabled on upload</span>`
            : nothing}
        </div>
        ${s.description
          ? html`<div class="desc">${s.description}</div>`
          : nothing}
      </div>
    `;
  }

  _renderEditor() {
    const d = this._draft;
    const caps = this._caps;
    const td = this._typeDescriptor(d.script_type);
    return html`
      <div class="pane">
        ${this._error
          ? html`<div class="banner error">${this._error}</div>`
          : nothing}
        ${d.disabled_on_upload
          ? html`<div class="banner">
              This script was recovered from a disabled-on-upload payload. Review it
              before enabling — recovered scripts can run arbitrary code.
            </div>`
          : nothing}
        <div class="grid">
          <label>Name</label>
          <input .value=${d.name} @input=${(e) => this._updateDraft({ name: e.target.value })} />
          <label>Description</label>
          <input .value=${d.description}
                 @input=${(e) => this._updateDraft({ description: e.target.value })} />
          <label>Type</label>
          <select @change=${(e) => {
              const next = e.target.value;
              const nextTd = caps.script_types.find((t) => t.id === next);
              this._updateDraft({
                script_type: next,
                hook: nextTd?.hookable ? (d.hook || nextTd.hooks?.[0] || null) : null,
              });
            }}>
            ${caps.script_types.map((t) => html`
              <option value=${t.id} ?selected=${t.id === d.script_type}>${t.label}</option>
            `)}
          </select>
          <label>Language</label>
          <select @change=${(e) => this._updateDraft({ language: e.target.value })}>
            ${caps.languages.map((l) => html`
              <option value=${l.id} ?selected=${l.id === d.language}>${l.label}</option>
            `)}
          </select>
          ${td?.hookable
            ? html`
                <label>Hook</label>
                <select @change=${(e) => this._updateDraft({ hook: e.target.value })}>
                  ${(td.hooks || []).map((h) => html`
                    <option value=${h} ?selected=${h === d.hook}>${h}</option>
                  `)}
                </select>
              `
            : nothing}
          ${caps?.features?.can_disable
            ? html`
                <label>Enabled</label>
                <div class="checkbox-cell">
                  <input type="checkbox" .checked=${d.enabled}
                         @change=${(e) => this._updateDraft({ enabled: e.target.checked })} />
                </div>
              `
            : nothing}
          ${td?.description
            ? html`
                <label>About</label>
                <div style="color:var(--color-text-muted);font-size:11px">${td.description}</div>
              `
            : nothing}
        </div>
        ${td?.takes_args ? this._renderArgs(d) : nothing}
        <h4>Source</h4>
        <div class="banner" style="background:transparent;border:1px solid var(--color-border);color:var(--color-text-muted)">
          Need help? The agent ships authoring skills for each script
          type (<code>ardour-lua-dsp</code>, <code>ardour-lua-action</code>,
          <code>ardour-lua-hook</code>, <code>ardour-lua-snippet</code>).
          Ask the chat panel "draft a snippet that…" or "what are the
          DSP plugin gotchas" — it'll consult the matching skill.
        </div>
        <div class="editor-wrap">
          <foyer-code-editor
            .value=${d.body}
            language=${d.language}
            min-height="280px"
            placeholder="Type your script…"
            @editor-change=${(e) => this._updateDraft({ body: e.detail.value })}
          ></foyer-code-editor>
        </div>
        <div class="actions">
          ${td?.runnable && caps?.features?.can_run_oneshot
            ? html`<button @click=${() => this._run()}
                           ?disabled=${this._running || !d.id}>
                     ${icon("play")} Run
                   </button>`
            : nothing}
          <span class="spacer"></span>
          ${d.id
            ? html`<button class="danger" @click=${() => this._delete()}>
                     ${icon("trash")} Delete
                   </button>`
            : nothing}
          <button class="primary" @click=${() => this._save()}
                  ?disabled=${this._saving || !this._dirty}>
            ${icon("check")} ${d.id ? "Save" : "Create"}
          </button>
        </div>
        ${this._runOutput
          ? html`<h4>Output</h4>
                 <pre class="output ${this._runOutput.includes("error:") ? "error" : ""}">${this._runOutput}</pre>`
          : nothing}
      </div>
    `;
  }

  _renderArgs(d) {
    const entries = Object.entries(d.args || {});
    return html`
      <h4>Args</h4>
      <div class="args">
        ${entries.map(([k, v]) => html`
          <div class="args-row">
            <input .value=${k}
                   placeholder="name"
                   @change=${(e) => this._setArgKey(k, e.target.value)} />
            <input .value=${v}
                   placeholder="value"
                   @input=${(e) => this._setArgValue(k, e.target.value)} />
            <button @click=${() => this._removeArg(k)} title="Remove arg">×</button>
          </div>
        `)}
        <div>
          <button @click=${() => this._addArg()}>${icon("plus")} Add arg</button>
        </div>
      </div>
    `;
  }
}

function cloneScript(s) {
  return {
    ...s,
    args: { ...(s.args || {}) },
  };
}

customElements.define("foyer-scripts-view", ScriptsView);
