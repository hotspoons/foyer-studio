// Phone app shell. Three states + a sheet:
//
//   ┌──────────────────────┐
//   │ TOP BAR              │  always visible
//   ├──────────────────────┤
//   │ TRANSPORT            │  visible when a session is open
//   ├──────────────────────┤
//   │ TRACK LIST (scroll)  │  visible when a session is open
//   └──────────────────────┘
//
// When no session is open the body collapses to a full-bleed welcome
// panel — passive "waiting for host" if the role can't launch, or a
// recents/open-sessions list rendered inline (the same component the
// session sheet uses) if it can.
//
// All store/ws/audio infrastructure is shared with ui-full — we just
// paint differently against the same reactive state.

import { LitElement, html, css } from "lit";
import { isAllowed, onRbacChange } from "foyer-core/rbac.js";

import "./components/top-bar.js";
import "./components/transport.js";
import "./components/track-row.js";
import "./components/session-sheet.js";
import "./components/track-advanced-sheet.js";
// Chat FAB + push-to-talk panel — same component the desktop UI uses,
// promoted to ui-core so both variants share it. The FAB is draggable
// and clamps to the viewport, so a phone screen gets the same
// quadrant-anchored panel a desktop does.
import "foyer-ui-core/chat-panel.js";

export class PhoneApp extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
    _sheetOpen: { state: true, type: Boolean },
    _advancedTrackId: { state: true, type: String },
    _rbacTick: { state: true, type: Number },
    _audioOn: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      /* Use the small viewport height when available (iOS Safari)
       * so address-bar collapse doesn't clip our last track row. */
      height: 100svh;
      background: var(--color-bg, #0b1120);
      color: var(--color-text);
      font-family: var(--font-sans);
      overscroll-behavior: contain;
    }
    main {
      flex: 1;
      display: flex; flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }
    .tracks {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* Welcome / empty state — same vertical centering for both
     * "waiting" and "tap to open" variants. */
    .welcome {
      flex: 1;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 32px 24px;
      text-align: center;
      gap: 16px;
    }
    .welcome h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: 0.02em;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .welcome p {
      margin: 0;
      color: var(--color-text-muted);
      font-size: 13px;
      line-height: 1.5;
      max-width: 28em;
    }
    .welcome .cta {
      margin-top: 8px;
      padding: 14px 28px;
      border: 0; border-radius: 12px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      font: inherit; font-size: 14px; font-weight: 700;
      letter-spacing: 0.04em;
      cursor: pointer;
    }
    .welcome .cta:active { transform: scale(0.97); }
    .empty-tracks {
      padding: 24px 16px;
      color: var(--color-text-muted);
      font-size: 12px;
      text-align: center;
    }
    /* Tunnel-mode audio prompt. The controller has a saved/forced
     * "tunnel = listen on" rule, but Chrome's autoplay policy refuses
     * to start an AudioContext outside a user-gesture call stack —
     * the bare Listen-button-tap path is too easy to miss on a phone
     * screen and the cold-boot flow has produced "audio just doesn't
     * come on" complaints. This prompt is a giant unambiguous tap
     * target that fires the gesture-bound audio toggle directly,
     * dismisses itself on success, and only renders for tunnel guests
     * who haven't yet enabled audio. */
    .tunnel-audio-prompt {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 14px 18px;
      margin: 8px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.04em;
      box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      cursor: pointer;
      animation: foyer-tap-pulse 1.6s ease-in-out infinite;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .tunnel-audio-prompt:active { transform: scale(0.98); }
    @keyframes foyer-tap-pulse {
      0%, 100% { box-shadow: 0 6px 24px rgba(0,0,0,0.35), 0 0 0 0 color-mix(in oklab, var(--color-accent) 60%, transparent); }
      50%      { box-shadow: 0 6px 24px rgba(0,0,0,0.35), 0 0 0 14px transparent; }
    }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._sheetOpen = false;
    this._advancedTrackId = "";
    this._rbacTick = 0;
    this._audioOn = !!window.__foyer?.audio?.isOn?.();
    this._onChange = () => { this._tick++; };
    this._onAudio = () => { this._audioOn = !!window.__foyer?.audio?.isOn?.(); };
    this._offRbac = null;
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    store?.addEventListener("change", this._onChange);
    store?.addEventListener("sessions", this._onChange);
    window.__foyer?.audio?.addEventListener?.("change", this._onAudio);
    this._offRbac = onRbacChange(() => { this._rbacTick++; });
  }
  disconnectedCallback() {
    const store = window.__foyer?.store;
    store?.removeEventListener("change", this._onChange);
    store?.removeEventListener("sessions", this._onChange);
    window.__foyer?.audio?.removeEventListener?.("change", this._onAudio);
    this._offRbac?.();
    super.disconnectedCallback();
  }

  _onTunnelAudioPromptTap = async () => {
    try { await window.__foyer?.audio?.toggle?.(); }
    catch (e) { console.error("[phone] tunnel audio prompt: toggle failed", e); }
  };

  _onOpenSheet = () => { this._sheetOpen = true; };
  _onCloseSheet = () => { this._sheetOpen = false; };
  _onOpenTrackAdvanced = (ev) => {
    const id = ev?.detail?.trackId;
    if (id) this._advancedTrackId = id;
  };
  _onCloseTrackAdvanced = () => { this._advancedTrackId = ""; };

  render() {
    void this._tick; void this._rbacTick;
    const session = window.__foyer?.store?.state?.session || null;
    const cur = window.__foyer?.store?.currentSession?.();
    const tracks = (session?.tracks || []).filter((t) => t && t.id);
    const hasSession = !!cur;
    const canLaunch = isAllowed("launch_project");
    const isTunnel = !!window.__foyer?.store?.state?.rbac?.isTunnel;
    const showAudioPrompt = isTunnel && hasSession && !this._audioOn;
    return html`
      <foyer-phone-top-bar @open-sheet=${this._onOpenSheet}></foyer-phone-top-bar>
      ${showAudioPrompt ? html`
        <div class="tunnel-audio-prompt"
             role="button"
             aria-label="Tap to enable audio"
             data-foyer-listen-toggle="1"
             @click=${this._onTunnelAudioPromptTap}>
          Tap to enable audio
        </div>
      ` : null}
      <main @open-track-advanced=${this._onOpenTrackAdvanced}>
        ${hasSession
          ? html`
              <foyer-phone-transport></foyer-phone-transport>
              <div class="tracks">
                ${tracks.length === 0
                  ? html`<div class="empty-tracks">This session has no tracks yet.</div>`
                  : tracks.map((t) => html`
                      <foyer-phone-track-row .track=${t}></foyer-phone-track-row>
                    `)}
              </div>
            `
          : html`
              <div class="welcome">
                <h1>Foyer</h1>
                ${canLaunch
                  ? html`
                      <p>
                        Pick a project to open, or join a session the host has
                        already started.
                      </p>
                      <button class="cta" @click=${this._onOpenSheet}>
                        Pick a session
                      </button>
                    `
                  : html`
                      <p>
                        Waiting for the host to open a session. Once they do,
                        this screen will switch to the transport.
                      </p>
                    `}
              </div>
            `}
      </main>
      <foyer-phone-session-sheet
        ?open=${this._sheetOpen}
        @close=${this._onCloseSheet}
      ></foyer-phone-session-sheet>
      <foyer-phone-track-advanced-sheet
        ?open=${!!this._advancedTrackId}
        .trackId=${this._advancedTrackId}
        @close=${this._onCloseTrackAdvanced}
      ></foyer-phone-track-advanced-sheet>
      <!--
        Chat / PTT FAB. The panel binds its drag bounds to
        window.innerWidth/innerHeight so it shrinks to fit a phone
        viewport on its own; we just need it in the DOM.
      -->
      <foyer-chat-panel></foyer-chat-panel>
    `;
  }
}
customElements.define("foyer-phone-app", PhoneApp);
