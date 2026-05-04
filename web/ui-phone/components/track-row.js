// One track per row on the phone surface. Layout:
//
//   ┌──────────────────────────────────────────────┐
//   │ [R] [S] [M]  Track name                       │
//   │ ─────────●─── Fader (gain)        −3.0 dB     │
//   └──────────────────────────────────────────────┘
//
// The chip row is fixed-height so the eye can scan a list of tracks
// for arm/solo/mute state at a glance; the fader sits below at full
// row width so the thumb has somewhere to land.
//
// Pan / I/O / plugins / sends are intentionally absent. This is a
// monitor-mix surface, not a tracking session — see ui-phone/package.js.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed } from "foyer-core/rbac.js";
import {
  isTrackMicActive,
  onTrackMicChange,
  toggleTrackTake,
} from "foyer-core/audio/track-mic.js";
import "./horizontal-fader.js";
import { dbToNorm, normToDb } from "./horizontal-fader.js";

export class PhoneTrackRow extends LitElement {
  static properties = {
    track: { type: Object },
    _gainDb: { state: true, type: Number },
    _takeBusy: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      padding: 14px 16px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .name {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    /* Big chip-style toggles. Larger than desktop because thumbs are
     * thumbs. The hit target is 38×38 even though the visible chip
     * is 36×36 — the extra 2px is invisible padding from the host. */
    .chip {
      flex: 0 0 auto;
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 10px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
    }
    /* Per-row Advanced button. Same height as the R/S/M row but
     * narrower because the kebab is the universal "more" affordance.
     * Lives at the right edge of the chip row so the eye groups it
     * with the track name (the thing the kebab acts on). */
    .more {
      flex: 0 0 auto;
      width: 32px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 8px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      user-select: none;
      transition: all 0.1s ease;
    }
    .more:active { transform: scale(0.94); }
    .more:hover { color: var(--color-text); }
    .chip:active { transform: scale(0.94); }
    .chip.rec.on {
      color: #fff;
      background: var(--color-danger, #ef4444);
      border-color: var(--color-danger, #ef4444);
      box-shadow: 0 0 12px color-mix(in oklab, var(--color-danger, #ef4444) 50%, transparent);
    }
    .chip.solo.on {
      color: #1f1300;
      background: #fbbf24;
      border-color: #fbbf24;
    }
    .chip.mute.on {
      color: #fff;
      background: #64748b;
      border-color: #64748b;
    }
    /* "Take" chip (I = Input): one-tap "this track is mine, my mic is
     * live on it." Bundles set-source-user + start-mic-ingress +
     * input-port wiring so a remote performer doesn't have to dive
     * into the advanced sheet for each take. Audio tracks only,
     * tunnel guests only — there's no equivalent gesture for a host
     * sitting at the studio rig. */
    .chip.take.on {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
      box-shadow: 0 0 12px color-mix(in oklab, var(--color-accent) 50%, transparent);
    }
    .chip.take.busy {
      opacity: 0.55;
      pointer-events: none;
      animation: foyer-take-pulse 1s ease-in-out infinite;
    }
    @keyframes foyer-take-pulse {
      0%, 100% { opacity: 0.55; }
      50%      { opacity: 0.85; }
    }
    .chip.disabled {
      opacity: 0.35;
      pointer-events: none;
    }
    /* Faded look for tracks the user can't drive — keeps the row
     * visible (so the engineer knows the track exists) but signals
     * "view only." */
    :host([readonly]) .name { color: var(--color-text-muted); }
    .gainline {
      display: flex; align-items: center; gap: 12px;
    }
    .gainline foyer-phone-hfader { flex: 1; min-width: 0; }
    .db {
      flex: 0 0 56px;
      text-align: right;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--color-text);
      font-variant-numeric: tabular-nums;
    }
  `;

  constructor() {
    super();
    this.track = null;
    this._gainDb = 0;
    this._takeBusy = false;
    this._unsub = null;
    // Re-render when the trackBrowserSources map changes (someone else
    // claimed/released this track) or when an ingress event lands —
    // so the Take chip's "on" state reflects reality without polling.
    this._onPeerSrcs = () => this.requestUpdate();
    this._onIngressEnv = (ev) => {
      const t = ev?.detail?.body?.type;
      if (t === "audio_ingress_opened" || t === "audio_ingress_closed") {
        this.requestUpdate();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    // Two store listeners by design:
    //   * `change` fires on snapshot replacements + session lifecycle
    //     events. Used to repaint when the underlying track shape
    //     changes (e.g. session swap).
    //   * `control` fires for every ControlUpdate. The R/S/M chips +
    //     fader read directly from the controls map at render time,
    //     so we MUST request an update on every relevant control
    //     event — without this the buttons "do nothing" on tap from
    //     the phone (the wire round-trip succeeds, the desktop sees
    //     the change, but the phone's render is never invalidated).
    this._onChange = () => this._syncFromStore();
    this._onControl = (ev) => {
      const id = ev.detail;
      const t = this.track;
      if (!t || !id) return;
      if (id === t.gain?.id) {
        // Update the @state-tracked dB so the fader cap moves.
        this._syncFromStore();
      } else if (
        id === t.mute?.id
        || id === t.solo?.id
        || id === t.record_arm?.id
      ) {
        // Plain re-render — chip CSS branches on store.get() at
        // render time, no separate state to mirror.
        this.requestUpdate();
      }
    };
    const store = window.__foyer?.store;
    store?.addEventListener("change", this._onChange);
    store?.addEventListener("control", this._onControl);
    store?.addEventListener("track-browser-sources", this._onPeerSrcs);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onIngressEnv);
    // Repaint the Take chip when ANY surface (this row, the phone
    // sheet, the desktop strip) flips a mic in/out of the shared
    // registry — the registry sits on globalThis, but state changes
    // need an explicit nudge to invalidate render.
    this._unsubTrackMic = onTrackMicChange(() => this.requestUpdate());
    this._syncFromStore();
    const ro = !isAllowed("control_set");
    this.toggleAttribute("readonly", ro);
  }
  disconnectedCallback() {
    const store = window.__foyer?.store;
    store?.removeEventListener("change", this._onChange);
    store?.removeEventListener("control", this._onControl);
    store?.removeEventListener("track-browser-sources", this._onPeerSrcs);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onIngressEnv);
    this._unsubTrackMic?.();
    this._unsubTrackMic = null;
    super.disconnectedCallback();
  }

  updated(changed) {
    super.updated?.(changed);
    if (changed.has("track")) this._syncFromStore();
  }

  _syncFromStore() {
    const t = this.track;
    if (!t?.gain?.id) return;
    const v = window.__foyer?.store?.get?.(t.gain.id);
    const num = Number(v);
    if (Number.isFinite(num)) this._gainDb = num;
  }

  _setBool(id, v) {
    if (!id) return;
    if (!isAllowed("control_set")) return;
    window.__foyer?.ws?.controlSet(id, v ? 1 : 0);
  }

  _onFaderInput = (ev) => {
    const db = ev.detail?.db;
    this._gainDb = db;
    if (!this.track?.gain?.id) return;
    if (!isAllowed("control_set")) return;
    window.__foyer?.ws?.controlSet(this.track.gain.id, db);
  };

  _isTakeActive() {
    return isTrackMicActive(this.track?.id);
  }

  /// Tap handler for the Take ("I") chip. Bundled source-user + mic
  /// + input-port toggle, shared with the desktop's strip Take button
  /// via `foyer-core/audio/track-mic.js` so both surfaces drive the
  /// same registry and ordering.
  _toggleTake = async () => {
    const t = this.track;
    if (!t?.id) return;
    if (this._takeBusy) return;
    this._takeBusy = true;
    try {
      await toggleTrackTake({
        trackId: t.id,
        ws: window.__foyer?.ws,
        store: window.__foyer?.store,
      });
    } finally {
      this._takeBusy = false;
      this.requestUpdate();
    }
  };

  _openAdvanced = () => {
    if (!this.track?.id) return;
    // Bubble up to the app shell, which owns the modal singleton —
    // we don't keep one sheet per track-row in the DOM (memory + a
    // pile of sheet event listeners that all want to close on
    // backdrop tap).
    this.dispatchEvent(new CustomEvent("open-track-advanced", {
      detail: { trackId: this.track.id },
      bubbles: true,
      composed: true,
    }));
  };

  render() {
    const t = this.track;
    if (!t) return html``;
    const rec  = !!Number(window.__foyer?.store?.get?.(t.record_arm?.id));
    const solo = !!Number(window.__foyer?.store?.get?.(t.solo?.id));
    const mute = !!Number(window.__foyer?.store?.get?.(t.mute?.id));
    const canControl = isAllowed("control_set");
    const armable = !!t.record_arm?.id;
    // Take chip is gated on tunnel + audio kind. Tunnel because the
    // host already has the studio interface — pulling their mic in
    // through the browser would just add latency. Audio because MIDI
    // tracks don't take audio input from the browser (they'd want a
    // separate "send my MIDI" gesture, which lives on the keyboard
    // panel, not here).
    const isTunnel = !!window.__foyer?.store?.state?.rbac?.isTunnel;
    const isAudio = t.kind === "audio";
    const showTake = isTunnel && isAudio;
    const takeOn = this._isTakeActive();
    const fmtDb = (db) => {
      if (db <= -60) return "−∞";
      const sign = db > 0 ? "+" : (db < 0 ? "−" : "");
      return `${sign}${Math.abs(db).toFixed(1)}`;
    };
    return html`
      <div class="head">
        <button class="chip rec ${rec ? "on" : ""} ${(!armable || !canControl) ? "disabled" : ""}"
                title="Arm for record"
                @click=${() => this._setBool(t.record_arm?.id, !rec)}>R</button>
        <button class="chip solo ${solo ? "on" : ""} ${!canControl ? "disabled" : ""}"
                title="Solo"
                @click=${() => this._setBool(t.solo?.id, !solo)}>S</button>
        <button class="chip mute ${mute ? "on" : ""} ${!canControl ? "disabled" : ""}"
                title="Mute"
                @click=${() => this._setBool(t.mute?.id, !mute)}>M</button>
        ${showTake ? html`
          <button class="chip take ${takeOn ? "on" : ""} ${this._takeBusy ? "busy" : ""} ${!canControl ? "disabled" : ""}"
                  title=${takeOn
                    ? "Stop my mic and release this track"
                    : "Claim this track for my mic — assigns source user + opens browser ingress"}
                  @click=${this._toggleTake}>I</button>
        ` : null}
        <span class="name">${t.name || "(unnamed)"}</span>
        <button class="more"
                title="Advanced — bypass plugins, routing, monitor mode"
                @click=${this._openAdvanced}>${icon("ellipsis-vertical", 16)}</button>
      </div>
      <div class="gainline">
        <foyer-phone-hfader
          .value=${dbToNorm(this._gainDb)}
          @input=${this._onFaderInput}
        ></foyer-phone-hfader>
        <span class="db">${fmtDb(this._gainDb)} dB</span>
      </div>
    `;
  }
}
customElements.define("foyer-phone-track-row", PhoneTrackRow);
