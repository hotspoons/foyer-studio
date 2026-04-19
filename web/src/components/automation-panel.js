// Automation script editor — AHK-flavored.
//
// Small modal panel with a textarea, save-and-activate button, and a live
// list of registered hotkeys + any parse errors. Persists to localStorage
// under `foyer.automation.v1`.
//
// Open via the command palette, menu, or automation FAB (to be added).
// Close with Escape or click-outside.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";
import { parseScript, comboToString } from "../automation/parser.js";
import { install as installAutomation, activeHotkeys } from "../automation/runtime.js";

const KEY = "foyer.automation.v1";

export const DEFAULT_SCRIPT = `; Foyer Studio — AHK-flavored automation
; Press the bound combo to fire each command. Examples:

^!p::Action transport.play
^!s::Action transport.stop
^!r::Action transport.record

; Layout presets
^!1::Layout mixer
^!2::Layout timeline
^!3::Layout mixer-left-timeline-right
^!0::Layout everything

; Float a view to a slot
^!e::Float plugins, right-third

; Multi-step block:
^!F1::
    ControlSet transport.tempo, 120
    Sleep 150
    Msg "Tempo reset to 120"
Return

; Theme cycle
^!t::Theme dim
`;

function loadScript() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null || raw === undefined) return DEFAULT_SCRIPT;
    return raw;
  } catch { return DEFAULT_SCRIPT; }
}
function saveScript(s) {
  try { localStorage.setItem(KEY, s); } catch {}
}

export class AutomationPanel extends LitElement {
  static properties = {
    _open: { state: true, type: Boolean },
    _text: { state: true, type: String },
    _status: { state: true, type: Object }, // { installed, errors }
  };

  static styles = css`
    :host { display: contents; }
    .scrim {
      position: fixed; inset: 0;
      background: rgba(2, 6, 23, 0.55);
      backdrop-filter: blur(3px);
      z-index: 1200;
      display: flex; align-items: center; justify-content: center;
    }
    .modal {
      width: min(880px, 92vw);
      max-height: 86vh;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
      color: var(--color-text);
      font-family: var(--font-sans);
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    header .title {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 700;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header .hint { font-size: 10px; color: var(--color-text-muted); }
    header .spacer { flex: 1; }
    header button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      font-size: 10px;
      font-family: var(--font-sans);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-accent); }
    header button.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    .split {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }
    textarea {
      flex: 1 1 auto;
      resize: none;
      padding: 12px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      background: var(--color-surface);
      color: var(--color-text);
      border: 0;
      outline: none;
      min-width: 0;
      tab-size: 4;
    }
    aside {
      flex: 0 0 260px;
      border-left: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 12px 14px;
      overflow: auto;
      font-size: 11px;
    }
    aside h3 {
      margin: 0 0 6px;
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      font-weight: 600;
    }
    aside .row {
      display: flex;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px dashed color-mix(in oklab, var(--color-border) 40%, transparent);
    }
    aside .row:last-child { border-bottom: 0; }
    aside .combo {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-accent-3);
      flex: 0 0 80px;
    }
    aside .summary {
      font-size: 10px;
      color: var(--color-text);
      min-width: 0;
      word-break: break-word;
    }
    aside .err {
      color: var(--color-danger);
      font-size: 10px;
      margin-top: 4px;
    }
    aside .empty { color: var(--color-text-muted); font-style: italic; font-size: 10px; }
  `;

  constructor() {
    super();
    this._open = false;
    this._text = loadScript();
    this._status = { installed: activeHotkeys().length, errors: [] };
    this._onKey = (ev) => {
      // Global open/close toggle: Ctrl+Alt+A.
      if (ev.ctrlKey && ev.altKey && !ev.shiftKey && !ev.metaKey
          && (ev.key === "a" || ev.key === "A")) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.toggle();
        return;
      }
      if (!this._open) return;
      if (ev.key === "Escape") { ev.preventDefault(); this.close(); }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "s") {
        ev.preventDefault();
        this._apply();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onKey, true);
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    super.disconnectedCallback();
  }

  open() { this._open = true; }
  close() { this._open = false; }
  toggle() { this._open = !this._open; }

  render() {
    if (!this._open) return html``;
    const errs = this._status.errors || [];
    return html`
      <div class="scrim" @click=${(e) => { if (e.target === e.currentTarget) this.close(); }}>
        <div class="modal" @click=${(e) => e.stopPropagation()}>
          <header>
            <div class="title">Automation</div>
            <div class="hint">AHK-flavored scripts · Ctrl+S to apply · Esc to close</div>
            <span class="spacer"></span>
            <button @click=${this._reset} title="Restore the built-in example script">Reset</button>
            <button class="primary" @click=${this._apply} title="Save + install">
              Apply
            </button>
            <button @click=${this.close} title="Close">
              ${icon("x-mark", 12)}
            </button>
          </header>
          <div class="split">
            <textarea
              spellcheck="false"
              .value=${this._text}
              @input=${(e) => { this._text = e.target.value; }}
            ></textarea>
            <aside>
              <h3>Active hotkeys</h3>
              ${activeHotkeys().length === 0
                ? html`<div class="empty">None installed yet.</div>`
                : activeHotkeys().map(
                    (h) => html`
                      <div class="row">
                        <span class="combo">${h.combo}</span>
                        <span class="summary">${h.summary}</span>
                      </div>
                    `
                  )}
              ${errs.length
                ? html`
                    <h3 style="margin-top:14px">Errors</h3>
                    ${errs.map(
                      (e) => html`<div class="err">line ${e.line}: ${e.message}</div>`
                    )}
                  `
                : null}
            </aside>
          </div>
        </div>
      </div>
    `;
  }

  _apply() {
    const ast = parseScript(this._text);
    saveScript(this._text);
    const summary = installAutomation(ast);
    this._status = { installed: summary.installed, errors: ast.errors };
    this.requestUpdate();
  }

  _reset() {
    this._text = DEFAULT_SCRIPT;
    this.requestUpdate();
  }
}
customElements.define("foyer-automation-panel", AutomationPanel);

/** Boot-time: install whatever script the user has saved. */
export function bootAutomation() {
  const text = loadScript();
  const ast = parseScript(text);
  installAutomation(ast);
  return { ast, text };
}
