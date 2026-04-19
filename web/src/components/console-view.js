// Tail of the DAW's stdout/stderr (captured by foyer-cli when it
// spawns Ardour/hardour — see `daw_log_path()` in foyer-cli). Polls
// `GET /console?since=<offset>` on the sidecar and appends new bytes.
// Auto-scrolls unless the user has scrolled up, matching the usual
// dev-tools / xterm convention.
//
// One-file-and-done scope: monospace terminal, no ANSI parsing, clear
// + pause + copy buttons. Good enough to see "protocol X not found"
// and "Falling back to Reasonable Synth" when a session misbehaves.

import { LitElement, html, css } from "lit";

import { icon } from "../icons.js";

const POLL_MS = 500;

export class ConsoleView extends LitElement {
  static properties = {
    _text:    { state: true, type: String },
    _size:    { state: true, type: Number },
    _path:    { state: true, type: String },
    _missing: { state: true, type: Boolean },
    _paused:  { state: true, type: Boolean },
    _follow:  { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
      background: var(--color-surface);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      font-size: 11px;
      color: var(--color-text-muted);
    }
    .toolbar .path {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text);
      opacity: 0.6;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar .spacer { flex: 1; }
    .toolbar button {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 10px;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      cursor: pointer;
    }
    .toolbar button:hover { color: var(--color-text); border-color: var(--color-accent); }
    .toolbar button.on {
      color: var(--color-accent-3);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .body {
      flex: 1;
      overflow: auto;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.45;
      color: var(--color-text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .body .error   { color: var(--color-danger); }
    .body .warning { color: var(--color-warning); }
    .body .info    { color: var(--color-accent-3); }
    .empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 12px;
    }
  `;

  constructor() {
    super();
    this._text = "";
    this._size = 0;
    this._path = "";
    this._missing = false;
    this._paused = false;
    this._follow = true;
    this._since = 0;
    this._pollTimer = null;
    this._onScroll = () => this._checkFollow();
  }

  connectedCallback() {
    super.connectedCallback();
    this._kickPoll();
  }
  disconnectedCallback() {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    super.disconnectedCallback();
  }

  updated() {
    const body = this.renderRoot.querySelector(".body");
    if (body && this._follow) body.scrollTop = body.scrollHeight;
    if (body && !body._scrollHooked) {
      body.addEventListener("scroll", this._onScroll);
      body._scrollHooked = true;
    }
  }

  _checkFollow() {
    const body = this.renderRoot.querySelector(".body");
    if (!body) return;
    const bottom = body.scrollHeight - body.clientHeight - body.scrollTop;
    // Sticky follow when the user is within ~32px of the bottom.
    this._follow = bottom < 32;
  }

  _kickPoll() {
    this._poll();
  }

  async _poll() {
    if (!this._paused) {
      try {
        const resp = await fetch(`/console?since=${this._since}`);
        if (resp.ok) {
          const j = await resp.json();
          this._path = j.path || "";
          this._missing = !!j.missing;
          this._size = j.size || 0;
          // If the log got truncated / rotated, the reported `size` will
          // be smaller than our running `since`. Reset + refetch from 0.
          if (j.size < this._since) {
            this._since = 0;
            this._text = "";
            this._schedule();
            return;
          }
          if (j.chunk) {
            this._text = (this._text + j.chunk).slice(-256 * 1024);
            this._since = j.next_since;
          }
        }
      } catch { /* ignore network blips — next tick retries */ }
    }
    this._schedule();
  }

  _schedule() {
    this._pollTimer = setTimeout(() => this._poll(), POLL_MS);
  }

  _togglePause() { this._paused = !this._paused; }
  _clear() {
    this._text = "";
    this._follow = true;
    const body = this.renderRoot.querySelector(".body");
    if (body) body.scrollTop = body.scrollHeight;
  }
  _jumpToBottom() {
    this._follow = true;
    const body = this.renderRoot.querySelector(".body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  render() {
    return html`
      <div class="toolbar">
        <span>DAW console</span>
        <span class="path" title=${this._path}>${this._path}</span>
        <span class="spacer"></span>
        <button
          class=${this._paused ? "on" : ""}
          title=${this._paused ? "Resume polling" : "Pause polling"}
          @click=${this._togglePause}
        >
          ${icon(this._paused ? "play" : "stop", 11)}
          ${this._paused ? "Paused" : "Live"}
        </button>
        <button
          class=${this._follow ? "on" : ""}
          title="Jump to tail (sticky while near the bottom)"
          @click=${this._jumpToBottom}
        >${icon("chevron-down", 11)} Tail</button>
        <button title="Clear the local buffer (doesn't truncate the file)"
                @click=${this._clear}>Clear</button>
      </div>
      <div class="body">${this._missing
        ? html`<div class="empty">
            No DAW output yet. The console streams from
            <code>${this._path || "daw.log"}</code> — once a project is
            opened, Ardour's stdout/stderr will show up here.
          </div>`
        : this._renderText()}</div>
    `;
  }

  _renderText() {
    if (!this._text) return html`<div class="empty">Waiting for output…</div>`;
    // Coarse tone-color pass: whole line classed by whichever marker
    // it contains first. Good enough to spot [ERROR] / [WARNING] at a
    // glance without an ANSI parser.
    const lines = this._text.split("\n");
    return lines.map((line, i) => {
      let cls = "";
      if (/\[ERROR\]/i.test(line)) cls = "error";
      else if (/\[WARNING\]|WARN/i.test(line)) cls = "warning";
      else if (/^foyer:/.test(line)) cls = "info";
      return html`<span class=${cls}>${line}${i < lines.length - 1 ? "\n" : ""}</span>`;
    });
  }
}
customElements.define("foyer-console-view", ConsoleView);
