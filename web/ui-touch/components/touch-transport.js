// SPDX-License-Identifier: Apache-2.0
// Touch-friendly transport bar. The desktop foyer-transport-bar packs
// too much into one inline row for narrow viewports; embedding it on
// phone widths caused the buttons to overflow / stack. This one keeps
// the same controls in spirit but lays them out in a single flex row
// where children flex-grow to fill the width up to a per-button cap,
// then wraps to a second row when there isn't enough room (portrait).

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import {
  RETURN_MODE_LABELS,
  cycleReturnMode,
  getReturnMode,
} from "foyer-core/transport-return.js";

export class TouchTransport extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      /* Background + border live on the parent row in the top bar so
       * this component sits flush. Keep the host transparent so it
       * inherits whatever container we drop it into. */
    }
    .row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: stretch;
      gap: 6px;
    }
    button {
      flex: 1 1 0;
      min-width: 44px;
      max-width: 72px;
      height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      background: var(--color-surface);
      color: var(--color-text-muted);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      transition: transform 80ms, background 100ms, color 100ms;
    }
    button:active { transform: scale(0.94); }
    button.play.on    { color: var(--color-accent); background: color-mix(in oklab, var(--color-accent) 24%, var(--color-surface)); border-color: var(--color-accent); }
    button.rec        { color: color-mix(in oklab, var(--color-danger, #d04040) 80%, var(--color-text-muted)); }
    button.rec.on     { color: var(--color-danger, #d04040); background: color-mix(in oklab, var(--color-danger, #d04040) 24%, var(--color-surface)); border-color: var(--color-danger, #d04040); animation: rec-pulse 1.2s ease-in-out infinite; }
    button.loop.on    { color: #dece5c; background: color-mix(in oklab, #dece5c 22%, var(--color-surface)); border-color: #dece5c; }
    button.locate     { color: color-mix(in oklab, #6ab0ff 60%, var(--color-text-muted)); }
    button.scrub      { color: color-mix(in oklab, #8fb8ff 55%, var(--color-text-muted)); }
    button.edit       { color: color-mix(in oklab, #b3c0d8 65%, var(--color-text-muted)); }
    button.save       { color: color-mix(in oklab, #7ac69a 65%, var(--color-text-muted)); }
    button.save.dirty { color: #b48adb; background: color-mix(in oklab, #b48adb 18%, var(--color-surface)); border-color: color-mix(in oklab, #b48adb 40%, var(--color-border)); }
    button.return-mode {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: color-mix(in oklab, #a384ff 65%, var(--color-text-muted));
      max-width: 84px;
    }
    @keyframes rec-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-danger, #d04040) 55%, transparent); }
      50%      { box-shadow: 0 0 0 4px color-mix(in oklab, var(--color-danger, #d04040) 0%, transparent); }
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._onStoreChange = () => { this._tick++; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onStoreChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onStoreChange);
  }

  _ctl(id) { return window.__foyer?.store?.state?.controls?.get(id); }
  _set(id, v) { window.__foyer?.ws?.controlSet?.(id, v ? 1 : 0); }
  _sr() {
    const s = window.__foyer?.store?.state?.session;
    return Number(s?.sample_rate || s?.meta?.sample_rate || 48_000);
  }
  _seek(samples) {
    window.__foyer?.store?.releaseTransportPositionLock?.();
    window.__foyer?.ws?.controlSet?.("transport.position", Math.max(0, samples));
  }
  _gotoStart() { this._seek(0); }
  _gotoEnd() {
    const meta = window.__foyer?.store?.state?.session?.meta || {};
    this._seek(Number(meta.length_samples || this._sr() * 60));
  }
  _rewind()      { this._seek(Number(this._ctl("transport.position") || 0) - 5 * this._sr()); }
  _fastForward() { this._seek(Number(this._ctl("transport.position") || 0) + 5 * this._sr()); }
  _stop() { this._set("transport.playing", false); }
  _save() { window.__foyer?.ws?.send?.({ type: "save_session" }); }
  _undo() { window.__foyer?.ws?.send?.({ type: "invoke_action", action: "undo" }); }
  _redo() { window.__foyer?.ws?.send?.({ type: "invoke_action", action: "redo" }); }

  _isDirty() {
    return !!window.__foyer?.store?.state?.session?.dirty;
  }

  render() {
    const playing = !!this._ctl("transport.playing");
    const recording = !!this._ctl("transport.recording");
    const looping = !!this._ctl("transport.looping");
    const rm = getReturnMode();
    return html`
      <div class="row">
        <button class="locate" title="Go to start" @click=${() => this._gotoStart()}>${icon("backward-step", 22)}</button>
        <button class="scrub"  title="Rewind 5 s"  @click=${() => this._rewind()}>${icon("backward", 22)}</button>
        <button class="locate" title="Stop"        @click=${() => this._stop()}>${icon("stop", 22)}</button>
        <button class="play ${playing ? "on" : ""}"
                title=${playing ? "Pause" : "Play"}
                @click=${() => this._set("transport.playing", !playing)}>
          ${icon(playing ? "pause" : "play", 22)}
        </button>
        <button class="rec ${recording ? "on" : ""}"
                title="Record arm"
                @click=${() => this._set("transport.recording", !recording)}>
          <span style="width:14px;height:14px;border-radius:50%;background:currentColor"></span>
        </button>
        <button class="loop ${looping ? "on" : ""}"
                title="Loop"
                @click=${() => this._set("transport.looping", !looping)}>${icon("loop", 22)}</button>
        <button class="scrub"  title="Fast forward 5 s" @click=${() => this._fastForward()}>${icon("forward", 22)}</button>
        <button class="locate" title="Go to end"        @click=${() => this._gotoEnd()}>${icon("forward-step", 22)}</button>
        <button class="return-mode"
                title=${`Return-on-stop: ${RETURN_MODE_LABELS[rm]} — tap to cycle`}
                @click=${() => { cycleReturnMode(); this._tick++; }}>${RETURN_MODE_LABELS[rm]}</button>
        <button class="edit" title="Undo" @click=${() => this._undo()}>${icon("arrow-uturn-left", 20)}</button>
        <button class="edit" title="Redo" @click=${() => this._redo()}>${icon("arrow-uturn-right", 20)}</button>
        <button class="save ${this._isDirty() ? "dirty" : ""}"
                title=${this._isDirty() ? "Save (unsaved changes)" : "Save"}
                @click=${() => this._save()}>${icon("document-save", 20)}</button>
      </div>
    `;
  }
}

customElements.define("foyer-touch-transport", TouchTransport);
