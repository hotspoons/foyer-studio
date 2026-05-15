// Reusable MIDNAM-driven patch picker. Single-form UI with channel +
// bank dropdowns, a search box that filters across every program in
// every bank, a scrolling program list with instrument names, and
// Save / Cancel buttons.
//
// Originally lived inline inside `automation-modal.js`. Extracted so
// the MIDI manager sidebar (piano-roll instrument inspector / track
// editor MIDI form) can drop the older inline 3-prompt + chip-grid
// approach in favor of the same form everywhere.
//
// Public surface:
//
//   <foyer-patch-picker
//     mode="add" | "edit"
//     .trackId=${"track.foo"}
//     .initialChannel=${0..15}      // wire MIDI channel
//     .initialBank=${-1 | 0..16383} // -1 = "program only"
//     .initialProgram=${0..127}
//     .inline=${false}              // true = no scrim, just the panel
//     @commit=${(e) => { /* e.detail = { channel, bank, program } */ }}
//     @cancel=${() => { /* close */ }}
//   ></foyer-patch-picker>
//
// The element fetches MIDNAM via `list_midi_patch_names` and listens
// for `midi_patch_names_listed` envelopes to populate its bank /
// program names. If the backend doesn't return MIDNAM data (no
// instrument loaded, plugin doesn't expose it), the list falls back
// to the generic "Program 1..128 · General MIDI" rows so the picker
// still works.

import { LitElement, html, css } from "lit";

const NO_BANK_SENTINELS = new Set([-1, 0xffff, 0xffffff, 0x7fff]);
export function normalizePatchBank(bank) {
  if (bank == null) return -1;
  const n = Number(bank);
  if (!Number.isFinite(n) || NO_BANK_SENTINELS.has(n) || n < 0) return -1;
  return Math.max(0, Math.min(16383, n)) & 0x3fff;
}

export function flattenPatchNames(patchNames) {
  const out = [];
  const banks = patchNames?.banks || [];
  if (banks.length) {
    for (const b of banks) {
      const bk = normalizePatchBank(b.bank);
      if (bk < 0) continue;
      const bankName = b.name || `Bank ${bk}`;
      const programs = (b.programs || []).filter((p) =>
        Number.isFinite(Number(p.program)));
      for (const p of programs) {
        const prog = Math.max(0, Math.min(127, Number(p.program) || 0));
        out.push({
          bank: bk,
          bankName,
          program: prog,
          name: p.name || `Program ${prog + 1}`,
        });
      }
    }
    if (out.length) return out;
  }
  for (let i = 0; i < 128; i += 1) {
    out.push({
      bank: -1,
      bankName: "General MIDI",
      program: i,
      name: `Program ${i + 1}`,
    });
  }
  return out;
}

