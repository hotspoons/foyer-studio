// SPDX-License-Identifier: Apache-2.0
//
// Session-info FAB — tear-out metadata view for the currently-loaded
// session. Was a fixed rail button on the right-dock; now a dockable
// FAB like Actions + Windows. Updates live as the session snapshot
// changes.

import { html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { QuadrantFab } from "./quadrant-fab.js";

export class FoyerSessionFab extends QuadrantFab {
  static styles = [
    QuadrantFab.styles,
    css`
      .wrap {
        font-family: var(--font-mono);
        font-size: 11px;
        padding: 10px;
        color: var(--color-text);
      }
      .track {
        margin-top: 8px;
      }
      .track .name { color: var(--color-accent-3); font-weight: 600; }
      .track .id { color: var(--color-text-muted); }
      .empty { color: var(--color-text-muted); padding: 16px 10px; font-size: 11px; }
    `,
  ];

  constructor() {
    super();
    this.storageKey = "foyer.session-info";
    this._fabTitle = "Session";
    this._fabAccent = "accent";
  }

  _dockMeta() {
    return {
      label: "Session",
      icon: "folder-open",
      accent: this._fabAccent,
      expandsRail: false,
      defaultDocked: true,
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._storeListener = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener?.("change", this._storeListener);
  }

  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener?.("change", this._storeListener);
    super.disconnectedCallback();
  }

  _renderFabContent() {
    return icon("folder-open", 22);
  }

  _renderPanelContent() {
    const s = window.__foyer?.store?.state?.session;
    if (!s) {
      return html`<div class="empty">No session loaded.</div>`;
    }
    const schema = s.schema_version ? `${s.schema_version[0]}.${s.schema_version[1]}` : "?";
    return html`
      <div class="wrap">
        <div>schema: ${schema}</div>
        <div>tracks: ${s.tracks?.length ?? 0}</div>
        ${(s.tracks || []).map((t) => html`
          <div class="track">
            <div class="name">${t.name}</div>
            <div class="id">${t.kind} · ${t.id}</div>
          </div>
        `)}
      </div>
    `;
  }
}

customElements.define("foyer-session-fab", FoyerSessionFab);
