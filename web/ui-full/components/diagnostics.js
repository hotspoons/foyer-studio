// Dev-only diagnostics panel. Calls the sidecar's `/dev/run-tests`
// endpoint (requires `FOYER_DEV=1` at server launch) and renders a
// per-probe pass/fail list.
//
// The same endpoint is reachable via `curl` from the shell, so Claude
// (or anyone) can run regressions without opening the browser. This
// panel is mostly a visual affordance for the human reviewer.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

export class DiagnosticsView extends LitElement {
  static properties = {
    _probes:  { state: true, type: Array },
    _results: { state: true, type: Array },
    _running: { state: true, type: Boolean },
    _disabled: { state: true, type: Boolean },
    _error: { state: true, type: String },
    _selected: { state: true, type: Object }, // Set<id>
  };

  static styles = css`
    ${scrollbarStyles}
    :host {
      display: flex; flex-direction: column;
      height: 100%;
      font-family: var(--font-sans);
      color: var(--color-text);
      background: transparent;
    }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .title { font-weight: 600; font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; }
    .count { color: var(--color-text-muted); font-size: 11px; }
    .spacer { flex: 1; }
    button {
      font-family: var(--font-sans);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 3px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    button:hover { border-color: var(--color-accent); color: var(--color-accent); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.primary {
      background: color-mix(in oklab, var(--color-accent) 25%, var(--color-surface));
      border-color: var(--color-accent);
    }
    .scroll {
      flex: 1; overflow: auto;
      padding: 8px 12px;
    }
    .row {
      display: grid;
      grid-template-columns: 24px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--color-border);
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .row:hover { background: var(--color-surface-elevated); }
    .row.selected { background: color-mix(in oklab, var(--color-accent) 10%, var(--color-surface)); }
    .status { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
    .status.pass { color: var(--color-success, #5cd188); background: color-mix(in oklab, var(--color-success, #5cd188) 18%, transparent); }
    .status.fail { color: var(--color-danger, #d04040); background: color-mix(in oklab, var(--color-danger, #d04040) 22%, transparent); }
    .status.idle { color: var(--color-text-muted); }
    .status.running { color: var(--color-accent); animation: spin 0.9s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .probe-id { font-family: var(--font-mono); font-size: 11px; color: var(--color-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .probe-desc { font-size: 11px; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .probe-detail { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); margin-top: 2px; word-break: break-all; }
    .probe-detail.fail { color: color-mix(in oklab, var(--color-danger, #d04040) 80%, var(--color-text-muted)); }
    .elapsed { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); text-align: right; white-space: nowrap; }
    .banner {
      padding: 12px 16px;
      background: color-mix(in oklab, var(--color-warning, #d0a040) 12%, var(--color-surface));
      border-bottom: 1px solid color-mix(in oklab, var(--color-warning, #d0a040) 40%, var(--color-border));
      font-size: 11px;
      color: var(--color-text);
    }
    .banner code { font-family: var(--font-mono); background: var(--color-surface); padding: 1px 4px; border-radius: 2px; }
    .summary {
      display: flex; gap: 12px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 11px;
    }
    .summary .pill {
      padding: 2px 8px;
      border-radius: 10px;
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .summary .pill.pass { color: var(--color-success, #5cd188); background: color-mix(in oklab, var(--color-success, #5cd188) 14%, transparent); }
    .summary .pill.fail { color: var(--color-danger, #d04040);  background: color-mix(in oklab, var(--color-danger, #d04040) 16%, transparent); }
  `;

  constructor() {
    super();
    this._probes = [];
    this._results = [];
    this._running = false;
    this._disabled = false;
    this._error = "";
    this._selected = new Set();
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadProbes();
  }

  async _loadProbes() {
    try {
      const res = await fetch("/dev/list-tests");
      if (res.status === 404) {
        this._disabled = true;
        return;
      }
      const body = await res.json();
      this._probes = body.probes || [];
    } catch (e) {
      this._error = String(e);
    }
  }

  async _runAll() {
    this._run("");
  }
  async _runSelected() {
    if (!this._selected.size) return this._runAll();
    this._run(Array.from(this._selected).join(","));
  }
  async _run(idsParam) {
    if (this._running) return;
    this._running = true;
    this._error = "";
    try {
      const res = await fetch(
        idsParam ? `/dev/run-tests?ids=${encodeURIComponent(idsParam)}` : "/dev/run-tests",
      );
      const body = await res.json();
      // Merge: keep prior results for probes not in this run so the
      // visual state isn't wiped when the user runs a subset.
      const byId = new Map(this._results.map((r) => [r.id, r]));
      for (const r of body.results) byId.set(r.id, r);
      this._results = Array.from(byId.values());
    } catch (e) {
      this._error = String(e);
    } finally {
      this._running = false;
    }
  }

  _toggleSelected(id) {
    const s = new Set(this._selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this._selected = s;
  }

  render() {
    if (this._disabled) {
      return html`
        <div class="banner">
          Dev probes aren't mounted on this server. Restart with <code>FOYER_DEV=1 just run</code>
          to enable <code>/dev/run-tests</code>.
        </div>
      `;
    }
    const resultsById = new Map(this._results.map((r) => [r.id, r]));
    const passed = this._results.filter((r) => r.pass).length;
    const failed = this._results.length - passed;
    return html`
      <div class="toolbar">
        <span class="count">${this._probes.length} probes</span>
        <span class="spacer"></span>
        <button @click=${this._runSelected} ?disabled=${this._running}>
          Run ${this._selected.size ? `selected (${this._selected.size})` : "all"}
        </button>
        <button class="primary" @click=${this._runAll} ?disabled=${this._running}>
          ${this._running ? "Running…" : "Run all"}
        </button>
      </div>
      ${this._error ? html`<div class="banner">error: ${this._error}</div>` : null}
      <div class="scroll">
        ${this._probes.map((p) => {
          const result = resultsById.get(p.id);
          const status = this._running
            ? "running"
            : result
              ? (result.pass ? "pass" : "fail")
              : "idle";
          const statusGlyph = status === "pass" ? icon("check-circle", 16)
            : status === "fail" ? icon("x-circle", 16)
            : status === "running" ? icon("arrow-path", 16)
            : icon("ellipsis-horizontal", 16);
          const selected = this._selected.has(p.id);
          return html`
            <div class="row ${selected ? "selected" : ""}"
                 @click=${() => this._toggleSelected(p.id)}
                 title="Click to select this probe for targeted re-runs">
              <span class="status ${status}">${statusGlyph}</span>
              <div class="meta">
                <div class="probe-id">${p.id}</div>
                <div class="probe-desc">${p.description}</div>
                ${result?.detail ? html`
                  <div class="probe-detail ${result.pass ? "" : "fail"}">${result.detail}</div>
                ` : null}
              </div>
              <div class="elapsed">${result ? `${result.elapsed_ms} ms` : "—"}</div>
            </div>
          `;
        })}
      </div>
      ${this._results.length ? html`
        <div class="summary">
          <span class="pill pass">${passed} passed</span>
          ${failed ? html`<span class="pill fail">${failed} failed</span>` : null}
          <span class="spacer"></span>
        </div>
      ` : null}
    `;
  }
}
customElements.define("foyer-diagnostics", DiagnosticsView);
