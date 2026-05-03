// MIDI manager — patch/bank/instrument inspector for a MIDI track.
//
// What this shows today (read-only, sourced from data the shim
// already emits on `session.snapshot`):
//   - The track's instrument plugin (if one is inserted).
//   - That plugin's discrete/enumerated parameters, which is where
//     most synths expose their Program / Patch / Bank selection (e.g.
//     a.fluidsynth's "bank" + "program", Sfizz's "preset", etc).
//   - The current value of each of those parameters, live via the
//     control store (so if Ardour changes the program you see it).
//
// What this intentionally does NOT do yet (tracked in docs/PLAN.md
// under "MIDI editor — full build-out" item 6):
//   - Surface per-region `patch_change` events from the MidiModel.
//     Ardour stores MIDI PC/BankSelect as events on the region's
//     Evoral::Sequence. The shim currently drops those on the floor;
//     adding them needs a `PatchChangeDesc` in schema_map.h plus a
//     `read()` block in `describe_region()` that walks
//     `model->patch_changes()`. Once exposed, this panel gains an
//     events list with add/edit/remove.
//   - Write-back from the panel. Changing a program here would mean
//     either sending `ControlSet` for the plugin parameter (already
//     works — just a UI affordance away) or, for region events,
//     shipping a new `UpdatePatchChange` command the shim translates
//     into Ardour ops.
//
// Honest scope: this is a first-class read surface that makes the
// existing data discoverable. The write side is the natural
// follow-on once the shim emits the events.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import "foyer-ui-core/widgets/param-control.js";

// Parameter kinds the shim emits where "discrete or enumerated" is
// true — these are the ones most likely to be the synth's patch /
// program / bank selector, which we promote to the summary view.
const PROGRAM_KINDS = new Set(["discrete", "enum"]);

// MIDI channel-mode constants. The schema serializes the mode as a
// lowercase string; the mask is a 16-bit bitmask with bit 0 = ch 1.
// New MIDI tracks default to ("force", 0x0001) so the picker stays
// hidden — the rationale lives in shims/ardour/src/dispatch.cc and
// crates/foyer-schema/src/session.rs alongside the field doc.
const CHANNEL_MODE_LABELS = {
  all:    "Pass through all channels",
  filter: "Record only selected channels",
  force:  "Force to a single channel",
};
const CHANNEL_DIRECTIONS = [
  { key: "capture",  label: "Inbound (record)" },
  { key: "playback", label: "Playback" },
];
const NO_BANK_SENTINELS = new Set([-1]);
const SECTION_STATE_KEY = "foyer.midi-manager.sections.v1";
const DEFAULT_SECTIONS = {
  instrument: true,
  patches: true,
  channel: false,
  parameters: false,
  inserts: false,
};
function channelMaskToList(mask) {
  const out = [];
  for (let i = 0; i < 16; ++i) if (mask & (1 << i)) out.push(i + 1);
  return out;
}
function isDefaultChannelState(track) {
  const dir = (m, k) => (track[`${k}_channel_mode`] === m);
  const mask = (k) => track[`${k}_channel_mask`] ?? 0;
  return (
    dir("force", "capture")  && mask("capture")  === 0x0001 &&
    dir("force", "playback") && mask("playback") === 0x0001
  );
}
function channelSummary(track) {
  const cm = track.capture_channel_mode  || "all";
  const pm = track.playback_channel_mode || "all";
  const cmask = track.capture_channel_mask  ?? 0;
  const pmask = track.playback_channel_mask ?? 0;
  if (cm === "force" && pm === "force" && cmask === pmask) {
    return `ch ${channelMaskToList(cmask)[0] ?? "?"}`;
  }
  if (cm === pm && cmask === pmask) {
    if (cm === "all") return "all channels";
    const list = channelMaskToList(cmask);
    return `${cm} · ${list.length === 1 ? `ch ${list[0]}` : `${list.length} ch`}`;
  }
  return "split routing";
}
function wireChannelToDisplay(ch) {
  const n = Number(ch);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(16, n + 1));
}
function displayChannelToWire(ch) {
  const n = Number(ch);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, n - 1));
}
function bankInputValue(bank) {
  if (bank == null) return "";
  const n = Number(bank);
  if (!Number.isFinite(n) || NO_BANK_SENTINELS.has(n)) return "";
  return String(Math.max(0, Math.min(16383, n)));
}
function normalizeBank(bank) {
  if (bank == null) return -1;
  const n = Number(bank);
  if (!Number.isFinite(n) || NO_BANK_SENTINELS.has(n)) return -1;
  return Math.max(0, Math.min(16383, n));
}
function midnamBankToPatchBank(bank) {
  const n = Number(bank);
  if (!Number.isFinite(n) || n < 0) return -1;
  // Ardour/MidNAM can expose 0xffff for the 127/127 bank. Evoral
  // PatchChange stores banks as a 14-bit MSB<<7 | LSB value.
  return n & 0x3fff;
}
function displayBankLabel(bank) {
  const n = normalizeBank(midnamBankToPatchBank(bank));
  return n < 0 ? "" : String(n);
}
function bankToMsbLsb(bank) {
  const n = normalizeBank(bank);
  const safe = n < 0 ? 0 : n;
  return { msb: (safe >> 7) & 0x7f, lsb: safe & 0x7f };
}
function msbLsbToBank(msb, lsb) {
  const m = Math.max(0, Math.min(127, Number(msb) || 0));
  const l = Math.max(0, Math.min(127, Number(lsb) || 0));
  return (m << 7) | l;
}

