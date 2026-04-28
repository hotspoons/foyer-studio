// Generated plugin UI — reads a PluginInstance and renders every param grouped
// by the plugin-provided `group` hint, with a sticky header carrying the
// bypass switch and the plugin name.
//
// This is the first-class delivery of the schema-driven promise: no plugin
// knows about this panel, no panel code knows about any specific plugin.
// Ranges, scales, units, enum labels, and grouping all come from the wire.
//
// The parent is responsible for passing the live plugin instance (and fresh
// values). The panel subscribes to per-control updates via the store so a
// collaborator twiddling a knob shows up live.

import { LitElement, html, css } from "lit";

import "foyer-ui-core/widgets/param-control.js";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

export class PluginPanel extends LitElement {
  static properties = {
    /** Live PluginInstance from the session snapshot. */
    plugin: { type: Object },
    /** Track that hosts this plugin (for context/breadcrumb display). */
    trackName: { type: String },
    /** Header-only layout when true; hides group body. */
    minimized: { type: Boolean, reflect: true },
    /** Reactive: presets returned by the shim for the current plugin. */
    _presets: { state: true, type: Array },
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      color: var(--color-text);
      font-family: var(--font-sans);
      /* Transparent so the frosted foyer-window shell shows through.
       * Inner blocks (header, .row, .footer) keep their own backgrounds. */
      background: transparent;
      overflow: hidden;
    }

