// Sprunki preferences modal — per-category instrument + GM-program
// picker. Saves selections to `sprunkiStore`; the app shell
// re-provisions the affected category track when prefs change.
//
// Intentionally simple compared to Foyer's full plugin-picker:
//   * The instrument picker is a small fixed list of GM-compatible
//     synths (gmsynth, fluidsynth-style, drumkv1) — enough to swap
//     the drum kit for a real one when the container ships
//     drumkv1, without exposing the 800-plugin LV2 catalog.
//   * The preset picker is the curated `GM_PRESETS[category]` list.
//   * A "Restore defaults" button per category and a "Clear all
//     boards" button for a full reset.

import { LitElement, html, css } from "lit";
import { CATEGORIES, GM_PRESETS } from "./sound-catalog.js";
import { sprunkiStore, resetSprunkiStore } from "../state-store.js";

const INSTRUMENTS = [
  // Stable across modern Ardour installs; the Foyer container
  // bundles an LV2 set anchored on these.
  { uri: "gmsynth",       label: "GM Synth (Ardour stock)" },
  { uri: "drumkv1",       label: "drumkv1 (sampled drum kit)" },
  { uri: "fluidsynth",    label: "Fluidsynth (SoundFont)" },
  { uri: "synthv1",       label: "synthv1 (analog synth)" },
];

