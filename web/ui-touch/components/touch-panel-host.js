// SPDX-License-Identifier: Apache-2.0
// Hosts the active panel body. Switches between the reused ui-full
// widget elements (mixer, timeline, etc.) and the touch-native
// panels (Tracks list, More menu). Uses `static-html` so swapping
// the tag still lets Lit do element reuse for the cases where the
// SAME tag is mounted twice in a row — same trick tile-leaf uses.

import { LitElement, html, css } from "lit";
import { unsafeStatic, html as staticHtml } from "lit/static-html.js";

import { panelById } from "../panels.js";

// Map panel id → tag name + per-tag props. For panels that need
// no special props, the tag is enough. For panels that drive
// per-track or per-region surfaces, the user pre-selects the target
// via Tracks → row → edit, and the host reads the selection from a
// global event. Today this is a stub for the most useful surfaces;
// per-track editors land when we wire row-selection through.
function tagFor(id) {
  switch (id) {
    case "mixer":        return "foyer-mixer";
    case "timeline":     return "foyer-touch-timeline-split";
    case "tracks":       return "foyer-touch-tracks-panel";
    case "more":         return "foyer-touch-more-panel";
    case "plugins":      return "foyer-plugins-view";
    case "automation":   return "foyer-automation-panel";
    case "sections":     return "foyer-touch-sections-panel";
    case "spectrum":     return "foyer-spectrum-tile";
    case "sessions":     return "foyer-session-view";
    case "midi-devices": return "foyer-midi-devices-panel";
    case "soft-keyboard":return "foyer-soft-keyboard";
    case "console":      return "foyer-console-view";
    case "diagnostics":  return "foyer-diagnostics";
    case "agent":        return "foyer-agent-panel";
    case "piano-roll":   return "foyer-midi-editor";
    case "beat-seq":     return "foyer-beat-sequencer";
    default:             return null;
  }
}

/** Walk the session and pick a reasonable default region of the given
 *  kind ("midi" or "sequencer"). Touch's piano-roll / beat-sequencer
 *  panels need a region to render against; if the user hasn't selected
 *  one via Tracks → Open, fall back to the first matching region. */
function firstRegionOfKind(session, wantKind) {
  for (const track of session?.tracks || []) {
    for (const region of track.regions || []) {
      if (wantKind === "midi" && region.kind === "midi") {
        return { trackId: track.id, regionId: region.id };
      }
      if (wantKind === "sequencer" && region.kind === "sequencer") {
        return { trackId: track.id, regionId: region.id };
      }
    }
  }
  return null;
}

/** Per-panel target IDs the user picked via Tracks → Open or
 *  timeline → ✎. Set globally so the panel host can pick them up when
 *  the user navigates between tabs. */
const TARGETS = (globalThis.__foyerTouchTargets ||= new Map());

export function setPanelTarget(panelId, target) {
  TARGETS.set(panelId, target || null);
  globalThis.dispatchEvent?.(new CustomEvent("foyer-touch:target-changed", { detail: { panelId } }));
}

export function getPanelTarget(panelId) {
  return TARGETS.get(panelId) || null;
}

