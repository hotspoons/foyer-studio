// Phone-shaped advanced editor for a single track. Bottom-sheet
// overlay with the four affordances the engineer-at-the-instrument
// actually needs to reach without leaving the phone:
//
//   1. Plugins — bypass each insert without opening its parameter
//      panel. (Tweaking parameters is desktop work; toggling the
//      vocal compressor on/off mid-take is phone work.)
//   2. Input — pick the audio port wired into this track. RBAC-
//      gated by `set_track_input`.
//   3. Output bus — assign this track to a sub-mix bus. RBAC-gated
//      by `update_track`.
//   4. Monitor mode — auto / input / disk. RBAC-gated by
//      `update_track`.
//
// Things explicitly NOT in scope:
//   * Plugin parameter editing
//   * Track creation / deletion / rename / color
//   * Group membership, automation, sends, region edits
//
// The desktop track editor is the place for those — this is the
// "self-engineering at a drum kit" subset.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { isAllowed } from "foyer-core/rbac.js";
import { AudioIngress } from "foyer-core/audio/audio-ingress.js";

// Shared with the desktop track-editor-modal: a global registry of
// per-track AudioIngress streams, keyed by track id. Lives on
// `globalThis` so the mic ingress survives the sheet being closed
// (closing the editor mid-take shouldn't mute the mic) AND so both
// the phone and desktop surfaces see the same "active mic" state for
// any given track.
const TRACK_MICS = (globalThis.__foyerTrackMics ||= new Map());