export class PatchPicker extends LitElement {
  static properties = {
    mode: { type: String },              // "add" | "edit"
    trackId: { type: String },
    initialChannel: { type: Number },
    initialBank: { type: Number },
    initialProgram: { type: Number },
    inline: { type: Boolean },           // skip the scrim wrapper
    _channel: { state: true, type: Number },
    _bank: { state: true, type: Number },
    _program: { state: true, type: Number },
    _search: { state: true, type: String },
    _patchNames: { state: true, type: Object },
    _patchNamesFor: { state: true, type: String },
    _patchNamesLoading: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans);
      color: var(--color-text);
    }
    .pp-scrim {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pp-panel {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
      width: 480px;
      max-width: 92vw;
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    :host([inline]) .pp-panel {
      box-shadow: none;
      border: 1px solid var(--color-border);
      width: 100%;
      max-width: 100%;
      max-height: 60vh;
    }
    .pp-head {
      padding: 12px 16px 10px;
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pp-head .title {
      font-weight: 600;
      font-size: 13px;
      color: var(--color-text);
      flex: 1;
    }
    .pp-head .x {
      cursor: pointer;
      background: transparent;
      color: var(--color-text-muted);
      border: 0;
      font-size: 14px;
      padding: 2px 6px;
    }
    .pp-head .x:hover { color: var(--color-text); }
    .pp-controls {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 10px;
      row-gap: 8px;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid color-mix(in oklab, var(--color-border) 50%, transparent);
    }
    .pp-controls label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .pp-controls select,
    .pp-controls input[type=search] {
      font: inherit;
      font-size: 12px;
      padding: 6px 8px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 4px;
      color: var(--color-text);
      width: 100%;
      box-sizing: border-box;
    }
    .pp-controls input[type=search]:focus,
    .pp-controls select:focus {
      outline: 1px solid var(--color-accent-2, #22d3ee);
      outline-offset: -1px;
    }
    .pp-hint {
      grid-column: 1 / -1;
      font-size: 10px;
      color: var(--color-text-muted);
      margin-top: -2px;
    }
    .pp-list {
      flex: 1;
      min-height: 120px;
      overflow-y: auto;
      padding: 6px 0;
    }
    .pp-row {
      padding: 6px 16px;
      display: grid;
      grid-template-columns: 38px 1fr auto;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      font-size: 12px;
      color: var(--color-text);
      border-left: 2px solid transparent;
    }
    .pp-row:hover {
      background: color-mix(in oklab, var(--color-accent) 10%, transparent);
    }
    .pp-row.active {
      background: color-mix(in oklab, var(--color-accent-2, #22d3ee) 18%, transparent);
      border-left-color: var(--color-accent-2, #22d3ee);
    }
    .pp-row .prog {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .pp-row.active .prog { color: var(--color-text); }
    .pp-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-row .bk {
      font-size: 9px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .pp-empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .pp-foot {
      padding: 10px 16px;
      border-top: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .pp-foot .summary {
      flex: 1 1 200px;
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .pp-foot .summary strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .pp-foot button {
      font: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      cursor: pointer;
    }
    .pp-foot button:hover { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-surface)); }
    .pp-foot button.primary {
      background: var(--color-accent-2, #22d3ee);
      border-color: var(--color-accent-2, #22d3ee);
      color: #001a20;
      font-weight: 600;
    }
  `;

  constructor() {
    super();
    this.mode = "add";
    this.trackId = "";
    this.initialChannel = 0;
    this.initialBank = -1;
    this.initialProgram = 0;
    this.inline = false;
    this._channel = 0;
    this._bank = -1;
    this._program = 0;
    this._search = "";
    this._patchNames = null;
    this._patchNamesFor = "";
    this._patchNamesLoading = false;
    this._onEnvelope = (ev) => this._handleEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    this._channel = Math.max(0, Math.min(15, Number(this.initialChannel) || 0));
    this._bank = normalizePatchBank(this.initialBank);
    this._program = Math.max(0, Math.min(127, Number(this.initialProgram) || 0));
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    this._requestPatchNames(this._channel);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
  }

  _handleEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "midi_patch_names_listed"
        && body.track_id === this.trackId) {
      this._patchNames = body.names || null;
      this._patchNamesFor = `${this.trackId}:${body.names?.channel ?? 0}`;
      this._patchNamesLoading = false;
    }
  }

  _requestPatchNames(channel) {
    if (!this.trackId) return;
    const ch = Math.max(0, Math.min(15, Number(channel) || 0));
    const key = `${this.trackId}:${ch}`;
    if (this._patchNamesFor === key && this._patchNames) return;
    this._patchNamesLoading = true;
    window.__foyer?.ws?.send?.({
      type: "list_midi_patch_names",
      track_id: this.trackId,
      channel: ch,
    });
  }

  _commit() {
    this.dispatchEvent(new CustomEvent("commit", {
      detail: {
        channel: this._channel,
        bank: normalizePatchBank(this._bank),
        program: Math.max(0, Math.min(127, Number(this._program) || 0)),
      },
      bubbles: true,
      composed: true,
    }));
  }

  _cancel() {
    this.dispatchEvent(new CustomEvent("cancel", {
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    const all = flattenPatchNames(this._patchNames);
    const banks = (this._patchNames?.banks || [])
      .map((b) => ({ bank: normalizePatchBank(b.bank), name: b.name || "" }))
      .filter((b) => b.bank >= 0);
    const q = (this._search || "").trim().toLowerCase();
    const rows = all.filter((r) => {
      if (this._bank >= 0 && r.bank !== this._bank) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q)
          || r.bankName.toLowerCase().includes(q)
          || String(r.program + 1).includes(q);
    });
    const activeRow = rows.find((r) => r.program === this._program
        && (this._bank < 0 || r.bank === this._bank));
    const model = this._patchNames?.model || "";
    const modeName = this._patchNames?.mode || "";
    const onScrim = (e) => {
      if (e.target.classList.contains("pp-scrim")) this._cancel();
    };
    const panel = html`
      <div class="pp-panel" role="dialog" aria-label="Patch change">
        <div class="pp-head">
          <div class="title">${this.mode === "edit" ? "Edit patch change" : "Add patch change"}</div>
          <button class="x" title="Close" @click=${() => this._cancel()}>×</button>
        </div>
        <div class="pp-controls">
          <label>Channel</label>
          <select
            .value=${String(this._channel + 1)}
            @change=${(e) => {
              const ch = Math.max(0, Math.min(15, Number(e.currentTarget.value) - 1));
              this._channel = ch;
              this._requestPatchNames(ch);
            }}
          >
            ${Array.from({ length: 16 }).map((_, i) => html`
              <option value=${String(i + 1)}>${i + 1}</option>
            `)}
          </select>

          <label>Bank</label>
          <select
            .value=${String(this._bank)}
            @change=${(e) => { this._bank = normalizePatchBank(Number(e.currentTarget.value)); }}
          >
            <option value="-1">Any · program only</option>
            ${banks.map((b) => html`
              <option value=${String(b.bank)}>${b.name || `Bank ${b.bank}`}</option>
            `)}
          </select>

          <label>Search</label>
          <input type="search"
                 placeholder="Filter by patch name, bank, or program number…"
                 .value=${this._search}
                 @input=${(e) => { this._search = e.currentTarget.value; }}>

          ${(model || modeName || this._patchNamesLoading) ? html`
            <div class="pp-hint">
              ${this._patchNamesLoading
                ? "Loading patch names from Ardour…"
                : `${model || "No MIDNAM"}${model && modeName ? " · " : ""}${modeName || ""}`}
            </div>
          ` : null}
        </div>
        <div class="pp-list">
          ${rows.length === 0 ? html`
            <div class="pp-empty">No patches match.</div>
          ` : rows.map((r) => html`
            <div class="pp-row ${activeRow === r ? "active" : ""}"
                 @click=${() => { this._bank = r.bank; this._program = r.program; }}
                 @dblclick=${() => { this._bank = r.bank; this._program = r.program; this._commit(); }}
                 title="Click to select · double-click to save">
              <span class="prog">${r.program + 1}</span>
              <span class="name">${r.name}</span>
              <span class="bk">${r.bank < 0 ? "" : r.bankName}</span>
            </div>
          `)}
        </div>
        <div class="pp-foot">
          <div class="summary">
            Ch <strong>${this._channel + 1}</strong>
            · Bank <strong>${this._bank < 0 ? "—" : this._bank}</strong>
            · Program <strong>${this._program + 1}</strong>
            ${activeRow ? html` · <strong>${activeRow.name}</strong>` : ""}
          </div>
          <button @click=${() => this._cancel()}>Cancel</button>
          <button class="primary" @click=${() => this._commit()}>
            ${this.mode === "edit" ? "Save" : "Add"}
          </button>
        </div>
      </div>
    `;
    return this.inline
      ? panel
      : html`<div class="pp-scrim" @click=${onScrim}>${panel}</div>`;
  }
}

customElements.define("foyer-patch-picker", PatchPicker);
