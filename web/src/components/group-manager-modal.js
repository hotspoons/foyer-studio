import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { confirmAction } from "./confirm-modal.js";

const COLOR_PALETTE = [
  { label: "Red",    hex: "#c04040" },
  { label: "Orange", hex: "#c08040" },
  { label: "Yellow", hex: "#c0b040" },
  { label: "Green",  hex: "#40c080" },
  { label: "Teal",   hex: "#40a0b0" },
  { label: "Blue",   hex: "#4080c0" },
  { label: "Purple", hex: "#9060c0" },
  { label: "Pink",   hex: "#c06090" },
  { label: "Gray",   hex: "#808080" },
];

export class GroupManagerModal extends LitElement {
  static properties = {
    _groups: { state: true, type: Array },
    _tracks: { state: true, type: Array },
    _editing: { state: true, type: String },
    _creating: { state: true, type: Boolean },
    _newName: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      font-family: var(--font-sans);
    }
    .body {
      flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px;
    }
    .section {
      margin-bottom: 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-elevated);
      padding: 10px 12px;
    }
    .section h3 {
      margin: 0 0 10px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--color-text-muted);
      font-weight: 600;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 5px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border: 0; border-radius: var(--radius-sm);
      color: #fff; font: inherit; font-size: 11px; font-weight: 600;
      padding: 5px 12px; cursor: pointer;
    }
    .btn.secondary {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
    }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    .row .flex { flex: 1; }
    .row label { font-size: 11px; color: var(--color-text-muted); min-width: 50px; }
    input[type=text], select {
      width: 100%; box-sizing: border-box;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 7px;
      font: inherit; font-size: 12px;
    }
    input[type=text]:focus, select:focus { outline: none; border-color: var(--color-accent); }

    .group-row {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      margin-bottom: 5px;
      transition: background 0.1s ease;
    }
    .group-row:hover {
      background: color-mix(in oklab, var(--color-accent) 5%, var(--color-surface));
    }
    .swatch {
      width: 16px; height: 16px; border-radius: 4px;
      border: 1px solid var(--color-border); flex-shrink: 0;
    }
    .name { flex: 1; font-size: 12px; color: var(--color-text); font-weight: 500; }
    .count {
      font-size: 10px; color: var(--color-text-muted);
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
      padding: 2px 7px; border-radius: 999px;
    }
    .actions { display: flex; gap: 4px; }
    .actions button {
      background: transparent; border: 1px solid var(--color-border);
      border-radius: var(--radius-sm); color: var(--color-text-muted);
      font-size: 10px; padding: 3px 8px; cursor: pointer;
    }
    .actions button:hover { color: var(--color-text); border-color: var(--color-accent); }
    .actions button.danger:hover { color: var(--color-danger); border-color: var(--color-danger); }
    .empty { color: var(--color-text-muted); font-size: 12px; padding: 16px; text-align: center; }

    .swatch-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .swatch-btn {
      width: 16px; height: 16px; border-radius: 3px;
      border: 1px solid var(--color-border); padding: 0; cursor: pointer;
    }
    .swatch-btn.active { outline: 2px solid var(--color-accent); outline-offset: 1px; }
  `;

  constructor() {
    super();
    this._groups = [];
    this._tracks = [];
    this._editing = null;
    this._creating = false;
    this._newName = "";
    this._onStore = () => this._sync();
    this._onKey = (e) => { if (e.key === "Escape") this._close(); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._onStore);
    document.addEventListener("keydown", this._onKey);
    this._sync();
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStore);
    document.removeEventListener("keydown", this._onKey);
    super.disconnectedCallback();
  }

  _sync() {
    const session = window.__foyer?.store?.state?.session;
    this._groups = session?.groups || [];
    this._tracks = session?.tracks || [];
  }

  _membersOf(gid) {
    return this._tracks.filter((t) => t.group_id === gid);
  }

  _submitCreate() {
    const name = this._newName.trim();
    if (!name) return;
    window.__foyer?.ws?.send({ type: "create_group", name, color: "", members: [] });
    this._creating = false;
    this._newName = "";
  }

  _startEdit(id) { this._editing = id; }

  _commitEdit(g, inputVal, color) {
    this._editing = null;
    const trimmed = (inputVal || "").trim();
    if (!trimmed || trimmed === g.name) {
      if (color && color !== g.color) {
        window.__foyer?.ws?.send({ type: "update_group", id: g.id, patch: { color } });
      }
      return;
    }
    window.__foyer?.ws?.send({
      type: "update_group",
      id: g.id,
      patch: { name: trimmed, ...(color ? { color } : {}) },
    });
  }

  async _delete(g) {
    const ok = await confirmAction({
      title: "Delete group",
      message: `Delete "${g.name}"?\nTracks in this group will become ungrouped.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) window.__foyer?.ws?.send({ type: "delete_group", id: g.id });
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="body">
        ${this._creating ? html`
          <div class="section">
            <h3>New group</h3>
            <div class="row">
              <label>Name</label>
              <div class="flex">
                <input type="text" placeholder="Group name"
                       .value=${this._newName}
                       @input=${(e) => this._newName = e.currentTarget.value}
                       @keydown=${(e) => { if (e.key === "Enter") this._submitCreate(); if (e.key === "Escape") { this._creating = false; this._newName = ""; } }}>
              </div>
            </div>
            <div class="row" style="justify-content:flex-end;">
              <button class="btn secondary" @click=${() => { this._creating = false; this._newName = ""; }}>Cancel</button>
              <button class="btn" ?disabled=${!this._newName.trim()} @click=${this._submitCreate}>
                ${icon("check", 12)} Create
              </button>
            </div>
          </div>
        ` : html`
          <div class="section" style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0">Groups</h3>
            <button class="btn" @click=${() => { this._creating = true; this._newName = `Group ${this._groups.length + 1}`; }}>
              ${icon("plus", 12)} New group
            </button>
          </div>
        `}

        <div class="section">
          ${this._groups.length === 0
            ? html`<div class="empty">No groups yet.</div>`
            : this._groups.map((g) => {
                const members = this._membersOf(g.id);
                const editing = this._editing === g.id;
                return html`
                  <div class="group-row">
                    <div class="swatch" style="background:${g.color || "var(--color-accent)"}"></div>
                    ${editing ? html`
                      <div class="flex" style="display:flex;align-items:center;gap:8px;">
                        <input type="text" .value=${g.name} style="flex:1;"
                               id="group-name-input-${g.id}"
                               @keydown=${(e) => { if (e.key === "Enter") this._commitEdit(g, e.currentTarget.value); if (e.key === "Escape") this._editing = null; }}
                               @blur=${(e) => this._commitEdit(g, e.currentTarget.value)}>
                        <div class="swatch-row">
                          ${COLOR_PALETTE.map((c) => html`
                            <button class="swatch-btn ${g.color === c.hex ? "active" : ""}"
                                    style="background:${c.hex}"
                                    title=${c.label}
                                    @click=${() => this._commitEdit(g, g.name, c.hex)}></button>
                          `)}
                        </div>
                      </div>
                    ` : html`
                      <span class="name">${g.name}</span>
                      <span class="count">${members.length} track${members.length === 1 ? "" : "s"}</span>
                      <div class="actions">
                        <button @click=${() => this._startEdit(g.id)}>${icon("pencil-square", 10)} Rename</button>
                        <button class="danger" @click=${() => this._delete(g)}>${icon("trash", 10)} Delete</button>
                      </div>
                    `}
                  </div>
                `;
              })}
        </div>
      </div>
    `;
  }

  updated(changed) {
    super.updated?.(changed);
    if (this._editing) {
      requestAnimationFrame(() => {
        const input = this.renderRoot.querySelector(`#group-name-input-${this._editing}`);
        if (input) { input.focus(); input.select(); }
      });
    }
  }
}
customElements.define("foyer-group-manager-modal", GroupManagerModal);

export function openGroupManager() {
  return import("./window.js").then((wm) => {
    const el = document.createElement("foyer-group-manager-modal");
    return wm.openWindow({
      title: "Group Manager",
      icon: "users",
      storageKey: "group-manager",
      content: el,
      width: 520,
      height: 480,
    });
  });
}
