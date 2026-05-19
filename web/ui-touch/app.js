// SPDX-License-Identifier: Apache-2.0
// Touch app shell. See package.js for the layout sketch + design intent.
//
// Composition:
//   <foyer-touch-app>
//     <foyer-touch-top-bar/>          ← session + transport
//     <foyer-touch-pin-row?>          ← pinned panels (hidden if empty)
//     <main>                          ← active panel body
//       <foyer-touch-panel-host/>
//     </main>
//     <foyer-touch-bottom-nav/>       ← Mixer / Timeline / Tracks / More

import { LitElement, html, css } from "lit";

import { applyTheme } from "foyer-ui-core/theme.js";
import { rehydrateWindows } from "foyer-ui-core/widgets/window.js";
import { bootRegionCache } from "foyer-core/region-cache.js";

import "./components/touch-top-bar.js";
import "./components/touch-bottom-nav.js";
import "./components/touch-pin-row.js";
import "./components/touch-panel-host.js";
import "./components/touch-more-panel.js";
import "./components/touch-tracks-panel.js";
import "./components/touch-timeline-split.js";

// View components re-used from ui-full. These are full-featured Lit
// elements; ui-touch just hosts them in a friendlier shell. Side-
// effect imports register the custom element tags; touch-panel-host
// instantiates them by tag.
import "../ui-full/components/mixer.js";
import "../ui-full/components/timeline-view.js";
import "../ui-full/components/plugins-view.js";
import "../ui-full/components/automation-panel.js";
import "../ui-full/components/midi-editor.js";
import "../ui-full/components/beat-sequencer.js";
import "../ui-full/components/spectrum-tile.js";
import "../ui-full/components/session-view.js";
import "../ui-full/components/midi-devices-panel.js";
import "../ui-full/components/soft-keyboard.js";
import "../ui-full/components/console-view.js";
import "../ui-full/components/diagnostics.js";
import "../ui-full/components/agent-panel.js";
// Modal: preferences + project picker
import "../ui-full/components/settings-modal.js";

import { activePanelFromHash, setActivePanel, panelById } from "./panels.js";
import { setPanelTarget } from "./components/touch-panel-host.js";

