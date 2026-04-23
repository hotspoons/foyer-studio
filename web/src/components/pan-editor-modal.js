import { LitElement, html, css } from "lit";

export class PanEditorModal extends LitElement {
  static properties = {
    trackId: { type: String, attribute: "track-id" },
    _tick: { state: true },
    _mode: { state: true },
    _surroundX: { state: true },
    _surroundY: { state: true },
  };

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; }
    .wrap { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
    .tabs { display: inline-flex; gap: 6px; }
    .tab {
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .tab.active {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .row input[type="range"] { flex: 1; }
    .hint { color: var(--color-text-muted); font-size: 11px; }
    .pad {
      width: 220px; height: 220px; border: 1px solid var(--color-border);
      border-radius: 8px; position: relative; background: var(--color-surface-elevated);
      cursor: crosshair;
    }
    .dot {
      position: absolute; width: 12px; height: 12px; border-radius: 50%;
      background: var(--color-accent); border: 2px solid #fff; pointer-events: none;
      transform: translate(-50%, -50%);
    }
  `;

  constructor() {
    super();
    this.trackId = "";
    this._tick = 0;
    this._mode = "stereo";
    this._surroundX = 0;
    this._surroundY = 0;
    this._onStore = () => this._tick++;
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._onStore);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStore);
    super.disconnectedCallback();
  }

  _track() {
    return window.__foyer?.store?.state?.session?.tracks?.find((t) => t.id === this.trackId) || null;
  }

  _setPan(v) {
    const tr = this._track();
    if (!tr?.pan?.id) return;
    const value = Math.max(-1, Math.min(1, Number(v) || 0));
    window.__foyer?.ws?.controlSet(tr.pan.id, value);
  }

  _pointerToPad(ev) {
    const pad = ev.currentTarget;
    const r = pad.getBoundingClientRect();
    const nx = ((ev.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((ev.clientY - r.top) / r.height) * 2 - 1;
    this._surroundX = Math.max(-1, Math.min(1, nx));
    this._surroundY = Math.max(-1, Math.min(1, ny));
    // For now, map X axis to host pan; Y axis stays client-side until
    // dedicated surround controls are added to backend contracts.
    this._setPan(this._surroundX);
  }

  render() {
    const tr = this._track();
    if (!tr) return html`<div class="wrap">Track not found.</div>`;
    const panVal = Number(window.__foyer?.store?.get(tr.pan?.id) ?? tr.pan?.value ?? 0);
    const dotX = ((this._surroundX + 1) * 0.5) * 220;
    const dotY = ((this._surroundY + 1) * 0.5) * 220;
    return html`
      <div class="wrap">
        <div class="tabs">
          <button class="tab ${this._mode === "stereo" ? "active" : ""}" @click=${() => (this._mode = "stereo")}>Stereo</button>
          <button class="tab ${this._mode === "surround" ? "active" : ""}" @click=${() => (this._mode = "surround")}>Surround</button>
        </div>
        ${this._mode === "stereo" ? html`
          <div class="row">
            <span>L</span>
            <input type="range" min="-1" max="1" step="0.001"
                   .value=${String(panVal)}
                   @input=${(e) => this._setPan(e.currentTarget.value)}>
            <span>R</span>
            <strong>${panVal.toFixed(3)}</strong>
          </div>
        ` : html`
          <div class="row">
            <div class="pad"
                 @pointerdown=${this._pointerToPad}
                 @pointermove=${(e) => { if (e.buttons & 1) this._pointerToPad(e); }}>
              <div class="dot" style="left:${dotX}px;top:${dotY}px"></div>
            </div>
            <div class="hint">
              X-axis writes host pan now.<br>
              Y-axis is previewed for future surround contracts.
            </div>
          </div>
        `}
      </div>
    `;
  }
}

customElements.define("foyer-pan-editor-modal", PanEditorModal);

export function openPanEditor(trackId) {
  if (!trackId) return;
  Promise.all([
    import("./window.js"),
    import("./pan-editor-modal.js"),
  ]).then(([wm]) => {
    const el = document.createElement("foyer-pan-editor-modal");
    el.trackId = trackId;
    wm.openWindow({
      title: "Pan editor",
      icon: "adjustments-horizontal",
      storageKey: `pan-editor.${trackId}`,
      content: el,
      width: 420,
      height: 360,
    });
  });
}
