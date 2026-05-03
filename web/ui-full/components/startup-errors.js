// Collects server-side error events that arrive during the "startup"
// window (connect + first few seconds after a backend swap) and shows
// them in a dismissable banner. The goal isn't to show every error
// ever — just the ones that accumulate on session load (missing
// plugins, shim init warnings, etc.) so the user has ONE place to
// acknowledge them instead of being confronted with a toast storm.
//
// After dismissal, further errors are ignored until the next swap —
// the DAW console view is the live surface for those.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";

/** Window (ms) after connect/swap during which errors are collected. */
const CAPTURE_MS = 4000;

/** Max errors held. Beyond this we collapse the tail. */
const MAX_ERRORS = 40;

export class StartupErrors extends LitElement {
  static properties = {
    _errors:   { state: true, type: Array },
    _dismissed:{ state: true, type: Boolean },
    // `backend_lost` events used to render as an inline crash card
    // here. They now own their own blocking modal
    // (backend-lost-modal.js) so they can offer recover/main-menu/
    // ignore actions instead of just "X this away" — disconnects
    // are almost always actionable. This component keeps handling
    // bulk startup errors only.
  };

  static styles = css`
    :host {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 5600;
      max-width: min(560px, calc(100vw - 24px));
      pointer-events: none;
      font-family: var(--font-sans);
    }
    .card {
      pointer-events: auto;
      background: var(--color-surface-elevated);
      border: 1px solid color-mix(in oklab, var(--color-danger) 55%, var(--color-border));
      border-radius: var(--radius-md, 8px);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: foyer-slide-in 0.18s ease;
    }
    /* Crash = full-severity. Pulse the border so the eye catches it. */
    .card.crash {
      border-color: var(--color-danger);
      border-width: 2px;
      animation: foyer-slide-in 0.18s ease, foyer-crash-pulse 1.6s ease-in-out infinite;
    }
    @keyframes foyer-crash-pulse {
      0%, 100% { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
      50%      { box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45),
                              0 0 0 4px color-mix(in oklab, var(--color-danger) 30%, transparent); }
    }
    @keyframes foyer-slide-in {
      from { transform: translateY(-8px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: color-mix(in oklab, var(--color-danger) 12%, transparent);
      border-bottom: 1px solid color-mix(in oklab, var(--color-danger) 30%, transparent);
      color: var(--color-danger);
    }
    header .title {
      flex: 1;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
    }
    header button {
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-muted);
      padding: 2px 6px;
      cursor: pointer;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    .list {
      max-height: 260px;
      overflow: auto;
      padding: 6px 0;
    }
    .row {
      display: flex;
      gap: 10px;
      padding: 6px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 40%, transparent);
    }
    .row:first-child { border-top: none; }
    .row .code {
      color: var(--color-warning);
      min-width: 120px;
      white-space: nowrap;
    }
    .row .msg { flex: 1; word-break: break-word; }
    footer {
      padding: 8px 14px 10px;
      font-size: 10px;
      color: var(--color-text-muted);
      border-top: 1px solid color-mix(in oklab, var(--color-border) 40%, transparent);
    }
  `;

  constructor() {
    super();
    this._errors = [];
    this._dismissed = false;
    this._captureUntil = 0;
    // Names of missing plugins the user has already dismissed within the
    // current session. Snapshots re-broadcast on every state change
    // (group create, region edit, …) — without this set we'd re-push the
    // missing-plugins row and force-undismiss the banner on every nudge.
    // Cleared on `backend_swapped`.
    this._dismissedMissingPlugins = new Set();
    this._onEnvelope = (ev) => this._onEnv(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    // Open a capture window immediately on mount — catches errors that
    // arrive during the initial catch-up / snapshot stream.
    this._openCaptureWindow();
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    super.disconnectedCallback();
  }

  _openCaptureWindow() {
    this._captureUntil = Date.now() + CAPTURE_MS;
    this._dismissed = false;
  }

  _onEnv(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "backend_swapped") {
      // Fresh session loading — collect its errors too.
      this._errors = [];
      this._dismissedMissingPlugins.clear();
      this._openCaptureWindow();
      return;
    }
    if (body.type === "backend_lost") {
      // Handled by backend-lost-modal.js — skip here.
      return;
    }
    // Snapshot-derived banner row: walk the session's plugin tree for
    // any insert flagged `missing: true` and surface the union as a
    // single "missing plugins" entry. Ardour's own GUI shows a modal
    // ("This session contains the following plugins that cannot be
    // found on this system: ...") that Foyer was silently swallowing
    // because the per-plugin warning chip on the mixer strip is too
    // easy to miss in a tiled-window context. The aggregated
    // banner-row gives the user the same "you should know about this
    // before you hit play" prompt the desktop DAW does.
    //
    // Source-of-truth is the snapshot (every backend that flags
    // `missing` on the wire — Ardour shim flags it from
    // `UnknownProcessor`, the stub doesn't but could) so we don't
    // need a dedicated event type. Re-derives on every snapshot so
    // re-scans / plugin-rescan reloads tighten the list.
    if (body.type === "session_snapshot") {
      const missing = collectMissingPlugins(body.session);
      if (missing.length > 0) {
        this._upsertMissingPluginsRow(missing);
      } else {
        // Re-scan picked up plugins that used to be missing — clear
        // the row so the banner doesn't keep yelling.
        this._errors = this._errors.filter((e) => e.code !== "missing_plugins");
      }
      return;
    }
    if (body.type !== "error") return;
    // The stub backend (and any backend that lacks an audio source)
    // emits `audio_egress_unavailable` whenever a peer opens the
    // master listener. That's expected on first load — the silence
    // is the truth, not an error worth pestering the user with.
    // The DAW console still logs it.
    if (body.code === "audio_egress_unavailable") return;
    // RBAC denials should always surface, not just during the startup
    // window — they describe user actions that failed *right now*.
    // The modal's dismiss state resets automatically so a stray click
    // after the initial capture window still pops a clear banner.
    const isRbac = body.code === "forbidden_for_role" || body.code === "auth_required";
    if (isRbac) {
      this._dismissed = false;
      this._captureUntil = Date.now() + CAPTURE_MS;
    } else if (this._dismissed && Date.now() > this._captureUntil) {
      return;
    }
    // Coalesce duplicates: a dead shim emits the same `list_ports_failed`
    // / `set_track_input_failed` / etc. across every retry, and three
    // rehydrate passes per editor was producing rows like
    //   list_ports_failed   writer queue closed   (×7)
    // in the banner. Group by (code, message) and surface a single
    // row with a count instead.
    const code    = body.code || "error";
    const message = body.message || "";
    const idx = this._errors.findIndex((e) => e.code === code && e.message === message);
    let next;
    if (idx >= 0) {
      next = this._errors.slice();
      next[idx] = { ...next[idx], count: (next[idx].count || 1) + 1 };
    } else {
      next = this._errors.concat([{ code, message, count: 1 }]);
    }
    this._errors = next.slice(-MAX_ERRORS);
  }