export class TouchPanelHost extends LitElement {
  static properties = {
    panelId: { type: String },
    _tick: { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      /* The ui-full widgets we mount expect to fill their container.
       * Default to a stacked panel; widgets with their own scroll
       * use overflow:auto on themselves. */
    }
    .empty {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100%;
      padding: 24px;
      gap: 12px;
      color: var(--color-text-muted);
      text-align: center;
    }
    .empty h2 {
      margin: 0;
      font-size: 22px;
      color: var(--color-text);
    }
    .empty p { margin: 0; max-width: 32em; line-height: 1.5; font-size: 14px; }
    .embed {
      width: 100%; height: 100%;
      overflow: hidden;
      -webkit-overflow-scrolling: touch;
    }
    /* Region picker shown when piano-roll / beat-seq panels open
     * without a selected region. Each card jumps into the editor
     * pre-targeted at the picked region. */
    .picker {
      display: flex; flex-direction: column;
      height: 100%; gap: 12px; padding: 16px;
      overflow: auto;
    }
    .picker h2 { margin: 0; font-size: 18px; color: var(--color-text); }
    .picker .hint { margin: 0; color: var(--color-text-muted); font-size: 13px; }
    .picker .card {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 12px;
      min-height: 56px;
      cursor: pointer;
    }
    .picker .card:active { transform: scale(0.99); }
    .picker .swatch {
      width: 4px; align-self: stretch; border-radius: 999px;
      background: var(--track-color, var(--color-accent));
    }
    .picker .name { flex: 1; font-weight: 600; }
    .picker .meta { color: var(--color-text-muted); font-size: 12px; }
  `;

  constructor() {
    super();
    this._tick = 0;
    this._onStoreChange = () => { this._tick++; };
    this._onTargetChange = (ev) => {
      if (ev.detail?.panelId === this.panelId) this._tick++;
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onStoreChange);
    globalThis.addEventListener?.("foyer-touch:target-changed", this._onTargetChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onStoreChange);
    globalThis.removeEventListener?.("foyer-touch:target-changed", this._onTargetChange);
  }

  _pickRegion(target) {
    setPanelTarget(this.panelId, target);
  }

  _renderRegionPicker(wantKind) {
    const session = window.__foyer?.store?.state?.session;
    const tracks = session?.tracks || [];
    const items = [];
    for (const track of tracks) {
      for (const region of track.regions || []) {
        const kindOk = wantKind === "midi"
          ? region.kind === "midi"
          : region.kind === "sequencer";
        if (kindOk) {
          items.push({
            trackId: track.id,
            trackName: track.name,
            trackColor: track.color || "#60a5fa",
            regionId: region.id,
            regionName: region.name || "Region",
          });
        }
      }
    }
    const label = panelById(this.panelId)?.label || "Editor";
    if (items.length === 0) {
      return html`
        <div class="empty">
          <h2>${label}</h2>
          <p>No ${wantKind === "midi" ? "MIDI" : "beat-sequencer"} regions
          in this session yet. Create one from the
          <strong>Timeline</strong> tab first.</p>
        </div>
      `;
    }
    return html`
      <div class="picker">
        <h2>${label}</h2>
        <p class="hint">Pick a region to edit:</p>
        ${items.map((it) => html`
          <div class="card"
               style=${`--track-color:${it.trackColor}`}
               @click=${() => this._pickRegion({ trackId: it.trackId, regionId: it.regionId })}>
            <div class="swatch"></div>
            <div class="name">${it.regionName}</div>
            <div class="meta">${it.trackName}</div>
          </div>
        `)}
      </div>
    `;
  }

  render() {
    const tag = tagFor(this.panelId);
    if (!tag) {
      const panel = panelById(this.panelId);
      return html`
        <div class="empty">
          <h2>${panel?.label || "Coming soon"}</h2>
          <p>This panel hasn't been wired into the touch layout yet.
          Until it lands, swap to the full UI from
          <strong>More → Settings</strong> if you need it now.</p>
        </div>
      `;
    }
    // Piano-roll / beat-seq need a target region. If the user hasn't
    // picked one explicitly, fall back to the first matching region
    // in the session; otherwise render a picker so they choose.
    let target = getPanelTarget(this.panelId);
    if (this.panelId === "piano-roll" || this.panelId === "beat-seq") {
      const wantKind = this.panelId === "piano-roll" ? "midi" : "sequencer";
      if (!target) {
        const session = window.__foyer?.store?.state?.session;
        target = firstRegionOfKind(session, wantKind);
      }
      if (!target) {
        return this._renderRegionPicker(wantKind);
      }
    }
    const session = window.__foyer?.store?.state?.session ?? null;
    const t = unsafeStatic(tag);
    return staticHtml`<div class="embed"><${t}
      .session=${session}
      .trackId=${target?.trackId || ""}
      .regionId=${target?.regionId || ""}
    ></${t}></div>`;
  }
}

customElements.define("foyer-touch-panel-host", TouchPanelHost);

// ─── Sections panel (placeholder for the dedicated section bar) ──
// The schema + agent surface are done; the visual section bar in
// the timeline is the open piece. Until that lands, surface
// section list + create-cue affordances here so users can still
// manage sections from this variant.

import { listPanels as _listPanels } from "../panels.js";

class TouchSectionsPanel extends LitElement {
  static properties = {
    _tick: { state: true, type: Number },
  };
  static styles = css`
    :host {
      display: block; height: 100%;
      overflow: auto; padding: 16px;
    }
    h2 { margin: 0 0 16px 0; font-size: 18px; }
    .row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px; border-radius: 12px;
      background: var(--color-surface);
      margin-bottom: 8px;
    }
    .row .name { flex: 1; font-weight: 600; }
    .row .meta { color: var(--color-text-muted); font-size: 12px; }
    button {
      min-height: 44px;
      padding: 10px 16px;
      border-radius: 10px;
      border: 0;
      background: var(--color-accent, #60a5fa);
      color: white;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    }
    .empty { color: var(--color-text-muted); padding: 24px 0; text-align: center; }
  `;
  constructor() {
    super();
    this._tick = 0;
    this._onChange = () => { this._tick++; };
  }
  connectedCallback() {
    super.connectedCallback();
    window.__foyer?.store?.addEventListener?.("change", this._onChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.__foyer?.store?.removeEventListener?.("change", this._onChange);
  }
  _addCue() {
    const t = window.__foyer?.store?.state?.session?.transport;
    const pos = t?.position_beats?.value ?? 0;
    const tempo = t?.tempo?.value ?? 120;
    const sr = window.__foyer?.store?.state?.session?.sample_rate ?? 48000;
    const seconds = (pos / tempo) * 60.0;
    const samples = Math.round(seconds * sr);
    const name = `Section ${(window.__foyer?.store?.state?.session?.sections?.length || 0) + 1}`;
    window.__foyer?.ws?.send({
      type: "create_section",
      name,
      start_samples: samples,
      end_samples: null,
      flags: { is_navigation: true },
    });
  }
  render() {
    const sections = window.__foyer?.store?.state?.session?.sections || [];
    return html`
      <h2>Sections</h2>
      <button @click=${() => this._addCue()}>Mark here</button>
      <div style="height: 16px"></div>
      ${sections.length === 0 ? html`
        <div class="empty">No sections yet. Tap “Mark here” to drop a cue at the playhead.</div>
      ` : sections.map((s) => html`
        <div class="row">
          <div class="name">${s.name}</div>
          <div class="meta">@ ${s.start_samples}</div>
          <button @click=${() => window.__foyer?.ws?.controlSet?.("transport.position", s.start_samples)}>Go</button>
        </div>
      `)}
    `;
  }
}
customElements.define("foyer-touch-sections-panel", TouchSectionsPanel);
