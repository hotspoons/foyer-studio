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
    case "timeline":     return "foyer-timeline-view";
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

export class TouchPanelHost extends LitElement {
  static properties = {
    panelId: { type: String },
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
      overflow: auto;
      -webkit-overflow-scrolling: touch;
    }
  `;

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
    // Some panels (piano-roll / beat-seq) need a region or track id.
    // Without one, render an informational placeholder rather than
    // mounting an empty editor — the desktop UI lets the user pick
    // a region first via the timeline / track list, which the touch
    // variant exposes as Tracks → row → ️Open editor.
    if (this.panelId === "piano-roll" || this.panelId === "beat-seq") {
      return html`
        <div class="empty">
          <h2>${panelById(this.panelId)?.label}</h2>
          <p>Open a region from the <strong>Tracks</strong> panel to
          start editing here. Tap a track, then a region.</p>
        </div>
      `;
    }
    const t = unsafeStatic(tag);
    return staticHtml`<div class="embed"><${t}></${t}></div>`;
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
