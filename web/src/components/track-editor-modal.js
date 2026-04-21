// Track editor modal. Full-depth editor for a single track — right-
// click the label in the mixer or timeline to open.
//
// Shows: name, color, comment (not wired yet), the full mixer strip
// embedded so the user can tune gain/pan/mute/solo without leaving
// the timeline tile, and — once shim support lands — bus assignment
// and group membership.
//
// Route all edits through `update_track`; backend echo updates the
// store and the modal re-reads from the live track.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import "./track-strip.js";
import { DENSITIES } from "../mixer-density.js";

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

export class TrackEditorModal extends LitElement {
  static properties = {
    trackId: { type: String, attribute: "track-id" },
    _tick:   { state: true, type: Number },
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
    header .swatch {
      width: 14px; height: 14px; border-radius: 3px;
      border: 1px solid var(--color-border);
    }
    header .close { display: none; }
    .body {
      padding: 14px 18px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 14px;
      flex: 1; min-height: 0;
    }
    .section { display: flex; flex-direction: column; gap: 6px; }
    .section h3 {
      margin: 0; font-size: 10px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .row {
      display: flex; align-items: center; gap: 10px;
    }
    .row label { font-size: 12px; color: var(--color-text); flex: 0 0 120px; }
    input[type="text"], textarea {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      font: inherit; font-size: 12px;
    }
    textarea { resize: vertical; min-height: 60px; }
    .swatch-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .swatch-btn {
      width: 22px; height: 22px;
      border-radius: 4px;
      border: 1px solid var(--color-border);
      cursor: pointer; padding: 0;
    }
    .swatch-btn.active { outline: 2px solid var(--color-accent); outline-offset: 1px; }
    .swatch-btn.clear {
      background: repeating-linear-gradient(45deg,
        var(--color-surface-elevated), var(--color-surface-elevated) 3px,
        var(--color-border) 3px, var(--color-border) 5px);
      display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted); font-size: 10px;
    }
    .strip-slot {
      display: flex;
      justify-content: center;
      align-items: stretch;
      padding: 12px;
      background: var(--color-surface-muted);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      min-height: 260px;
    }
    .strip-slot foyer-track-strip {
      width: 160px;
      flex: 0 0 160px;
    }
    footer {
      padding: 10px 18px;
      border-top: 1px solid var(--color-border);
      display: flex; justify-content: flex-end; gap: 8px;
    }
    footer button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 12px; cursor: pointer;
      border-radius: var(--radius-sm);
      font: inherit; font-size: 12px;
    }
    footer button.primary {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
  `;

  constructor() {
    super();
    this.trackId = "";
    this._tick = 0;
    this._keyHandler = (ev) => { if (ev.key === "Escape") this._close(); };
    this._storeHandler = () => this._tick++;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._keyHandler);
    window.__foyer?.store?.addEventListener("change", this._storeHandler);
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._keyHandler);
    window.__foyer?.store?.removeEventListener("change", this._storeHandler);
    super.disconnectedCallback();
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _track() {
    const s = window.__foyer?.store?.state?.session;
    return s?.tracks?.find((t) => t.id === this.trackId) || null;
  }

  _patch(patch) {
    window.__foyer?.ws?.send({
      type: "update_track",
      id: this.trackId,
      patch,
    });
  }

  _commitName(value) {
    const name = (value || "").trim();
    const t = this._track();
    if (!name || !t || name === t.name) return;
    this._patch({ name });
  }

  render() {
    const t = this._track();
    if (!t) {
      return html`
        <div class="card">
          <header><h2>Track not found</h2></header>
          <div class="body">
            <div style="color:var(--color-text-muted);font-size:12px">
              The track this editor was opened for is no longer in the session.
            </div>
          </div>
        </div>
      `;
    }
    const color = t.color || "";
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          ${color ? html`<span class="swatch" style="background:${color}"></span>` : null}
          <h2>${t.name}</h2>
          <span style="font-size:10px;color:var(--color-text-muted);letter-spacing:0.08em;text-transform:uppercase">${t.kind}</span>
          <button class="close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        <div class="body">
          <div class="section">
            <h3>Name</h3>
            <div class="row">
              <input type="text" autofocus .value=${t.name}
                     @change=${(e) => this._commitName(e.currentTarget.value)}
                     @keydown=${(e) => { if (e.key === "Enter") this._commitName(e.currentTarget.value); }}>
            </div>
          </div>
          <div class="section">
            <h3>Color</h3>
            <div class="row">
              <div class="swatch-row">
                ${COLOR_PALETTE.map((c) => html`
                  <button class="swatch-btn ${color === c.hex ? "active" : ""}"
                          style="background:${c.hex}"
                          title=${c.label}
                          @click=${() => this._patch({ color: c.hex })}></button>
                `)}
                <button class="swatch-btn clear"
                        title="Clear color"
                        @click=${() => this._patch({ color: "" })}>×</button>
              </div>
            </div>
          </div>
          <div class="section">
            <h3>Comment</h3>
            <div class="row">
              <textarea placeholder="Notes about this track — not wired to the backend yet."
                        .value=${t.comment || ""}
                        @change=${(e) => this._patch({ comment: e.currentTarget.value })}></textarea>
            </div>
          </div>
          <div class="section">
            <h3>Mixer strip</h3>
            <div class="strip-slot">
              <foyer-track-strip
                .track=${t}
                .density=${DENSITIES.normal}
                .widthMode=${"absolute"}
              ></foyer-track-strip>
            </div>
          </div>
          <div class="section">
            <h3>Routing</h3>
            <div class="row">
              <label style="color:var(--color-text-muted);font-size:11px">
                Bus / group assignment lands once the shim exposes it (tracked in
                TODO.md "busses and groups — need to support this").
              </label>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-track-editor-modal", TrackEditorModal);

export function openTrackEditor(trackId) {
  if (!trackId) return () => {};
  const el = document.createElement("foyer-track-editor-modal");
  el.trackId = trackId;
  return import("./window.js").then((m) => m.openWindow({
    title: "Track editor",
    icon: "adjustments-horizontal",
    storageKey: `track-editor.${trackId}`,
    content: el,
    width: 720,
    height: 640,
  }));
}
