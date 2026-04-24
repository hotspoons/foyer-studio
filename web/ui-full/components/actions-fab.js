// SPDX-License-Identifier: Apache-2.0
//
// Actions FAB — tearable-out presentation of the DAW action catalog
// that used to be a fixed rail button on the right-dock. Defaults to
// docked (shows up as a rail icon); drag off to tear into a floating
// panel that can live anywhere.
//
// Content is sourced from `Event::ActionsList` (server replies to
// `list_actions`). Clicking an entry invokes it via `invoke_action`.

import { html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { QuadrantFab } from "./quadrant-fab.js";

export class FoyerActionsFab extends QuadrantFab {
  static styles = [
    QuadrantFab.styles,
    css`
      .group-title {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        margin: 8px 10px 2px;
      }
      .item {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 10px;
        font-size: 11px;
        color: var(--color-text);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }
      .item:hover { background: var(--color-surface-elevated); color: var(--color-accent-3); }
      .item .shortcut {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--color-text-muted);
      }
      .empty {
        padding: 16px 10px;
        font-size: 11px;
        color: var(--color-text-muted);
      }
    `,
  ];

  static properties = {
    ...QuadrantFab.properties,
    _actions: { state: true, type: Array },
  };

  constructor() {
    super();
    this.storageKey = "foyer.actions";
    this._fabTitle = "Actions";
    this._fabAccent = "accent";
    this._actions = [];
  }

  _dockMeta() {
    return {
      label: "Actions",
      icon: "list-bullet",
      accent: this._fabAccent,
      expandsRail: false,
      defaultDocked: true,
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._onEnvelope = (ev) => {
      const body = ev.detail?.body;
      if (body?.type === "actions_list") {
        this._actions = body.actions || [];
      }
    };
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    window.__foyer?.ws?.send?.({ type: "list_actions" });
  }

  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
    super.disconnectedCallback();
  }

  _invoke(id) {
    window.__foyer?.ws?.send?.({ type: "invoke_action", id });
  }

  _renderFabContent() {
    return icon("list-bullet", 22);
  }

  _renderPanelContent() {
    if (!this._actions.length) {
      return html`<div class="empty">No actions from the backend yet — request pending.</div>`;
    }
    const byCat = {};
    for (const a of this._actions) (byCat[a.category] ||= []).push(a);
    const cats = Object.keys(byCat).sort();
    return html`
      ${cats.map((c) => html`
        <div class="group-title">${c}</div>
        ${byCat[c].map((a) => html`
          <div class="item" @click=${() => this._invoke(a.id)}>
            <span style="flex:1">${a.label}</span>
            ${a.shortcut ? html`<span class="shortcut">${a.shortcut}</span>` : null}
          </div>
        `)}
      `)}
    `;
  }
}

customElements.define("foyer-actions-fab", FoyerActionsFab);