export class MidiManager extends LitElement {
  static properties = {
    trackId:   { type: String, attribute: "track-id" },
    trackName: { type: String, attribute: "track-name" },
    mode:      { type: String },
    _tick:     { state: true, type: Number },
    _regions:  { state: true, type: Array },
    _presets:  { state: true, type: Array },
    /// User-clicked the channel chip — surface the controls even if
    /// the track is in the default ForceChannel + 0x0001 state.
    /// Otherwise the section auto-hides.
    _channelExpanded: { state: true, type: Boolean },
    _tab: { state: true, type: String },
    _pickerOpen: { state: true, type: Boolean },
    _pickerRegionId: { state: true, type: String },
    _pickerPatchId: { state: true, type: String },
    _pickerChannel: { state: true, type: Number },
    _pickerBank: { state: true, type: Number },
    _pickerProgram: { state: true, type: Number },
    _patchNames: { state: true, type: Object },
    _patchNamesFor: { state: true, type: String },
    _patchNamesLoading: { state: true, type: Boolean },
    _sections: { state: true, type: Object },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 12px;
    }
    .tb {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      flex: 0 0 auto;
      font-size: 11px;
    }
    .tb .title { color: var(--color-text); font-weight: 600; font-size: 13px; }
    .body {
      flex: 1; min-height: 0;
      overflow: auto;
      padding: 14px 16px;
      display: flex; flex-direction: column; gap: 16px;
    }
    section {
      display: flex; flex-direction: column; gap: 8px;
    }
    section h3 {
      margin: 0; font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .fold {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .fold-head {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      padding: 0;
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .fold-head .chev {
      display: inline-flex;
      transition: transform 0.12s ease;
    }
    .fold.open .fold-head .chev {
      transform: rotate(90deg);
    }
    .fold-head .label {
      color: var(--color-text-muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .fold-head .summary {
      min-width: 0;
      flex: 1;
      color: var(--color-text-muted);
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fold-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 4px);
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .card.missing {
      border-style: dashed;
      border-color: var(--color-warning, #f59e0b);
      background: color-mix(in oklab, var(--color-warning, #f59e0b) 6%, var(--color-surface-muted));
    }
    .card.muted {
      color: var(--color-text-muted);
      background: transparent;
      border-style: dashed;
    }
    .card.missing .name { color: var(--color-warning, #f59e0b); }
    .warn { color: var(--color-warning, #f59e0b); display: flex; align-items: center; gap: 4px; }
    /* Channel chip in the toolbar — buried-but-discoverable button
     * for accessing the channel-routing controls when the track is
     * in the default single-channel state. Shows a tinted/borderless
     * pill in the default state ("bury") and a more prominent border
     * in non-default state ("surface"). */
    .chan-chip {
      background: transparent;
      border: 1px solid transparent;
      color: var(--color-text-muted);
      padding: 2px 8px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit; font-size: 10px;
      letter-spacing: 0.04em;
    }
    .chan-chip:hover {
      background: var(--color-surface);
      color: var(--color-text);
    }
    .chan-chip.surfaced {
      border-color: var(--color-accent-2, #38bdf8);
      color: var(--color-accent-2, #38bdf8);
    }
    .chan-block {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 14px;
      align-items: center;
    }
    .chan-block .dir-label {
      font-size: 11px;
      color: var(--color-text-muted);
      letter-spacing: 0.04em;
    }
    .chan-block select {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 3px 6px;
      border-radius: var(--radius-sm, 4px);
      font: inherit; font-size: 11px;
    }
    .chan-block .ch-grid {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 3px;
      max-width: 360px;
    }
    .chan-block .ch-cell {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 3px 0;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .chan-block .ch-cell.on {
      background: var(--color-accent, #7c5cff);
      color: #fff;
      border-color: transparent;
    }
    .chan-block .ch-cell:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(140px, 1fr) auto minmax(80px, 1fr);
      gap: 10px; align-items: center;
      font-size: 12px;
    }
    .row .label { color: var(--color-text); font-weight: 500; }
    .row .kind {
      font-size: 9px; color: var(--color-text-muted);
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .row .value {
      font-variant-numeric: tabular-nums;
      color: var(--color-accent, #7c5cff);
      text-align: right;
    }
    .plugin-head {
      display: flex; align-items: center; gap: 10px;
      justify-content: space-between;
    }
    .plugin-head .name { font-weight: 600; }
    .plugin-head .uri {
      font-size: 10px; color: var(--color-text-muted);
      font-family: var(--font-mono, monospace);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      min-width: 0;
    }
    .actions {
      display: flex; gap: 6px; align-items: center;
      flex-wrap: wrap;
    }
    .actions button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 4px 10px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
    }
    .actions button:hover {
      background: var(--color-surface);
    }
    .actions button.primary {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff; border-color: transparent;
    }
    .actions button.danger {
      color: var(--color-danger, #ef4444);
      border-color: color-mix(in oklab, var(--color-danger, #ef4444) 35%, var(--color-border) 65%);
    }
    .actions button.danger:hover {
      background: color-mix(in oklab, var(--color-danger, #ef4444) 10%, transparent);
    }
    .row-head {
      display: grid;
      grid-template-columns: minmax(120px, 1.5fr) repeat(4, minmax(60px, 1fr)) 76px;
      gap: 6px;
      font-size: 10px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 4px 6px;
      border-bottom: 1px solid var(--color-border);
    }
    .pc-row {
      display: grid;
      grid-template-columns: minmax(120px, 1.5fr) repeat(4, minmax(60px, 1fr)) 76px;
      gap: 6px; align-items: center;
      padding: 4px 4px;
      font-size: 11px;
    }
    .pc-row .label {
      color: var(--color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pc-row input.num {
      width: 100%; padding: 3px 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm, 4px);
      font: inherit; font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .pc-row button.danger {
      background: transparent;
      border: 1px solid color-mix(in oklab, var(--color-danger, #ef4444) 35%, var(--color-border) 65%);
      color: var(--color-danger, #ef4444);
      padding: 2px 4px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .pc-actions {
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .pc-actions button.pick {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 10px;
    }
    .pc-actions button.pick:hover {
      border-color: var(--color-accent);
      color: var(--color-text);
    }
    .patch-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .patch-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 4px);
      padding: 10px 12px;
    }
    .patch-summary {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) minmax(150px, 2fr) auto;
      gap: 10px;
      align-items: center;
    }
    .patch-summary .region {
      color: var(--color-text);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .patch-summary .choice {
      color: var(--color-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    details.advanced {
      border-top: 1px solid var(--color-border);
      padding-top: 6px;
    }
    details.advanced > summary {
      cursor: pointer;
      color: var(--color-text-muted);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .inline-picker {
      border-top: 1px solid var(--color-border);
      padding-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .preset-group {
      font-size: 10px; color: var(--color-text-muted);
      letter-spacing: 0.08em; text-transform: uppercase;
      margin: 8px 0 4px;
    }
    .preset-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 4px;
    }
    .preset-grid .preset {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm, 4px);
      color: var(--color-text);
      padding: 4px 8px;
      font: inherit; font-size: 11px;
      cursor: pointer;
      text-align: left;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .preset-grid .preset:hover {
      background: var(--color-surface-muted);
      border-color: var(--color-accent);
    }
    .reload {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      padding: 2px 8px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 10px;
    }
    .reload:hover { color: var(--color-text); }
    .hint {
      color: var(--color-text-muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted);
    }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 2200;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .modal-card {
      width: min(900px, 92vw);
      max-height: min(760px, 90vh);
      display: flex;
      flex-direction: column;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md, 8px);
      box-shadow: var(--shadow-panel);
      overflow: hidden;
    }
    .modal-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .modal-head .title { font-size: 12px; font-weight: 600; color: var(--color-text); }
    .modal-head .spacer { flex: 1; }
    .modal-head button.close {
      background: transparent; border: 0; color: var(--color-text-muted);
      cursor: pointer; padding: 4px;
    }
    .modal-body {
      display: flex; flex-direction: column; gap: 10px;
      padding: 12px 14px;
      overflow: auto;
    }
    .picker-row {
      display: grid;
      grid-template-columns: 110px 1fr;
      align-items: center;
      gap: 8px;
    }
    .picker-row label { color: var(--color-text-muted); font-size: 11px; }
    .picker-row select {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm, 4px);
      padding: 4px 8px;
      font: inherit;
      font-size: 11px;
    }
    .program-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 6px;
    }
    .program-btn {
      text-align: left;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm, 4px);
      padding: 6px 8px;
      cursor: pointer;
      font: inherit; font-size: 11px;
      line-height: 1.35;
    }
    .program-btn:hover {
      border-color: var(--color-accent);
    }
    .program-btn.active {
      border-color: transparent;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .modal-foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .modal-foot button {
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text);
      border-radius: var(--radius-sm, 4px);
      padding: 4px 10px;
      font: inherit; font-size: 11px;
      cursor: pointer;
    }
    .modal-foot button.primary {
      border-color: transparent;
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
    }
  `;

  constructor() {
    super();
    this.trackId = "";
    this.trackName = "";
    this.mode = "all";
    this._tick = 0;
    this._regions = [];
    this._presets = [];
    this._presetsForPluginId = "";
    this._tab = "setup";
    this._pickerOpen = false;
    this._pickerRegionId = "";
    this._pickerPatchId = "";
    this._pickerChannel = 0;
    this._pickerBank = 0;
    this._pickerProgram = 0;
    this._patchNames = null;
    this._patchNamesFor = "";
    this._patchNamesLoading = false;
    this._sections = this._loadSections();
    this._storeHandler = () => { this._tick++; };
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener("change",  this._storeHandler);
    window.__foyer?.store?.addEventListener("control", this._storeHandler);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      // Ask for this track's regions up front — the timeline may have
      // already fetched them but we don't have access to that cache,
      // and the backend is cheap to re-list.
      if (this.trackId) ws.send({ type: "list_regions", track_id: this.trackId });
    }
  }
  disconnectedCallback() {
    window.__foyer?.store?.removeEventListener("change",  this._storeHandler);
    window.__foyer?.store?.removeEventListener("control", this._storeHandler);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "regions_list" && body.track_id === this.trackId) {
      this._regions = body.regions || [];
    } else if (body.type === "region_updated" && body.region?.track_id === this.trackId) {
      const i = this._regions.findIndex((r) => r.id === body.region.id);
      if (i >= 0) {
        const copy = this._regions.slice();
        copy[i] = body.region;
        this._regions = copy;
      } else {
        this._regions = [...this._regions, body.region];
      }
    } else if (body.type === "region_removed" && body.track_id === this.trackId) {
      this._regions = this._regions.filter((r) => r.id !== body.region_id);
    } else if (body.type === "plugin_presets_listed"
            && body.plugin_id === this._presetsForPluginId) {
      this._presets = body.presets || [];
    } else if (body.type === "midi_patch_names_listed"
            && body.track_id === this.trackId) {
      this._patchNames = body.names || null;
      this._patchNamesFor = `${this.trackId}:${body.names?.channel ?? 0}`;
      this._patchNamesLoading = false;
      if (this._pickerOpen) this._ensurePickerBankForNames(body.names);
    }
  }

  _requestPatchNamesForWireChannel(wireChannel) {
    if (!this.trackId) return;
    const ch = Math.max(0, Math.min(15, Number(wireChannel) || 0));
    const key = `${this.trackId}:${ch}`;
    if (this._patchNamesFor === key && this._patchNames) return;
    this._patchNamesLoading = true;
    window.__foyer?.ws?.send({
      type: "list_midi_patch_names",
      track_id: this.trackId,
      channel: ch,
    });
  }

  _defaultPickerBankFromNames(names = this._patchNames) {
    const firstBank = (names?.banks || []).find((b) => b?.programs?.length);
    return midnamBankToPatchBank(firstBank?.bank);
  }

  _requestPresetsFor(pluginId) {
    if (!pluginId) return;
    if (this._presetsForPluginId === pluginId && this._presets.length > 0) return;
    this._presetsForPluginId = pluginId;
    this._presets = [];
    window.__foyer?.ws?.send({ type: "list_plugin_presets", plugin_id: pluginId });
  }

  _loadSections() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SECTION_STATE_KEY) || "{}");
      return { ...DEFAULT_SECTIONS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      return { ...DEFAULT_SECTIONS };
    }
  }

  _setSection(id, open) {
    const next = { ...this._sections, [id]: !!open };
    this._sections = next;
    try {
      localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(next));
    } catch {}
  }

  _sectionOpen(id) {
    return this._sections?.[id] ?? DEFAULT_SECTIONS[id] ?? true;
  }

  _renderFold(id, label, summary, body) {
    const open = this._sectionOpen(id);
    return html`
      <section class="fold ${open ? "open" : ""}">
        <button class="fold-head" @click=${() => this._setSection(id, !open)}>
          <span class="chev">${icon("chevron-right", 12)}</span>
          <span class="label">${label}</span>
          ${summary ? html`<span class="summary">${summary}</span>` : html`<span class="summary"></span>`}
        </button>
        ${open ? html`<div class="fold-body">${body}</div>` : null}
      </section>
    `;
  }

  _loadPreset(pluginId, presetId) {
    window.__foyer?.ws?.send({ type: "load_plugin_preset", plugin_id: pluginId, preset_id: presetId });
  }

  _renderPresetList(instrument) {
    // Lazily fetch on first render for this plugin.
    if (this._presetsForPluginId !== instrument.id) {
      Promise.resolve().then(() => this._requestPresetsFor(instrument.id));
    }
    const list = this._presets || [];
    const factory = list.filter((p) => p.is_factory !== false);
    const user    = list.filter((p) => p.is_factory === false);
    const group = (items) => html`
      <div class="preset-grid">
        ${items.map((p) => html`
          <button class="preset" title=${p.id}
                  @click=${() => this._loadPreset(instrument.id, p.id)}>
            ${p.name || p.id}
          </button>
        `)}
      </div>
    `;
    return html`
      <div class="card" style="margin-top:8px">
        <div class="plugin-head">
          <div class="name" style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-text-muted)">
            Presets · ${list.length}
          </div>
          <button class="reload" title="Refresh preset list"
                  @click=${() => { this._presetsForPluginId = ""; this._requestPresetsFor(instrument.id); }}>
            Refresh
          </button>
        </div>
        ${list.length === 0 ? html`
          <div class="hint">
            ${this._presetsForPluginId === instrument.id
              ? "No presets exposed by this plugin."
              : "Loading…"}
          </div>
        ` : html`
          ${factory.length > 0 ? html`
            <div class="preset-group">Factory</div>
            ${group(factory)}
          ` : null}
          ${user.length > 0 ? html`
            <div class="preset-group">User</div>
            ${group(user)}
          ` : null}
        `}
      </div>
    `;
  }

  _renderPatchChanges() {
    const allPcs = [];
    for (const r of this._regions) {
      for (const pc of r.patch_changes || []) {
        allPcs.push({ region: r, pc });
      }
    }
    allPcs.sort(
      (a, b) => (a.region.start_samples || 0) - (b.region.start_samples || 0)
              || (a.pc.start_ticks || 0) - (b.pc.start_ticks || 0),
    );
    const firstMidiRegion = this._regions[0];
    const liveSummary = this._livePatchSummary();
    return html`
      <div class="card muted">
        <div class="row">
          <span class="label">Current live patch</span>
          <span class="value">${liveSummary}</span>
        </div>
      </div>
      ${allPcs.length === 0
        ? html`
            <div class="card muted">
              No program / bank change events on this track's regions.
              Add one to trigger a patch change at a specific point in a
              region.
            </div>
          `
        : html`
            <div class="patch-list">
              ${allPcs.map(({ region, pc }) => {
                const selected = this._pickerOpen
                  && this._pickerRegionId === region.id
                  && this._pickerPatchId === pc.id;
                return html`
                  <div class="patch-card">
                    <div class="patch-summary">
                      <span class="region" title=${region.name}>${region.name}</span>
                      <span class="choice">
                        Ch ${wireChannelToDisplay(pc.channel ?? 0)}
                        · ${normalizeBank(pc.bank) < 0 ? "program only" : `bank ${normalizeBank(pc.bank)}`}
                        · program ${Number(pc.program ?? 0) + 1}
                      </span>
                      <span class="pc-actions">
                        <button class="pick" @click=${() => selected ? this._closePatchPicker() : this._openPatchPicker(region, pc)}>
                          ${selected ? "Close" : "Pick…"}
                        </button>
                        <button class="danger" @click=${() => this._deletePatchChange(region, pc)}>
                          ${icon("trash", 12)}
                        </button>
                      </span>
                    </div>
                    ${selected ? this._renderPatchPickerInline(region, pc) : null}
                    <details class="advanced">
                      <summary>Advanced event fields</summary>
                      <div class="row-head" style="margin-top:8px">
                        <span>Region</span>
                        <span>Time (ticks)</span>
                        <span>Ch</span>
                        <span>Bank</span>
                        <span>Prog</span>
                        <span></span>
                      </div>
                      <div class="pc-row">
                        <span class="label">${region.name}</span>
                        <input class="num" type="number" min="0" step="1"
                               .value=${String(pc.start_ticks ?? 0)}
                               @change=${(e) => this._editPatchChange(region, pc, { start_ticks: Math.max(0, Number(e.currentTarget.value) || 0) })}>
                        <input class="num" type="number" min="1" max="16" step="1"
                               .value=${String(wireChannelToDisplay(pc.channel ?? 0))}
                               @change=${(e) => this._editPatchChange(region, pc, { channel: displayChannelToWire(e.currentTarget.value) })}>
                        <input class="num" type="number" step="1"
                               placeholder="—"
                               .value=${bankInputValue(pc.bank)}
                               @change=${(e) => {
                                 const v = e.currentTarget.value.trim();
                                 const next = v === "" ? -1 : Math.max(0, Math.min(16383, Number(v) || 0));
                                 this._editPatchChange(region, pc, { bank: next });
                               }}>
                        <input class="num" type="number" min="0" max="127" step="1"
                               .value=${String(pc.program ?? 0)}
                               @change=${(e) => this._editPatchChange(region, pc, { program: Math.max(0, Math.min(127, Number(e.currentTarget.value) || 0)) })}>
                        <span></span>
                      </div>
                    </details>
                  </div>
                `;
              })}
            </div>
          `}
        ${firstMidiRegion ? html`
          <div class="actions">
            <button class="primary" @click=${() => this._addPatchChangeTo(firstMidiRegion)}>
              Add patch change…
            </button>
            <span class="hint" style="padding-left:6px;font-size:10px">
              Drops a new PC at tick 0 of <em>${firstMidiRegion.name}</em>.
              Edit the row to retarget.
            </span>
          </div>
        ` : html`
          <div class="hint">
            This track has no regions yet — create one in the
            timeline to host patch-change events.
          </div>
        `}
    `;
  }

  _addPatchChangeTo(region) {
    const ws = window.__foyer?.ws;
    if (!ws || !region?.id) return;
    const track = this._track();
    const playbackMask = track?.playback_channel_mask ?? 0x0001;
    const defaultChannel = channelMaskToList(playbackMask)[0] ?? 1;
    const live = this._trackMidiPatch(displayChannelToWire(defaultChannel));
    const pc = {
      // Server generates the real id via Evoral event_id; this
      // optimistic prefix is harmless because AddPatchChange echos
      // with the authoritative id, and our region list gets replaced.
      id: `patchchange.opt.${Math.random().toString(36).slice(2)}`,
      channel: displayChannelToWire(defaultChannel),
      program: live?.program ?? 0,
      bank: normalizeBank(live?.bank),
      start_ticks: 0,
    };
    ws.send({ type: "add_patch_change", region_id: region.id, patch_change: pc });
  }

  _editPatchChange(region, pc, patch) {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    ws.send({
      type: "update_patch_change",
      region_id: region.id,
      patch_change_id: pc.id,
      patch,
    });
  }

  _deletePatchChange(region, pc) {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    ws.send({
      type: "delete_patch_change",
      region_id: region.id,
      patch_change_id: pc.id,
    });
  }
  _openPatchPicker(region, pc) {
    const live = this._trackMidiPatch(pc?.channel ?? 0);
    this._pickerRegionId = region?.id || "";
    this._pickerPatchId = pc?.id || "";
    this._pickerChannel = pc?.channel ?? 0;
    this._pickerBank = normalizeBank(live?.bank ?? pc?.bank);
    this._pickerProgram = live?.program ?? pc?.program ?? 0;
    this._requestPatchNamesForWireChannel(this._pickerChannel);
    this._ensurePickerBankForNames();
    this._pickerOpen = true;
  }
  _closePatchPicker() {
    this._pickerOpen = false;
  }
  _pickerBanks() {
    return (this._patchNames?.banks || []).filter((b) => midnamBankToPatchBank(b.bank) >= 0);
  }
  _pickerProgramBank() {
    if (this._pickerBank >= 0) {
      return (this._patchNames?.banks || []).find((b) => midnamBankToPatchBank(b.bank) === normalizeBank(this._pickerBank));
    }
    return null;
  }
  _trackMidiPatch(channel = 0) {
    const ch = Math.max(0, Math.min(15, Number(channel) || 0));
    return (this._track()?.midi_patches || []).find((p) => Number(p.channel) === ch) || null;
  }
  _livePatchSummary(track = this._track()) {
    const playbackMask = track?.playback_channel_mask ?? 0x0001;
    const displayChannel = channelMaskToList(playbackMask)[0] ?? 1;
    const live = this._trackMidiPatch(displayChannelToWire(displayChannel));
    if (!live) return "live patch unknown";
    const bank = normalizeBank(live.bank);
    return `live ch ${wireChannelToDisplay(live.channel)} · ${bank < 0 ? "program only" : `bank ${bank}`} · program ${Number(live.program ?? 0) + 1}`;
  }
  _ensurePickerBankForNames(names = this._patchNames) {
    if (this._patchNamesFor !== `${this.trackId}:${this._pickerChannel}`) return;
    const banks = names?.banks || [];
    if (banks.length === 0) return;
    if (this._pickerBank >= 0) {
      const hasBank = banks.some((b) => midnamBankToPatchBank(b.bank) === normalizeBank(this._pickerBank));
      if (hasBank) return;
    }
    const nextBank = this._defaultPickerBankFromNames(names);
    if (nextBank >= 0) this._pickerBank = nextBank;
  }
  _pickerPrograms() {
    const bank = this._pickerProgramBank();
    if (bank?.programs?.length) {
      const byProgram = new Map(bank.programs.map((p) => [Number(p.program), p.name || `Program ${Number(p.program) + 1}`]));
      const out = [];
      for (let i = 0; i < 128; i += 1) out.push({ program: i, name: byProgram.get(i) || `Program ${i + 1}` });
      return out;
    }
    const out = [];
    for (let i = 0; i < 128; i += 1) out.push({ program: i, name: `Program ${i + 1}` });
    return out;
  }
  _commitPatchPicker() {
    const bank = normalizeBank(this._pickerBank);
    if (this._pickerRegionId && this._pickerPatchId) {
      const region = this._regions.find((r) => r.id === this._pickerRegionId);
      const pc = region?.patch_changes?.find((p) => p.id === this._pickerPatchId);
      if (region && pc) {
        this._editPatchChange(region, pc, {
          channel: this._pickerChannel,
          bank,
          program: this._pickerProgram,
        });
      }
    }
    window.__foyer?.ws?.send({
      type: "set_track_midi_patch",
      track_id: this.trackId,
      channel: this._pickerChannel,
      bank,
      program: this._pickerProgram,
    });
  }

  _track() {
    const s = window.__foyer?.store?.state?.session;
    return s?.tracks?.find((t) => t.id === this.trackId) || null;
  }

  _currentValue(param) {
    if (!param) return undefined;
    const store = window.__foyer?.store;
    const live = store?.get(param.id);
    if (live !== undefined) {
      return typeof live === "object" && live !== null && "Float" in live
        ? live.Float
        : live;
    }
    const raw = param.value;
    if (raw && typeof raw === "object" && "Float" in raw) return raw.Float;
    return raw;
  }
  _setParam(param, value) {
    if (!param?.id) return;
    window.__foyer?.ws?.controlSet(param.id, value);
  }

  _setChannelMode(direction, mode, mask) {
    if (!this.trackId) return;
    window.__foyer?.ws?.send({
      type: "set_track_midi_channel_mode",
      track_id: this.trackId,
      direction,
      mode,
      mask: mask & 0xffff,
    });
  }
  _onModeChange(direction, ev) {
    const t = this._track();
    const mode = ev.target.value;
    const cur = t?.[`${direction}_channel_mask`] ?? 0x0001;
    // Force-mode collapses the mask to a single channel — preserve
    // the current channel if it was a force selection, otherwise pick
    // the lowest set bit, defaulting to ch 1.
    let mask = cur;
    if (mode === "force") {
      const bit = cur ? Math.log2(cur & -cur) | 0 : 0;
      mask = 1 << bit;
    } else if (mode === "all") {
      mask = 0xffff;
    } else if (mode === "filter" && cur === 0) {
      mask = 0x0001;
    }
    this._setChannelMode(direction, mode, mask);
  }
  _onChannelClick(direction, channelIdx) {
    const t = this._track();
    const mode = t?.[`${direction}_channel_mode`] || "all";
    const cur = t?.[`${direction}_channel_mask`] ?? 0x0001;
    const bit = 1 << channelIdx;
    let next = cur;
    if (mode === "force") {
      next = bit;
    } else if (mode === "filter") {
      next = cur ^ bit;
      if (!next) next = bit; // refuse to disable every channel
    } else {
      // mode === "all" — clicking a channel switches us to filter
      // semantics with just that channel enabled.
      this._setChannelMode(direction, "filter", bit);
      return;
    }
    this._setChannelMode(direction, mode, next);
  }

  _openInstrumentPicker({ replace = false } = {}) {
    const t = this._track();
    import("./plugin-picker-modal.js").then((m) => {
      m.openInstrumentPicker({
        trackId: this.trackId,
        trackName: t?.name || this.trackName,
        replace,
      });
    });
  }
  _removeInstrument() {
    const t = this._track();
    const current = (t?.plugins || [])[0];
    if (!current?.id) return;
    window.__foyer?.ws?.send({ type: "remove_plugin", plugin_id: current.id });
  }
  _toggleBypass(pluginId, bypassed) {
    // Plugin bypass is expressed as a control set on `plugin.<id>.bypass`.
    const id = `${pluginId}.bypass`;
    window.__foyer?.ws?.send({ type: "control_set", id, value: bypassed ? 0 : 1 });
  }

  _renderChannelSection(track) {
    // Rendered above "Instrument" and only when the track is in a
    // non-default state OR the user explicitly opened the chip. Keeps
    // multi-channel routing out of the way for the 95% of MIDI tracks
    // that don't need it (TODO #270).
    return html`
      <div class="card">
        ${CHANNEL_DIRECTIONS.map(({ key, label }) => {
          const mode = track[`${key}_channel_mode`] || "all";
          const mask = track[`${key}_channel_mask`] ?? 0x0001;
          const channelDisabled = mode === "all";
          const cells = [];
          for (let i = 0; i < 16; ++i) {
            const on = !!(mask & (1 << i));
            cells.push(html`
              <button
                class="ch-cell ${on ? "on" : ""}"
                ?disabled=${channelDisabled}
                @click=${() => this._onChannelClick(key, i)}
              >${i + 1}</button>
            `);
          }
          return html`
            <div class="chan-block">
              <span class="dir-label">${label}</span>
              <select
                .value=${mode}
                @change=${(e) => this._onModeChange(key, e)}
              >
                ${Object.entries(CHANNEL_MODE_LABELS).map(([m, lbl]) => html`
                  <option value=${m} ?selected=${m === mode}>${lbl}</option>
                `)}
              </select>
              <span></span>
              <div class="ch-grid">${cells}</div>
            </div>
          `;
        })}
      </div>
      <div class="hint">
        New MIDI tracks are forced to channel 1 by default. Switch a
        direction off "force" to record from or play to multiple
        channels; most synths only listen on one.
      </div>
    `;
  }

  render() {
    const t = this._track();
    if (!t) {
      return html`
        <div class="empty">
          Track not found. It may have been removed from the session.
        </div>
      `;
    }

    const plugins = t.plugins || [];
    // First plugin on a MIDI track is almost always the instrument.
    const instrument = plugins[0] || null;
    const otherPlugins = plugins.slice(1);

    const programLike = (instrument?.params || []).filter(
      (p) => PROGRAM_KINDS.has(p.kind) && !p.id?.endsWith(".bypass"),
    );

    const inDefault = isDefaultChannelState(t);
    const channelLabel = channelSummary(t);
    const sectionMode = this.mode || "all";
    const showSetup = sectionMode !== "patches";
    const showPatches = sectionMode !== "setup";
    const patchEventCount = this._regions.reduce((n, r) => n + (r.patch_changes?.length || 0), 0);

    return html`
      <div class="tb">
        <span class="title">${this.trackName || t.name}</span>
        <span>· MIDI</span>
        <span style="flex:1"></span>
        <button
          class="chan-chip ${inDefault ? "" : "surfaced"}"
          title="Current MIDI channel routing"
          @click=${() => this._setSection("channel", !this._sectionOpen("channel"))}
        >${channelLabel}</button>
        <span>· ${t.plugins?.length || 0} plugin${(t.plugins?.length === 1) ? "" : "s"}</span>
      </div>

      <div class="body">
        ${showSetup ? html`
          <section>
            <h3>Instrument</h3>
            ${instrument ? html`
              <div class="card ${instrument.missing ? "missing" : ""}">
                <div class="plugin-head">
                  <div>
                    <div class="name">${instrument.name}</div>
                    <div class="uri">${instrument.uri || ""}</div>
                  </div>
                  <div class="kind">${instrument.missing ? "missing" : (instrument.bypassed ? "bypassed" : "active")}</div>
                </div>
                ${instrument.missing ? html`
                  <div class="warn">
                    ${icon("exclamation-triangle", 12)}
                    Plugin binary is missing or unloadable.
                  </div>` : null}
                <div class="actions">
                  <button @click=${() => this._openInstrumentPicker({ replace: true })}>
                    Change…
                  </button>
                  <button
                    ?disabled=${instrument.missing}
                    @click=${() => this._toggleBypass(instrument.id, instrument.bypassed)}
                  >
                    ${instrument.bypassed ? "Unbypass" : "Bypass"}
                  </button>
                  <button class="danger" @click=${() => this._removeInstrument()}>
                    Remove
                  </button>
                </div>
              </div>
              ${this._renderPresetList(instrument)}
            ` : html`
              <div class="card muted">
                No instrument plugin on this track. Ardour will still
                record + play back the MIDI, but there's no synth to
                turn notes into audio.
                <div class="actions" style="margin-top:10px">
                  <button class="primary" @click=${() => this._openInstrumentPicker()}>
                    Add instrument…
                  </button>
                </div>
              </div>
            `}
          </section>
          ${this._renderFold("channel", "MIDI channel", channelLabel, this._renderChannelSection(t))}
          ${this._renderFold("parameters", "Instrument parameters", programLike.length > 0 ? `${programLike.length} parameter${programLike.length === 1 ? "" : "s"}` : "none exposed", html`
            ${programLike.length > 0 ? html`
              <div class="card" style="gap:8px">
                ${programLike.map((p) => html`
                  <foyer-param-control
                    .param=${p}
                    .value=${this._currentValue(p)}
                    .size=${36}
                    widget="auto"
                    @input=${(e) => this._setParam(p, e.detail)}
                    @change=${(e) => this._setParam(p, e.detail)}
                  ></foyer-param-control>
                `)}
              </div>
              <div class="hint">
                Discrete / enum parameters on the instrument. Synths
                route program / bank selection through these — change
                a value and the patch updates immediately. (If the synth
                doesn't expose a parameter for program, use the
                "Patches &amp; banks" section above instead.)
              </div>
            ` : html`
              <div class="card muted">
                The instrument on this track doesn't expose any
                discrete / enumerated parameters, so there's no
                plugin-side patch selector to display here. Use the
                "Patches &amp; banks" section above to send standard
                MIDI program-change events to the instrument.
              </div>
            `}
          `)}
          ${otherPlugins.length > 0 ? html`
            <section>
              <h3>Inserts</h3>
              <div class="card">
                ${otherPlugins.map((pi) => html`
                  <div class="row">
                    <span class="label">${pi.name}</span>
                    <span class="kind">${pi.bypassed ? "bypassed" : "active"}</span>
                    <span class="value">${pi.params?.length ?? 0} params</span>
                  </div>
                `)}
              </div>
            </section>
          ` : null}
        ` : null}

        ${showPatches ? this._renderFold(
          "patches",
          "Patches & banks",
          `${this._livePatchSummary(t)} · ${patchEventCount} event${patchEventCount === 1 ? "" : "s"}`,
          this._renderPatchChanges(),
        ) : null}
      </div>
    `;
  }
  _renderPatchPickerInline() {
    const banks = this._pickerBanks();
    const programs = this._pickerPrograms();
    const currentBank = this._pickerProgramBank() || banks[0];
    const bankValue = this._pickerBank < 0 ? 0 : this._pickerBank;
    const { msb, lsb } = bankToMsbLsb(bankValue);
    const model = this._patchNames?.model || "";
    const mode = this._patchNames?.mode || "";
    return html`
      <div class="inline-picker">
        <div class="picker-row">
          <label>Bank</label>
          <select
            .value=${String(normalizeBank(this._pickerBank))}
            @change=${(e) => {
              this._pickerBank = normalizeBank(e.currentTarget.value);
              this._commitPatchPicker();
            }}
          >
            <option value="-1">Program only</option>
            ${banks.map((b) => html`
              <option value=${String(midnamBankToPatchBank(b.bank))}>${b.name || `Bank ${displayBankLabel(b.bank)}`}</option>
            `)}
          </select>
        </div>
        ${(model || mode) ? html`
          <div class="hint">
            ${model ? `Model: ${model}` : ""}${model && mode ? " · " : ""}${mode ? `Mode: ${mode}` : ""}
          </div>
        ` : null}
        ${this._patchNamesLoading ? html`<div class="hint">Loading patch names from Ardour…</div>` : null}
        <div class="hint">
          ${currentBank?.name || "Program only"} · pick a program:
        </div>
        <div class="program-grid">
          ${programs.map((p) => html`
            <button
              class="program-btn ${this._pickerProgram === p.program ? "active" : ""}"
              @click=${() => {
                this._pickerProgram = p.program;
                this._commitPatchPicker();
              }}
              title=${`Program ${p.program + 1}`}
            >
              ${p.program + 1}. ${p.name}
            </button>
          `)}
        </div>
        <details class="advanced">
          <summary>Advanced MIDI event fields</summary>
          <div class="picker-row" style="margin-top:8px">
            <label>Channel</label>
            <select
              .value=${String(wireChannelToDisplay(this._pickerChannel))}
              @change=${(e) => {
                this._pickerChannel = displayChannelToWire(e.currentTarget.value);
                this._requestPatchNamesForWireChannel(this._pickerChannel);
                this._commitPatchPicker();
              }}
            >
              ${Array.from({ length: 16 }).map((_, i) => html`
                <option value=${String(i + 1)}>${i + 1}</option>
              `)}
            </select>
          </div>
          <div class="picker-row" style="margin-top:8px">
            <label>MSB / LSB</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <input class="num" type="number" min="0" max="127" step="1"
                     .value=${String(msb)}
                     @change=${(e) => {
                       this._pickerBank = msbLsbToBank(e.currentTarget.value, lsb);
                       this._commitPatchPicker();
                     }}>
              <input class="num" type="number" min="0" max="127" step="1"
                     .value=${String(lsb)}
                     @change=${(e) => {
                       this._pickerBank = msbLsbToBank(msb, e.currentTarget.value);
                       this._commitPatchPicker();
                     }}>
            </div>
          </div>
        </details>
      </div>
    `;
  }
}
customElements.define("foyer-midi-manager", MidiManager);
