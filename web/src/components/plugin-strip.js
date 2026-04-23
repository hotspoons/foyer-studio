// Per-track vertical plugin insert strip.
//
// Each row shows an insert with its name and a bypass toggle. Clicking the
// name opens the generated plugin panel in a floating window (sticky-slotted
// per the user's last choice). Right-click or the menu affordance prompts the
// slot picker. The bypass button sends `ControlSet` on the plugin's synthetic
// `.bypass` parameter so the authoritative state stays on the backend; the UI
// re-renders when the echo arrives.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { openPluginFloat } from "../layout/plugin-layer.js";
import { openPluginPicker } from "./plugin-picker-modal.js";
import { showContextMenu } from "./context-menu.js";

export class PluginStrip extends LitElement {
  static properties = {
    plugins: { type: Array },
    maxLines: { type: Number },
    trackId: { type: String, attribute: "track-id" },
    trackName: { type: String, attribute: "track-name" },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 3px;
      min-width: 0;
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      background: color-mix(in oklab, var(--color-surface-muted) 30%, var(--color-surface));
    }
    .row {
      display: flex; align-items: center; gap: 3px;
      padding: 1px 3px;
      min-width: 0;
      height: 17px;
      border-radius: 3px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      font-family: var(--font-sans);
      font-size: 9px;
      color: var(--color-text);
      overflow: hidden;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .row:hover {
      border-color: var(--color-accent);
      color: var(--color-accent-3);
    }
    .row.bypassed { opacity: 0.45; }
    .row .name {
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      letter-spacing: 0.01em;
    }
    .row button {
      flex: 0 0 auto;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      color: var(--color-text-muted);
      padding: 0 3px;
      font-size: 9px;
      cursor: pointer;
      display: inline-flex; align-items: center;
    }
    .row button.by {
      font-weight: 800;
      font-family: var(--font-mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: color-mix(in oklab, var(--color-text) 35%, var(--color-accent-2));
    }
    .row button:hover { color: var(--color-text); border-color: var(--color-border); }
    .row.bypassed button.by {
      color: var(--color-warning);
      border-color: color-mix(in oklab, var(--color-warning) 65%, transparent);
      background: color-mix(in oklab, var(--color-warning) 22%, transparent);
    }
    .slot {
      display: flex; align-items: center; justify-content: center;
      height: 13px;
      font-size: 10px;
      color: var(--color-text-muted);
      border: 1px dashed var(--color-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .slot:hover { color: var(--color-accent-3); border-color: var(--color-accent); }
    .empty { color: var(--color-text-muted); font-size: 9px; padding: 1px; text-align: center; font-style: italic; }
  `;

  constructor() {
    super();
    this.plugins = [];
    this.maxLines = 3;
    this._errors = [];
    this._dismissed = this._loadDismissed();
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._onControl = () => this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.ws?.addEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.addEventListener("control", this._onControl);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    window.__foyer?.store?.removeEventListener("control", this._onControl);
    super.disconnectedCallback();
  }

  /** Capture `add_plugin_failed` / `remove_plugin_failed` error
   *  events broadcast by the sidecar. The server today sends a
   *  generic `Event::Error` without a track id — we heuristically
   *  attach the last pending add to this track if the error's
   *  message mentions our track or plugin URI. */
  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type !== "error") return;
    const code = body.code || "";
    if (!code.startsWith("add_plugin") && !code.startsWith("remove_plugin")) return;
    const msg = body.message || "";
    // Only surface errors whose message mentions this track — prevents
    // a failure from one track's insert showing in another.
    if (this.trackId && !msg.includes(this.trackId)) return;
    const key = `${this.trackId}|${msg}`;
    if (this._dismissed.has(key)) return;
    this._errors = [...this._errors, { code, message: msg, key }];
    this.requestUpdate();
  }

  _loadDismissed() {
    try {
      const raw = localStorage.getItem("foyer.plugin.errors.dismissed") || "[]";
      return new Set(JSON.parse(raw));
    } catch {
      return new Set();
    }
  }
  _dismiss(key) {
    this._dismissed.add(key);
    try {
      localStorage.setItem(
        "foyer.plugin.errors.dismissed",
        JSON.stringify([...this._dismissed]),
      );
    } catch {}
    this._errors = this._errors.filter((e) => e.key !== key);
    this.requestUpdate();
  }

  render() {
    const plugs = this.plugins || [];
    const extra = Math.max(0, plugs.length - this.maxLines);
    const shown = plugs.slice(0, this.maxLines);
    return html`
      ${this._errors.map((e) => html`
        <div class="row"
             style="background:color-mix(in oklab, var(--color-danger, #d04040) 24%, var(--color-surface-elevated));border-color:var(--color-danger, #d04040);color:#fff"
             title="${e.message}">
          <span class="name" style="color:#fff">${e.code}</span>
          <button class="by" title="Dismiss"
                  @click=${(ev) => { ev.stopPropagation(); this._dismiss(e.key); }}>×</button>
        </div>
      `)}
      ${shown.map(
        (p) => html`
          <div
            class="row ${this._isBypassed(p) ? "bypassed" : ""}"
            title="Click to open ${p.name}"
            @click=${() => this._openPanel(p)}
            @dblclick=${(ev) => this._openTrackEditor(ev)}
            @contextmenu=${(ev) => this._onContextMenu(ev, p)}
          >
            <span class="name">${p.name}</span>
            <button
              class="by"
              title=${this._isBypassed(p) ? "Enable" : "Bypass"}
              @click=${(ev) => this._toggleBypass(ev, p)}
            >
              by
            </button>
          </div>
        `
      )}
      ${extra > 0 ? html`<div class="empty">+${extra} more</div>` : null}
      <div class="slot" @click=${this._addSlot} @dblclick=${(ev) => this._openTrackEditor(ev)} title="Open plugin picker">
        ${icon("plus", 10)}
      </div>
    `;
  }

  _isBypassed(p) {
    const bypassParam = (p.params || []).find((x) => x.id.endsWith(".bypass"));
    if (bypassParam) {
      const store = window.__foyer?.store;
      const live = store?.get(bypassParam.id);
      if (live !== undefined) return live === true || live === 1 || live?.Bool === true;
      if (typeof bypassParam.value === "boolean") return bypassParam.value;
    }
    return !!p.bypassed;
  }

  _toggleBypass(ev, p) {
    ev.stopPropagation();
    const bypassParam = (p.params || []).find((x) => x.id.endsWith(".bypass"));
    const ws = window.__foyer?.ws;
    const on = !this._isBypassed(p);
    if (bypassParam && ws) {
      ws.controlSet(bypassParam.id, on);
    } else {
      // Legacy path: no bypass param on this plugin instance. Flip local state
      // so the gesture still registers; backend will catch up once params are
      // wired.
      p.bypassed = on;
      this.requestUpdate();
    }
    this.dispatchEvent(
      new CustomEvent("bypass", {
        detail: { plugin: p, bypassed: on },
        bubbles: true,
        composed: true,
      })
    );
  }

  _openPanel(p) {
    // Plugin windows live on their own auto-layout layer — they are NOT
    // floating-tiles. See docs/DECISIONS.md #12.
    openPluginFloat(p);
  }

  _onContextMenu(ev, p) {
    ev.preventDefault();
    ev.stopPropagation();
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    const duplicateTargets = tracks
      .filter((t) => t.id && t.id !== this.trackId)
      .map((t) => ({
        label: t.name,
        action: () => this._duplicatePluginToTrack(p, t.id),
      }));
    showContextMenu(ev, [
      { heading: p?.name || "Plugin" },
      {
        label: "Open plugin panel",
        icon: "window",
        action: () => openPluginFloat(p),
      },
      {
        label: "Open track editor…",
        icon: "adjustments-horizontal",
        action: () => this._openTrackEditor(),
      },
      ...(duplicateTargets.length ? [
        {
          label: "Duplicate to track",
          icon: "document-duplicate",
          submenu: duplicateTargets,
        },
      ] : []),
      { separator: true },
      {
        label: "Remove plugin",
        icon: "trash",
        tone: "danger",
        action: () => this._removePlugin(p),
      },
    ]);
  }

  _removePlugin(p) {
    if (!p?.id) return;
    window.__foyer?.ws?.send({ type: "remove_plugin", plugin_id: p.id });
  }

  _duplicatePluginToTrack(plugin, targetTrackId) {
    if (!plugin?.uri || !targetTrackId) return;
    window.__foyer?.ws?.send({
      type: "add_plugin",
      track_id: targetTrackId,
      plugin_uri: plugin.uri,
    });
  }

  _openTrackEditor(ev) {
    ev?.stopPropagation?.();
    if (!this.trackId) return;
    import("./track-editor-modal.js").then((m) => m.openTrackEditor(this.trackId));
  }

  _addSlot() {
    if (!this.trackId) {
      // Fallback if the parent didn't pass a target track — land on the
      // catalog view so the click isn't dead. Shouldn't happen in the
      // normal mixer/timeline flow.
      location.hash = "plugins";
      return;
    }
    openPluginPicker({ trackId: this.trackId, trackName: this.trackName });
  }
}
customElements.define("foyer-plugin-strip", PluginStrip);
