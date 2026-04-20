import { LitElement, html, css } from "lit";

import "./toggle.js";
import "./number-scrub.js";
import { ControlController } from "../store.js";
import { icon } from "../icons.js";
import {
  RETURN_MODE_LABELS,
  RETURN_MODE_TITLES,
  cycleReturnMode,
  getReturnMode,
} from "../transport-return.js";

export class TransportBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface));
      border-bottom: 1px solid var(--color-border);
      position: relative;
      z-index: 1200;
    }
    .row { display: flex; align-items: center; gap: 4px; }
    .row.transport { gap: 2px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      height: 28px;
      padding: 0 8px;
      font-family: var(--font-sans);
      font-size: 14px;
      /* Base color is set per-variant below; plain .btn stays muted. */
      color: var(--color-text-muted);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
    }
    .btn:hover {
      filter: brightness(1.3);
      border-color: color-mix(in oklab, currentColor 60%, var(--color-border));
      background: color-mix(in oklab, currentColor 10%, var(--color-surface));
    }
    .btn:active { transform: translateY(1px); }

    /* Per-button idle tints — dim enough to read as "off" but saturated
     * enough to convey meaning at a glance. Hover brightens via currentColor
     * + filter so we don't have to double the CSS. */
    .btn.locate  { color: color-mix(in oklab, #6ab0ff 65%, var(--color-text-muted)); }
    .btn.scrub   { color: color-mix(in oklab, #8fb8ff 60%, var(--color-text-muted)); }
    .btn.stop    { color: color-mix(in oklab, #b8b8c6 75%, var(--color-text-muted)); }
    .btn.play    { color: color-mix(in oklab, var(--color-accent) 80%, var(--color-text-muted)); }
    .btn.rec     { color: color-mix(in oklab, var(--color-danger, #d04040) 80%, var(--color-text-muted)); }
    .btn.loop    { color: color-mix(in oklab, #dece5c 70%, var(--color-text-muted)); }
    .btn.return-mode {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 0 8px;
      min-width: 52px;
      color: color-mix(in oklab, #a384ff 70%, var(--color-text-muted));
    }
    .btn.edit    { color: color-mix(in oklab, #b3c0d8 70%, var(--color-text-muted)); }
    .btn.save    { color: color-mix(in oklab, #7ac69a 70%, var(--color-text-muted)); }
    .btn.save.dirty {
      color: #b48adb;
      background: color-mix(in oklab, #b48adb 18%, var(--color-surface));
      border-color: color-mix(in oklab, #b48adb 40%, var(--color-border));
    }

    /* "On" states: saturate fully + tinted background for that DAW
     * lit-button feel. */
    .btn.play.on {
      color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 28%, var(--color-surface));
      border-color: var(--color-accent);
    }
    .btn.rec.on {
      color: var(--color-danger, #d04040);
      background: color-mix(in oklab, var(--color-danger, #d04040) 28%, var(--color-surface));
      border-color: var(--color-danger, #d04040);
      animation: rec-pulse 1.2s ease-in-out infinite;
    }
    .btn.loop.on {
      color: #dece5c;
      background: color-mix(in oklab, #dece5c 22%, var(--color-surface));
      border-color: #dece5c;
    }
    @keyframes rec-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-danger, #d04040) 55%, transparent); }
      50%      { box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-danger, #d04040) 0%,  transparent); }
    }
    .sep {
      width: 1px;
      height: 20px;
      background: var(--color-border);
      margin: 0 4px;
    }
    .spacer { flex: 1; }
    .meta {
      color: var(--color-text-muted);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
  `;

  constructor() {
    super();
    this._playCtl = null;
    this._recCtl = null;
    this._loopCtl = null;
    this._tempoCtl = null;
    this._onStoreChange = () => this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer.store;
    this._playCtl  = new ControlController(this, store, "transport.playing");
    this._recCtl   = new ControlController(this, store, "transport.recording");
    this._loopCtl  = new ControlController(this, store, "transport.looping");
    this._tempoCtl = new ControlController(this, store, "transport.tempo");
    // Repaint when the session.dirty flag flips — the Save button
    // enables/disables off that.
    store.addEventListener("change", this._onStoreChange);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStoreChange);
    super.disconnectedCallback();
  }

  render() {
    const play = !!this._playCtl?.value;
    const rec  = !!this._recCtl?.value;
    const loop = !!this._loopCtl?.value;
    const tempo = Number(this._tempoCtl?.value ?? 120);
    const returnMode = getReturnMode();

    return html`
      <div class="row transport">
        <div class="btn locate" title="Go to start (Home)" @click=${this._gotoStart}>${icon("backward-step", 16)}</div>
        <div class="btn scrub"  title="Rewind 5 s" @click=${this._rewind}>${icon("backward", 16)}</div>
        <div class="btn stop"   title="Stop" @click=${this._stop}>${icon("stop", 16)}</div>
        <div class="btn play ${play ? "on" : ""}"
             title="${play ? "Pause" : "Play"} (Space)"
             @click=${() => this._setPlay(!play)}>${icon(play ? "pause" : "play", 16)}</div>
        <div class="btn rec ${rec ? "on" : ""}"
             title="Record arm (R)"
             @click=${() => this._set("transport.recording", !rec)}>${icon("record", 16)}</div>
        <div class="btn loop ${loop ? "on" : ""}"
             title="Toggle loop (L)"
             @click=${() => this._set("transport.looping", !loop)}>${icon("loop", 16)}</div>
        <div class="btn scrub"  title="Fast forward 5 s" @click=${this._fastForward}>${icon("forward", 16)}</div>
        <div class="btn locate" title="Go to end (End)" @click=${this._gotoEnd}>${icon("forward-step", 16)}</div>
      </div>
      <div class="btn return-mode"
           title=${RETURN_MODE_TITLES[returnMode] + " — click to cycle"}
           @click=${this._cycleReturnMode}>${RETURN_MODE_LABELS[returnMode]}</div>
      <div class="sep"></div>
      <div class="row">
        <div class="btn edit"
             title="Undo (${this._metaChord()}+Z)"
             @click=${this._undo}>${icon("arrow-uturn-left", 14)}</div>
        <div class="btn edit"
             title="Redo (${this._metaChord()}+Shift+Z)"
             @click=${this._redo}>${icon("arrow-uturn-right", 14)}</div>
        <div class="btn save ${this._isDirty() ? "dirty" : ""}"
             title="${this._isDirty() ? "Save session (unsaved changes)" : "Save session"}"
             @click=${this._save}>${icon("document-save", 14)}</div>
      </div>
      <div class="sep"></div>
      <foyer-number
        label="Tempo"
        unit="BPM"
        .value=${tempo}
        .min=${20}
        .max=${300}
        .step=${1}
        .fineStep=${0.1}
        .coarseStep=${10}
        .precision=${1}
        .pxPerStep=${3}
        @input=${this._onTempo}
        @change=${this._onTempo}
      ></foyer-number>
      <span class="spacer"></span>
      <span class="meta">Foyer · M4 transport</span>
    `;
  }

  _set(id, v) {
    // Post-stop return behavior is installed once globally by
    // `installTransportReturn` (web/src/transport-return.js) — no need
    // to special-case stop here.
    window.__foyer.ws.controlSet(id, v ? 1 : 0);
  }

  _setPlay(v) { this._set("transport.playing", v); }
  _cycleReturnMode = () => {
    cycleReturnMode();
    this.requestUpdate();
  };
  _stop = () => this._set("transport.playing", false);
  // All of these are explicit user seeks — if the return-on-stop lock
  // is still running we release it so the new target isn't swallowed.
  _seek(samples) {
    window.__foyer?.store?.releaseTransportPositionLock?.();
    window.__foyer?.ws?.controlSet("transport.position", Math.max(0, samples));
  }
  _gotoStart = () => this._seek(0);
  _gotoEnd = () => {
    const meta = window.__foyer?.store?.state?.session?.meta || {};
    const endSamples = Number(meta.length_samples || 48_000 * 60);
    this._seek(endSamples);
  };
  // RW/FF jump by 5s. Full scrub-while-held comes later once we have a
  // shim-side transport.speed endpoint.
  _rewind = () => {
    const cur = Number(window.__foyer?.store?.state?.controls?.get("transport.position") || 0);
    const sr = Number(window.__foyer?.store?.state?.session?.meta?.sample_rate || 48_000);
    this._seek(cur - 5 * sr);
  };
  _fastForward = () => {
    const cur = Number(window.__foyer?.store?.state?.controls?.get("transport.position") || 0);
    const sr = Number(window.__foyer?.store?.state?.session?.meta?.sample_rate || 48_000);
    this._seek(cur + 5 * sr);
  };

  _onTempo = (ev) => {
    const v = Number(ev.detail?.value);
    if (Number.isFinite(v)) window.__foyer.ws.controlSet("transport.tempo", v);
  };

  _metaChord() {
    // Cosmetic: pick the chord symbol for the tooltip based on OS.
    return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl";
  }

  _isDirty() {
    return !!window.__foyer?.store?.state?.session?.dirty;
  }

  _invoke(id) {
    window.__foyer?.ws?.send({ type: "invoke_action", id });
  }
  _undo = () => this._invoke("edit.undo");
  _redo = () => this._invoke("edit.redo");
  _save = () => this._invoke("session.save");
}
customElements.define("foyer-transport-bar", TransportBar);