export class SprunkiPreferencesModal extends LitElement {
  static properties = {
    _rev: { type: Number, state: true },
  };
  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.78);
      z-index: 9999;
      font-family: system-ui, sans-serif;
      color: #e5e8ee;
    }
    .panel {
      width: min(640px, 92vw);
      max-height: 88vh;
      overflow-y: auto;
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 10px;
      padding: 18px 22px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.5);
    }
    h2 { margin: 0 0 8px 0; font-size: 17px; }
    .sub { color: #8a93a3; font-size: 12px; margin-bottom: 16px; }
    .cat-block {
      display: grid;
      grid-template-columns: 96px 1fr 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 10px 0;
      border-top: 1px solid #1f2630;
    }
    .cat-block:first-of-type { border-top: 0; }
    .cat-label { font-weight: 600; font-size: 13px; }
    select {
      background: #0e1116; color: #e5e8ee;
      border: 1px solid #2a3140; border-radius: 4px;
      padding: 5px 7px; font: inherit; font-size: 12px;
      width: 100%;
    }
    .row-actions { display: flex; gap: 6px; }
    button {
      background: #1f262f; color: #e5e8ee;
      border: 1px solid #2a3140; border-radius: 5px;
      padding: 5px 10px; font: inherit; font-size: 12px;
      cursor: pointer;
    }
    button:hover { background: #283040; border-color: #6c8cff; }
    .footer {
      display: flex; justify-content: space-between;
      margin-top: 16px; padding-top: 12px;
      border-top: 1px solid #1f2630;
    }
    button.danger { background: #3a1d24; border-color: #5a2731; color: #ffb4be; }
    button.primary { background: #6c8cff; border-color: #6c8cff; color: #0e1116; font-weight: 600; }

    .kid-safety {
      background: rgba(108, 140, 255, 0.06);
      border: 1px solid rgba(108, 140, 255, 0.25);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 14px;
    }
    .kid-safety-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 0;
    }
    .kid-safety-row + .kid-safety-row {
      border-top: 1px solid rgba(108, 140, 255, 0.15);
      margin-top: 4px;
      padding-top: 8px;
    }
    .ks-label { font-size: 13px; font-weight: 600; }
    .ks-sub { font-size: 11px; color: #8a93a3; margin-top: 2px; }
    .ks-toggle {
      background: #1f262f; color: #e5e8ee;
      border: 1px solid #2a3140; border-radius: 5px;
      padding: 5px 14px; font: inherit; font-size: 12px;
      cursor: pointer;
      min-width: 70px;
    }
    .ks-toggle.on {
      background: #fb7185;
      border-color: #fb7185;
      color: #0e1116;
      font-weight: 600;
    }
  `;

  constructor() {
    super();
    this._rev = 0;
    this._store = sprunkiStore();
    this._onChange = () => { this._rev++; this.requestUpdate(); };
  }
  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("prefs-changed", this._onChange);
    this._store.addEventListener("parental-changed", this._onChange);
    this._store.addEventListener("scary-mode-changed", this._onChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("prefs-changed", this._onChange);
    this._store.removeEventListener("parental-changed", this._onChange);
    this._store.removeEventListener("scary-mode-changed", this._onChange);
  }

  _requestParentalGate() {
    this.dispatchEvent(
      new CustomEvent("request-parental-gate", { bubbles: true, composed: true })
    );
  }
  _toggleScaryMode() {
    if (!this._store.parentalUnlocked) {
      this._requestParentalGate();
      return;
    }
    const ok = this._store.setScaryMode(!this._store.scaryMode);
    if (!ok) this._requestParentalGate();
  }
  _lockNow() {
    this._store.clearParentalUnlock();
    // Flipping back to safe mode whenever we lock — otherwise the
    // kid could re-open the app and find scary content still live
    // until the unlock timer expired on its own.
    this._store.setScaryMode(false);
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
  _setInstrument(catId, uri) {
    this._store.setPrefs(catId, { instrument_uri: uri });
  }
  _setProgram(catId, programStr) {
    this._store.setPrefs(catId, { gm_program: parseInt(programStr, 10) || 0 });
  }
  _restoreDefaults(cat) {
    this._store.setPrefs(cat.id, {
      instrument_uri: cat.default_instrument_uri,
      gm_program: cat.default_gm_program,
    });
  }
  _clearAll() {
    if (confirm("Clear all boards, prefs, and re-provision tracks?")) {
      resetSprunkiStore();
      location.reload();
    }
  }

  render() {
    const unlocked = this._store.parentalUnlocked;
    const scaryOn = this._store.scaryMode;
    return html`
      <div class="panel" @click=${(e) => e.stopPropagation()}>
        <h2>Sprunki preferences</h2>
        <div class="sub">
          Pick the synth + patch for each character group. Changes
          re-provision the relevant track on the backend; your
          beat patterns stay put.
        </div>
        <div class="kid-safety">
          <div class="kid-safety-row">
            <div>
              <div class="ks-label">Scary characters</div>
              <div class="ks-sub">
                ${scaryOn
                  ? "Visible. Switch off to hide horror-mode sprunkis."
                  : "Hidden — only friendly characters show up on the board."}
              </div>
            </div>
            <button
              class="ks-toggle ${scaryOn ? "on" : ""}"
              @click=${this._toggleScaryMode}
              title="${unlocked
                ? "Toggle scary content"
                : "Solve the adult quiz to change this"}"
            >${scaryOn ? "On" : "Off"}</button>
          </div>
          <div class="kid-safety-row">
            <div>
              <div class="ks-label">Adult unlock</div>
              <div class="ks-sub">
                ${unlocked
                  ? "Unlocked for this session."
                  : "Quiz required to change scary-mode or open the full plugin catalog."}
              </div>
            </div>
            ${unlocked
              ? html`<button class="ks-toggle" @click=${this._lockNow}>Lock now</button>`
              : html`<button class="ks-toggle" @click=${this._requestParentalGate}>Unlock…</button>`}
          </div>
        </div>
        ${CATEGORIES.map((cat) => {
          const prefs = this._store.prefsFor(cat.id);
          const presets = GM_PRESETS[cat.id] || [];
          return html`
            <div class="cat-block">
              <div class="cat-label">${cat.label}</div>
              <select
                title="Instrument plugin (gmsynth is the safe default; others may not be installed in every container)"
                @change=${(e) => this._setInstrument(cat.id, e.currentTarget.value)}
              >
                ${INSTRUMENTS.map((i) => html`
                  <option value=${i.uri} ?selected=${prefs.instrument_uri === i.uri}>${i.label}</option>
                `)}
              </select>
              <select
                title="GM patch / program"
                @change=${(e) => this._setProgram(cat.id, e.currentTarget.value)}
              >
                ${presets.length === 0
                  ? html`<option value="0" selected>Default kit</option>`
                  : presets.map((p) => html`
                      <option value=${p.program} ?selected=${prefs.gm_program === p.program}>${p.label}</option>
                    `)}
              </select>
              <div class="row-actions">
                <button title="Restore the built-in default for this group" @click=${() => this._restoreDefaults(cat)}>Reset</button>
              </div>
            </div>
          `;
        })}
        <div class="footer">
          <button class="danger" @click=${this._clearAll}>Clear all boards + reset</button>
          <button class="primary" @click=${this._close}>Done</button>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-preferences-modal", SprunkiPreferencesModal);
