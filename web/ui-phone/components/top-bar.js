// Phone top bar: connection dot + session name (tap to open the
// session sheet) + master Listen toggle. Fixed-height, sticky to the
// top of the viewport so the transport+tracks scroll under it.
//
// This is the ONLY persistent chrome on the phone surface. Anything
// else lives in a sheet that the user has to tap to open.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed } from "foyer-core/rbac.js";

export class PhoneTopBar extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _audioOn: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      font-family: var(--font-sans);
      /* Sit above any sheet animation we throw underneath. */
      position: sticky;
      top: 0;
      z-index: 60;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--color-text-muted);
      flex: 0 0 auto;
    }
    .dot.open   { background: var(--color-success, #22c55e); }
    .dot.closed { background: var(--color-text-muted); }
    .dot.error  { background: var(--color-danger,  #ef4444); }
    /* Tap-to-open session sheet. Stretches to fill so the entire
     * bar (minus the dot + Listen) is one large hit target. Easier
     * than trying to find a 12-pt session name on the move. */
    .session {
      flex: 1;
      display: flex; align-items: center; gap: 6px;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 8px;
      background: transparent;
      border: 0;
      color: var(--color-text);
      font: inherit; font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s ease;
    }
    .session:active { background: var(--color-surface-elevated); }
    .session .name {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 600;
    }
    .session .none {
      color: var(--color-text-muted);
      font-style: italic;
      font-weight: 500;
    }
    .session .dirty { color: var(--color-warning, #fbbf24); flex: 0 0 auto; }
    .listen {
      flex: 0 0 auto;
      width: 44px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 8px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .listen.on {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
    .listen:active { transform: scale(0.94); }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._audioOn = !!window.__foyer?.audio?.isOn?.();
    this._onChange = () => { this._tick++; };
    this._onAudio = () => { this._audioOn = !!window.__foyer?.audio?.isOn?.(); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change", this._onChange);
    window.__foyer?.store?.addEventListener("sessions", this._onChange);
    window.__foyer?.audio?.addEventListener?.("change", this._onAudio);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onChange);
    window.__foyer?.store?.removeEventListener("sessions", this._onChange);
    window.__foyer?.audio?.removeEventListener?.("change", this._onAudio);
    super.disconnectedCallback();
  }

  _toggleListen = async () => {
    try { await window.__foyer?.audio?.toggle?.(); }
    catch (e) { console.error("[phone] listen toggle failed:", e); }
  };

  _openSheet = () => {
    this.dispatchEvent(new CustomEvent("open-sheet", {
      bubbles: true, composed: true,
    }));
  };

  render() {
    void this._tick;
    const status = window.__foyer?.store?.state?.status || "idle";
    const cur = window.__foyer?.store?.currentSession?.();
    const sessions = window.__foyer?.store?.state?.sessions || [];
    const tappable = isAllowed("launch_project") || sessions.length > 1;
    return html`
      <span class="dot ${status}" title=${status}></span>
      <button class="session" ?disabled=${!tappable} @click=${this._openSheet}>
        ${cur ? html`
          <span class="name">${cur.name || "(unnamed)"}</span>
          ${cur.dirty ? html`<span class="dirty">•</span>` : null}
          ${tappable ? icon("chevron-down", 12) : null}
        ` : html`
          <span class="name none">No session open</span>
          ${tappable ? icon("chevron-down", 12) : null}
        `}
      </button>
      <button class="listen ${this._audioOn ? "on" : ""}"
              title=${this._audioOn ? "Stop monitoring" : "Listen to master"}
              @click=${this._toggleListen}>
        ${icon(this._audioOn ? "speaker-wave" : "speaker-x-mark", 18)}
      </button>
    `;
  }
}
customElements.define("foyer-phone-top-bar", PhoneTopBar);
