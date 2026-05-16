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
import { isActionHiddenFromCatalog } from "foyer-core/rbac.js";
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
    _scripts: { state: true, type: Array },
  };

  constructor() {
    super();
    this.storageKey = "foyer.actions";
    this._fabTitle = "Actions";
    this._fabAccent = "accent";
    this._actions = [];
    // Persisted scripts the shim has flagged runnable. Surfaced as a
    // "Scripts" group at the bottom of the catalog so users can fire
    // them with one click without opening the dedicated Script Manager
    // panel. The agent already exposes them via `scripts.run`; this
    // is the user-facing peer affordance.
    this._scripts = [];
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
      if (!body?.type) return;
      switch (body.type) {
        case "actions_list":
          this._actions = body.actions || [];
          return;
        case "script_list":
          this._scripts = body.scripts || [];
          return;
        case "script_saved": {
          const s = body.script;
          const i = this._scripts.findIndex((x) => x.id === s.id);
          const next = this._scripts.slice();
          if (i >= 0) next[i] = s; else next.push(s);
          this._scripts = next;
          return;
        }
        case "script_removed": {
          const id = body.id?.toString?.() || body.id;
          this._scripts = this._scripts.filter((x) => x.id !== id);
          return;
        }
      }
    };
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    window.__foyer?.ws?.send?.({ type: "list_actions" });
    // The server pushes ScriptList on attach (see foyer-server's
    // ws.rs attach handler) so we usually have data already; the
    // explicit refresh here covers cases where the FAB mounts
    // mid-session.
    window.__foyer?.ws?.send?.({ type: "list_scripts" });
  }

  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
    super.disconnectedCallback();
  }

  _invoke(id) {
    if (id === "session.save_as") {
      import("./save-session-as-modal.js").then((m) => m.openSaveSessionAs());
      return;
    }
    if (id === "session.preferences") {
      import("./settings-modal.js").then((m) => m.openSettings());
      return;
    }
    window.__foyer?.ws?.send?.({ type: "invoke_action", id });
  }

  _runScript(id) {
    window.__foyer?.ws?.send?.({ type: "run_script", id });
  }

  /// Filter the persisted script set down to entries whose backend-
  /// declared type descriptor sets `runnable=true`. Reads the
  /// scripting capabilities off the live snapshot so the host-
  /// agnostic shape stays intact — we never hard-code "snippet" or
  /// "editor_action" here, the shim is the source of truth.
  _runnableScripts() {
    const caps = window.__foyer?.store?.state?.session?.scripting;
    if (!caps?.script_types) return [];
    const runnable = new Set(
      caps.script_types.filter((t) => t.runnable).map((t) => t.id),
    );
    return this._scripts.filter((s) => s.enabled && runnable.has(s.script_type));
  }

  _renderFabContent() {
    return icon("list-bullet", 22);
  }

  _renderPanelContent() {
    const visible = this._actions.filter((a) => !isActionHiddenFromCatalog(a));
    const runnable = this._runnableScripts();
    if (!visible.length && !runnable.length) {
      return html`<div class="empty">No actions from the backend yet — request pending.</div>`;
    }
    const byCat = {};
    for (const a of visible) (byCat[a.category] ||= []).push(a);
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
      ${runnable.length ? html`
        <div class="group-title">Scripts</div>
        ${runnable.map((s) => html`
          <div class="item" @click=${() => this._runScript(s.id)}
               title=${s.description || ""}>
            <span style="flex:1">${s.name}</span>
            <span class="shortcut">${s.script_type}</span>
          </div>
        `)}
      ` : null}
    `;
  }
}

customElements.define("foyer-actions-fab", FoyerActionsFab);
