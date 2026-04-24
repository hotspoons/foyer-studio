// Mixer surface. Wraps a row of track strips with a density toolbar that
// lets the user flip between Wide / Normal / Compact / Narrow presets and
// choose whether strip widths scale with the container (Relative) or lock
// to a fixed pixel width (Absolute) that horizontally scrolls.
//
// Settings persist via mixer-density.js.

import { LitElement, html, css } from "lit";
import "./track-strip.js";
import { DENSITIES, loadMixerSettings, saveMixerSettings } from "foyer-core/mixer-density.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import { icon } from "foyer-ui-core/icons.js";
import { AudioListener } from "foyer-core/audio/audio-listener.js";

export class Mixer extends LitElement {
  static properties = {
    session: { type: Object },
    _density: { state: true, type: String },
    _widthMode: { state: true, type: String },
    _widthOverrides: { state: true, type: Object },
    _listening: { state: true, type: Boolean },
  };

  static styles = css`
    ${scrollbarStyles}
    :host { display: flex; flex: 1 1 auto; flex-direction: column; overflow: hidden; background: var(--color-surface); }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      font-size: 11px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .toolbar .group {
      display: inline-flex;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .toolbar .group button {
      background: transparent;
      border: 0;
      font: inherit; font-family: var(--font-sans);
      font-size: 10px; font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      padding: 3px 8px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .toolbar .group button + button { border-left: 1px solid var(--color-border); }
    .toolbar .group button:hover { color: var(--color-text); background: var(--color-surface-elevated); }
    .toolbar .group button.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    /* The body is split into a LEFT scroll region that carries input
     * strips (the only thing that ever overflows horizontally) and a
     * RIGHT master section that's always visible — the engineer's
     * output bus shouldn't scroll off when a project grows past the
     * visible width. Horizontal scrollbars only appear on the
     * .strips-scroll child, which respects the right edge of the
     * master section. */
    .body {
      flex: 1 1 auto;
      display: flex;
      align-items: stretch;
      min-width: 0;
      overflow: hidden;
    }
    .strips-scroll {
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .strips {
      display: flex;
      align-items: stretch;
      min-width: 0;
      height: 100%;
    }
    .master-section {
      display: flex;
      align-items: stretch;
      flex: 0 0 auto;
      border-left: 1px solid var(--color-border);
      background: linear-gradient(180deg,
        color-mix(in oklab, var(--color-accent) 5%, var(--color-surface)),
        color-mix(in oklab, var(--color-accent) 2%, var(--color-surface)));
      box-shadow: -4px 0 12px rgba(0, 0, 0, 0.25);
    }
    .master-gutter {
      width: 14px;
      flex-shrink: 0;
    }
    /* Small toolbar chip for the master-bus monitor toggle. Same shape
     * as other toolbar buttons so it doesn't steal attention, but
     * picks up an accent tint when active so you know something's
     * playing. */
    .listen-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-family: var(--font-sans);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .listen-chip:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
    }
    .listen-chip.on {
      color: var(--color-accent);
      border-color: var(--color-accent);
      background: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
    .empty {
      padding: 24px;
      color: var(--color-text-muted);
    }
  `;

