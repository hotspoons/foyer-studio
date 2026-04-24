// Layout manager FAB — presets, saved layouts, keyboard help.
//
// Built on the shared QuadrantFab base. Layout presets are reorderable,
// hideable, and each can be bound to a keyboard chord via the context menu.
// Saved layouts get the same context-menu treatment (assign chord, rename,
// delete).

import { html, css } from "lit";

import { icon } from "foyer-ui-core/icons.js";
import { QuadrantFab } from "./quadrant-fab.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import {
  listBindings,
  setBinding,
  clearBinding,
  bindingFor,
  eventToCombo,
} from "foyer-ui-core/layout/layout-bindings.js";

// Canonical preset order — most-useful combinations first, singles at the
// bottom where they're out of the way until you specifically want one.
// Default-visible set excludes the single-view layouts; users can flip them
// on through the "Show hidden" toggle.
const PRESET_ORDER = [
  { id: "mixer-left-timeline-right",    label: "Mixer + Timeline",        tag: "M · T" },
  { id: "timeline-left-mixer-right",    label: "Timeline + Mixer",        tag: "T · M" },
  { id: "timeline-over-mixer",          label: "Timeline over Mixer",     tag: "stack" },
  { id: "mixer-over-timeline",          label: "Mixer over Timeline",     tag: "stack" },
  { id: "everything",                   label: "Everything",              tag: "full" },
  { id: "session+timeline+mixer",       label: "Projects · Timeline · Mixer", tag: "3-col" },
  { id: "session+timeline-over-mixer",  label: "Projects · Timeline / Mixer", tag: "tri" },
  { id: "session-left-timeline-right",  label: "Projects + Timeline",     tag: "P · T" },
  { id: "plugins-left-mixer-right",     label: "Plugins + Mixer",         tag: "P · M" },
  { id: "mixer-left-plugins-right",     label: "Mixer + Plugins",         tag: "M · P" },
  { id: "mixer",                        label: "Mixer only",              tag: "single" },
  { id: "timeline",                     label: "Timeline only",           tag: "single" },
  { id: "plugins",                      label: "Plugins only",            tag: "single" },
  { id: "session",                      label: "Projects only",           tag: "single" },
];

const DEFAULT_HIDDEN = new Set(["mixer", "timeline", "plugins", "session"]);

const CONFIG_KEY = "foyer.layout.preset-config.v1";

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { hidden: Array.from(DEFAULT_HIDDEN), order: [], showHidden: false };
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

const HELP_KEYS = [
  ["Ctrl+Alt H/J/K/L", "Focus left / down / up / right"],
  ["Ctrl+Alt |",       "Split focused tile to the right"],
  ["Ctrl+Alt -",       "Split focused tile below"],
  ["Ctrl+Alt W",       "Close focused tile"],
  ["Ctrl+Alt [ / ]",   "Shrink / grow focused tile"],
  ["Ctrl+Alt A",       "Toggle automation panel"],
  ["Ctrl/Cmd K",       "Command palette"],
];

export class LayoutFab extends QuadrantFab {
  static properties = {
    ...QuadrantFab.properties,
    store: { type: Object },
    _tab:  { state: true, type: String },
    _saveName: { state: true, type: String },
    _cfg:  { state: true, type: Object },
    _captureFor: { state: true, type: Object }, // {kind, name, label} when capturing
    _bindings: { state: true, type: Object },
  };

  static styles = [
    QuadrantFab.styles,
    css`
      .tabs { display: flex; padding: 0 8px; border-bottom: 1px solid var(--color-border); }
      .tabs button {
        background: transparent; border: 0; border-bottom: 2px solid transparent;
        color: var(--color-text-muted); padding: 6px 10px;
        font-size: 11px; font-weight: 500;
        cursor: pointer;
      }
      .tabs button:hover { color: var(--color-text); }
      .tabs button.active { color: var(--color-text); border-bottom-color: var(--color-accent); }

      .content { padding: 8px; }
      .row {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 12px;
        transition: background 0.1s ease;
      }
      .row:hover { background: color-mix(in oklab, var(--color-accent) 12%, transparent); }
      .row.hidden { opacity: 0.45; }
      .row .label { flex: 1; font-family: var(--font-sans); }
      .row .tag {
        font-size: 9px; font-weight: 600;
        letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--color-text-muted);
        padding: 1px 5px;
        border: 1px solid color-mix(in oklab, var(--color-border) 60%, transparent);
        border-radius: 3px;
      }
      .kbd {
        font-family: var(--font-mono);
        font-size: 10px;
        color: var(--color-accent-3);
        border: 1px solid color-mix(in oklab, var(--color-accent) 40%, var(--color-border));
        border-radius: var(--radius-sm);
        padding: 1px 6px;
      }
      .toggle-row {
        display: flex; align-items: center; gap: 8px;
        padding: 8px;
        font-size: 10px;
        color: var(--color-text-muted);
        border-top: 1px solid var(--color-border);
      }
      .toggle-row input { accent-color: var(--color-accent); }
      .save-row {
        display: flex; gap: 6px; padding: 8px;
        border-top: 1px solid var(--color-border);
      }
      .save-row input {
        flex: 1;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text);
        padding: 4px 8px;
        font-size: 12px;
      }
      .save-row button {
        background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
        color: #fff;
        border: 0;
        border-radius: var(--radius-sm);
        padding: 4px 10px;
        font-size: 11px;
        cursor: pointer;
      }
      .capture-overlay {
        position: absolute;
        inset: 0;
        background: color-mix(in oklab, var(--color-surface) 85%, transparent);
        backdrop-filter: blur(6px);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 14px;
        padding: 24px;
        z-index: 5;
      }
      .capture-overlay h3 {
        margin: 0;
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--color-accent-3);
      }
      .capture-overlay .target {
        font-family: var(--font-sans);
        font-size: 13px;
        color: var(--color-text);
      }
      .capture-overlay .hint {
        font-size: 10px; color: var(--color-text-muted);
        text-align: center;
      }
      .capture-overlay .cancel {
        background: transparent;
        border: 1px solid var(--color-border);
        color: var(--color-text);
        border-radius: var(--radius-sm);
        padding: 4px 10px;
        font-size: 10px;
        cursor: pointer;
      }
    `,
  ];

