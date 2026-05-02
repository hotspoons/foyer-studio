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

export class MidiManager extends LitElement {
  static properties = {
    trackId:   { type: String, attribute: "track-id" },
    trackName: { type: String, attribute: "track-name" },
    _tick:     { state: true, type: Number },
    _regions:  { state: true, type: Array },
    _presets:  { state: true, type: Array },
    /// User-clicked the channel chip — surface the controls even if
    /// the track is in the default ForceChannel + 0x0001 state.
    /// Otherwise the section auto-hides.
    _channelExpanded: { state: true, type: Boolean },
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
      grid-template-columns: minmax(120px, 1.5fr) repeat(4, minmax(60px, 1fr)) 28px;
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
      grid-template-columns: minmax(120px, 1.5fr) repeat(4, minmax(60px, 1fr)) 28px;
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
  `;

  constructor() {
    super();
    this.trackId = "";
    this.trackName = "";
    this._tick = 0;
    this._regions = [];
    this._presets = [];
    this._presetsForPluginId = "";
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
    }
  }

  _requestPresetsFor(pluginId) {
    if (!pluginId) return;
    if (this._presetsForPluginId === pluginId && this._presets.length > 0) return;
    this._presetsForPluginId = pluginId;
    this._presets = [];
    window.__foyer?.ws?.send({ type: "list_plugin_presets", plugin_id: pluginId });
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
    return html`
      <section>
        <h3>Patches &amp; banks</h3>
        ${allPcs.length === 0
          ? html`
              <div class="card muted">
                No program / bank change events on this track's regions.
                Add one to trigger a patch change at a specific point in a
                region — the instrument hears it as if a MIDI keyboard had
                sent a PC+bank-select at that tick.
              </div>
            `
          : html`
              <div class="card">
                <div class="row-head">
                  <span>Region</span>
                  <span>Time (ticks)</span>
                  <span>Ch</span>
                  <span>Bank</span>
                  <span>Prog</span>
                  <span></span>
                </div>
                ${allPcs.map(({ region, pc }) => html`
                  <div class="pc-row">
                    <span class="label">${region.name}</span>
                    <input class="num" type="number" min="0" step="1"
                           .value=${String(pc.start_ticks ?? 0)}
                           @change=${(e) => this._editPatchChange(region, pc, { start_ticks: Math.max(0, Number(e.currentTarget.value) || 0) })}>
                    <input class="num" type="number" min="0" max="15" step="1"
                           .value=${String(pc.channel ?? 0)}
                           @change=${(e) => this._editPatchChange(region, pc, { channel: Math.max(0, Math.min(15, Number(e.currentTarget.value) || 0)) })}>
                    <input class="num" type="number" step="1"
                           placeholder="—"
                           .value=${pc.bank == null || pc.bank < 0 ? "" : String(pc.bank)}
                           @change=${(e) => {
                             const v = e.currentTarget.value.trim();
                             const next = v === "" ? -1 : Math.max(0, Math.min(16383, Number(v) || 0));
                             this._editPatchChange(region, pc, { bank: next });
                           }}>
                    <input class="num" type="number" min="0" max="127" step="1"
                           .value=${String(pc.program ?? 0)}
                           @change=${(e) => this._editPatchChange(region, pc, { program: Math.max(0, Math.min(127, Number(e.currentTarget.value) || 0)) })}>
                    <button class="danger" @click=${() => this._deletePatchChange(region, pc)}>
                      ${icon("trash", 12)}
                    </button>
                  </div>
                `)}
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
      </section>
    `;
  }

  _addPatchChangeTo(region) {
    const ws = window.__foyer?.ws;
    if (!ws || !region?.id) return;
    const pc = {
      // Server generates the real id via Evoral event_id; this
      // optimistic prefix is harmless because AddPatchChange echos
      // with the authoritative id, and our region list gets replaced.
      id: `patchchange.opt.${Math.random().toString(36).slice(2)}`,
      channel: 0,
      program: 0,
      bank: -1,
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
      <section>
        <h3>MIDI channel</h3>
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
          channels — most synths only listen on one, so the default
          stays out of the way.
        </div>
      </section>
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
    // Surface the channel controls when the track has been switched
    // off the default single-channel routing, OR when the user has
    // explicitly clicked the toolbar chip to expand them. In the
    // default state with no manual override, render only the chip —
    // the controls themselves stay hidden so the picker doesn't add
    // noise to the 95% case.
    const channelOpen = !inDefault || this._channelExpanded;
    const channelLabel = channelSummary(t);

    return html`
      <div class="tb">
        <span class="title">${this.trackName || t.name}</span>
        <span>· MIDI</span>
        <span style="flex:1"></span>
        <button
          class="chan-chip ${inDefault ? "" : "surfaced"}"
          title=${inDefault
            ? "Click to expose multi-channel routing controls"
            : "Track is using non-default MIDI channel routing"}
          @click=${() => { this._channelExpanded = !this._channelExpanded; }}
        >${channelLabel}</button>
        <span>· ${t.plugins?.length || 0} plugin${(t.plugins?.length === 1) ? "" : "s"}</span>
      </div>

      <div class="body">
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

        ${channelOpen ? this._renderChannelSection(t) : null}

        ${this._renderPatchChanges()}

        <section>
          <h3>Instrument parameters</h3>
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
        </section>

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
      </div>
    `;
  }
}
customElements.define("foyer-midi-manager", MidiManager);
