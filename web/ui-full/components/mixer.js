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
// AudioListener is owned by foyer-core/audio/master-controller.js now;
// the mixer just observes via window.__foyer.audio. Import removed.

export class Mixer extends LitElement {
  static properties = {
    session: { type: Object },
    _density: { state: true, type: String },
    _widthMode: { state: true, type: String },
    _widthOverrides: { state: true, type: Object },
    // _listening is a getter on audioController state; not Lit-tracked.
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
  }

  /// True iff the master-bus listener is currently running. Sourced
  /// from the global `audioController` (TODO 38) so the mixer button
  /// stays in sync regardless of who started/stopped it.
  get _listening() {
    return !!window.__foyer?.audio?.isOn?.();
  }

  connectedCallback() {
    super.connectedCallback();
    // The mixer no longer owns the listener — `audioController`
    // (boot-mounted in app.js) does. We just observe its `change`
    // events to keep the toggle button in sync, and re-render on
    // store changes so things like density/width updates land.
    this._onStoreChange = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("change", this._onStoreChange);
    this._onAudioChange = () => this.requestUpdate();
    window.__foyer?.audio?.addEventListener?.("change", this._onAudioChange);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStoreChange);
    window.__foyer?.audio?.removeEventListener?.("change", this._onAudioChange);
    super.disconnectedCallback();
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

  _toggleListen = async () => {
    // Thin wrapper — the controller decides start vs stop based on
    // its own state, persists the user pref, and emits `change` so
    // the button re-renders.
    try {
      await window.__foyer?.audio?.toggle?.();
    } catch (e) {
      console.error("[mixer] listen toggle failed:", e);
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
