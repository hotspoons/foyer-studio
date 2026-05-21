// SPDX-License-Identifier: Apache-2.0
// Touch-friendly track list. Each row is a 64px-tall card:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌ TrackName               -6 dB   [M] [S] [R]   [Open]   │
//   └──────────────────────────────────────────────────────────┘
//
// Tap "Open" → drops to Piano Roll (MIDI tracks) or Plugins panel
// (audio tracks). M / S / R are 44px touch targets.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

import { setActivePanel } from "../panels.js";

export class TouchTracksPanel extends LitElement {
  static properties = { _tick: { state: true, type: Number } };

  static styles = css`
    :host {
      display: block; height: 100%;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      padding: 12px;
      background: var(--color-surface);
    }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px;
      margin-bottom: 8px;
      background: var(--color-surface);
      border-radius: 12px;
      min-height: 64px;
    }
    .swatch {
      width: 4px; align-self: stretch;
      border-radius: 999px;
      background: var(--track-color, var(--color-accent));
    }
    .meta {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      gap: 2px;
    }
    .name {
      font-weight: 600; font-size: 15px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sub {
      font-size: 11px; color: var(--color-text-muted);
    }
    .btn {
      width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    }
    .btn.on.mute   { background: var(--color-warning, #f59e0b); border-color: transparent; color: #1f1300; }
    .btn.on.solo   { background: var(--color-accent,  #60a5fa); border-color: transparent; color: white; }
    .btn.on.rec    { background: var(--color-danger,  #f87171); border-color: transparent; color: white; }
    .open {
      padding: 0 14px;
      width: auto;
      font-size: 13px;
      gap: 6px;
      display: flex; align-items: center;
    }
    .empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; padding: 24px; gap: 12px;
      color: var(--color-text-muted); text-align: center;
    }
    .empty h2 { margin: 0; color: var(--color-text); font-size: 20px; }
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

  _toggle(track, field) {
    const param = track[field];
    if (!param?.id) return;
    const cur = param.value === true || param.value === "Bool(true)";
    window.__foyer?.ws?.controlSet?.(param.id, !cur);
  }

  _open(track) {
    const isMidi = track.kind === "midi" || track.kind === "Midi";
    // We don't carry per-tile state in the variant yet — the
    // simplest open is route to the editor panel and let the user
    // pick a region from the timeline. When per-tile track/region
    // selection lands (broadcast via a CustomEvent), this routes
    // straight to the right region.
    if (isMidi) setActivePanel("piano-roll");
    else setActivePanel("plugins");
  }

  render() {
    const session = window.__foyer?.store?.state?.session;
    const tracks = session?.tracks || [];
    if (tracks.length === 0) {
      return html`
        <div class="empty">
          <h2>No tracks yet</h2>
          <p>Open a session from <strong>More → Sessions</strong>
          to get started.</p>
        </div>
      `;
    }
    return html`
      ${tracks.map((t) => {
        const muted = t.mute?.value === true;
        const soloed = t.solo?.value === true;
        const armed = t.record_arm?.value === true;
        const gainLinear = typeof t.gain?.value === "number" ? t.gain.value : 1;
        const gainDb = gainLinear > 1e-6 ? 20 * Math.log10(gainLinear) : -120;
        const color = t.color || "#60a5fa";
        return html`
          <div class="row" style=${`--track-color: ${color}`}>
            <div class="swatch"></div>
            <div class="meta">
              <div class="name">${t.name}</div>
              <div class="sub">${t.kind} · ${gainDb.toFixed(1)} dB</div>
            </div>
            <button class="btn ${muted ? "on mute" : ""}"
                    title=${muted ? "Unmute" : "Mute"}
                    @click=${() => this._toggle(t, "mute")}>M</button>
            <button class="btn ${soloed ? "on solo" : ""}"
                    title=${soloed ? "Unsolo" : "Solo"}
                    @click=${() => this._toggle(t, "solo")}>S</button>
            ${t.record_arm ? html`
              <button class="btn ${armed ? "on rec" : ""}"
                      title=${armed ? "Disarm" : "Arm record"}
                      @click=${() => this._toggle(t, "record_arm")}>R</button>
            ` : null}
            <button class="btn open" @click=${() => this._open(t)}>
              ${icon("pencil-square", 16)}<span>Open</span>
            </button>
          </div>
        `;
      })}
    `;
  }
}

customElements.define("foyer-touch-tracks-panel", TouchTracksPanel);
