// SPDX-License-Identifier: Apache-2.0
// Top app bar — single row: transport buttons + hamburger menu.
//
// The hamburger opens a popover with:
//   - session name + tempo / time-signature controls
//   - Settings shortcut
//   - pinned-panel chips as a subsection
//
// Older revisions used a separate session-name row above the transport
// but it was mostly wasted space — the same info lives in the popover
// now, freeing the top strip for transport alone.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { cycleTheme, getTheme, onThemeChange, THEME_META } from "foyer-ui-core/theme.js";
import "./touch-transport.js";

import {
  getPins,
  panelById,
  setActivePanel,
  onPinsChange,
} from "../panels.js";

export class TouchTopBar extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _menuOpen: { state: true, type: Boolean },
    _pins: { state: true },
    _theme: { state: true, type: String },
  };

  static styles = css`
    :host {
      flex: 0 0 auto;
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      border-bottom: 1px solid var(--color-border);
      padding-top: env(safe-area-inset-top, 0);
      position: relative;
      z-index: 50;
    }
    .row {
      display: flex;
      align-items: stretch;
      gap: 6px;
      padding: 6px 8px;
    }
    foyer-touch-transport {
      flex: 1 1 auto;
      min-width: 0;
      /* The transport component already supplies its own padding +
       * borders. Strip them here so it merges cleanly into our row. */
    }
    .menu-btn {
      flex: 0 0 auto;
      width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 8px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      cursor: pointer;
      position: relative;
      align-self: center;
      padding: 0;
    }
    .menu-btn:active { transform: scale(0.94); }
    .menu-btn .badge {
      position: absolute;
      top: -4px; right: -4px;
      min-width: 18px; height: 18px;
      padding: 0 5px;
      background: var(--color-accent);
      color: white;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .popover {
      position: absolute;
      top: calc(100% + 6px); right: 8px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 12px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.5);
      min-width: 260px;
      max-width: 92vw;
      max-height: 80vh;
      overflow: auto;
      z-index: 100;
      padding: 4px 0;
    }
    .pop-section { padding: 8px 12px; }
    .pop-section + .pop-section {
      border-top: 1px solid var(--color-border);
    }
    .pop-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      padding: 4px 0 6px;
    }
    .pop-session .name {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pop-session .pos {
      font-size: 12px;
      color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      padding-top: 2px;
    }
    .pop-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding-top: 6px;
    }
    .pop-field { display: flex; flex-direction: column; gap: 4px; }
    .pop-field label {
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .pop-field input {
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 14px;
      min-height: 40px;
      font-variant-numeric: tabular-nums;
      box-sizing: border-box;
    }
    .ts-row {
      display: flex; align-items: center; gap: 6px;
    }
    .ts-row input { flex: 1; min-width: 0; }
    .ts-row .slash { color: var(--color-text-muted); }
    .pop-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px;
      border: 0;
      background: transparent;
      color: var(--color-text);
      font-size: 14px;
      text-align: left;
      min-height: 44px;
      cursor: pointer;
      width: 100%;
    }
    .pop-item:active { background: var(--color-surface); }
    .pop-item .muted { color: var(--color-text-muted); }
    .pop-item-row {
      display: flex; align-items: center; gap: 4px;
    }
    .pop-item-row .pop-item { flex: 1; min-width: 0; }
    .pop-item-row .pop-item span {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pop-item-close {
      flex: 0 0 auto;
      width: 36px; min-height: 36px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      margin-right: 8px;
    }
    .pop-item-close:active { transform: scale(0.94); }
    .pop-empty {
      padding: 8px 12px 12px;
      color: var(--color-text-muted);
      font-size: 13px;
    }
    .backdrop {
      position: fixed; inset: 0;
      z-index: 90;
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._menuOpen = false;
    this._pins = getPins();
    this._theme = getTheme();
    this._onChange = () => { this._tick++; };
    this._onWindowsChange = () => { this._tick++; };
    this._unsubPins = null;
    this._offThemeChange = null;
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onChange);
    this._unsubPins = onPinsChange((pins) => { this._pins = pins; });
    this._offThemeChange = onThemeChange(() => { this._theme = getTheme(); this._tick++; });
    // Window-stack count + content stays fresh as floats open / close /
    // minimize. The widget code emits `foyer-window:minimized`; close
    // bubbles a normal `close` event that we listen for on document.
    globalThis.addEventListener("foyer-window:minimized", this._onWindowsChange);
    document.addEventListener("close", this._onWindowsChange, true);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onChange);
    this._unsubPins?.();
    this._offThemeChange?.();
    globalThis.removeEventListener("foyer-window:minimized", this._onWindowsChange);
    document.removeEventListener("close", this._onWindowsChange, true);
  }

  _listWindows() {
    const out = [];
    for (const w of document.querySelectorAll("foyer-window")) {
      out.push({
        el: w,
        title: w.title || w.storageKey || "Window",
        minimized: !!w.minimized,
      });
    }
    return out;
  }

  _focusWindow(w) {
    w.el.minimized = false;
    try {
      const layout = window.__foyer?.layout;
      const id = w.el._layoutId;
      if (id) layout?.setExternalMinimized?.(id, false);
    } catch {}
    try { document.body.appendChild(w.el); } catch {}
    this._closeMenu();
  }

  _closeWindow(w) {
    w.el.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this._onWindowsChange();
  }

  _ctl(id) { return window.__foyer?.store?.state?.controls?.get(id); }
  _set(id, v) { window.__foyer?.ws?.controlSet?.(id, v); }

  _sessionName() {
    const cur = window.__foyer?.store?.currentSession?.();
    if (cur?.name) return cur.name;
    const path = cur?.path || "";
    if (path) return path.split("/").pop().replace(/\.ardour$/, "");
    return "Foyer";
  }
  _positionLabel() {
    const beats = Number(this._ctl("transport.position_beats") || 0);
    const bars = Math.max(1, Math.floor(beats / 4) + 1);
    const b = Math.max(1, Math.floor(beats % 4) + 1);
    return `${bars}.${b}`;
  }

  _onTempoChange(ev) {
    const v = Number(ev.currentTarget.value);
    if (Number.isFinite(v)) this._set("transport.tempo", v);
  }
  _onTsNumChange(ev) {
    const v = Number(ev.currentTarget.value);
    if (Number.isFinite(v) && v > 0) this._set("transport.time_signature_numerator", v);
  }
  _onTsDenChange(ev) {
    const v = Number(ev.currentTarget.value);
    if (Number.isFinite(v) && v > 0) this._set("transport.time_signature_denominator", v);
  }

  _toggleMenu() { this._menuOpen = !this._menuOpen; }
  _closeMenu()  { this._menuOpen = false; }
  _openPanel(id) { this._closeMenu(); setActivePanel(id); }
  _openSettings() {
    this._closeMenu();
    globalThis.dispatchEvent(new CustomEvent("foyer-touch:open-modal", { detail: { id: "settings" } }));
  }

  _renderPopover() {
    if (!this._menuOpen) return null;
    const tempo = Number(this._ctl("transport.tempo") ?? 120);
    const tsNum = Number(this._ctl("transport.time_signature_numerator") ?? 4);
    const tsDen = Number(this._ctl("transport.time_signature_denominator") ?? 4);
    const pinItems = this._pins.map((id) => panelById(id)).filter(Boolean);
    return html`
      <div class="backdrop" @click=${() => this._closeMenu()}></div>
      <div class="popover" @click=${(e) => e.stopPropagation()}>
        <div class="pop-section pop-session">
          <div class="name">${this._sessionName()}</div>
          <div class="pos">${this._positionLabel()} · ${tempo.toFixed(0)} BPM</div>
          <div class="pop-fields">
            <div class="pop-field">
              <label>Tempo</label>
              <input type="number" min="20" max="300" step="0.1"
                     .value=${String(tempo)}
                     @change=${(e) => this._onTempoChange(e)}>
            </div>
            <div class="pop-field">
              <label>Time signature</label>
              <div class="ts-row">
                <input type="number" min="1" max="32" step="1"
                       .value=${String(tsNum)}
                       @change=${(e) => this._onTsNumChange(e)}>
                <span class="slash">/</span>
                <input type="number" min="1" max="32" step="1"
                       .value=${String(tsDen)}
                       @change=${(e) => this._onTsDenChange(e)}>
              </div>
            </div>
          </div>
        </div>
        <div class="pop-section">
          <button class="pop-item" @click=${() => { cycleTheme(); }}>
            ${icon(THEME_META[this._theme]?.icon || "sparkles", 18)}
            <span>Theme: ${THEME_META[this._theme]?.label || this._theme}</span>
          </button>
          <button class="pop-item" @click=${() => this._openSettings()}>
            ${icon("cog-6-tooth", 18)}<span>Settings</span>
          </button>
        </div>
        ${(() => {
          const wins = this._listWindows();
          if (wins.length === 0) return null;
          return html`
            <div class="pop-section">
              <div class="pop-title">Windows</div>
              ${wins.map((w) => html`
                <div class="pop-item-row">
                  <button class="pop-item"
                          @click=${() => this._focusWindow(w)}
                          title=${w.minimized ? "Bring back" : "Bring to front"}>
                    ${icon(w.minimized ? "window" : "arrow-up-on-square", 18)}
                    <span class=${w.minimized ? "muted" : ""}>${w.title}</span>
                  </button>
                  <button class="pop-item-close"
                          title="Close"
                          @click=${(e) => { e.stopPropagation(); this._closeWindow(w); }}>
                    ${icon("x-mark", 14)}
                  </button>
                </div>
              `)}
            </div>
          `;
        })()}
        <div class="pop-section">
          <div class="pop-title">Pinned</div>
          ${pinItems.length === 0 ? html`
            <div class="pop-empty">Pin panels from More → ⭐ for quick access here.</div>
          ` : pinItems.map((p) => html`
            <button class="pop-item" @click=${() => this._openPanel(p.id)}>
              ${icon(p.icon, 18)}<span>${p.label}</span>
            </button>
          `)}
        </div>
      </div>
    `;
  }

  render() {
    const winCount = this._listWindows().length;
    return html`
      <div class="row">
        <foyer-touch-transport></foyer-touch-transport>
        <button class="menu-btn"
                title="Menu"
                @click=${() => this._toggleMenu()}>
          ${icon("bars-3", 22)}
          ${winCount > 0 ? html`<span class="badge">${winCount}</span>` : null}
        </button>
      </div>
      ${this._renderPopover()}
    `;
  }
}

customElements.define("foyer-touch-top-bar", TouchTopBar);
