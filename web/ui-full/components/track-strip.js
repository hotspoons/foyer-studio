// Channel strip: color swatch · name · kind · plugin strip · M/S/R/I · fader + meter.

import { LitElement, html, css } from "lit";

import "foyer-ui-core/widgets/fader.js";
import "foyer-ui-core/widgets/toggle.js";
import "foyer-ui-core/widgets/meter.js";
import "./plugin-strip.js";
import { ControlController } from "foyer-core/store.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";
import { openTrackEditor } from "./track-editor-modal.js";
// `t` is already used throughout this file as the local `track`
// variable in render bodies, so alias the i18n function as `tr` to
// dodge the shadow.
import { t as tr, onLocaleChange } from "/core/i18n.js";
import { openPanEditor } from "./pan-editor-modal.js";
import { isAllowed } from "foyer-core/rbac.js";
import {
  isTrackMicActive,
  onTrackMicChange,
  toggleTrackTake,
} from "foyer-core/audio/track-mic.js";
import {
  isTrackMidiActive,
  onTrackMidiChange,
  toggleTrackMidi,
} from "foyer-core/midi/track-midi.js";

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
    _panOpen: { state: true, type: Boolean },
    _panMode: { state: true, type: String },
    // Optimistic monitor-mode override. Set when the user clicks
    // a mon-btn; cleared once the backend echoes the same value back.
    // Without this the parent's next render replaces our local
    // optimistic copy with the stale store value and the button
    // appears to ignore the first click (Rich, 2026-04-25).
    _monitoringPending: { state: true, type: String },
    // Take-chip latch: blocks re-entry while the bundled
    // claim+mic+wire toggle is in flight, fades the chip while busy.
    _takeBusy: { state: true, type: Boolean },
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
    /* Name + kind share one column so every strip has the same vertical
       rhythm; the group stripe is not in document flow. */
    .name-kind-header {
      display: flex;
      flex-direction: column;
      align-items: stretch;
    }
    .name-block {
      position: relative;
    }
    /* Preserve the same 6px breathing room that :host gap used to insert
       between the old standalone .name and .kind siblings. */
    .name-kind-header.has-kind .name-block {
      margin-bottom: 6px;
    }
    /* Group color — absolutely positioned in the gap between the track
       name and the AUDIO/MIDI row so grouped strips don't push M/S/R
       and the fader stack down relative to ungrouped neighbors. */
    .group-band {
      position: absolute;
      left: 2px;
      right: 2px;
      height: 3px;
      border-radius: 2px;
      background: var(--color-accent);
      opacity: 0.85;
      pointer-events: none;
      z-index: 1;
    }
    .name-kind-header.has-kind .group-band {
      /* Center the 3px bar in the 6px margin under the name block. */
      top: calc(100% + 3px - 1.5px);
    }
    .name-kind-header:not(.has-kind) .group-band {
      /* No kind row — tuck a short marker just under the name; still
         out of flow so layout matches ungrouped strips. */
      top: calc(100% + 2px);
    }
    .group-band.linked-on {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      box-sizing: border-box;
      padding-right: 1px;
    }
    .group-band.linked-on::after {
      /* Dot: link flags active on this group. */
      content: "";
      flex-shrink: 0;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 0 4px currentColor;
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
    /* Bundled Take chip — same one-tap claim+mic+wire as the phone
     * surface (web/ui-phone/components/track-row.js). The shared
     * state-machine lives in foyer-core/audio/track-mic.js so a flip
     * on either surface lights up the chip on both. We render a
     * regular foyer-toggle for visual consistency with M/S/●; the
     * .busy modifier fades+pulses it while the async toggle is
     * in flight so a double-click does not queue a second claim. */
    foyer-toggle.take-toggle.busy {
      opacity: 0.55;
      pointer-events: none;
      animation: foyer-take-pulse 1s ease-in-out infinite;
    }
    @keyframes foyer-take-pulse {
      0%, 100% { opacity: 0.55; }
      50%      { opacity: 0.85; }
    }
  `;

  constructor() {
    super();
    this.track = null;
    this.density = null;
    this.widthMode = "fill";
    this.overrideWidth = null;
    this._gainCtl = null;
    this._muteCtl = null;
    this._soloCtl = null;
    this._recCtl = null;
    this._meterCtl = null;
    this._panOpen = false;
    this._panMode = "stereo";
    this._takeBusy = false;
    this._unsubTrackMic = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onSelection = () => this._syncSelected();
    this._onBrowserSources = () => this.requestUpdate();
    // Audio ingress envelopes — the desktop track-editor modal and
    // any other surface that drives the registry without going
    // through `toggleTrackTake` only signal the change via a WS
    // envelope. Listening here keeps the Take chip in sync with
    // mic flips that happen "around" us.
    this._onIngressEnv = (ev) => {
      const t = ev?.detail?.body?.type;
      if (t === "audio_ingress_opened" || t === "audio_ingress_closed") {
        this.requestUpdate();
      }
    };
    window.__foyer?.store?.addEventListener("selection", this._onSelection);
    window.__foyer?.store?.addEventListener("track-browser-sources", this._onBrowserSources);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onIngressEnv);
    // Repaint the Take chip whenever ANY surface (this strip, the
    // phone row) flips a mic via the shared `toggleTrackTake` — the
    // shared registry is on globalThis but state changes need an
    // explicit nudge to invalidate render.
    this._unsubTrackMic = onTrackMicChange(() => this.requestUpdate());
    this._unsubTrackMidi = onTrackMidiChange(() => this.requestUpdate());
    this._i18nDispose = onLocaleChange(() => this.requestUpdate());
    this._syncSelected();
    this.addEventListener("click", this._onStripClick);
    this.addEventListener("dblclick", this._onStripDblClick);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("selection", this._onSelection);
    window.__foyer?.store?.removeEventListener("track-browser-sources", this._onBrowserSources);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onIngressEnv);
    this._unsubTrackMic?.();
    this._unsubTrackMic = null;
    this._unsubTrackMidi?.();
    this._unsubTrackMidi = null;
    this._i18nDispose?.();
    this._i18nDispose = null;
    this.removeEventListener("click", this._onStripClick);
    this.removeEventListener("dblclick", this._onStripDblClick);
    super.disconnectedCallback();
  }

  _toggleTake = async () => {
    if (!this.track?.id || this._takeBusy) return;
    this._takeBusy = true;
    try {
      const isMidi = this.track.kind === "midi";
      const args = {
        trackId: this.track.id,
        ws: window.__foyer?.ws,
        store: window.__foyer?.store,
      };
      if (isMidi) {
        await toggleTrackMidi(args);
      } else {
        await toggleTrackTake(args);
      }
    } finally {
      this._takeBusy = false;
      this.requestUpdate();
    }
  };
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
      // Echo settled — drop the pending override.
      if (this._monitoringPending && this.track.monitoring === this._monitoringPending) {
        this._monitoringPending = null;
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
    if (this.widthMode === "fixed") {
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
    const panVal = Number(window.__foyer?.store?.get(t.pan?.id) ?? t.pan?.value ?? 0);

    const swatchStyle = t.color
      ? `background:${t.color}`
      : `background:linear-gradient(90deg, var(--color-accent), var(--color-accent-2))`;
    const nameStyle = `font-size:${d.labelSize}px`;
    // Group affinity band. `t.group_id` is the foreign key; the
    // matching group object lives on `session.groups`. We read it via
    // the store rather than asking the parent because tile-leaf
    // doesn't otherwise pass the session through.
    const group = this._groupOf(t);
    const groupActive = group && group.active !== false
      && (group.link_gain !== false || group.link_mute !== false
       || group.link_solo !== false || group.link_record !== false);
    const groupBandStyle = group?.color
      ? `background:${group.color}`
      : null;

    return html`
      ${d.showColorBar ? html`<div class="swatch" style=${swatchStyle}></div>` : null}
      <div class="name-kind-header ${d.showKind ? "has-kind" : ""}">
        <div class="name-block">
          ${this._renaming
            ? html`
          <input class="name-input" style=${nameStyle}
                 .value=${t.name}
                 @keydown=${(e) => this._onRenameKey(e)}
                 @blur=${(e) => this._commitRename(e.currentTarget.value)}>
        `
            : html`
          <div class="name" style=${nameStyle}
               title=${tr("%{name} — click to select · right-click for options", { name: t.name })}
               @click=${(e) => this._onNameClick(e)}
               @contextmenu=${(e) => this._onContextMenu(e)}>${t.name}</div>
        `}
          ${group && groupBandStyle ? html`
            <div class="group-band ${groupActive ? "linked-on" : ""}"
                 style=${groupBandStyle}
                 title=${groupActive
                   ? tr("Group: %{name}", { name: group.name })
                   : tr("Group: %{name} (inactive)", { name: group.name })}></div>
          ` : null}
        </div>
        ${d.showKind ? html`
          <div class="kind">
            ${t.kind}${this._isSequencer() ? html`<span class="seq-chip" title=${tr("This track has an active beat-sequencer region")}>${tr("SEQ")}</span>` : null}
          </div>
        ` : null}
      </div>
      <div class="monitor-stack">
        <div class="row">
          <foyer-toggle tone="mute" label="M" .on=${mute} @input=${(e) => this._setBool(t.mute?.id, e.detail.value)}></foyer-toggle>
          <foyer-toggle tone="solo" label="S" .on=${solo} @input=${(e) => this._setBool(t.solo?.id, e.detail.value)}></foyer-toggle>
          ${t.record_arm ? html`
            <foyer-toggle tone="rec" label="●" .on=${rec} @input=${(e) => this._setBool(t.record_arm.id, e.detail.value)}></foyer-toggle>
          ` : null}
          ${this._showTake() ? (() => {
            const isMidi = t.kind === "midi";
            const active = isMidi ? isTrackMidiActive(t.id) : isTrackMicActive(t.id);
            const onTitle = isMidi
              ? tr("Stop sending browser MIDI to this track")
              : tr("Stop my mic and release this track");
            const offTitle = isMidi
              ? tr("Claim this track for my browser MIDI — devices + on-screen keyboard route here")
              : tr("Claim this track for my mic — assigns source user + opens browser ingress");
            return html`
              <foyer-toggle class="take-toggle ${this._takeBusy ? "busy" : ""}"
                            label="I"
                            .on=${active}
                            title=${active ? onTitle : offTitle}
                            @input=${this._toggleTake}></foyer-toggle>
            `;
          })() : null}
        </div>
        ${t.monitoring !== undefined && t.monitoring !== null ? html`
          <div class="divider"></div>
          ${this._hasBrowserSource(t.id) ? html`
            <div class="mon-row" title=${tr("Live monitoring is off for browser-sourced tracks — the round-trip latency would make it unusable.")}>
              <span style="font-size:10px;color:var(--color-text-muted);padding:2px 4px">${tr("MON OFF")}</span>
            </div>
          ` : html`
            <div class="mon-row" title=${tr("Monitoring: auto, input (live), disk (playback) — Ardour MonitorChoice")}>
              ${["auto", "in", "disk"].map((mode) => {
                const full = mode === "in" ? "input" : mode;
                const effective = this._monitoringPending || t.monitoring || "auto";
                const active = effective === full;
                return html`
                  <button class="mon-btn ${active ? "on" : ""}"
                          title=${
                            full === "input" ? tr("Input — always monitor the live input (rehearsing)")
                            : full === "disk" ? tr("Disk — always play back from disk (no live input)")
                            : tr("Auto — switch based on transport state")
                          }
                          @click=${() => this._setMonitoring(full)}>${mode.toUpperCase()}</button>
                `;
              })}
            </div>
          `}
        ` : null}
      </div>
      <div class="plugin-scroll">
        <foyer-plugin-strip
          .plugins=${t.plugins || []}
          .maxLines=${d.pluginsLines}
          .trackId=${t.id}
          .trackName=${t.name}
        ></foyer-plugin-strip>
      </div>
      ${t.pan ? this._renderPanControl(t, panVal) : null}
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
           title=${tr("Drag to resize this channel · double-click to clear override")}
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
  _setPan(v) {
    if (!this.track?.pan?.id) return;
    const value = Math.max(-1, Math.min(1, Number(v) || 0));
    window.__foyer.ws.controlSet(this.track.pan.id, value);
  }
  _setBool(id, v) {
    if (!id) return;
    window.__foyer.ws.controlSet(id, v ? 1 : 0);
  }

  /// Take chip gates: audio tracks + control_set permission.
  ///
  /// Unlike the phone (web/ui-phone/components/track-row.js), the
  /// desktop chip is NOT tunnel-only. The desktop UI variant is
  /// frequently a remote control surface against a DAW running
  /// somewhere else (Cloud Run instance, studio rig over LAN, a
  /// container the user is SSH'd into) — the "host already has the
  /// studio interface" assumption that justifies the phone's tunnel
  /// gate doesn't carry over. A user sitting at the actual studio
  /// rig can still see the chip and just ignore it; that's a smaller
  /// loss than hiding the affordance from every remote-control
  /// session that isn't routed through a Cloudflare tunnel.
  _showTake() {
    if (!this.track) return false;
    if (this.track.kind !== "audio" && this.track.kind !== "midi") return false;
    if (!isAllowed("control_set")) return false;
    return true;
  }

  _renderPanControl(t, panVal) {
    return html`
      <div style="flex:0 0 auto;display:flex;flex-direction:column;gap:4px;">
        <button style="background:transparent;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-muted);font-size:9px;cursor:pointer;padding:2px 0;"
                @click=${() => this._panOpen = !this._panOpen}>
          ${tr("Pan")} ${this._panOpen ? "▲" : "▼"}
        </button>
        ${this._panOpen ? html`
          <div style="display:flex;gap:4px;justify-content:center;">
            <button style="background:${this._panMode === "stereo" ? "var(--color-accent)" : "transparent"};border:1px solid var(--color-border);border-radius:var(--radius-sm);color:${this._panMode === "stereo" ? "#fff" : "var(--color-text-muted)"};font-size:8px;cursor:pointer;padding:1px 4px;"
                    @click=${() => this._panMode = "stereo"}>${tr("Stereo")}</button>
            <button style="background:${this._panMode === "surround" ? "var(--color-accent)" : "transparent"};border:1px solid var(--color-border);border-radius:var(--radius-sm);color:${this._panMode === "surround" ? "#fff" : "var(--color-text-muted)"};font-size:8px;cursor:pointer;padding:1px 4px;"
                    @click=${() => this._panMode = "surround"}>${tr("Surround")}</button>
          </div>
          ${this._panMode === "stereo" ? html`
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:8px;color:var(--color-text-muted)">${tr("L")}</span>
              <input type="range" min="-1" max="1" step="0.01" style="flex:1;min-width:0"
                     .value=${String(panVal)}
                     @input=${(e) => this._setPan(e.currentTarget.value)}>
              <span style="font-size:8px;color:var(--color-text-muted)">${tr("R")}</span>
            </div>
            <div style="text-align:center;font-size:9px;color:var(--color-text)">${panVal.toFixed(2)}</div>
          ` : html`
            <div style="position:relative;width:100%;height:80px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-elevated);cursor:crosshair;"
                 @pointerdown=${this._onSurroundPointerDown}
                 @pointermove=${(e) => { if (e.buttons & 1) this._onSurroundPointerMove(e); }}>
              <div style="position:absolute;left:50%;top:50%;width:6px;height:6px;border-radius:50%;background:var(--color-accent);border:1px solid #fff;transform:translate(-50%,-50%);pointer-events:none;"
                   id="pan-dot"></div>
            </div>
            <div style="text-align:center;font-size:8px;color:var(--color-text-muted)">${tr("X writes pan · Y preview")}</div>
          `}
        ` : null}
      </div>
    `;
  }

  _onSurroundPointerDown(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    this._setPan(Math.max(-1, Math.min(1, nx)));
    this._updateDot(ev.currentTarget, nx, ny);
  }

  _onSurroundPointerMove(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    this._setPan(Math.max(-1, Math.min(1, nx)));
    this._updateDot(ev.currentTarget, nx, ny);
  }

  _updateDot(pad, nx, ny) {
    const dot = pad.querySelector("#pan-dot");
    if (dot) {
      dot.style.left = `${((nx + 1) * 0.5 * 100)}%`;
      dot.style.top = `${((ny + 1) * 0.5 * 100)}%`;
    }
  }

  // ── rename / color / right-click menu ──────────────────────────────
  _onContextMenu(ev) {
    if (!this.track) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = this.track;
    showContextMenu(ev, [
      { label: tr("Rename"), icon: "pencil-square", action: () => this._startRename() },
      {
        label: tr("Set color"),
        icon: "swatch",
        submenu: [
          ...COLOR_PALETTE.map((c) => ({
            label: tr(c.label),
            icon: "square-3-stack-3d",
            action: () => this._updatePatch({ color: c.hex }),
          })),
          { separator: true },
          { label: tr("Clear"), icon: "x-mark", action: () => this._updatePatch({ color: "" }) },
        ],
      },
      {
        label: tr("Track editor…"),
        icon: "cog-6-tooth",
        action: () => openTrackEditor(t.id),
      },
      { separator: true },
      { label: tr("ID: %{id}", { id: t.id }), disabled: true },
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

  /** Resolve the group object this track belongs to (or null). Read
   *  through the store so the strip stays sealed off from any
   *  parent-prop plumbing — the session always lives there. */
  _groupOf(t) {
    if (!t?.group_id) return null;
    const groups = window.__foyer?.store?.state?.session?.groups;
    if (!Array.isArray(groups)) return null;
    return groups.find((g) => g.id === t.group_id) || null;
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
    // Optimistic local override so the pressed state flips
    // immediately. Lives in `_monitoringPending` (a state property,
    // not on `this.track`) because the parent re-renders by pushing a
    // fresh `.track` and would otherwise overwrite a mutation here.
    // Cleared in `willUpdate` once the shim echoes a `track_updated`
    // carrying the new value. (Pre-fix the user had to click twice
    // because Ardour's MonitorControl::set_value queues to the audio
    // thread and the inline echo from dispatch.cc returned the OLD
    // value; the SignalBridge wiring fixes the echo, this hardens
    // the click-feel until the echo lands.)
    if (!this.track) return;
    this._monitoringPending = mode;
    this._updatePatch({ monitoring: mode });
  }

  /**
   * True when some browser is the assigned source for this track —
   * in which case live monitoring is forced off (browser round-trip
   * latency kills the "hear yourself while laying a take" use case).
   */
  _hasBrowserSource(trackId) {
    const sources = window.__foyer?.store?.state?.trackBrowserSources;
    return !!(sources && sources.get && sources.get(trackId));
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