  _dismiss = () => {
    // Record which missing-plugin names the user is acknowledging so a
    // re-snapshot (e.g. from creating a group) doesn't immediately
    // re-pop the banner with the same set.
    const missingRow = this._errors.find((e) => e.code === "missing_plugins");
    if (missingRow?.names) {
      for (const n of missingRow.names) this._dismissedMissingPlugins.add(n);
    }
    this._dismissed = true;
    this._errors = [];
  };

  _upsertMissingPluginsRow(names) {
    // `names` is `[{name, uri}]`. Build a stable de-duplicated list
    // sorted by name so the message stays readable across re-snaps.
    const dedup = new Map();
    for (const n of names) {
      if (!dedup.has(n.name)) dedup.set(n.name, n);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) =>
      (a.name || "").localeCompare(b.name || ""),
    );
    // If every name in this snapshot has already been dismissed, suppress
    // the row entirely — re-snapshots from unrelated edits (group create,
    // region drag, …) shouldn't re-pop a banner the user just closed.
    const sortedNames = sorted.map((p) => p.name);
    const hasNew = sortedNames.some((n) => !this._dismissedMissingPlugins.has(n));
    if (!hasNew && this._dismissed) return;
    const message =
      sorted.length === 1
        ? `${sorted[0].name} cannot be found on this system. The insert is preserved as an inactive stub until the plugin is installed and the session is reloaded.`
        : `${sorted.length} plugins cannot be found on this system: ${sorted
            .map((p) => p.name)
            .join(", ")}. Inserts are preserved as inactive stubs until the plugins are installed and the session is reloaded.`;
    // Replace any existing missing_plugins row in place so the count
    // pill ("×N") doesn't grow on each snapshot-driven re-derive.
    const next = this._errors.filter((e) => e.code !== "missing_plugins");
    next.push({ code: "missing_plugins", message, count: 1, names: sortedNames });
    this._errors = next.slice(-MAX_ERRORS);
    // Only force-undismiss when the set genuinely grew — otherwise we'd
    // override the user's dismiss intent on every re-snapshot.
    if (hasNew) {
      this._dismissed = false;
      this._captureUntil = Date.now() + CAPTURE_MS;
    }
  }

  render() {
    if (this._dismissed) return null;
    if (this._errors.length === 0) return null;
    return html`
      <div class="card">
        <header>
          ${icon("exclamation-triangle", 14)}
          <span class="title">${this._errors.length} issue${this._errors.length === 1 ? "" : "s"} on load</span>
          <button title="Dismiss" @click=${this._dismiss}>${icon("x-mark", 12)}</button>
        </header>
        <div class="list">
          ${this._errors.map((e) => html`
            <div class="row">
              <span class="code">${e.code}</span>
              <span class="msg">${e.message}${e.count > 1 ? ` (×${e.count})` : ""}</span>
            </div>
          `)}
        </div>
        <footer>
          Further errors after dismissal will only appear in the DAW console.
        </footer>
      </div>
    `;
  }
}
customElements.define("foyer-startup-errors", StartupErrors);

/// Walk a snapshot's track tree and return every plugin instance
/// flagged as missing on the wire. The Ardour shim sets this when it
/// finds an `UnknownProcessor` in a route's processor chain (the stub
/// Ardour leaves in place when the plugin's library can't be loaded —
/// e.g. gmsynth / vst3 binaries that didn't install). Returns
/// `[{ name, uri }]`; empty list means clean session.
function collectMissingPlugins(session) {
  if (!session || !Array.isArray(session.tracks)) return [];
  const out = [];
  for (const t of session.tracks) {
    for (const p of t.plugins || []) {
      if (p && p.missing === true) {
        out.push({
          name: p.name || "(unknown)",
          uri: p.uri || "",
        });
      }
    }
  }
  return out;
}
