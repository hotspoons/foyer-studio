// Layout manager FAB — presets, saved layouts, keyboard help.
//
// Built on the shared QuadrantFab base. Layout presets are reorderable,
// hideable, and each can be bound to a keyboard chord via the context menu.
// Saved layouts get the same context-menu treatment (assign chord, rename,
// delete).

import { html, css } from "lit";
import { ref } from "lit/directives/ref.js";

import { icon } from "foyer-ui-core/icons.js";
import { QuadrantFab } from "./quadrant-fab.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import { confirmAction } from "foyer-ui-core/widgets/confirm-modal.js";
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
// Layout presets are tile-tree templates. Mixer + Timeline are the
// only tile-class views; Plugins / Console / Diagnostics / Projects
// are widgets now and live in the right-dock's widget layer, so they
// don't appear here. Removed: every preset that included `plugins`
// or `session` as a tile slot.
const PRESET_ORDER = [
  { id: "mixer-left-timeline-right",    label: "Mixer + Timeline",        tag: "M · T" },
  { id: "timeline-left-mixer-right",    label: "Timeline + Mixer",        tag: "T · M" },
  { id: "timeline-over-mixer",          label: "Timeline over Mixer",     tag: "stack" },
  { id: "mixer-over-timeline",          label: "Mixer over Timeline",     tag: "stack" },
  // "Everything" + the plugins/session multi-pane presets are gone:
  // every non-tile-class view (plugins, session/Projects, console,
  // diagnostics) is a widget now — putting them in the tile tree
  // rendered as "missing entity" placeholders. Widgets live in the
  // right-dock + foyer-window layer instead.
  { id: "mixer",                        label: "Mixer only",              tag: "single" },
  { id: "timeline",                     label: "Timeline only",           tag: "single" },
];

const DEFAULT_HIDDEN = new Set(["mixer", "timeline"]);

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

export class LayoutFab extends QuadrantFab {
  static properties = {
    ...QuadrantFab.properties,
    store: { type: Object },
    _saveName: { state: true, type: String },
    _cfg:  { state: true, type: Object },
    _captureFor: { state: true, type: Object }, // {kind, name, label} when capturing
    _bindings: { state: true, type: Object },
    // Active inline rename: { name: <current saved name>, draft: <new text> }.
    // Null when no row is being renamed. Inline (vs a separate modal) keeps
    // the panel feeling like an editable list — the rename input replaces
    // the row's label in place, with save / cancel controls flush right.
    _renaming: { state: true, type: Object },
  };

