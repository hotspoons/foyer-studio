// Mixer surface. Wraps a row of track strips with a density toolbar that
// lets the user flip between Wide / Normal / Compact / Narrow presets and
// choose whether strip widths scale with the container (Relative) or lock
// to a fixed pixel width (Absolute) that horizontally scrolls.
//
// Settings persist via mixer-density.js.

import { LitElement, html, css } from "lit";
import "./track-strip.js";
import { DENSITIES, loadMixerSettings, saveMixerSettings } from "../mixer-density.js";
import { scrollbarStyles } from "../shared-styles.js";
import { icon } from "../icons.js";
import { AudioListener } from "../viz/audio-listener.js";

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
    /** @type {AudioListener | null} */
    this._listener = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // The store mutates `session.tracks[i]` in place when a
    // `track_updated` arrives (rename, color, etc.) so Lit's default
    // property-identity check won't see a change on `.session`. Timeline
    // avoids this by subscribing to control/selection events; mixer
    // needs the same "repaint on change" listener or a rename only
    // updates the timeline strip, not the mixer strip.
    this._onStoreChange = () => this.requestUpdate();
    window.__foyer?.store?.addEventListener("change", this._onStoreChange);
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change", this._onStoreChange);
    this._listener?.stop();
    this._listener = null;
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
    if (this._listening) {
      try { await this._listener?.stop(); } catch {}
      this._listener = null;
      this._listening = false;
      return;
    }
    // Master-out preview: listens on the sidecar's synthesized test
    // tone today; will flip to the real Ardour master as soon as the
    // shim-side `Route::output()` tap lands.
    const ws = window.__foyer?.ws;
    if (!ws) return;
    const baseUrl = location.origin.replace(/^http/, "ws");
    try {
      this._listener = new AudioListener({
        ws,
        baseUrl,
        sourceKind: "master",
        codec: "opus",
      });
      await this._listener.start();
      this._listening = true;
    } catch (e) {
      console.error("[mixer] listen failed:", e);
      this._listener = null;
      this._listening = false;
      alert("Audio listen failed: " + e.message);
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
    const { trackId, width, final } = ev.detail || {};
    if (!trackId) return;
    // A zero width means "clear my override and follow the global setting."
    const next = { ...this._widthOverrides };
    if (!width) delete next[trackId];
    else next[trackId] = width;
    this._widthOverrides = next;
    if (final) this._save();
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
        <button class="listen-chip ${this._listening ? "on" : ""}"
                @click=${this._toggleListen}
                title="${this._listening ? "Stop monitoring" : "Monitor the master bus in your browser"}">
          ${icon(this._listening ? "speaker-wave" : "speaker-x-mark", 12)}
          <span>${this._listening ? "Monitoring" : "Listen"}</span>
        </button>
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
