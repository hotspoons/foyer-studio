// SPDX-License-Identifier: Apache-2.0
// Top app bar — session name + the full ui-full transport bar.
//
// We tried a slimmer 3-button version (Play / Record / Loop) but the
// touch user-base wants parity with desktop — locate, rewind, stop,
// ffw, locate-end, undo/redo, save, time-sig, tempo, return-mode are
// all part of "the transport." Embed the existing foyer-transport-bar
// rather than reimplement; CSS bumps the hit targets for fat fingers.

import { LitElement, html, css } from "lit";
// Side-effect import so `<foyer-transport-bar>` is defined.
import "../../ui-full/components/transport-bar.js";

export class TouchTopBar extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      flex: 0 0 auto;
      background: var(--color-surface, #1a2333);
      border-bottom: 1px solid var(--color-border, #2a3548);
      padding-top: env(safe-area-inset-top, 0);
    }
    .session-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px 4px;
    }
    .session {
      flex: 1;
      min-width: 0;
      display: flex; flex-direction: column;
      gap: 2px;
    }
    .session .name {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--color-text);
    }
    .session .pos {
      font-size: 11px;
      color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
    }
    /* Push the embedded desktop transport-bar's hit targets up. The
     * bar's .btn rule defines 32px min-width / 28px height; bump both
     * via descendant selectors so touch users still get ~40px. */
    foyer-transport-bar {
      display: block;
    }
    foyer-transport-bar::part(btn) {
      min-width: 40px;
      height: 38px;
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._onChange = () => { this._tick++; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onChange);
  }

  _state() {
    const s = window.__foyer?.store?.state?.session;
    const t = s?.transport;
    return {
      playing: t?.playing?.value === true || t?.playing?.value === "Bool(true)",
      recording: t?.recording?.value === true,
      looping: t?.looping?.value === true,
      tempo: typeof t?.tempo?.value === "number" ? t.tempo.value : 120,
      position_beats: typeof t?.position_beats?.value === "number" ? t.position_beats.value : 0,
      sessionName: this._sessionName(),
    };
  }

  _sessionName() {
    const cur = window.__foyer?.store?.currentSession?.();
    if (cur?.name) return cur.name;
    const path = cur?.path || "";
    if (path) return path.split("/").pop().replace(/\.ardour$/, "");
    return "Foyer";
  }

  _set(id, value) {
    window.__foyer?.ws?.controlSet?.(id, value);
  }

  render() {
    const s = this._state();
    const bars = Math.max(1, Math.floor(s.position_beats / 4) + 1);
    const beats = Math.max(1, Math.floor(s.position_beats % 4) + 1);
    return html`
      <div class="session-row">
        <div class="session">
          <div class="name">${s.sessionName}</div>
          <div class="pos">${bars}.${beats} · ${s.tempo.toFixed(0)} BPM</div>
        </div>
      </div>
      <foyer-transport-bar></foyer-transport-bar>
    `;
  }
}

customElements.define("foyer-touch-top-bar", TouchTopBar);
