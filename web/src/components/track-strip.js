// Channel strip: color swatch · name · kind · plugin strip · M/S/R · fader + meter.

import { LitElement, html, css } from "lit";

import "./fader.js";
import "./toggle.js";
import "./meter.js";
import "./plugin-strip.js";
import { ControlController } from "../store.js";
import { showContextMenu } from "./context-menu.js";
import { openTrackEditor } from "./track-editor-modal.js";

// Curated palette for the "Set color" submenu. Close to DAW defaults so
// colors carry some semantic weight (reds for drums, blues for bass,
// etc.) without forcing users into a custom-picker popup for the common
// case. "Clear" removes the color entirely.
const COLOR_PALETTE = [
  { label: "Red",        hex: "#c04040" },
  { label: "Orange",     hex: "#c08040" },
  { label: "Yellow",     hex: "#c0b040" },
  { label: "Green",      hex: "#40c080" },
  { label: "Teal",       hex: "#40a0b0" },
  { label: "Blue",       hex: "#4080c0" },
  { label: "Purple",     hex: "#9060c0" },
  { label: "Pink",       hex: "#c06090" },
  { label: "Gray",       hex: "#808080" },
];

function normToDb(n) {
  n = Math.max(0, Math.min(1, n));
  if (n <= 0.0001) return -60;
  if (n <= 0.75) return -60 + (n / 0.75) * 60;
  return (n - 0.75) / 0.25 * 6;
}
function dbToNorm(db) {
  if (db <= -60) return 0;
  if (db <= 0) return ((db + 60) / 60) * 0.75;
  return 0.75 + Math.min(6, db) / 6 * 0.25;
}

