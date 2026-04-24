// Track editor modal. Full-depth editor for a single track — right-
// click the label in the mixer or timeline to open.
//
// Shows: name, color, comment (not wired yet), the full mixer strip
// embedded so the user can tune gain/pan/mute/solo without leaving
// the timeline tile, and — once shim support lands — bus assignment
// and group membership.
//
// Route all edits through `update_track`; backend echo updates the
// store and the modal re-reads from the live track.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import "./track-strip.js";
import "./midi-manager.js";
import { openPanEditor } from "./pan-editor-modal.js";
import { DENSITIES } from "foyer-core/mixer-density.js";
import { AudioIngress } from "foyer-core/audio/audio-ingress.js";

// Global registry of per-track browser-mic ingresses. Keyed by track
// id so the lifecycle survives modal open/close (closing the editor
// shouldn't mute the mic — that'd stop a recording mid-take). Keyed
// by track id so reopening the modal re-shows the "connected" state.
//   trackId → { ingress: AudioIngress, portName: string }
const TRACK_MICS = (globalThis.__foyerTrackMics ||= new Map());

const COLOR_PALETTE = [
  { label: "Red",    hex: "#c04040" },
  { label: "Orange", hex: "#c08040" },
  { label: "Yellow", hex: "#c0b040" },
  { label: "Green",  hex: "#40c080" },
  { label: "Teal",   hex: "#40a0b0" },
  { label: "Blue",   hex: "#4080c0" },
  { label: "Purple", hex: "#9060c0" },
  { label: "Pink",   hex: "#c06090" },
  { label: "Gray",   hex: "#808080" },
];