export class PhoneTrackAdvancedSheet extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    trackId: { type: String },
    _tick: { state: true, type: Number },
    _ports: { state: true },
    // Mic-ingress state machine for the "Start my mic" button when
    // this client is the source user. "idle" → "starting" → "active"
    // (or → "error"). Mirrors the same state machine in the desktop
    // track editor.
    _micState: { state: true },
    _micError: { state: true },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      z-index: 220;
      display: none;
      align-items: flex-end;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      font-family: var(--font-sans);
    }
    :host([open]) { display: flex; }
    .sheet {
      width: 100%;
      max-height: 92vh;
      background: var(--color-surface);
      border-top-left-radius: 16px;
      border-top-right-radius: 16px;
      border-top: 1px solid var(--color-border);
      box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.5);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .grip {
      width: 40px; height: 4px;
      background: var(--color-border);
      border-radius: 2px;
      margin: 8px auto 4px;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 16px 12px;
      border-bottom: 1px solid var(--color-border);
    }
    header h2 {
      flex: 1;
      margin: 0;
      font-size: 13px; font-weight: 600;
      color: var(--color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    header .name {
      font-weight: 700;
      color: var(--color-accent);
    }
    header .x {
      flex: 0 0 auto;
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      color: var(--color-text-muted);
      cursor: pointer;
    }
    .body {
      overflow-y: auto;
      padding: 4px 0 24px;
      -webkit-overflow-scrolling: touch;
    }
    section { padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    section:last-child { border-bottom: 0; }
    section h3 {
      margin: 0 16px 6px;
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .empty {
      padding: 12px 16px;
      color: var(--color-text-muted);
      font-size: 12px;
      font-style: italic;
    }

    /* Plugin row */
    .plugin {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px; align-items: center;
      padding: 10px 16px;
    }
    .plugin .name {
      font-size: 13px; color: var(--color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      min-width: 0;
    }
    .plugin .name.missing {
      color: var(--color-danger, #ef4444);
      font-style: italic;
    }
    /* Toggle the desktop calls "bypass" reads as "off" on the chip
     * (consistent with mute: pressed = "this is off"). When ON the
     * chip lights to indicate the bypass is engaged. */
    .toggle {
      flex: 0 0 auto;
      min-width: 60px; height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .toggle:active { transform: scale(0.96); }
    .toggle.on {
      color: #fff;
      background: var(--color-warning, #fbbf24);
      border-color: var(--color-warning, #fbbf24);
    }
    .toggle.disabled {
      opacity: 0.35;
      pointer-events: none;
    }

    /* Routing rows */
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
    }
    .row label {
      flex: 0 0 80px;
      font-size: 12px; color: var(--color-text-muted);
    }
    .row select, .row input[type="text"] {
      flex: 1; min-width: 0;
      padding: 8px 10px;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      font: inherit; font-size: 13px;
    }
    .row select:disabled { opacity: 0.5; }

    /* Mode chips (monitor) */
    .chips {
      display: flex; gap: 8px;
      padding: 4px 16px 8px;
    }
    .chip-btn {
      flex: 1;
      min-height: 40px;
      border-radius: 10px;
      border: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .chip-btn:active { transform: scale(0.96); }
    .chip-btn.on {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
    .chip-btn.disabled {
      opacity: 0.35;
      pointer-events: none;
    }

    .lock {
      padding: 8px 16px;
      font-size: 11px;
      color: var(--color-text-muted);
      font-style: italic;
    }

    /* "Start my mic" button + status hints. The button is full-width
     * with a 48px hit target — the host's "give me a rough take"
     * use case lives or dies on whether the remote performer can
     * tap it without a fight. */
    .mic-row {
      display: flex; flex-direction: column; gap: 8px;
      padding: 8px 16px 4px;
    }
    .mic-btn {
      width: 100%;
      min-height: 48px;
      padding: 10px 12px;
      display: inline-flex; align-items: center; justify-content: center;
      gap: 8px;
      border-radius: 12px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 13px; font-weight: 700;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .mic-btn:active { transform: scale(0.98); }
    .mic-btn.on {
      color: #fff;
      background: var(--color-danger, #ef4444);
      border-color: transparent;
      box-shadow: 0 0 16px color-mix(in oklab, var(--color-danger, #ef4444) 50%, transparent);
    }
    .mic-btn.starting {
      opacity: 0.65;
      pointer-events: none;
    }
    .mic-hint {
      padding: 0 16px 8px;
      font-size: 11px;
      color: var(--color-text-muted);
      line-height: 1.4;
    }
    .mic-hint.error { color: var(--color-danger, #ef4444); }
  `;

  constructor() {
    super();
    this.open = false;
    this.trackId = "";
    this._tick = 0;
    this._ports = [];
    this._micState = "idle";
    this._micError = "";
    this._onChange = () => { this._tick++; };
    this._onEnvelope = (ev) => {
      const body = ev.detail?.body;
      if (body?.type === "ports_listed") {
        this._ports = body.ports || [];
      } else if (
        body?.type === "audio_ingress_opened"
        || body?.type === "audio_ingress_closed"
      ) {
        // Refresh the ports list so the input dropdown sees a newly-
        // opened browser ingress port the moment it shows up.
        window.__foyer?.ws?.send?.({ type: "list_ports", direction: "source" });
      }
    };
    this._onBackdrop = (ev) => {
      if (ev.target === this) this._close();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    store?.addEventListener("change", this._onChange);
    store?.addEventListener("control", this._onChange);
    // Peer roster + browser-source assignments are tracked on the
    // store too. Without listening for them the source-user select
    // can't update when a remote user joins/leaves or when the host
    // changes the assignment from another client.
    store?.addEventListener("peers", this._onChange);
    store?.addEventListener("track-browser-sources", this._onChange);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    this.addEventListener("click", this._onBackdrop);
  }
  disconnectedCallback() {
    const store = window.__foyer?.store;
    store?.removeEventListener("change", this._onChange);
    store?.removeEventListener("control", this._onChange);
    store?.removeEventListener("peers", this._onChange);
    store?.removeEventListener("track-browser-sources", this._onChange);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
    this.removeEventListener("click", this._onBackdrop);
    super.disconnectedCallback();
  }

  updated(changed) {
    super.updated?.(changed);
    if (changed.has("open") && this.open && this.trackId) {
      // Refresh the input-port list each time the sheet opens — the
      // available ports change as ingress streams come up/down on
      // other clients, and the PortsListed echo only refreshes
      // listeners that exist at the time it's broadcast.
      window.__foyer?.ws?.send?.({ type: "list_ports", direction: "source" });
      // Restore mic-active visual state if THIS track already has a
      // live ingress (sheet was closed mid-take and reopened).
      this._micState = TRACK_MICS.has(this.trackId) ? "active" : "idle";
      this._micError = "";
    }
  }

  _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _track() {
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    return tracks.find((t) => t.id === this.trackId) || null;
  }

  _allBuses() {
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    return tracks.filter((t) => t.kind === "bus" && t.id !== this.trackId);
  }

  _patch(patch) {
    if (!this.trackId) return;
    window.__foyer?.ws?.send?.({
      type: "update_track",
      id: this.trackId,
      patch,
    });
  }

  _toggleBypass(plugin) {
    if (!plugin) return;
    const bypassParam = (plugin.params || []).find((x) => x.id?.endsWith?.(".bypass"));
    if (!bypassParam) return;
    if (!isAllowed("control_set")) return;
    const store = window.__foyer?.store;
    const live = store?.get?.(bypassParam.id);
    const currentOn = live === true || live === 1 || live?.Bool === true || !!plugin.bypassed;
    window.__foyer?.ws?.controlSet?.(bypassParam.id, !currentOn);
  }

  _setMonitor(mode) {
    if (!isAllowed("update_track")) return;
    this._patch({ monitoring: mode });
  }

  _setInputPort(name) {
    if (!isAllowed("set_track_input") && !isAllowed("update_track")) return;
    // The wire patch field (`input_port`) is what the desktop modal
    // uses too — the older standalone `set_track_input` command goes
    // through the same backend code path.
    this._patch({ input_port: name || "" });
  }

  _setBusAssign(busId) {
    if (!isAllowed("update_track")) return;
    this._patch({ bus_assign: busId || "" });
  }

  /// Eligible source-users for this track. Mirrors the desktop
  /// track-editor's `_performerPeers` filter: LAN peers always
  /// qualify (they're the host), and tunnel peers must hold a role
  /// that's allowed to capture audio (admin / session_controller /
  /// performer). Sorted host-first then alphabetical so the order
  /// stays stable across renders.
  _performerPeers() {
    const peers = window.__foyer?.store?.state?.peers;
    if (!peers) return [];
    const out = [];
    for (const p of peers.values()) {
      if (p.is_local) { out.push(p); continue; }
      if (!p.is_tunnel) { out.push(p); continue; }
      const role = p.role_id || "";
      if (role === "admin" || role === "session_controller" || role === "performer") {
        out.push(p);
      }
    }
    out.sort((a, b) => {
      if (a.is_local && !b.is_local) return -1;
      if (!a.is_local && b.is_local) return 1;
      return (a.label || "").localeCompare(b.label || "");
    });
    return out;
  }

  _onBrowserSourceChange = async (peerId) => {
    const selfPeerId = window.__foyer?.store?.state?.selfPeerId || "";
    const prev = window.__foyer?.store?.state?.trackBrowserSources?.get?.(this.trackId) || "";
    // If we WERE the active source and the selection changes, stop
    // our local ingress — the new user (or no one) takes over.
    if (prev === selfPeerId && peerId !== selfPeerId) {
      await this._stopLocalMicIfActive();
    }
    window.__foyer?.ws?.send?.({
      type: "set_track_browser_source",
      track_id: this.trackId,
      peer_id: peerId || "",
    });
  };

  _toggleBrowserMic = async () => {
    if (!this.trackId) return;
    // Active → disconnect: close our owned ingress (if any) and clear
    // the track's input_port so Ardour re-auto-connects to whatever
    // it was wired to before. If the track is pointed at a
    // foyer:ingress port WE didn't open (another client owns it),
    // just unwire the track on our end — we don't terminate someone
    // else's mic.
    const live = TRACK_MICS.get(this.trackId);
    const t = this._track();
    const curr = (t?.inputs?.[0]?.name) || "";
    if (live || curr.startsWith("foyer:")) {
      if (live) {
        try { await live.ingress.stop(); } catch {}
        TRACK_MICS.delete(this.trackId);
      }
      // Clear the input pinned to this ingress.
      this._patch({ input_port: "" });
      this._micState = "idle";
      return;
    }
    // Idle → start. AudioIngress.start() resolves after the shim
    // acks audio_ingress_opened with the engine port name.
    this._micState = "starting";
    this._micError = "";
    const ingress = new AudioIngress({
      ws: window.__foyer?.ws,
      baseUrl: location.origin.replace(/^http/, "ws"),
    });
    try {
      await ingress.start();
    } catch (e) {
      console.error("[phone-track-advanced] mic ingress failed:", e);
      this._micError = e?.message || String(e);
      this._micState = "error";
      return;
    }
    const portName = ingress.enginePortName;
    TRACK_MICS.set(this.trackId, { ingress, portName });
    // Wire the track's input to the freshly-opened browser port so
    // the audio actually lands on this track and not somewhere else.
    this._patch({ input_port: portName });
    this._micState = "active";
  };

  async _stopLocalMicIfActive() {
    const live = TRACK_MICS.get(this.trackId);
    if (!live) return;
    try { await live.ingress.stop(); } catch {}
    TRACK_MICS.delete(this.trackId);
    this._micState = "idle";
  }

  _renderPlugins(track) {
    const plugins = track.plugins || [];
    const canCtl = isAllowed("control_set");
    if (plugins.length === 0) {
      return html`<div class="empty">No plugins on this track.</div>`;
    }
    const store = window.__foyer?.store;
    return plugins.map((p) => {
      const bypassParam = (p.params || []).find((x) => x.id?.endsWith?.(".bypass"));
      const live = bypassParam ? store?.get?.(bypassParam.id) : undefined;
      const on = live !== undefined
        ? (live === true || live === 1 || live?.Bool === true)
        : !!p.bypassed;
      const missing = !!p.missing;
      return html`
        <div class="plugin">
          <span class="name ${missing ? "missing" : ""}"
                title=${p.name || ""}>${p.name || "(unnamed)"}${missing ? " — missing" : ""}</span>
          <button class="toggle ${on ? "on" : ""} ${(!canCtl || !bypassParam) ? "disabled" : ""}"
                  title=${on ? "Bypassed — tap to engage" : "Engaged — tap to bypass"}
                  @click=${() => this._toggleBypass(p)}>
            ${on ? "Bypass" : "Active"}
          </button>
        </div>
      `;
    });
  }

  /// Source-user picker + local mic-capture button. Mirrors the
  /// desktop track-editor's source-user UX so the "remote performer
  /// streams a rough take from their phone while the band overdubs
  /// in the studio" workflow round-trips through whichever client
  /// the user grabbed. The select itself is host-side configuration
  /// (anyone can SEE it; only the user holding the right RBAC tag
  /// can CHANGE it); the mic button is each-user-for-themselves
  /// (you can only start your OWN mic).
  _renderRemoteSource(track) {
    const store = window.__foyer?.store;
    const sources = store?.state?.trackBrowserSources;
    const selfPeerId = store?.state?.selfPeerId || "";
    const assigned = sources?.get?.(track.id) || "";
    const peers = this._performerPeers();
    const canAssign = isAllowed("set_track_browser_source");
    const starting = this._micState === "starting";
    return html`
      <div class="row">
        <label>Source user</label>
        <select ?disabled=${!canAssign || starting}
                .value=${assigned}
                @change=${(e) => this._onBrowserSourceChange(e.currentTarget.value)}>
          <option value="">None (off)</option>
          ${peers.map((p) => html`
            <option value=${p.id} ?selected=${assigned === p.id}>
              ${p.id === selfPeerId ? `This phone (${p.label})` : p.label}
            </option>
          `)}
          ${assigned && !peers.find((p) => p.id === assigned) ? html`
            <option value=${assigned} ?selected=${true}>
              (offline peer — ${assigned.slice(0, 6)}…)
            </option>` : null}
        </select>
      </div>
      ${assigned === selfPeerId ? html`
        <div class="mic-row">
          <button class="mic-btn ${this._micState === "active" ? "on" : ""} ${starting ? "starting" : ""}"
                  ?disabled=${starting}
                  title=${this._micState === "active"
                    ? "Stop the browser mic ingress"
                    : "Start streaming this phone's mic into the track"}
                  @click=${this._toggleBrowserMic}>
            ${icon("microphone", 16)}
            <span>${
              starting ? "Starting mic…"
              : this._micState === "active" ? "Stop mic"
              : "Start my mic"
            }</span>
          </button>
        </div>
        ${this._micState === "error" ? html`
          <div class="mic-hint error">${this._micError || "Mic failed to start."}</div>
        ` : html`
          <div class="mic-hint">
            Live monitoring is forced off for browser-sourced tracks —
            the round-trip latency would make it unusable for live monitoring.
            Use this to capture overdub-quality takes that you re-record later.
          </div>
        `}
      ` : assigned ? html`
        <div class="mic-hint">
          Waiting for that user to start their mic from their own browser.
        </div>
      ` : null}
      ${!canAssign ? html`
        <div class="lock">Reassigning the source requires the host's permission.</div>
      ` : null}
    `;
  }

  _renderRouting(track) {
    const canEdit = isAllowed("update_track");
    const ports = (this._ports || []).filter((p) => p.direction === "source");
    const currentInput = (track.inputs?.[0]?.name) || "";
    const buses = this._allBuses();
    const currentBus = track.bus_assign || "";
    return html`
      <div class="row">
        <label>Input</label>
        <select ?disabled=${!canEdit && !isAllowed("set_track_input")}
                .value=${currentInput}
                @change=${(e) => this._setInputPort(e.currentTarget.value)}>
          <option value="">Auto-connect</option>
          ${ports.map((p) => html`
            <option value=${p.name} ?selected=${p.name === currentInput}>${p.name}</option>
          `)}
        </select>
      </div>
      <div class="row">
        <label>Output</label>
        <select ?disabled=${!canEdit}
                .value=${currentBus}
                @change=${(e) => this._setBusAssign(e.currentTarget.value)}>
          <option value="">Master</option>
          ${buses.map((b) => html`
            <option value=${b.id} ?selected=${b.id === currentBus}>${b.name || b.id}</option>
          `)}
        </select>
      </div>
      ${!canEdit ? html`
        <div class="lock">Routing changes require the host's permission.</div>
      ` : null}
    `;
  }

  _renderMonitor(track) {
    if (track.monitoring === undefined || track.monitoring === null) {
      return html`<div class="empty">This track has no monitoring control.</div>`;
    }
    const canEdit = isAllowed("update_track");
    const current = track.monitoring || "auto";
    const dis = canEdit ? "" : "disabled";
    return html`
      <div class="chips">
        ${["auto", "input", "disk"].map((mode) => html`
          <button class="chip-btn ${mode === current ? "on" : ""} ${dis}"
                  title=${
                    mode === "input" ? "Always monitor live input"
                    : mode === "disk" ? "Always play back from disk"
                    : "Auto — switch based on transport state"
                  }
                  @click=${() => this._setMonitor(mode)}>
            ${mode === "input" ? "In" : mode === "disk" ? "Disk" : "Auto"}
          </button>
        `)}
      </div>
      ${!canEdit ? html`
        <div class="lock">Monitor changes require the host's permission.</div>
      ` : null}
    `;
  }

  render() {
    void this._tick;
    const track = this._track();
    if (!track) {
      // Sheet is open with no resolved track — usually a stale id
      // from a track that just got deleted. Render empty + close
      // affordance so the user isn't trapped.
      return html`
        <div class="sheet" @click=${(e) => e.stopPropagation()}>
          <div class="grip"></div>
          <header>
            <h2>Track unavailable</h2>
            <button class="x" @click=${() => this._close()}>${icon("x-mark", 16)}</button>
          </header>
        </div>
      `;
    }
    return html`
      <div class="sheet" @click=${(e) => e.stopPropagation()}>
        <div class="grip"></div>
        <header>
          <h2>Advanced — <span class="name">${track.name || "(unnamed)"}</span></h2>
          <button class="x" title="Close" @click=${() => this._close()}>
            ${icon("x-mark", 16)}
          </button>
        </header>
        <div class="body">
          <section>
            <h3>Plugins</h3>
            ${this._renderPlugins(track)}
          </section>
          <section>
            <h3>Remote source</h3>
            ${this._renderRemoteSource(track)}
          </section>
          <section>
            <h3>Routing</h3>
            ${this._renderRouting(track)}
          </section>
          <section>
            <h3>Monitor</h3>
            ${this._renderMonitor(track)}
          </section>
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-phone-track-advanced-sheet", PhoneTrackAdvancedSheet);
