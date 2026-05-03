// Phone transport. Six controls in the main row:
//   back-to-zero, play, stop, record, return-on-stop cycle, seek toggle
// plus a clock readout and a tempo display. Built around 56×56 hit
// targets — a thumb is ~10 mm wide, the Material guideline is 48dp,
// and recording-while-playing-an-instrument means you're tapping
// with the wrong hand at an awkward angle.
//
// Loop is intentionally absent. Looping is studio-mode behavior —
// "set up an A-B repeat region, fine-tune to taste" — and a stale
// loop is exactly the kind of "huh, why isn't transport doing what
// I want?" foot-gun the user has when they walk 20 feet to the kit.
// The return-on-stop cycle is here for the same reason in reverse:
// "snap the playhead back to the take's start when I hit stop" is
// the workflow that actually pays off when you can't reach the
// console.
//
// All control mutations go through `ws.controlSet(id, value)` —
// same wire surface the desktop transport uses, RBAC-gated by the
// `control_set` action.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed, onRbacChange } from "foyer-core/rbac.js";
import {
  RETURN_MODES,
  RETURN_MODE_LABELS,
  RETURN_MODE_TITLES,
  cycleReturnMode,
  getReturnMode,
} from "foyer-core/transport-return.js";

export class PhoneTransport extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _rbacTick: { state: true, type: Number },
    // Seek bar visibility. Sticky in localStorage so the user's
    // preference survives a reload. Closed by default — the phone
    // surface is opinionated about "what does an engineer at the
    // drum kit need," and a seek bar is "nice to have" not "load-
    // bearing."
    _seekOpen: { state: true, type: Boolean },
    // Drag-in-progress flag so the playhead label sticks at the
    // dragged value instead of fighting the live transport.position
    // echo while the finger is down.
    _seekDrag: { state: true, type: Boolean },
    _seekDragSamples: { state: true, type: Number },
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
    /* Return-on-stop cycle — labels are short on purpose because the
     * button slot is small and the user only cares about the current
     * mode at a glance. The detailed title attribute carries the
     * full meaning for accessibility tools. */
    .btn.ret {
      width: auto;
      min-width: 56px;
      padding: 0 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .btn.ret.zero,
    .btn.ret.play_start {
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

    /* Expand/collapse chevron for the seek bar. Sits on the right
     * end of the button row. Rotates 180° when open so the affordance
     * reads as "fold up" instead of a redundant "fold down." */
    .btn.seek-toggle {
      width: 36px; height: 36px;
      border-radius: 10px;
    }
    .btn.seek-toggle.on { color: var(--color-accent); border-color: var(--color-accent); }
    .btn.seek-toggle.on svg { transform: rotate(180deg); transition: transform 0.15s ease; }

    /* Seek bar — bounded by the session's audio bounds (earliest
     * region start to latest region end). Tap or drag the rail to
     * jump the transport. Hidden behind the chevron by default. */
    .seek-wrap {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--color-border);
      display: flex; flex-direction: column; gap: 6px;
    }
    .seek-bounds {
      display: flex; justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .seek-rail {
      position: relative;
      width: 100%;
      height: 36px;                /* big touch zone — the visible bar
                                    * lives in the middle 6px but the
                                    * gesture target is the whole row. */
      display: flex; align-items: center;
      cursor: pointer;
      touch-action: pan-y;
    }
    .seek-track {
      position: absolute;
      left: 0; right: 0;
      height: 6px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 3px;
      overflow: hidden;
    }
    .seek-fill {
      height: 100%;
      width: var(--seek-fill, 0%);
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--color-accent) 75%, transparent),
        color-mix(in oklab, var(--color-accent-2) 70%, transparent));
      transition: width 0.05s linear;
    }
    .seek-handle {
      position: absolute;
      top: 50%;
      width: 20px; height: 20px;
      transform: translate(-50%, -50%);
      left: var(--seek-pos, 0%);
      background: linear-gradient(180deg, #f1f5f9, #cbd5e1);
      border: 1px solid var(--color-border);
      border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4),
                  inset 0 1px 0 rgba(255,255,255,0.5);
      pointer-events: none;
    }
    :host([seek-drag]) .seek-handle {
      background: linear-gradient(180deg, var(--color-accent-3), var(--color-accent-2));
      border-color: var(--color-accent);
    }
    .seek-empty {
      padding: 4px 0;
      font-size: 11px;
      color: var(--color-text-muted);
      font-style: italic;
      text-align: center;
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._rbacTick = 0;
    this._seekDrag = false;
    this._seekDragSamples = 0;
    // Sticky open/closed state — pulled from localStorage so the user
    // doesn't have to re-open the bar on every reload.
    let openPref = false;
    try { openPref = localStorage.getItem("foyer.phone.seekbar.v1") === "1"; } catch {}
    this._seekOpen = openPref;
    this._onChange = () => { this._tick++; };
    this._offRbac = null;
  }

  _cycleReturn = () => {
    cycleReturnMode();
    this._tick++;       // re-render so the button label updates
  };

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

  _toggleSeek = () => {
    this._seekOpen = !this._seekOpen;
    try {
      localStorage.setItem("foyer.phone.seekbar.v1", this._seekOpen ? "1" : "0");
    } catch {}
  };

  /// Compute the session's audio bounds in samples — the position
  /// of the earliest region's left edge to the position of the
  /// latest region's right edge. Used to bound the seek bar so the
  /// playhead can't slide past the session's actual audio.
  ///
  /// Falls back to a 30-second window starting at zero when no
  /// regions are known yet (cold boot, before regions_list arrives).
  /// Returns `null` when the session is fully empty AND we already
  /// have a snapshot — that drives the "nothing to scrub yet" hint
  /// instead of a deceptively-empty bar.
  _audioBoundsSamples() {
    const regions = window.__foyer?.store?.state?.regionsByTrack;
    if (!regions || regions.size === 0) {
      // Snapshot might just not have populated regions yet — give the
      // user the benefit of the doubt with a 30-second default
      // window. Once a real regions_list lands, we'll re-render with
      // accurate bounds.
      const sr = this._sampleRate();
      const session = window.__foyer?.store?.state?.session;
      if (!session) return { start: 0, end: sr * 30, fallback: true };
      // Snapshot is loaded but no regions on any track — say so.
      return null;
    }
    let earliest = null;
    let latest = null;
    for (const list of regions.values()) {
      for (const r of list || []) {
        const s = Number(r?.start_samples ?? 0);
        const len = Number(r?.length_samples ?? 0);
        if (!Number.isFinite(s) || !Number.isFinite(len)) continue;
        const right = s + len;
        if (earliest === null || s < earliest) earliest = s;
        if (latest === null || right > latest) latest = right;
      }
    }
    if (earliest === null || latest === null || latest <= earliest) {
      const sr = this._sampleRate();
      return { start: 0, end: sr * 30, fallback: true };
    }
    // Anchor the start at zero when the session sits at the timeline
    // origin — UX expectation is "0:00 is on the left." Negative
    // start_samples (pre-roll regions) get the literal earliest.
    return { start: Math.min(0, earliest), end: latest, fallback: false };
  }

  _sampleRate() {
    return Number(
      window.__foyer?.store?.state?.session?.sample_rate
        || window.__foyer?.store?.state?.session?.meta?.sample_rate
        || 48_000,
    );
  }

  _seekFromPointer(ev, rail) {
    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const bounds = this._audioBoundsSamples();
    if (!bounds) return null;
    const t = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const samples = Math.round(bounds.start + t * (bounds.end - bounds.start));
    return Math.max(0, samples);
  }

  _seekDown = (ev) => {
    if (!isAllowed("control_set")) return;
    ev.preventDefault();
    const rail = ev.currentTarget;
    rail.setPointerCapture?.(ev.pointerId);
    const samples = this._seekFromPointer(ev, rail);
    if (samples == null) return;
    this._seekDrag = true;
    this.toggleAttribute("seek-drag", true);
    this._seekDragSamples = samples;
    this._set("transport.position", samples);
  };
  _seekMove = (ev) => {
    if (!this._seekDrag) return;
    const samples = this._seekFromPointer(ev, ev.currentTarget);
    if (samples == null) return;
    this._seekDragSamples = samples;
    this._set("transport.position", samples);
  };
  _seekUp = (ev) => {
    if (!this._seekDrag) return;
    this._seekDrag = false;
    this.toggleAttribute("seek-drag", false);
    ev.currentTarget.releasePointerCapture?.(ev.pointerId);
  };

  _formatSamples(samples) {
    const sr = this._sampleRate();
    const total = Math.max(0, samples / sr);
    const intSec = Math.floor(total);
    const s = intSec % 60;
    const m = Math.floor(intSec / 60) % 60;
    const h = Math.floor(intSec / 3600);
    const p2 = (n) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  }

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
        ${this._renderReturnButton()}
        <button class="btn seek-toggle ${this._seekOpen ? "on" : ""}"
                title="${this._seekOpen ? "Hide seek bar" : "Show seek bar"}"
                @click=${this._toggleSeek}>
          ${icon("chevron-down", 16)}
        </button>
      </div>
      ${this._seekOpen ? this._renderSeekBar() : null}
    `;
  }

  /// Return-on-stop 3-way cycle. The sister of Loop on the desktop —
  /// loops are too "studio mode" for the phone surface (the user
  /// dropping their phone to grab a guitar shouldn't have to fight a
  /// stale loop state) but return-on-stop is exactly the thing the
  /// remote-instrument workflow needs: "I want the playhead back to
  /// the take's start when I hit stop and walk to the kit." Three
  /// modes:
  ///   * `leave`      — Stay where stopped (no seek)
  ///   * `zero`       — Seek to sample 0 on stop
  ///   * `play_start` — Seek to wherever play was last pressed
  /// Cycle by tap. State persists in localStorage via transport-return.js.
  _renderReturnButton() {
    const mode = getReturnMode();
    const label = RETURN_MODE_LABELS[mode] || "Stay";
    const title = RETURN_MODE_TITLES[mode] || "";
    const next = RETURN_MODES[(RETURN_MODES.indexOf(mode) + 1) % RETURN_MODES.length];
    const nextLabel = RETURN_MODE_LABELS[next];
    return html`
      <button class="btn ret ${mode}"
              title="On stop: ${title}. Tap to cycle (next: ${nextLabel})."
              @click=${this._cycleReturn}>
        ${label}
      </button>
    `;
  }

  /// YouTube-style seek bar. Bounded by the session's audio bounds
  /// (earliest region start to latest region end). Tap or drag the
  /// rail to jump the transport. RBAC-gated by `control_set` — view-
  /// only roles see the bar but can't move it. The whole element is
  /// only rendered when `_seekOpen` is true (sticky in localStorage).
  _renderSeekBar() {
    const bounds = this._audioBoundsSamples();
    if (!bounds) {
      return html`
        <div class="seek-wrap">
          <div class="seek-empty">No regions yet — record or import audio to enable scrubbing.</div>
        </div>
      `;
    }
    // Use the user's drag value while the finger is down so the
    // handle doesn't fight the live transport.position echo.
    const livePos = Number(this._get("transport.position") || 0);
    const samples = this._seekDrag ? this._seekDragSamples : livePos;
    const span = bounds.end - bounds.start;
    const t = span > 0
      ? Math.max(0, Math.min(1, (samples - bounds.start) / span))
      : 0;
    const pct = (t * 100).toFixed(2);
    const canControl = isAllowed("control_set");
    return html`
      <div class="seek-wrap">
        <div class="seek-bounds">
          <span>${this._formatSamples(bounds.start)}</span>
          <span>${this._formatSamples(samples)}</span>
          <span>${this._formatSamples(bounds.end)}</span>
        </div>
        <div class="seek-rail"
             style=${`--seek-fill:${pct}%; --seek-pos:${pct}%`}
             @pointerdown=${canControl ? this._seekDown : null}
             @pointermove=${canControl ? this._seekMove : null}
             @pointerup=${canControl ? this._seekUp : null}
             @pointercancel=${canControl ? this._seekUp : null}>
          <div class="seek-track">
            <div class="seek-fill"></div>
          </div>
          <div class="seek-handle"></div>
        </div>
        ${bounds.fallback ? html`
          <div class="seek-empty" style="text-align:left;padding-top:0">
            Showing the default 30 s window — bounds will tighten when
            the session reports its regions.
          </div>
        ` : null}
      </div>
    `;
  }
}
customElements.define("foyer-phone-transport", PhoneTransport);