  constructor() {
    super();
    this.session = null;
    const s = loadMixerSettings();
    this._density = s.density;
    this._widthMode = s.widthMode;
    this._widthOverrides = s.widthOverrides || {};
    this._listening = false;
    this._applyingListenPref = false;
    /** @type {AudioListener | null} */
    this._listener = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Listen-state restore has two paths:
    //   1. Explicit saved pref in localStorage → honor it immediately,
    //      no greeting needed. This path also handles the common
    //      case where the mixer mounts on a session switch (the
    //      greeting fired once, at WS connect, so it's long gone
    //      by the time we get here on a fresh mount).
    //   2. No saved pref → wait for the greeting, then default based
    //      on `is_local` (off for local, on for remote).
    // Previous version relied on a `store.state._greeting` fallback
    // that never actually got populated — the greeting lived in
    // status-bar's private state, so cases where the greeting fired
    // before the mixer mounted left the saved pref unapplied.
    this._onStoreChange = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("change", this._onStoreChange);
    this._onGreeting = (ev) => {
      const body = ev?.detail?.body;
      if (!body) return;
      if (body.type === "client_greeting") {
        this._applyListenPref(!!body.is_local);
      } else if (body.type === "backend_swapped" || body.type === "session_opened") {
        // Session changed — the old listener's stream belongs to the
        // previous shim and is dead. Tear it down so the saved-pref
        // branch below can spin up a fresh one against the new
        // backend's master tap.
        if (this._listening) {
          this._cleanupListener();
          this._listening = false;
          // Deliberately NOT saving "0" here — the user's saved
          // preference should survive across switches. Just apply
          // the pref again to restart if wanted.
        }
        this._applyListenPref(null);
      }
    };
    window.__foyer?.ws?.addEventListener("envelope", this._onGreeting);
    // Apply the saved pref right away. Remote-session / no-pref case
    // falls through here (`wantOn = null`) and waits for the greeting.
    this._applyListenPref(null);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStoreChange);
    window.__foyer?.ws?.removeEventListener("envelope", this._onGreeting);
    this._cleanupListener();
    super.disconnectedCallback();
  }

  _applyListenPref(isLocal) {
    // `_listening` flips true only after start() resolves. Between
    // the `new AudioListener` call and that resolution we have a
    // second in-flight, so guard with `_applyingListenPref` to stop
    // rapid `session_opened` / `backend_swapped` replays from
    // stacking up concurrent listener starts (each overwrote
    // `_listener` and orphaned the previous one mid-handshake,
    // which is what the "monitoring keeps turning off" regression
    // was really observing).
    if (this._listening || this._applyingListenPref) return;
    // Tunnel guests always want Listen on — they have no hardware
    // connection to the DAW's output and the whole point of the
    // tunnel session is hearing what the host is playing. The
    // toggle itself is hidden from their UI (see render()), so
    // the saved localStorage pref is bypassed in this branch.
    // PLAN 158.
    const rbac = window.__foyer?.store?.state?.rbac;
    const isTunnel = !!rbac?.isTunnel;
    let wantOn;
    if (isTunnel) {
      wantOn = true;
    } else {
      const saved = localStorage.getItem("foyer.listen.master");
      if (saved === "1") wantOn = true;
      else if (saved === "0") wantOn = false;
      else if (isLocal === null) return; // no pref + no greeting yet — wait
      else wantOn = !isLocal;
    }
    if (wantOn) {
      this._applyingListenPref = true;
      this._toggleListen(true)
        .catch(() => {})
        .finally(() => { this._applyingListenPref = false; });
    }
  }

  // (connectedCallback + disconnectedCallback are defined above — the
  // listener cleanup + store-change wiring lives there now.)
  _cleanupListener() {
    this._listener?.stop();
    this._listener = null;
  }

  /** Mixers overflow horizontally on big sessions, but the browser's
   *  default wheel behavior scrolls vertically — which does nothing
   *  useful here (no vertical overflow within the strips). Translate
   *  vertical wheel into horizontal scroll so a trackpad gesture or
   *  plain mousewheel traverses the track strip row. Shift-wheel is
   *  already horizontal natively, so don't double-handle that case. */
  _onMixerWheel = (ev) => {
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.deltaY === 0) return;
    const scroller = ev.currentTarget;
    const max = scroller.scrollWidth - scroller.clientWidth;
    if (max <= 0) return;
    ev.preventDefault();
    scroller.scrollLeft = Math.max(
      0,
      Math.min(max, scroller.scrollLeft + ev.deltaY),
    );
  };

  _toggleListen = async (silent = false) => {
    if (this._listening) {
      try { await this._listener?.stop(); } catch {}
      this._listener = null;
      this._listening = false;
      // Persist user's preference: off.
      localStorage.setItem("foyer.listen.master", "0");
      return;
    }
    // Master-out preview: listens on the sidecar's synthesized test
    // tone today; will flip to the real Ardour master as soon as the
    // shim-side `Route::output()` tap lands.
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const baseUrl = location.origin.replace(/^http/, "ws");
    try {
      // Codec override via URL: `?audio_codec=raw_f32_le` bypasses
      // Opus entirely so we can A/B the decoder against the raw
      // PCM path. Useful when debugging decoder-specific issues
      // like the half-pitch symptom we hit on 2026-04-20.
      const params = new URLSearchParams(location.search);
      const codec = params.get("audio_codec") || "opus";
      this._listener = new AudioListener({
        ws,
        baseUrl,
        sourceKind: "master",
        codec,
      });
      console.info(`[mixer] Listen starting with codec=${codec}`);
      await this._listener.start();
      this._listening = true;
      localStorage.setItem("foyer.listen.master", "1");
    } catch (e) {
      console.error("[mixer] listen failed:", e);
      this._listener = null;
      this._listening = false;
      // Only nag with a dialog on explicit user clicks. Auto-restore
      // paths (page refresh, session switch) pass silent=true so a
      // stale saved pref doesn't pop a modal on every refresh.
      if (!silent) {
        import("foyer-ui-core/widgets/confirm-modal.js").then(({ confirmAction }) => {
          confirmAction({
            title: "Listen failed",
            message: `Couldn't start the master-out listener:\n\n${e.message}`,
            confirmLabel: "OK",
            cancelLabel: "Close",
          });
        });
      }
    }
  };

  _save() {
    saveMixerSettings({
      density: this._density,
      widthMode: this._widthMode,
      widthOverrides: this._widthOverrides,
    });
  }

  _setDensity(k) { this._density = k; this._save(); }
  _setMode(m)    { this._widthMode = m; this._save(); }

  _onChannelResize(ev) {
    const { trackId, width, delta, startWidth, final, resizeAll } = ev.detail || {};
    if (!trackId) return;
    const next = { ...this._widthOverrides };
    if (resizeAll) {
      // Shift-drag mode: every strip's width shifts by the same
      // delta from wherever it started. Capture each strip's
      // pre-drag width on first tick so subsequent ticks don't
      // compound.
      if (!this._resizeAllBase) {
        const tracks = this.session?.tracks || [];
        const base = {};
        for (const t of tracks) {
          if (!t?.id) continue;
          base[t.id] = this._widthOverrides[t.id] || startWidth || 0;
        }
        this._resizeAllBase = base;
      }
      for (const [id, baseW] of Object.entries(this._resizeAllBase)) {
        const w = Math.max(28, Math.min(360, (baseW || startWidth || 0) + (delta || 0)));
        if (w > 0) next[id] = Math.round(w);
      }
    } else {
      // A zero width means "clear my override and follow the
      // global setting."
      if (!width) delete next[trackId];
      else next[trackId] = width;
    }
    this._widthOverrides = next;
    if (final) {
      this._resizeAllBase = null;
      this._save();
    }
  }

  _resetAllOverrides() {
    this._widthOverrides = {};
    this._save();
  }

  render() {
    const tracks = this.session?.tracks ?? [];
    const density = DENSITIES[this._density] || DENSITIES.normal;
    return html`
      <div class="toolbar">
        <span>Density</span>
        <div class="group">
          ${Object.entries(DENSITIES).map(([k, v]) => html`
            <button class=${this._density === k ? "active" : ""}
                    @click=${() => this._setDensity(k)}>${v.label}</button>
          `)}
        </div>
        <span style="margin-left:10px">Width</span>
        <div class="group">
          <button class=${this._widthMode === "relative" ? "active" : ""}
                  @click=${() => this._setMode("relative")}>Relative</button>
          <button class=${this._widthMode === "absolute" ? "active" : ""}
                  @click=${() => this._setMode("absolute")}>Absolute</button>
        </div>
        <span style="flex:1"></span>
        ${Object.keys(this._widthOverrides).length
          ? html`<button
              @click=${this._resetAllOverrides}
              title="Clear every per-channel width override"
              style="background:transparent;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-muted);font-size:10px;padding:3px 8px;cursor:pointer;font-family:var(--font-sans);"
            >Reset widths</button>`
          : null}
        ${window.__foyer?.store?.state?.rbac?.isTunnel
          ? null
          : html`<button class="listen-chip ${this._listening ? "on" : ""}"
                    @click=${this._toggleListen}
                    title="${this._listening ? "Stop monitoring" : "Monitor the master bus in your browser"}">
              ${icon(this._listening ? "speaker-wave" : "speaker-x-mark", 12)}
              <span>${this._listening ? "Monitoring" : "Listen"}</span>
            </button>`}
        <span>${tracks.length} tracks · ${density.trackWidth}px</span>
      </div>
      ${tracks.length === 0
        ? html`<div class="empty">Waiting for session…</div>`
        : (() => {
            // Partition into "inputs" (audio/midi + busses) and
            // "master-like" strips (master + monitor). Both categories
            // render in the same visual vocabulary; they just live in
            // different columns so the master stays pinned at the right.
            const inputs = tracks.filter(t => t.kind !== "master" && t.kind !== "monitor");
            const masters = tracks.filter(t => t.kind === "master" || t.kind === "monitor");
            return html`
              <div class="body" @channel-resize=${(e) => this._onChannelResize(e)}>
                <div class="strips-scroll" @wheel=${this._onMixerWheel}>
                  <div class="strips">
                    ${inputs.map(t => html`
                      <foyer-track-strip
                        .track=${t}
                        .density=${density}
                        .widthMode=${this._widthMode}
                        .overrideWidth=${this._widthOverrides[t.id] || null}
                      ></foyer-track-strip>
                    `)}
                  </div>
                </div>
                ${masters.length
                  ? html`
                      <div class="master-gutter"></div>
                      <div class="master-section">
                        ${masters.map(t => html`
                          <foyer-track-strip
                            .track=${t}
                            .density=${density}
                            .widthMode=${this._widthMode}
                            .overrideWidth=${this._widthOverrides[t.id] || null}
                          ></foyer-track-strip>
                        `)}
                      </div>
                    `
                  : null}
              </div>
            `;
          })()}
    `;
  }
}
customElements.define("foyer-mixer", Mixer);
