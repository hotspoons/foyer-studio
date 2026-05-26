// Sprunki parental gate — a short math-quiz to confirm an adult is
// at the keyboard before flipping the scary-mode toggle or opening
// the full plugin catalog. Tuned to be solvable by anyone over ~10
// but resistant to a young kid randomly tapping numbers.
//
// The quiz is one two-digit addition + one two-digit multiplication.
// Both must be correct in the same submission; we don't tell the
// parent which one was wrong so a kid mashing the keypad can't
// converge by trial-and-error. After three wrong tries the modal
// locks for 60 s. Success calls `sprunkiStore.grantParentalUnlock()`
// which lasts 30 minutes by default.
//
// This is gentle UX, not a security boundary. A determined kid will
// still find ways around it — the goal is "the autistic 5yo can't
// accidentally end up looking at scary content", not "prevent
// determined teens from bypassing".

import { LitElement, html, css } from "lit";
import { sprunkiStore } from "../state-store.js";

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function newQuiz() {
  // Two-digit + two-digit (sum < 200); two-digit × single-digit
  // (product < 200). Calibrated so a fluent adult solves both in
  // under ~15 seconds, but a typing-only kid can't speedrun it.
  return {
    a1: randInt(11, 89),
    a2: randInt(11, 89),
    b1: randInt(11, 19),
    b2: randInt(3, 9),
  };
}

export class SprunkiParentalGateModal extends LitElement {
  static properties = {
    _quiz: { type: Object, state: true },
    _attempts: { type: Number, state: true },
    _lockedUntil: { type: Number, state: true },
    _aAns: { type: String, state: true },
    _bAns: { type: String, state: true },
    _msg: { type: String, state: true },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.82);
      z-index: 10000;
      font-family: system-ui, sans-serif;
      color: #f0f0f0;
    }
    .panel {
      width: min(420px, 92vw);
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 10px;
      padding: 22px 26px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
    }
    h2 { margin: 0 0 6px 0; font-size: 17px; }
    .sub {
      color: #8a93a3;
      font-size: 12px;
      line-height: 1.45;
      margin-bottom: 16px;
    }
    .quiz {
      display: grid;
      grid-template-columns: 1fr auto 80px;
      gap: 10px;
      align-items: center;
      margin: 10px 0;
    }
    .quiz .expr {
      font-family: ui-monospace, monospace;
      font-size: 18px;
      color: #e5e8ee;
    }
    .quiz .eq { color: #8a93a3; }
    input[type=number] {
      width: 100%;
      background: #0e1116;
      color: #e5e8ee;
      border: 1px solid #2a3140;
      border-radius: 4px;
      padding: 7px 8px;
      font: inherit;
      font-size: 16px;
      text-align: right;
      -moz-appearance: textfield;
    }
    input[type=number]::-webkit-outer-spin-button,
    input[type=number]::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .msg { font-size: 12px; min-height: 16px; color: #f87171; margin-top: 6px; }
    .msg.ok { color: #4ade80; }
    .actions {
      display: flex; justify-content: space-between; gap: 8px;
      margin-top: 14px;
    }
    button {
      background: #1f262f; color: #e5e8ee;
      border: 1px solid #2a3140; border-radius: 6px;
      padding: 8px 16px; font: inherit; font-size: 13px;
      cursor: pointer;
    }
    button.primary { background: #6c8cff; border-color: #6c8cff; color: #0e1116; font-weight: 600; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .locked { color: #fbbf24; text-align: center; padding: 12px 0; font-size: 13px; }
  `;

  constructor() {
    super();
    this._quiz = newQuiz();
    this._attempts = 0;
    this._lockedUntil = 0;
    this._aAns = "";
    this._bAns = "";
    this._msg = "";
  }

  _isLocked() {
    return this._lockedUntil > Date.now();
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _submit() {
    if (this._isLocked()) return;
    const a = parseInt(this._aAns, 10);
    const b = parseInt(this._bAns, 10);
    const correctA = this._quiz.a1 + this._quiz.a2;
    const correctB = this._quiz.b1 * this._quiz.b2;
    if (a === correctA && b === correctB) {
      sprunkiStore().grantParentalUnlock();
      this._msg = "Unlocked.";
      // Brief success state so the toast registers before we close.
      setTimeout(() => this.dispatchEvent(
        new CustomEvent("unlocked", { bubbles: true, composed: true })
      ), 350);
      return;
    }
    this._attempts++;
    if (this._attempts >= 3) {
      this._lockedUntil = Date.now() + 60_000;
      this._msg = "Too many tries — try again in a minute.";
      this.requestUpdate();
      const interval = setInterval(() => {
        this.requestUpdate();
        if (!this._isLocked()) {
          clearInterval(interval);
          this._attempts = 0;
          this._quiz = newQuiz();
          this._aAns = "";
          this._bAns = "";
          this._msg = "";
        }
      }, 1000);
    } else {
      this._msg = "Nope, try again.";
      // New quiz so a kid can't brute-force by submitting the
      // same value repeatedly.
      this._quiz = newQuiz();
      this._aAns = "";
      this._bAns = "";
    }
  }

  render() {
    const locked = this._isLocked();
    const lockSecs = locked ? Math.ceil((this._lockedUntil - Date.now()) / 1000) : 0;
    return html`
      <div class="panel" @click=${(e) => e.stopPropagation()}>
        <h2>Adult check</h2>
        <div class="sub">
          Quick math for the grown-up — this keeps the scary
          characters and the advanced controls behind a small
          speed bump. Solve both, then click <em>Unlock</em>.
        </div>
        ${locked
          ? html`<div class="locked">Locked — try again in ${lockSecs}s.</div>`
          : html`
              <div class="quiz">
                <span class="expr">${this._quiz.a1} + ${this._quiz.a2}</span>
                <span class="eq">=</span>
                <input
                  type="number" inputmode="numeric"
                  .value=${this._aAns}
                  @input=${(e) => { this._aAns = e.currentTarget.value; }}
                  autofocus
                />
              </div>
              <div class="quiz">
                <span class="expr">${this._quiz.b1} × ${this._quiz.b2}</span>
                <span class="eq">=</span>
                <input
                  type="number" inputmode="numeric"
                  .value=${this._bAns}
                  @input=${(e) => { this._bAns = e.currentTarget.value; }}
                />
              </div>
              <div class="msg ${this._msg === "Unlocked." ? "ok" : ""}">${this._msg}</div>
            `}
        <div class="actions">
          <button @click=${this._close}>Cancel</button>
          <button
            class="primary"
            ?disabled=${locked || !this._aAns || !this._bAns}
            @click=${this._submit}
          >Unlock</button>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-parental-gate-modal", SprunkiParentalGateModal);