    header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(135deg,
        color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-elevated)),
        var(--color-surface-elevated));
      border-bottom: 1px solid var(--color-border);
      font-size: 11px;
      user-select: none;
    }
    header .brand {
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--color-text);
    }
    header .breadcrumb {
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    header .uri {
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--color-text-muted);
      opacity: 0.7;
    }
    header .spacer { flex: 1; }
    header .bypass {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 8px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      background: var(--color-surface);
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    header .bypass[data-on=""] {
      background: var(--color-danger);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
    }
    header .bypass:hover { border-color: var(--color-accent); color: var(--color-text); }

    header select.presets {
      flex: 0 0 auto;
      width: 120px;
      min-width: 0;
      max-width: 120px;
      box-sizing: border-box;
      font-size: 10px;
      padding: 3px 6px;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    header select.presets:hover { border-color: var(--color-accent); }
    header select.presets:disabled { opacity: 0.4; cursor: default; }
    header .bypass { flex: 0 0 auto; }
    /* The brand/URI block is the elastic part — it gets the leftover
       space and shrinks before the controls do. */
    header > div:first-child { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    header > div:first-child .uri,
    header > div:first-child .brand {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .groups {
      flex: 1 1 auto;
      overflow: auto;
      padding: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    section {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-elevated);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    section h3 {
      margin: 0;
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-accent-3);
      font-weight: 600;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      justify-content: flex-start;
      align-items: flex-end;
    }

    .empty {
      padding: 20px;
      color: var(--color-text-muted);
      font-size: 11px;
      text-align: center;
    }
  `;

  constructor() {
    super();
    this.plugin = null;
    this.trackName = "";
    this.minimized = false;
    this._presets = [];
    this._presetsForPluginId = "";
    /// Preset id the user picked (or that the plugin reported as
    /// loaded). Drives the dropdown's selected value so the chosen
    /// preset name stays visible after applying. Cleared when the
    /// bound plugin instance changes.
    this._selectedPresetId = "";
    this._onControl = (ev) => {
      const id = ev.detail;
      const p = this.plugin;
      if (!p) return;
      if (p.params?.some((x) => x.id === id)) this.requestUpdate();
    };
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
    this._measured = false;
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("control", this._onControl);
    window.__foyer?.store?.addEventListener("change", this._onControl);
    window.__foyer?.ws?.addEventListener("envelope", this._envelopeHandler);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("control", this._onControl);
    window.__foyer?.store?.removeEventListener("change", this._onControl);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  /** When the bound plugin changes, lazily fetch its presets. */
  willUpdate(changed) {
    if (changed.has("plugin")) {
      const id = this.plugin?.id;
      if (id && id !== this._presetsForPluginId) {
        this._presetsForPluginId = id;
        this._presets = [];
        // Different plugin instance → drop any preset selection from
        // the prior one. The shim's `current_preset` field on the
        // plugin descriptor (when populated) re-seeds it on the next
        // snapshot.
        this._selectedPresetId = "";
        window.__foyer?.ws?.send({ type: "list_plugin_presets", plugin_id: id });
      }
      // Adopt any current_preset the snapshot carries (post-load,
      // sessions saved with a preset applied).
      const fromSnap = this.plugin?.current_preset;
      if (fromSnap && fromSnap !== this._selectedPresetId) {
        this._selectedPresetId = fromSnap;
      }
    }
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "plugin_presets_listed"
        && body.plugin_id === this._presetsForPluginId) {
      this._presets = body.presets || [];
    }
  }

  _onPresetChange(ev) {
    const presetId = ev.target.value;
    if (!presetId || !this.plugin?.id) return;
    this._selectedPresetId = presetId;
    window.__foyer?.ws?.send({
      type: "load_plugin_preset",
      plugin_id: this.plugin.id,
      preset_id: presetId,
    });
    // Hand focus back to the document so global keyboard shortcuts
    // (Space → transport play/pause, etc.) aren't swallowed by the
    // still-focused <select>. Without this, the next Space press
    // re-opens the dropdown instead of toggling transport.
    ev.target.blur();
  }

  /**
   * After first render, measure the content's natural size (groups grid at
   * min-content width × its vertical extent) and bubble an event so the
   * plugin-layer can resize the window to fit. Avoids opening every plugin
   * window oversized.
   */
  updated() {
    if (this._measured || !this.plugin) return;
    // Wait for layout to settle — .groups inside header+body must have
    // painted so `scrollWidth / scrollHeight` reflect natural sizing.
    requestAnimationFrame(() => {
      if (this._measured) return;
      const groups = this.renderRoot.querySelector(".groups");
      const header = this.renderRoot.querySelector("header");
      if (!groups) return;
      const rect = groups.getBoundingClientRect();
      const headerH = header?.getBoundingClientRect().height ?? 44;
      // scrollWidth gives the content's natural width ignoring overflow.
      // For single-column layouts it's close to the grid's minmax(180,1fr).
      const natW = Math.max(260, Math.ceil(groups.scrollWidth + 24));
      const natH = Math.max(240, Math.ceil(groups.scrollHeight + headerH + 16));
      this._measured = true;
      this.dispatchEvent(new CustomEvent("natural-size", {
        detail: { pluginId: this.plugin.id, w: natW, h: natH },
        bubbles: true,
        composed: true,
      }));
      void rect;
    });
  }

  render() {
    const p = this.plugin;
    if (!p) return html`<div class="empty">No plugin selected.</div>`;

    const bypassParam = (p.params || []).find((x) => x.id.endsWith(".bypass"));
    const bypassOn = this._currentValue(bypassParam) === true;

    // Group params by their `group` field; bypass goes in the header not the body.
    const groups = new Map();
    for (const param of p.params || []) {
      if (param.id.endsWith(".bypass")) continue;
      const key = param.group || "Parameters";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(param);
    }

    const presets = this._presets || [];
    const factory = presets.filter((pp) => pp.is_factory !== false);
    const user    = presets.filter((pp) => pp.is_factory === false);

    return html`
      <header>
        <div>
          ${this.trackName
            ? html`<div class="breadcrumb">${this.trackName}</div>`
            : null}
          <div class="brand">${p.name}</div>
          ${p.uri ? html`<div class="uri">${p.uri}</div>` : null}
        </div>
        <span class="spacer"></span>
        <select
          class="presets"
          title="Load preset"
          ?disabled=${presets.length === 0}
          .value=${this._selectedPresetId || ""}
          @change=${(e) => this._onPresetChange(e)}
        >
          <option value="" disabled ?selected=${!this._selectedPresetId}>
            ${presets.length === 0 ? "No presets" : "Load preset…"}
          </option>
          ${factory.length > 0 ? html`
            <optgroup label="Factory">
              ${factory.map((pp) => html`
                <option value=${pp.id} title=${pp.id}
                        ?selected=${pp.id === this._selectedPresetId}>${pp.name || pp.id}</option>
              `)}
            </optgroup>` : null}
          ${user.length > 0 ? html`
            <optgroup label="User">
              ${user.map((pp) => html`
                <option value=${pp.id} title=${pp.id}
                        ?selected=${pp.id === this._selectedPresetId}>${pp.name || pp.id}</option>
              `)}
            </optgroup>` : null}
        </select>
        <button
          class="bypass"
          ?data-on=${bypassOn}
          title="Bypass (engage = plugin off)"
          @click=${() => this._setBypass(bypassParam, !bypassOn)}
        >
          ${icon(bypassOn ? "eye-slash" : "check-circle", 12)}
          ${bypassOn ? "Bypassed" : "Active"}
        </button>
      </header>

      ${this.minimized
        ? null
        : html`
            <div class="groups">
              ${[...groups.entries()].map(
                ([group, params]) => html`
                  <section>
                    <h3>${group}</h3>
                    <div class="row">
                      ${params.map(
                        (param) => html`
                          <foyer-param-control
                            .param=${param}
                            .value=${this._currentValue(param)}
                            .size=${42}
                            widget="auto"
                            @input=${(e) => this._onParam(e)}
                            @change=${(e) => this._onParam(e)}
                          ></foyer-param-control>
                        `
                      )}
                    </div>
                  </section>
                `
              )}
            </div>
          `}
    `;
  }

  /** Prefer the live store value over the snapshot's embedded one. */
  _currentValue(param) {
    if (!param) return undefined;
    const store = window.__foyer?.store;
    const live = store?.get(param.id);
    if (live !== undefined) {
      return typeof live === "object" && live !== null && "Float" in live
        ? live.Float
        : live;
    }
    const raw = param.value;
    if (raw && typeof raw === "object" && "Float" in raw) return raw.Float;
    return raw;
  }

  _setBypass(bypassParam, on) {
    if (!bypassParam) return;
    this._send(bypassParam.id, on);
  }

  _onParam(ev) {
    const { id, value } = ev.detail || {};
    if (!id) return;
    this._send(id, value);
  }

  _send(id, value) {
    const ws = window.__foyer?.ws;
    ws?.controlSet(id, value);
  }
}
customElements.define("foyer-plugin-panel", PluginPanel);
