// Phone transport. Five buttons (back-to-zero / play / stop /
// record / loop) plus a clock readout and a tempo display. Built
// around 56×56 hit targets — a thumb is ~10 mm wide, the Material
// guideline is 48dp, and recording-while-playing-an-instrument means
// you're tapping with the wrong hand at an awkward angle.
//
// All control mutations go through `ws.controlSet(id, value)` —
// same wire surface the desktop transport uses, RBAC-gated by the
// `control_set` action.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed, onRbacChange } from "foyer-core/rbac.js";

export class PhoneTransport extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _rbacTick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      padding: 14px 16px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      font-family: var(--font-sans);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: center;
    }
    .btn {
      flex: 0 0 auto;
      width: 56px; height: 56px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 16px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
    }
    .btn:active { transform: scale(0.94); }
    .btn.disabled {
      opacity: 0.35;
      pointer-events: none;
    }
    /* Play and Record are the two buttons that change visual state
     * based on transport state — solid fill when active, accent or
     * red respectively. Stop is always neutral; loop tints when on. */
    .btn.play.on {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
      box-shadow: 0 0 16px color-mix(in oklab, var(--color-accent) 50%, transparent);
    }
    .btn.rec.on {
      color: #fff;
      background: var(--color-danger, #ef4444);
      border-color: transparent;
      box-shadow: 0 0 16px color-mix(in oklab, var(--color-danger, #ef4444) 50%, transparent);
    }
    .btn.loop.on {
      color: var(--color-accent);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .meta {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      font-variant-numeric: tabular-nums;
    }
    .clock {
      font-family: var(--font-mono);
      font-size: 32px;
      font-weight: 700;
      color: var(--color-text);
      letter-spacing: 0.02em;
    }
    .barbeat {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--color-text-muted);
    }
    .tempo {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--color-text-muted);
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._rbacTick = 0;
    this._onChange = () => { this._tick++; };
    this._offRbac = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Position + meter ticks come in as "control" events. Re-render
    // on either path; the position is the only field that animates.
    window.__foyer?.store?.addEventListener("change", this._onChange);
    window.__foyer?.store?.addEventListener("control", this._onChange);
    this._offRbac = onRbacChange(() => { this._rbacTick++; });
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onChange);
    window.__foyer?.store?.removeEventListener("control", this._onChange);
    this._offRbac?.();
    super.disconnectedCallback();
  }

  _get(id) { return window.__foyer?.store?.get?.(id); }

  _set(id, v) {
    if (!isAllowed("control_set")) return;
    window.__foyer?.ws?.controlSet(id, v);
  }
  _setBool(id, v) { this._set(id, v ? 1 : 0); }

  _formatClock() {
    const samples = Number(this._get("transport.position") || 0);
    const sr = Number(
      window.__foyer?.store?.state?.session?.sample_rate
        || window.__foyer?.store?.state?.session?.meta?.sample_rate
        || 48_000,
    );
    const total = Math.max(0, samples / sr);
    const ms = Math.floor((total % 1) * 1000);
    const intSec = Math.floor(total);
    const s = intSec % 60;
    const m = Math.floor(intSec / 60) % 60;
    const h = Math.floor(intSec / 3600);
    const p2 = (n) => n.toString().padStart(2, "0");
    const p3 = (n) => n.toString().padStart(3, "0");
    return h > 0
      ? `${h}:${p2(m)}:${p2(s)}.${p3(ms)}`
      : `${m}:${p2(s)}.${p3(ms)}`;
  }

  _formatBarBeat() {
    const samples = Number(this._get("transport.position") || 0);
    const sr = Number(
      window.__foyer?.store?.state?.session?.sample_rate
        || window.__foyer?.store?.state?.session?.meta?.sample_rate
        || 48_000,
    );
    const tempo = Number(this._get("transport.tempo") || 0);
    const tsNum = Math.max(1, Number(this._get("transport.ts.num") || 4));
    if (!sr || !tempo) return "—";
    const totalBeats = (samples / sr) * (tempo / 60);
    const bar = Math.floor(totalBeats / tsNum) + 1;
    const beat = Math.floor(totalBeats % tsNum) + 1;
    return `${bar}.${beat}`;
  }

  render() {
    void this._tick; void this._rbacTick;
    const playing = !!Number(this._get("transport.playing"));
    const rec     = !!Number(this._get("transport.recording"));
    const loop    = !!Number(this._get("transport.looping"));
    const tempo   = Number(this._get("transport.tempo") || 0);
    const tsN     = Number(this._get("transport.ts.num") || 4);
    const tsD     = Number(this._get("transport.ts.den") || 4);
    const canControl = isAllowed("control_set");
    const dis = canControl ? "" : "disabled";
    return html`
      <div class="meta">
        <span class="clock">${this._formatClock()}</span>
        <span class="barbeat">${this._formatBarBeat()}</span>
      </div>
      <div class="meta">
        <span class="tempo">${tempo ? tempo.toFixed(1) : "—"} BPM</span>
        <span class="tempo">${tsN}/${tsD}</span>
      </div>
      <div class="row">
        <button class="btn ${dis}"
                title="Back to start"
                @click=${() => this._set("transport.position", 0)}>
          ${icon("backward", 22)}
        </button>
        <button class="btn play ${playing ? "on" : ""} ${dis}"
                title=${playing ? "Pause" : "Play"}
                @click=${() => this._setBool("transport.playing", !playing)}>
          ${icon(playing ? "pause" : "play", 26)}
        </button>
        <button class="btn ${dis}"
                title="Stop"
                @click=${() => this._setBool("transport.playing", false)}>
          ${icon("stop", 22)}
        </button>
        <button class="btn rec ${rec ? "on" : ""} ${dis}"
                title=${rec ? "Disarm record" : "Arm record"}
                @click=${() => this._setBool("transport.recording", !rec)}>
          ${icon("record", 22)}
        </button>
        <button class="btn loop ${loop ? "on" : ""} ${dis}"
                title=${loop ? "Loop on" : "Loop off"}
                @click=${() => this._setBool("transport.looping", !loop)}>
          ${icon("loop", 22)}
        </button>
      </div>
    `;
  }
}
customElements.define("foyer-phone-transport", PhoneTransport);