  constructor() {
    super();
    this.storageKey = "foyer.layout-fab.v1";
    this._fabAccent = "accent-2";
    this._fabTitle = "Layouts";
    this._tab = "presets";
    this._saveName = "";
    this._cfg = loadConfig();
    this._captureFor = null;
    this._bindings = listBindings();
    this._onBindingsChange = () => {
      this._bindings = listBindings();
      this.requestUpdate();
    };
    this._onCaptureKey = (ev) => this._onCaptureKeydown(ev);
  }

  _dockMeta() {
    return {
      label: "Layouts",
      icon: "square-3-stack-3d",
      accent: "accent-2",
      expandsRail: false,
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("foyer:layout-bindings-changed", this._onBindingsChange);
  }
  disconnectedCallback() {
    window.removeEventListener("foyer:layout-bindings-changed", this._onBindingsChange);
    this._uninstallCaptureListener();
    super.disconnectedCallback();
  }

  _renderFabContent() {
    // Stacked-layers metaphor — "saved layout stacks" — distinct from the
    // window-manager 2x2 grid in the right-dock rail.
    return html`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6.429 9.75 2.25 12l4.179 2.25m0-4.5 5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0 4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0-5.571 3-5.571-3"/>
      </svg>
    `;
  }

  _renderPanelContent() {
    return html`
      ${this._captureFor ? this._renderCaptureOverlay() : null}
      <div class="tabs">
        <button class=${this._tab === "presets" ? "active" : ""}
                @click=${() => { this._tab = "presets"; }}>Presets</button>
        <button class=${this._tab === "saved" ? "active" : ""}
                @click=${() => { this._tab = "saved"; }}>Saved</button>
        <button class=${this._tab === "keys" ? "active" : ""}
                @click=${() => { this._tab = "keys"; }}>Keys</button>
      </div>
      <div class="content">
        ${this._tab === "presets"
          ? this._renderPresets()
          : this._tab === "saved"
          ? this._renderSaved()
          : this._renderKeys()}
      </div>
      ${this._tab === "presets"
        ? html`
            <div class="toggle-row">
              <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox"
                       .checked=${!!this._cfg.showHidden}
                       @change=${(e) => this._toggleShowHidden(e.target.checked)}>
                Show hidden presets
              </label>
            </div>
          `
        : null}
      ${this._tab === "saved"
        ? html`
            <div class="save-row">
              <input placeholder="layout name…"
                     .value=${this._saveName}
                     @input=${(e) => { this._saveName = e.currentTarget.value; }}
                     @keydown=${(e) => { if (e.key === "Enter") this._save(); }}>
              <button @click=${this._save}>Save current</button>
            </div>
          `
        : null}
    `;
  }

  _renderPresets() {
    const hiddenSet = new Set(this._cfg.hidden || []);
    const shown = this._cfg.showHidden
      ? PRESET_ORDER
      : PRESET_ORDER.filter((p) => !hiddenSet.has(p.id));
    if (shown.length === 0) {
      return html`<div style="padding:14px;color:var(--color-text-muted);font-size:12px">
        No presets visible. Enable "Show hidden" to bring them back.
      </div>`;
    }
    return html`
      ${shown.map((p) => {
        const chord = bindingFor("preset", p.id);
        const hidden = hiddenSet.has(p.id);
        return html`
          <div class="row ${hidden ? "hidden" : ""}"
               @click=${() => this._apply(p.id)}
               @contextmenu=${(ev) => this._onPresetContext(ev, p)}>
            ${icon("adjustments-horizontal", 12)}
            <span class="label">${p.label}</span>
            ${p.tag ? html`<span class="tag">${p.tag}</span>` : null}
            ${chord ? html`<span class="kbd">${chord}</span>` : null}
          </div>
        `;
      })}
    `;
  }

  _renderSaved() {
    const names = this.store?.listNamed?.() || [];
    if (!names.length) {
      return html`<div style="padding:14px;color:var(--color-text-muted);font-size:12px">
        No saved layouts yet. Arrange panes the way you like, then save below.
      </div>`;
    }
    return html`
      ${names.map((n) => {
        const chord = bindingFor("named", n);
        return html`
          <div class="row"
               @click=${() => this.store.loadNamed(n)}
               @contextmenu=${(ev) => this._onSavedContext(ev, n)}>
            <span class="label">${n}</span>
            ${chord ? html`<span class="kbd">${chord}</span>` : null}
          </div>
        `;
      })}
    `;
  }

  _renderKeys() {
    return html`
      ${HELP_KEYS.map(([k, desc]) => html`
        <div class="row">
          <span class="kbd">${k}</span>
          <span class="label" style="margin-left:8px">${desc}</span>
        </div>
      `)}
    `;
  }

  _renderCaptureOverlay() {
    const c = this._captureFor;
    return html`
      <div class="capture-overlay">
        <h3>Assign keybind</h3>
        <div class="target">${c.label}</div>
        <div class="hint">Press a combo (with Ctrl/Alt/Shift/Meta)<br/>or Esc to cancel</div>
        <button class="cancel" @click=${() => this._cancelCapture()}>Cancel</button>
      </div>
    `;
  }

  // ── actions ────────────────────────────────────────────────────────────

  _apply(presetId) {
    this.store?.loadPreset?.(presetId);
  }

  _save() {
    const n = this._saveName.trim();
    if (!n) return;
    this.store?.saveNamed(n);
    this._saveName = "";
  }

  _toggleShowHidden(on) {
    this._cfg = { ...this._cfg, showHidden: on };
    saveConfig(this._cfg);
  }

  _togglePresetHidden(presetId) {
    const hidden = new Set(this._cfg.hidden || []);
    if (hidden.has(presetId)) hidden.delete(presetId);
    else hidden.add(presetId);
    this._cfg = { ...this._cfg, hidden: Array.from(hidden) };
    saveConfig(this._cfg);
  }

  _onPresetContext(ev, preset) {
    ev.preventDefault();
    const existing = bindingFor("preset", preset.id);
    const hidden = new Set(this._cfg.hidden || []).has(preset.id);
    const items = [
      { heading: preset.label },
      { label: "Apply", icon: "play", action: () => this._apply(preset.id) },
      { separator: true },
      {
        label: existing ? `Assign new keybind (current: ${existing})` : "Assign keybind…",
        icon: "key",
        action: () => this._beginCapture({ kind: "preset", name: preset.id, label: preset.label }),
      },
      existing
        ? { label: "Clear keybind", icon: "x-mark", action: () => clearBinding(existing) }
        : null,
      { separator: true },
      {
        label: hidden ? "Show this preset" : "Hide this preset",
        icon: hidden ? "eye" : "eye-slash",
        action: () => this._togglePresetHidden(preset.id),
      },
    ].filter(Boolean);
    showContextMenu(ev, items);
  }

  _onSavedContext(ev, name) {
    ev.preventDefault();
    const existing = bindingFor("named", name);
    const items = [
      { heading: name },
      { label: "Load", icon: "play", action: () => this.store.loadNamed(name) },
      { separator: true },
      {
        label: existing ? `Assign new keybind (current: ${existing})` : "Assign keybind…",
        icon: "key",
        action: () => this._beginCapture({ kind: "named", name, label: name }),
      },
      existing
        ? { label: "Clear keybind", icon: "x-mark", action: () => clearBinding(existing) }
        : null,
      { separator: true },
      {
        label: "Delete",
        icon: "trash",
        tone: "danger",
        action: () => {
          this.store.deleteNamed(name);
          // Also clear any keybind tied to the deleted name.
          if (existing) clearBinding(existing);
        },
      },
    ].filter(Boolean);
    showContextMenu(ev, items);
  }

  // ── keybind capture ───────────────────────────────────────────────────

  _beginCapture(target) {
    this._captureFor = target;
    this._installCaptureListener();
  }
  _cancelCapture() {
    this._captureFor = null;
    this._uninstallCaptureListener();
  }
  _installCaptureListener() {
    this._uninstallCaptureListener();
    window.addEventListener("keydown", this._onCaptureKey, true);
  }
  _uninstallCaptureListener() {
    window.removeEventListener("keydown", this._onCaptureKey, true);
  }
  _onCaptureKeydown(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (ev.key === "Escape") { this._cancelCapture(); return; }
    const combo = eventToCombo(ev);
    if (!combo) return; // bare modifier
    if (this._captureFor) {
      setBinding(combo, this._captureFor.kind, this._captureFor.name);
    }
    this._cancelCapture();
  }
}
customElements.define("foyer-layout-fab", LayoutFab);
