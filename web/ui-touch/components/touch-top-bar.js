// SPDX-License-Identifier: Apache-2.0
// Top app bar — session name + big transport buttons + agent FAB.
//
// We re-use foyer-core's ws.controlSet for transport, but we don't
// embed ui-full's transport-bar because that surface is too dense
// for the touch target sizes we want. This is a slimmer, ~5-control
// version: Play, Stop, Record, Loop, Position readout.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

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
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      min-height: 56px;
    }
    .session {
      flex: 1;
      min-width: 0;
      display: flex; flex-direction: column;
      gap: 2px;
    }
    .session .name {
      font-size: 14px;
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
    .transport {
      display: flex;
      gap: 8px;
      flex: 0 0 auto;
    }
    button {
      width: 48px; height: 48px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 12px;
      border: 0;
      background: var(--color-bg);
      color: var(--color-text);
      cursor: pointer;
      transition: transform 80ms, background 100ms, color 100ms;
    }
    button:active { transform: scale(0.94); }
    button.play {
      background: var(--color-accent, #60a5fa);
      color: #fff;
    }
    button.playing {
      background: var(--color-success, #34d399);
      color: #062018;
    }
    button.record {
      background: var(--color-bg);
      color: var(--color-danger, #f87171);
      border: 2px solid var(--color-danger, #f87171);
    }
    button.record.armed {
      background: var(--color-danger, #f87171);
      color: #fff;
      animation: pulse 1.2s ease-in-out infinite;
    }
    button.loop.on {
      background: var(--color-accent, #60a5fa);
      color: #fff;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
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
      <header>
        <div class="session">
          <div class="name">${s.sessionName}</div>
          <div class="pos">${bars}.${beats} · ${s.tempo.toFixed(0)} BPM</div>
        </div>
        <div class="transport">
          <button class="play ${s.playing ? "playing" : ""}"
                  title=${s.playing ? "Stop" : "Play"}
                  @click=${() => this._set("transport.playing", !s.playing)}>
            ${icon(s.playing ? "stop" : "play", 22)}
          </button>
          <button class="record ${s.recording ? "armed" : ""}"
                  title=${s.recording ? "Disarm record" : "Arm record"}
                  @click=${() => this._set("transport.recording", !s.recording)}>
            <span style="width:14px;height:14px;border-radius:50%;background:currentColor;display:inline-block"></span>
          </button>
          <button class="loop ${s.looping ? "on" : ""}"
                  title=${s.looping ? "Loop off" : "Loop on"}
                  @click=${() => this._set("transport.looping", !s.looping)}>
            ${icon("arrow-path", 22)}
          </button>
        </div>
      </header>
    `;
  }
}

customElements.define("foyer-touch-top-bar", TouchTopBar);