export class TouchApp extends LitElement {
  static properties = {
    _activePanel: { state: true, type: String },
    _modal: { state: true, type: String },
    _tick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      height: 100svh;
      background: var(--color-bg, #0b1120);
      color: var(--color-text);
      font-family: var(--font-sans);
      overscroll-behavior: contain;
      /* The whole variant is tuned to bigger touch targets: bump
       * the base font + control hit areas via local CSS vars that
       * cascade into the embedded ui-full widgets where possible.
       * Widgets that hardcode their sizes will still feel cramped;
       * those are tracked separately. */
      --touch-tap: 44px;
      --touch-gap: 12px;
      font-size: 15px;
    }
    main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    foyer-touch-panel-host {
      flex: 1;
      min-height: 0;
      display: block;
    }
    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
    }
    .modal-frame {
      background: var(--color-surface, #1f2937);
      border-radius: 16px;
      max-width: 92vw;
      max-height: 92vh;
      width: 600px;
      overflow: auto;
      padding: 0;
    }
  `;

  constructor() {
    super();
    this._activePanel = activePanelFromHash();
    this._modal = null;
    this._tick = 0;
    this._onHashChange = () => {
      this._activePanel = activePanelFromHash();
    };
    this._onStoreChange = () => { this._tick++; };
    this._onOpenModal = (ev) => { this._modal = ev?.detail?.id || null; };
    this._onClosePanel = () => { this._modal = null; };
    // Region edit pencil in the embedded timeline fires this event
    // before falling back to the desktop floating-window opener. We
    // claim it (preventDefault) and route to the matching panel with
    // the region pre-selected.
    this._onRegionEdit = (ev) => {
      const d = ev?.detail || {};
      if (d.editor !== "piano-roll" && d.editor !== "beat-seq") return;
      ev.preventDefault?.();
      setPanelTarget(d.editor, { trackId: d.trackId, regionId: d.regionId });
      setActivePanel(d.editor);
    };
  }

  connectedCallback() {
    super.connectedCallback();
    applyTheme();
    bootRegionCache();
    rehydrateWindows();
    globalThis.addEventListener("hashchange", this._onHashChange);
    globalThis.addEventListener("foyer-touch:open-modal", this._onOpenModal);
    globalThis.addEventListener("foyer-touch:close-modal", this._onClosePanel);
    this.addEventListener("foyer:request-region-edit", this._onRegionEdit);
    window.__foyer?.store?.addEventListener?.("change", this._onStoreChange);
    // No initial hash → set the default so back/forward feels stable.
    if (!globalThis.location.hash) setActivePanel(this._activePanel);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("hashchange", this._onHashChange);
    globalThis.removeEventListener("foyer-touch:open-modal", this._onOpenModal);
    globalThis.removeEventListener("foyer-touch:close-modal", this._onClosePanel);
    this.removeEventListener("foyer:request-region-edit", this._onRegionEdit);
    window.__foyer?.store?.removeEventListener?.("change", this._onStoreChange);
  }

  _closeModal() { this._modal = null; }

  _renderModal() {
    if (!this._modal) return null;
    const panel = panelById(this._modal);
    if (!panel) return null;
    let body = null;
    if (this._modal === "settings") {
      body = html`<foyer-settings-modal @close=${() => this._closeModal()}></foyer-settings-modal>`;
    } else if (this._modal === "language") {
      // Same settings modal — it already has a language section first.
      body = html`<foyer-settings-modal @close=${() => this._closeModal()}></foyer-settings-modal>`;
    } else if (this._modal === "snapshot") {
      // Tiny inline form: name + Save.
      body = html`
        <div style="padding:20px; display:flex; flex-direction:column; gap:12px">
          <h2 style="margin:0">Quick snapshot</h2>
          <p style="margin:0; color: var(--color-text-muted); font-size: 13px">
            Saves a named copy of the current project file. Use it to
            A/B without leaving the session.
          </p>
          <input id="snap-name" type="text" placeholder="snapshot name (optional)"
                 style="padding:12px; font-size:15px; border-radius:8px;
                        border:1px solid var(--color-border); background:var(--color-bg);
                        color: var(--color-text)">
          <div style="display:flex; gap:8px; justify-content:flex-end">
            <button @click=${() => this._closeModal()}
                    style="padding:12px 18px; border-radius:8px; border:0;
                           background: var(--color-border); color: var(--color-text);
                           font-size:14px">Cancel</button>
            <button @click=${(e) => {
              const name = e.currentTarget.closest(".modal-frame")
                ?.querySelector("#snap-name")?.value?.trim() || null;
              window.__foyer?.ws?.send({
                type: "snapshot_session",
                name,
              });
              this._closeModal();
            }} style="padding:12px 18px; border-radius:8px; border:0;
                       background: var(--color-accent); color: white;
                       font-size:14px; font-weight: 600">Save snapshot</button>
          </div>
        </div>
      `;
    } else {
      body = html`<div style="padding:24px">${panel.label}: nothing wired yet.</div>`;
    }
    return html`
      <div class="modal-backdrop" @click=${() => this._closeModal()}>
        <div class="modal-frame" @click=${(e) => e.stopPropagation()}>${body}</div>
      </div>
    `;
  }

  render() {
    return html`
      <foyer-touch-top-bar></foyer-touch-top-bar>
      <foyer-touch-pin-row .activeId=${this._activePanel}></foyer-touch-pin-row>
      <main>
        <foyer-touch-panel-host .panelId=${this._activePanel}></foyer-touch-panel-host>
      </main>
      <foyer-touch-bottom-nav .activeId=${this._activePanel}></foyer-touch-bottom-nav>
      ${this._renderModal()}
    `;
  }
}

customElements.define("foyer-touch-app", TouchApp);