  static styles = [
    QuadrantFab.styles,
    css`
      .content { padding: 8px; }
      /* Section header. Mirrors the tabs' typography (uppercase, small,
         accent-tinted on the active one) so the redesign feels like a
         continuation of the old shell rather than a brand-new look. */
      .section-header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 4px 6px;
        font-size: 10px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--color-text-muted);
      }
      .section-header.first { padding-top: 4px; }
      .section-header .rule {
        flex: 1; height: 1px;
        background: var(--color-border);
      }
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
      /* Per-row action buttons (rename / delete on user-preset rows).
         Hidden until row hover so resting state is a clean list. */
      .row .row-actions {
        display: flex; gap: 2px;
        opacity: 0;
        transition: opacity 0.1s ease;
      }
      .row:hover .row-actions,
      .row:focus-within .row-actions {
        opacity: 1;
      }
      .row .row-actions button {
        background: transparent;
        border: 0;
        padding: 3px 5px;
        color: var(--color-text-muted);
        cursor: pointer;
        border-radius: var(--radius-sm);
        display: inline-flex; align-items: center;
      }
      .row .row-actions button:hover { color: var(--color-text); background: var(--color-surface); }
      .row .row-actions button.danger:hover { color: var(--color-danger, #f87171); }
      .row .rename-input {
        flex: 1;
        background: var(--color-surface);
        border: 1px solid var(--color-accent);
        border-radius: var(--radius-sm);
        color: var(--color-text);
        padding: 2px 6px;
        font-size: 12px;
        font-family: var(--font-sans);
      }
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
    this._saveName = "";
    this._cfg = loadConfig();
    this._captureFor = null;
    this._bindings = listBindings();
    this._renaming = null;
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
      defaultDocked: true,
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
    // Single scrolling body with two sectional dividers — no tabs.
    // Built-in presets at the top, user-saved presets below, and the
    // "save current as…" row sits flush against the user-presets list
    // so it reads as "add a new one." The legacy Keys help tab is
    // gone; keybind capture still lives behind the row-level context
    // menu (right-click) since that's where it's discoverable.
    return html`
      ${this._captureFor ? this._renderCaptureOverlay() : null}
      <div class="content">
        <div class="section-header first">
          <span>Presets</span>
          <span class="rule"></span>
        </div>
        ${this._renderPresets()}
        <div class="toggle-row" style="border-top:0;padding:6px 4px 0">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox"
                   .checked=${!!this._cfg.showHidden}
                   @change=${(e) => this._toggleShowHidden(e.target.checked)}>
            Show hidden presets
          </label>
        </div>

        <div class="section-header">
          <span>User presets</span>
          <span class="rule"></span>
        </div>
        ${this._renderSaved()}
      </div>
      <div class="save-row">
        <input placeholder="Name this layout…"
               .value=${this._saveName}
               @input=${(e) => { this._saveName = e.currentTarget.value; }}
               @keydown=${(e) => { if (e.key === "Enter") this._save(); }}>
        <button @click=${this._save}>Save current</button>
      </div>
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
      return html`<div style="padding:10px 4px;color:var(--color-text-muted);font-size:12px">
        No user presets yet. Arrange panes the way you like, then name and save below.
      </div>`;
    }
    return html`
      ${names.map((n) => {
        const chord = bindingFor("named", n);
        const renaming = this._renaming && this._renaming.name === n;
        if (renaming) {
          // Inline rename: replace the label + chord with an input
          // and Save / Cancel controls. Click anywhere outside resets
          // via the `_cancelRename` path (the keydown handlers cover
          // Enter / Esc).
          return html`
            <div class="row" @click=${(e) => e.stopPropagation()}>
              <input
                class="rename-input"
                .value=${this._renaming.draft}
                @click=${(e) => e.stopPropagation()}
                @input=${(e) => { this._renaming = { ...this._renaming, draft: e.currentTarget.value }; }}
                @keydown=${(e) => this._onRenameKey(e)}
                @blur=${() => this._commitRename()}
                ${ref((el) => { if (el && this._renaming && document.activeElement !== el) {
                  // Auto-focus the input the first frame the row flips
                  // into rename mode — without this the user has to
                  // click into the field after pressing rename.
                  queueMicrotask(() => { try { el.focus(); el.select(); } catch {} });
                } })}
              />
              <div class="row-actions" style="opacity:1">
                <button title="Save"
                        @click=${(e) => { e.stopPropagation(); this._commitRename(); }}>
                  ${icon("check", 13)}
                </button>
                <button title="Cancel"
                        @click=${(e) => { e.stopPropagation(); this._cancelRename(); }}>
                  ${icon("x-mark", 13)}
                </button>
              </div>
            </div>
          `;
        }
        return html`
          <div class="row"
               @click=${() => this.store.loadNamed(n)}
               @contextmenu=${(ev) => this._onSavedContext(ev, n)}>
            <span class="label">${n}</span>
            ${chord ? html`<span class="kbd">${chord}</span>` : null}
            <div class="row-actions">
              <button title="Rename"
                      @click=${(e) => { e.stopPropagation(); this._beginRename(n); }}>
                ${icon("pencil-square", 13)}
              </button>
              <button class="danger" title="Delete"
                      @click=${(e) => { e.stopPropagation(); this._confirmDelete(n); }}>
                ${icon("trash", 13)}
              </button>
            </div>
          </div>
        `;
      })}
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

  // ── rename + delete on saved layouts ─────────────────────────────

  _beginRename(name) {
    this._renaming = { name, draft: name };
  }
  _cancelRename() {
    this._renaming = null;
  }
  _onRenameKey(ev) {
    if (ev.key === "Enter") { ev.preventDefault(); this._commitRename(); }
    else if (ev.key === "Escape") { ev.preventDefault(); this._cancelRename(); }
  }
  _commitRename() {
    if (!this._renaming) return;
    const oldName = this._renaming.name;
    const newName = (this._renaming.draft || "").trim();
    this._renaming = null;
    if (!newName || newName === oldName) return;
    const ok = this.store?.renameNamed?.(oldName, newName);
    if (!ok) return;
    // Carry any existing keybinding over to the new name so the user
    // doesn't have to re-assign their chord after a typo fix.
    const existingCombo = bindingFor("named", oldName);
    if (existingCombo) {
      clearBinding(existingCombo);
      setBinding(existingCombo, "named", newName);
    }
  }

  /// Styled delete confirmation. Resolves on confirm → drops the
  /// saved layout AND any keybinding tied to its name; resolves on
  /// cancel → no-op.
  async _confirmDelete(name) {
    const ok = await confirmAction({
      title: "Delete user preset?",
      message: `"${name}" will be removed from your saved layouts. The current workspace stays as-is.`,
      confirmLabel: "Delete",
      cancelLabel: "Keep",
      tone: "danger",
    });
    if (!ok) return;
    const existingCombo = bindingFor("named", name);
    this.store?.deleteNamed?.(name);
    if (existingCombo) clearBinding(existingCombo);
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
      { label: "Rename…", icon: "pencil-square", action: () => this._beginRename(name) },
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
        label: "Delete…",
        icon: "trash",
        tone: "danger",
        // Routes through the styled confirm dialog so the user gets a
        // proper "are you sure" instead of an immediate drop.
        action: () => this._confirmDelete(name),
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