export class TrackStrip extends LitElement {
  static properties = {
    track: { type: Object },
    density: { type: Object },
    widthMode: { type: String },
    overrideWidth: { type: Number },
    _renaming: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      padding: 8px 6px;
      gap: 6px;
      border-right: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      transition: background 0.15s ease;
      min-width: 0;
      overflow: hidden;
      position: relative;
    }
    :host(:hover) {
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    :host([selected]) {
      background: linear-gradient(180deg,
        color-mix(in oklab, var(--color-accent) 14%, var(--color-surface-elevated)),
        color-mix(in oklab, var(--color-accent) 8%, var(--color-surface)));
      box-shadow: inset 2px 0 0 var(--color-accent);
    }
    .channel-resize {
      /* Stays INSIDE the strip's right edge so it doesn't trespass into
       * the floating-window edge-resize zone. A channel-resize floating
       * 3px past the strip's right used to fight the window's east
       * resize handle for clicks. */
      position: absolute;
      top: 0; bottom: 0; right: 0;
      width: 5px;
      cursor: ew-resize;
      z-index: 2;
      transition: background 0.12s ease;
    }
    .channel-resize:hover,
    :host([resizing]) .channel-resize {
      background: color-mix(in oklab, var(--color-accent) 45%, transparent);
    }
    .name {
      font-family: var(--font-sans);
      font-weight: 600;
      text-align: center;
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: text;
    }
    .name-input {
      font-family: var(--font-sans);
      font-weight: 600;
      text-align: center;
      color: var(--color-text);
      background: var(--color-surface);
      border: 1px solid var(--color-accent);
      border-radius: 3px;
      padding: 2px 4px;
      width: 100%;
      box-sizing: border-box;
      outline: none;
    }
    .kind {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--color-text-muted);
      text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 5px;
    }
    .seq-chip {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 1px 4px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-accent) 24%, transparent);
      color: var(--color-accent);
    }
    .row {
      display: flex;
      gap: 4px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .body { display: flex; gap: 6px; align-items: flex-end; justify-content: center; flex: 0 0 auto; min-height: 0; }
    .plugin-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .swatch {
      height: 3px;
      border-radius: 2px;
      margin: 0 2px;
      background: var(--color-accent);
    }
    foyer-plugin-strip { flex: 0 0 auto; }
    .mon-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 0 2px;
    }
    .monitor-stack {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 2px;
    }
    .monitor-stack .divider {
      height: 1px;
      margin: 0 2px;
      background: color-mix(in oklab, var(--color-border) 70%, transparent);
      opacity: 0.8;
    }
    .mon-btn {
      font-family: var(--font-sans);
      font-size: 8.5px; font-weight: 700;
      padding: 2px 0;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      letter-spacing: 0.04em;
      width: 100%;
    }
    .mon-btn:hover { color: var(--color-text); border-color: var(--color-accent); }
    .mon-btn.on {
      color: #fff;
      background: color-mix(in oklab, var(--color-accent) 55%, transparent);
      border-color: var(--color-accent);
    }
  `;

  constructor() {
    super();
    this.track = null;
    this.density = null;
    this.widthMode = "relative";
    this.overrideWidth = null;
    this._gainCtl = null;
    this._muteCtl = null;
    this._soloCtl = null;
    this._recCtl = null;
    this._meterCtl = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onSelection = () => this._syncSelected();
    window.__foyer?.store?.addEventListener("selection", this._onSelection);
    this._syncSelected();
    this.addEventListener("click", this._onStripClick);
    this.addEventListener("dblclick", this._onStripDblClick);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("selection", this._onSelection);
    this.removeEventListener("click", this._onStripClick);
    this.removeEventListener("dblclick", this._onStripDblClick);
    super.disconnectedCallback();
  }
  _syncSelected() {
    if (!this.track) return;
    const sel = !!window.__foyer?.store?.isTrackSelected?.(this.track.id);
    if (sel) this.setAttribute("selected", "");
    else this.removeAttribute("selected");
  }
  _onStripClick = (ev) => {
    // Don't steal clicks from interactive children (fader/toggles/context
    // menu on the name, etc). Only select when the user clicks on
    // "empty" strip space.
    const tag = (ev.target?.tagName || "").toLowerCase();
    if (["foyer-fader", "foyer-toggle", "foyer-meter", "foyer-plugin-strip", "input", "button"].includes(tag)) {
      return;
    }
    // Name div is interactive (rename/context-menu) — leave it alone.
    const cls = ev.target?.classList;
    if (cls && (cls.contains("name") || cls.contains("name-input") || cls.contains("channel-resize"))) return;
    if (!this.track?.id) return;
    let mode = "replace";
    if (ev.shiftKey) mode = "extend";
    else if (ev.ctrlKey || ev.metaKey) mode = "toggle";
    window.__foyer?.store?.selectTrack(this.track.id, mode);
  };

  _onStripDblClick = (ev) => {
    // Same protection as click: don't fire when the user double-clicked
    // an interactive child (fader reset, toggle, etc.).
    const tag = (ev.target?.tagName || "").toLowerCase();
    if (["foyer-fader", "foyer-toggle", "foyer-meter", "foyer-plugin-strip", "input", "button"].includes(tag)) {
      return;
    }
    const cls = ev.target?.classList;
    if (cls && (cls.contains("name") || cls.contains("name-input") || cls.contains("channel-resize"))) return;
    if (this.track?.id) openTrackEditor(this.track.id);
  };

  willUpdate(changed) {
    if (changed.has("track") && this.track) {
      const store = window.__foyer.store;
      this._gainCtl = new ControlController(this, store, this.track.gain?.id);
      this._muteCtl = new ControlController(this, store, this.track.mute?.id);
      this._soloCtl = new ControlController(this, store, this.track.solo?.id);
      if (this.track.record_arm?.id) {
        this._recCtl = new ControlController(this, store, this.track.record_arm.id);
      }
      if (this.track.peak_meter) {
        this._meterCtl = new ControlController(this, store, this.track.peak_meter);
      }
    }
    // Apply width via inline styles so the mixer's layout mode can drive us.
    if (changed.has("density") || changed.has("widthMode") || changed.has("overrideWidth")) {
      this._applyWidth();
    }
  }

  _applyWidth() {
    const d = this.density || { trackWidth: 96 };
    // Per-channel override always wins — if the user has explicitly sized
    // this strip, we honor that regardless of the mixer's global width mode.
    if (this.overrideWidth) {
      this.style.flex = "0 0 auto";
      this.style.width = `${this.overrideWidth}px`;
      this.style.minWidth = `${this.overrideWidth}px`;
      return;
    }
    if (this.widthMode === "absolute") {
      this.style.flex = "0 0 auto";
      this.style.width = `${d.trackWidth}px`;
      this.style.minWidth = `${d.trackWidth}px`;
    } else {
      this.style.flex = "1 1 0";
      this.style.width = "auto";
      this.style.minWidth = `${Math.max(32, Math.floor(d.trackWidth * 0.8))}px`;
    }
  }

  render() {
    if (!this.track) return html``;
    const d = this.density || {
      trackWidth: 96, plugins: true, pluginsLines: 3, meterWidth: 8,
      showKind: true, showColorBar: true, labelSize: 11,
    };
    const t = this.track;
    const gainDb = Number(this._gainCtl?.value ?? t.gain?.value ?? 0);
    const gainNorm = dbToNorm(gainDb);
    const gainLabel = `${gainDb.toFixed(1)} dB`;

    const mute = !!(this._muteCtl?.value ?? t.mute?.value);
    const solo = !!(this._soloCtl?.value ?? t.solo?.value);
    const rec  = !!(this._recCtl?.value  ?? t.record_arm?.value);
    const meterDb = Number(this._meterCtl?.value ?? -60);

    const swatchStyle = t.color
      ? `background:${t.color}`
      : `background:linear-gradient(90deg, var(--color-accent), var(--color-accent-2))`;
    const nameStyle = `font-size:${d.labelSize}px`;

    return html`
      ${d.showColorBar ? html`<div class="swatch" style=${swatchStyle}></div>` : null}
      ${this._renaming
        ? html`
          <input class="name-input" style=${nameStyle}
                 .value=${t.name}
                 @keydown=${(e) => this._onRenameKey(e)}
                 @blur=${(e) => this._commitRename(e.currentTarget.value)}>
        `
        : html`
          <div class="name" style=${nameStyle}
               title="${t.name} — click to select · right-click for options"
               @click=${(e) => this._onNameClick(e)}
               @contextmenu=${(e) => this._onContextMenu(e)}>${t.name}</div>
        `}
      ${d.showKind ? html`
        <div class="kind">
          ${t.kind}${this._isSequencer() ? html`<span class="seq-chip" title="This track has an active beat-sequencer region">SEQ</span>` : null}
        </div>
      ` : null}
      <div class="monitor-stack">
        <div class="row">
          <foyer-toggle tone="mute" label="M" .on=${mute} @input=${(e) => this._setBool(t.mute?.id, e.detail.value)}></foyer-toggle>
          <foyer-toggle tone="solo" label="S" .on=${solo} @input=${(e) => this._setBool(t.solo?.id, e.detail.value)}></foyer-toggle>
          ${t.record_arm ? html`
            <foyer-toggle tone="rec" label="●" .on=${rec} @input=${(e) => this._setBool(t.record_arm.id, e.detail.value)}></foyer-toggle>
          ` : null}
        </div>
        ${t.monitoring !== undefined && t.monitoring !== null ? html`
          <div class="divider"></div>
          <div class="mon-row" title="Monitoring: auto, input (live), disk (playback) — Ardour MonitorChoice">
            ${["auto", "in", "disk"].map((mode) => {
              const full = mode === "in" ? "input" : mode;
              const active = (t.monitoring || "auto") === full;
              return html`
                <button class="mon-btn ${active ? "on" : ""}"
                        title=${
                          full === "input" ? "Input — always monitor the live input (rehearsing)"
                          : full === "disk" ? "Disk — always play back from disk (no live input)"
                          : "Auto — switch based on transport state"
                        }
                        @click=${() => this._setMonitoring(full)}>${mode.toUpperCase()}</button>
              `;
            })}
          </div>
        ` : null}
      </div>
      ${d.plugins && (t.plugins || []).length ? html`
        <div class="plugin-scroll">
          <foyer-plugin-strip
            .plugins=${t.plugins || []}
            .maxLines=${d.pluginsLines}
            .trackId=${t.id}
            .trackName=${t.name}
          ></foyer-plugin-strip>
        </div>
      ` : null}
      <div class="body">
        <foyer-fader
          .value=${gainNorm}
          .label=${gainLabel}
          @input=${(e) => this._setGain(e.detail.value)}
          @reset=${() => this._setGain(dbToNorm(0))}
        ></foyer-fader>
        <foyer-meter .value=${meterDb} height="140"></foyer-meter>
      </div>
      <div class="channel-resize"
           title="Drag to resize this channel · double-click to clear override"
           @pointerdown=${(e) => this._startChannelResize(e)}
           @dblclick=${() => this._clearChannelOverride()}></div>
    `;
  }

  _startChannelResize(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = this.getBoundingClientRect().width;
    this.setAttribute("resizing", "");
    const minW = 28;
    const maxW = 360;
    // Shift-drag broadcasts a second event that tells the mixer to
    // apply the same delta to every strip. We still do the local
    // override for visual feedback; the mixer's handler interprets
    // `resize_all: true` and fans the delta across all tracks.
    const resizeAll = ev.shiftKey;
    const tick = (e) => {
      const w = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX)));
      this.overrideWidth = w;
      this._applyWidth();
      this.dispatchEvent(new CustomEvent("channel-resize", {
        detail: {
          trackId: this.track?.id,
          width: Math.round(w),
          delta: Math.round((e.clientX - startX)),
          startWidth: Math.round(startW),
          final: false,
          resizeAll,
        },
        bubbles: true,
        composed: true,
      }));
    };
    const up = (e) => {
      window.removeEventListener("pointermove", tick);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.removeAttribute("resizing");
      this.dispatchEvent(new CustomEvent("channel-resize", {
        detail: {
          trackId: this.track?.id,
          width: Math.round(this.overrideWidth || 0),
          delta: Math.round(((e?.clientX ?? startX) - startX)),
          startWidth: Math.round(startW),
          final: true,
          resizeAll,
        },
        bubbles: true,
        composed: true,
      }));
    };
    window.addEventListener("pointermove", tick);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  _clearChannelOverride() {
    this.overrideWidth = null;
    this._applyWidth();
    this.dispatchEvent(new CustomEvent("channel-resize", {
      detail: { trackId: this.track?.id, width: 0, final: true },
      bubbles: true,
      composed: true,
    }));
  }

  _setGain(norm) {
    if (!this.track?.gain?.id) return;
    const db = normToDb(norm);
    window.__foyer.ws.controlSet(this.track.gain.id, db);
  }
  _setBool(id, v) {
    if (!id) return;
    window.__foyer.ws.controlSet(id, v ? 1 : 0);
  }

  // ── rename / color / right-click menu ──────────────────────────────
  _onContextMenu(ev) {
    if (!this.track) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = this.track;
    showContextMenu(ev, [
      { label: "Rename", icon: "pencil-square", action: () => this._startRename() },
      {
        label: "Set color",
        icon: "swatch",
        submenu: [
          ...COLOR_PALETTE.map((c) => ({
            label: c.label,
            icon: "square-3-stack-3d",
            action: () => this._updatePatch({ color: c.hex }),
          })),
          { separator: true },
          { label: "Clear", icon: "x-mark", action: () => this._updatePatch({ color: "" }) },
        ],
      },
      {
        label: "Track editor…",
        icon: "cog-6-tooth",
        action: () => openTrackEditor(t.id),
      },
      { separator: true },
      { label: `ID: ${t.id}`, disabled: true },
    ]);
  }

  _startRename() {
    this._renaming = true;
  }

  /** Single-click on the name: if the strip is already selected,
   *  start inline rename. Otherwise select the strip (don't rename
   *  on the click that SELECTS — that matches Finder/Nautilus, and
   *  avoids renaming every time the user picks a track). */
  /** True if this track has at least one region with an active
   *  beat-sequencer layout — drives the SEQ chip on the strip. */
  _isSequencer() {
    const ids = window.__foyer?.store?.state?.sequencerTrackIds;
    return ids ? ids.has(this.track?.id) : false;
  }

  _onNameClick(ev) {
    ev.stopPropagation();
    if (!this.track?.id) return;
    const store = window.__foyer?.store;
    if (store?.isTrackSelected?.(this.track.id)) {
      this._startRename();
    } else {
      store?.selectTrack?.(this.track.id, "replace");
    }
  }

  _onRenameKey(ev) {
    if (ev.key === "Enter") {
      this._commitRename(ev.currentTarget.value);
      ev.preventDefault();
    } else if (ev.key === "Escape") {
      this._renaming = false;
      ev.preventDefault();
    }
  }

  _commitRename(value) {
    const trimmed = (value || "").trim();
    this._renaming = false;
    if (!trimmed || trimmed === this.track?.name) return;
    this._updatePatch({ name: trimmed });
  }

  _updatePatch(patch) {
    if (!this.track?.id) return;
    window.__foyer?.ws?.send({ type: "update_track", id: this.track.id, patch });
  }

  _setMonitoring(mode) {
    // Optimistic local update so the pressed state flips immediately
    // — the shim echoes a track_updated event with the committed
    // value shortly after. "auto" | "input" | "disk" | "cue".
    if (!this.track) return;
    this.track = { ...this.track, monitoring: mode };
    this._updatePatch({ monitoring: mode });
  }

  updated(changed) {
    super.updated?.(changed);
    if (this._renaming && changed.has("_renaming")) {
      const input = this.shadowRoot?.querySelector("input.name-input");
      if (input) {
        input.focus();
        input.select();
      }
    }
  }
}
customElements.define("foyer-track-strip", TrackStrip);