export class TrackEditorModal extends LitElement {
  static properties = {
    trackId: { type: String, attribute: "track-id" },
    initialTab: { attribute: false },
    _tick:   { state: true, type: Number },
    _ports:  { state: true },
    _micState: { state: true },   // "idle" | "starting" | "active" | "error"
    _micError: { state: true },
    _tab: { state: true },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      font-family: var(--font-sans);
    }
    .card {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--color-border);
      flex: 0 0 auto;
    }
    header h2 { margin: 0; font-size: 13px; color: var(--color-text); font-weight: 600; }
    header .swatch {
      width: 14px; height: 14px; border-radius: 3px;
      border: 1px solid var(--color-border);
    }
    header .close { display: none; }
    .tabs {
      display: inline-flex;
      gap: 4px;
      margin-left: 8px;
    }
    .tab {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font: inherit;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .tab.active {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
    .content {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .form-body {
      flex: 1;
      overflow-y: auto;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .strip-panel {
      flex: 0 0 auto;
      width: 180px;
      border-left: 1px solid var(--color-border);
      background: var(--color-surface-muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }
    .strip-panel foyer-track-strip {
      width: 160px;
      flex: 0 0 auto;
    }
    .section { display: flex; flex-direction: column; gap: 6px; }
    .section h3 {
      margin: 0; font-size: 10px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .row {
      display: flex; align-items: center; gap: 10px;
    }
    .row label { font-size: 12px; color: var(--color-text); flex: 0 0 90px; }
    .row.stacked { flex-direction: column; align-items: stretch; gap: 4px; }
    .row.stacked > label { flex: 0 0 auto; }
    select.fld {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      font: inherit; font-size: 12px;
    }
    .send-row {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px;
      background: var(--color-surface-elevated);
      padding: 4px 8px; border-radius: 4px;
    }
    .send-row .target { flex: 0 0 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .send-row input[type="range"] { flex: 1; min-width: 0; }
    .send-row .num { color: var(--color-text-muted); min-width: 32px; text-align: right; }
    .send-row .mode { color: var(--color-text-muted); }
    .send-row .rm {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 0 6px; border-radius: var(--radius-sm);
      font: inherit; font-size: 10px; cursor: pointer;
    }
    .refresh {
      align-self: flex-start;
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 6px; border-radius: var(--radius-sm);
      font: inherit; font-size: 10px; cursor: pointer;
    }
    .mic-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      font: inherit; font-size: 12px;
      cursor: pointer;
    }
    .mic-btn:hover:not([disabled]) { border-color: var(--color-accent); }
    .mic-btn[disabled] { opacity: 0.6; cursor: progress; }
    .mic-btn.on {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
      color: #fff;
    }
    .hint { color: var(--color-text-muted); font-size: 10px; }
    input[type="text"], textarea {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      font: inherit; font-size: 12px;
    }
    textarea { resize: vertical; min-height: 60px; }
    .swatch-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .swatch-btn {
      width: 22px; height: 22px;
      border-radius: 4px;
      border: 1px solid var(--color-border);
      cursor: pointer; padding: 0;
    }
    .swatch-btn.active { outline: 2px solid var(--color-accent); outline-offset: 1px; }
    .swatch-btn.clear {
      background: repeating-linear-gradient(45deg,
        var(--color-surface-elevated), var(--color-surface-elevated) 3px,
        var(--color-border) 3px, var(--color-border) 5px);
      display: flex; align-items: center; justify-content: center;
      color: var(--color-text-muted); font-size: 10px;
    }

    footer {
      padding: 10px 18px;
      border-top: 1px solid var(--color-border);
      display: flex; justify-content: flex-end; gap: 8px;
    }
    footer button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 12px; cursor: pointer;
      border-radius: var(--radius-sm);
      font: inherit; font-size: 12px;
    }
    footer button.primary {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
    }
  `;

  constructor() {
    super();
    this.trackId = "";
    this._tick = 0;
    this._ports = [];
    this._micState = "idle";
    this._micError = "";
    this._tab = "editor";
    this._keyHandler = (ev) => { if (ev.key === "Escape") this._close(); };
    this._storeHandler = () => this._tick++;
    // Watch envelope traffic for the PortsListed reply so the Input
    // dropdown stays fresh, and refresh the list whenever an ingress
    // port opens/closes (could be another client, or our own Use-mic
    // button) so the dropdown shows the new port without a click.
    this._onEnvelope = (ev) => {
      const body = ev.detail?.body;
      if (body?.type === "ports_listed") {
        this._ports = body.ports || [];
      } else if (body?.type === "audio_ingress_opened"
              || body?.type === "audio_ingress_closed") {
        this._requestPorts();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._keyHandler);
    window.__foyer?.store?.addEventListener("change", this._storeHandler);
    window.__foyer?.ws?.addEventListener?.("envelope", this._onEnvelope);
    // Restore mic state if this track already has a live ingress
    // (modal was closed and reopened).
    if (TRACK_MICS.has(this.trackId)) this._micState = "active";
    // Kick off a list_ports request — the shim replies with
    // ports_listed which we stash into this._ports. Source-only
    // filter: we only route track inputs *from* readable ports.
    this._requestPorts();
    const preferred = this.initialTab || this._loadLastTab();
    if (preferred === "midi") this._tab = "midi";
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._keyHandler);
    window.__foyer?.store?.removeEventListener("change", this._storeHandler);
    window.__foyer?.ws?.removeEventListener?.("envelope", this._onEnvelope);
    super.disconnectedCallback();
  }

  _requestPorts() {
    window.__foyer?.ws?.send?.({ type: "list_ports", direction: "source" });
  }

  _toggleBrowserMic = async () => {
    // Active → disconnect: close our owned ingress (if any) and
    // clear the track's input_port so Ardour re-auto-connects.
    // If the track is pointed at a foyer:ingress port we didn't
    // open (e.g., another client's), just unwire the track — we
    // don't own the ingress's lifecycle.
    const live = TRACK_MICS.get(this.trackId);
    const t    = this._track();
    const curr = (t?.inputs?.[0]?.name) || "";
    if (live || curr.startsWith("foyer:")) {
      if (live) {
        try { await live.ingress.stop(); } catch {}
        TRACK_MICS.delete(this.trackId);
      }
      this._setTrackInput("");
      this._micState = "idle";
      return;
    }
    // Idle → start. AudioIngress.start() resolves after the shim
    // acks `audio_ingress_opened`, so by the time we patch the
    // track the port already exists in Ardour's engine.
    this._micState = "starting";
    this._micError = "";
    const ingress = new AudioIngress({
      ws: window.__foyer?.ws,
      baseUrl: location.origin.replace(/^http/, "ws"),
    });
    try {
      await ingress.start();
    } catch (e) {
      console.error("[track-editor] mic ingress failed:", e);
      this._micError = e?.message || String(e);
      this._micState = "error";
      return;
    }
    // AudioIngress.start() resolves after the shim acks `audio_ingress_opened`
    // with the actual engine-level port name (e.g. `foyer-ingress-browser-123`).
    // Read that from the ingress object — don't hardcode the port name here.
    const portName = ingress.enginePortName;
    TRACK_MICS.set(this.trackId, { ingress, portName });
    this._setTrackInput(portName);
    this._micState = "active";
  };

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _loadLastTab() {
    try {
      return localStorage.getItem("foyer.trackEditor.lastMidiTab") || "editor";
    } catch {
      return "editor";
    }
  }

  _setTab(tab) {
    this._tab = tab === "midi" ? "midi" : "editor";
    try {
      localStorage.setItem("foyer.trackEditor.lastMidiTab", this._tab);
    } catch {}
  }

  _track() {
    const s = window.__foyer?.store?.state?.session;
    return s?.tracks?.find((t) => t.id === this.trackId) || null;
  }

  _patch(patch) {
    window.__foyer?.ws?.send({
      type: "update_track",
      id: this.trackId,
      patch,
    });
  }

  _setTrackInput(portName) {
    // Use UpdateTrack with input_port patch rather than the standalone
    // SetTrackInput command — the shim's UpdateTrack handler routes
    // input_port through IO::connect/disconnect_all and emits a
    // TrackUpdated echo that carries the refreshed inputs list.
    window.__foyer?.ws?.send({
      type: "update_track",
      id: this.trackId,
      patch: { input_port: portName || "" },
    });
  }

  _setBusAssign(busId) {
    window.__foyer?.ws?.send({
      type: "update_track",
      id: this.trackId,
      patch: { bus_assign: busId || "" },
    });
  }

  _addSend(targetTrackId) {
    if (!targetTrackId) return;
    window.__foyer?.ws?.send({
      type: "add_send",
      track_id: this.trackId,
      target_track_id: targetTrackId,
      pre_fader: false,
    });
  }

  _removeSend(sendId) {
    window.__foyer?.ws?.send({ type: "remove_send", send_id: sendId });
  }

  _setSendLevel(sendId, level) {
    window.__foyer?.ws?.send({
      type: "set_send_level",
      send_id: sendId,
      level: Number(level),
    });
  }

  _setGroup(groupId) {
    this._patch({ group_id: groupId || "" });
  }

  _commitName(value) {
    const name = (value || "").trim();
    const t = this._track();
    if (!name || !t || name === t.name) return;
    this._patch({ name });
  }

  render() {
    const t = this._track();
    if (!t) {
      return html`
        <div class="card">
          <header><h2>Track not found</h2></header>
          <div class="body">
            <div style="color:var(--color-text-muted);font-size:12px">
              The track this editor was opened for is no longer in the session.
            </div>
          </div>
        </div>
      `;
    }
    const color = t.color || "";
    return html`
      <div class="card" @click=${(e) => e.stopPropagation()}>
        <header>
          ${color ? html`<span class="swatch" style="background:${color}"></span>` : null}
          <h2>${t.name}</h2>
          <span style="font-size:10px;color:var(--color-text-muted);letter-spacing:0.08em;text-transform:uppercase">${t.kind}</span>
          ${t.kind === "midi" ? html`
            <div class="tabs">
              <button class="tab ${this._tab === "editor" ? "active" : ""}" @click=${() => this._setTab("editor")}>Track</button>
              <button class="tab ${this._tab === "midi" ? "active" : ""}" @click=${() => this._setTab("midi")}>MIDI</button>
            </div>
          ` : null}
          <button class="close" @click=${this._close}>${icon("x-mark", 16)}</button>
        </header>
        ${t.kind === "midi" && this._tab === "midi" ? html`
          <foyer-midi-manager
            style="flex:1;min-height:0"
            .trackId=${this.trackId}
            .trackName=${t.name}
          ></foyer-midi-manager>
        ` : html`<div class="content">
          <div class="form-body">
            <div class="section">
              <h3>Name</h3>
              <div class="row">
                <input type="text" autofocus .value=${t.name}
                       @change=${(e) => this._commitName(e.currentTarget.value)}
                       @keydown=${(e) => { if (e.key === "Enter") this._commitName(e.currentTarget.value); }}>
              </div>
            </div>
            <div class="section">
              <h3>Color</h3>
              <div class="row">
                <div class="swatch-row">
                  ${COLOR_PALETTE.map((c) => html`
                    <button class="swatch-btn ${color === c.hex ? "active" : ""}"
                            style="background:${c.hex}"
                            title=${c.label}
                            @click=${() => this._patch({ color: c.hex })}></button>
                  `)}
                  <button class="swatch-btn clear"
                          title="Clear color"
                          @click=${() => this._patch({ color: "" })}>×</button>
                </div>
              </div>
            </div>
            <div class="section">
              <h3>Comment</h3>
              <div class="row">
                <textarea placeholder="Notes about this track — not wired to the backend yet."
                          .value=${t.comment || ""}
                          @change=${(e) => this._patch({ comment: e.currentTarget.value })}></textarea>
              </div>
            </div>
            ${this._renderRoutingSection(t)}
          </div>
          <div class="strip-panel">
            <foyer-track-strip
              .track=${t}
              .density=${DENSITIES.normal}
              .widthMode=${"absolute"}
            ></foyer-track-strip>
          </div>
        </div>`}
      </div>
    `;
  }

  _renderRoutingSection(t) {
    const session = window.__foyer?.store?.state?.session;
    const allTracks = session?.tracks || [];
    const groups = session?.groups || [];
    // Master isn't a user-selectable bus target (that's the default
    // destination); sending to yourself is also nonsensical, filter.
    const busses = allTracks.filter(
      (tt) => (tt.kind === "bus" || tt.kind === "master") && tt.id !== t.id,
    );
    const sendableBuses = busses.filter((tt) => tt.kind === "bus");
    const sends = t.sends || [];
    const groupName = t.group_id
      ? groups.find((g) => g.id === t.group_id)?.name || t.group_id
      : null;

    // Input dropdown: the currently-wired input port is the track's
    // first input's name; the picker surface is the shim-enumerated
    // engine ports filtered to the subset that's actually useful as
    // a track input source.
    const inputs = t.inputs || [];
    const currentInput = inputs.length > 0 ? inputs[0].name : "";
    const { foyer: foyerPorts, hw: physPorts, tracks: trackPorts } =
      this._curateInputPorts(t, allTracks);

    const currentBus = t.bus_assign || "";
    // Only buses not already in this track's send list are options
    // for "Add send".
    const existingTargets = new Set(sends.map((s) => s.target_track));
    const addableBuses = sendableBuses.filter((b) => !existingTargets.has(b.id));

    return html`
      <div class="section">
        <h3>Routing</h3>
        <div class="row">
          <label>Group</label>
          <select class="fld"
            .value=${t.group_id || ""}
            @change=${(e) => this._setGroup(e.currentTarget.value)}>
            <option value="">—</option>
            ${groups.map((g) => html`<option value=${g.id}>${g.name}</option>`)}
          </select>
          <button class="refresh"
                  title="Open Group Manager"
                  @click=${() => import("./group-manager-modal.js").then((m) => m.openGroupManager())}>
            Manage…
          </button>
        </div>
        <div class="row">
          <label>Pan</label>
          <button class="refresh" @click=${() => openPanEditor(t.id)}>Open pan editor…</button>
        </div>
        <div class="row">
          <label>Input</label>
          <select class="fld"
            .value=${currentInput}
            @change=${(e) => this._setTrackInput(e.currentTarget.value)}>
            <option value="">Auto (default)</option>
            ${foyerPorts.length > 0 ? html`
              <optgroup label="Browser (foyer)">
                ${foyerPorts.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
              </optgroup>` : null}
            ${physPorts.length > 0 ? html`
              <optgroup label="Hardware">
                ${physPorts.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
              </optgroup>` : null}
            ${trackPorts.length > 0 ? html`
              <optgroup label="Other tracks">
                ${trackPorts.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
              </optgroup>` : null}
            ${(foyerPorts.length + physPorts.length + trackPorts.length) === 0 && currentInput ? html`
              <option value=${currentInput}>${currentInput}</option>` : null}
          </select>
        </div>
        ${t.kind === "midi" ? null : this._renderMicRow(currentInput)}
        ${t.kind === "audio" || t.kind === "midi" ? html`
          <div class="row">
            <label>Output bus</label>
            <select class="fld"
              .value=${currentBus}
              @change=${(e) => this._setBusAssign(e.currentTarget.value)}>
              <option value="">Master (default)</option>
              ${busses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
            </select>
          </div>` : null}
        <div class="row">
          <label>Ports</label>
          <button class="refresh" @click=${this._requestPorts}>Refresh port list</button>
        </div>

        <div class="row stacked" style="margin-top:8px">
          <label style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted)">Sends</label>
          ${sends.length === 0 ? html`
            <span class="hint">No sends on this track.</span>` : null}
          ${sends.map((s) => {
            const target = allTracks.find((tt) => tt.id === s.target_track);
            const level = Number(s.level?.value ?? 1);
            return html`
              <div class="send-row">
                <span class="target" title=${target?.name || s.target_track}>${target?.name || s.target_track}</span>
                <input type="range" min="0" max="2" step="0.01"
                       .value=${String(level)}
                       @input=${(e) => this._setSendLevel(s.id, e.currentTarget.value)}>
                <span class="num">${level.toFixed(2)}</span>
                <span class="mode">${s.pre_fader ? "pre" : "post"}</span>
                <button class="rm" title="Remove send" @click=${() => this._removeSend(s.id)}>×</button>
              </div>`;
          })}
          ${addableBuses.length > 0 ? html`
            <select class="fld"
              @change=${(e) => { this._addSend(e.currentTarget.value); e.currentTarget.value = ""; }}>
              <option value="">Add send to bus…</option>
              ${addableBuses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
            </select>` : html`
            <span class="hint">
              ${sendableBuses.length === 0 ? "No user buses in this session — create one first." : "Already sending to every available bus."}
            </span>`}
        </div>
      </div>
    `;
  }

  _renderMicRow(currentInput) {
    const live    = TRACK_MICS.get(this.trackId);
    // Button reads "Disconnect" if we own the ingress OR if the track
    // is already wired to a foyer: port (another client may have
    // hooked it up). The disconnect path handles both cases.
    const micOn   = this._micState === "active"
                 || !!live
                 || (currentInput || "").startsWith("foyer:");
    const starting = this._micState === "starting";
    const label = starting
      ? html`${icon("microphone", 14)} <span>Starting mic…</span>`
      : micOn
        ? html`${icon("microphone", 14)} <span>Disconnect browser mic</span>`
        : html`${icon("microphone", 14)} <span>Use browser mic for this track</span>`;
    const title = micOn
      ? `Stop the browser mic ingress (${live?.portName || currentInput})`
      : "Grant mic access and route this track's input to the browser capture";
    return html`
      <div class="row">
        <label></label>
        <button class="mic-btn ${micOn ? "on" : ""}"
                ?disabled=${starting}
                title=${title}
                @click=${this._toggleBrowserMic}>
          ${label}
        </button>
      </div>
      ${this._micState === "error" ? html`
        <div class="row">
          <label></label>
          <span class="hint" style="color:var(--color-danger,#c04040)">${this._micError || "Mic failed to start."}</span>
        </div>` : null}
    `;
  }

  // Trim the raw port list down to the subset that's actually useful
  // as a track input source. Ardour's `IsOutput` port set is a firehose:
  // it includes every track's `audio_out_N` (including this track's
  // own — wiring that back into the input is a feedback loop), the
  // master/monitor outputs, the click/LTC helper outputs, and so on.
  // We partition into three UX buckets: foyer ingress, hardware
  // capture, and other tracks' outputs (for pre-split / cue routing).
  _curateInputPorts(track, allTracks) {
    const ports = this._ports || [];
    // Track-kind gate: a MIDI track wired to an audio port would
    // produce silent frames (Ardour data-type mismatch) and lets the
    // user click a mic source for a MIDI track, which makes no sense.
    // For MIDI tracks we only surface MIDI-flagged ports; for audio
    // tracks we drop MIDI-flagged ports. Physical-bus/master ports
    // are filtered further below regardless.
    const isMidiTrack = track.kind === "midi";
    // Build a set of this track's own output port names so we can
    // exclude them from "Other tracks" (pre-empt the self-feedback).
    const ownOutputs = new Set((track.outputs || []).map((p) => p.name));
    const trackNames = new Set(
      allTracks.map((tt) => tt.name).filter(Boolean),
    );
    const foyer = [];
    const hw = [];
    const tracks = [];
    for (const p of ports) {
      if (!p?.name) continue;
      // Drop mismatched-kind ports up front.
      if (isMidiTrack && !p.is_midi) continue;
      if (!isMidiTrack && p.is_midi) continue;
      const n = p.name;
      if (n.startsWith("foyer:")) { foyer.push(p); continue; }
      if (p.is_physical) { hw.push(p); continue; }
      // Filter out Ardour's always-present helper outputs. These
      // aren't useful as track inputs and just clutter the picker.
      if (/^ardour:(Master|Monitor|Click|LTC-Out)\b/i.test(n)) continue;
      if (n === "ardour:LTC-Out") continue;
      if (ownOutputs.has(n)) continue;
      // Keep track/bus outputs keyed as "ardour:<name>/audio_out_N".
      // Drop anything that doesn't resolve to a route name the user
      // can recognize — unknown internal ports are rarely useful.
      const m = /^ardour:(.+?)\/audio_out/.exec(n);
      if (m && trackNames.has(m[1])) {
        // Skip this track's own outputs even if the name matches
        // by string rather than port id.
        if (m[1] === track.name) continue;
        tracks.push(p);
        continue;
      }
      // Everything else (MIDI ports, unrecognized helpers) gets dropped.
    }
    return { foyer, hw, tracks };
  }
}
customElements.define("foyer-track-editor-modal", TrackEditorModal);

export function openTrackEditor(trackId, options = {}) {
  if (!trackId) return () => {};
  const el = document.createElement("foyer-track-editor-modal");
  el.trackId = trackId;
  el.initialTab = options.tab || "";
  return import("foyer-ui-core/widgets/window.js").then((m) => m.openWindow({
    title: "Track editor",
    icon: "adjustments-horizontal",
    storageKey: `track-editor.${trackId}`,
    content: el,
    width: 720,
    height: 640,
  }));
}
