// MIDI piano roll editor. Right-side scrollable note area + pinned
// piano keyboard on the left. Notes render as rectangles whose
// horizontal position tracks `start_ticks`, width tracks
// `length_ticks`, vertical row tracks `pitch`, and color saturation
// tracks velocity.
//
// Edit ops (move, resize, delete, velocity) are planned but not wired
// to a backend yet — the shim-side `MidiNote` emission + mutations
// ship alongside this component in a follow-up. For now the component
// is a high-fidelity viewer that accepts a `notes` array via property
// and will start talking to the backend as soon as the wire format
// settles.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

const KEY_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

function isBlackKey(pitch) {
  return BLACK.has(pitch % 12);
}
function keyLabel(pitch) {
  const octave = Math.floor(pitch / 12) - 1;
  return `${KEY_LABELS[pitch % 12]}${octave}`;
}

export class MidiEditor extends LitElement {
  static properties = {
    notes:       { attribute: false },
    regionName:  { type: String, attribute: "region-name" },
    ppqn:        { type: Number },
    _zoom:       { state: true, type: Number },
    _scroll:     { state: true, type: Number },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 11px;
    }
    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
    }
    .toolbar .title { color: var(--color-text); font-weight: 600; }
    .toolbar input[type="range"] { flex: 0 0 120px; }
    .body {
      flex: 1; min-height: 0;
      display: flex;
      overflow: hidden;
    }
    .keyboard {
      flex: 0 0 60px;
      overflow: hidden;
      background: var(--color-surface-muted);
      border-right: 1px solid var(--color-border);
      position: relative;
    }
    .keyboard .keys {
      position: absolute;
      top: 0; left: 0; right: 0;
      /* vertical translation matches the notes scroll so keys & rows stay aligned */
    }
    .key {
      display: flex; align-items: center; justify-content: flex-end;
      padding-right: 6px;
      height: var(--key-h, 14px);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text);
      background: #f7f7f7;
      color: #111;
    }
    .key.black {
      background: #222;
      color: #f7f7f7;
    }
    .key.c-row { font-weight: 600; }
    .notes-scroll {
      flex: 1; min-width: 0;
      overflow: auto;
      position: relative;
    }
    .notes-canvas {
      position: relative;
      background: repeating-linear-gradient(0deg,
        var(--color-surface), var(--color-surface) var(--key-h, 14px),
        var(--color-surface-elevated) var(--key-h, 14px), var(--color-surface-elevated) calc(var(--key-h, 14px) * 2));
    }
    .note {
      position: absolute;
      border-radius: 2px;
      background: linear-gradient(180deg, var(--color-accent-2), var(--color-accent));
      border: 1px solid color-mix(in oklab, var(--color-accent) 60%, #000 40%);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
    }
    .note:hover { filter: brightness(1.2); }
    .empty {
      padding: 32px;
      color: var(--color-text-muted);
      text-align: center;
    }
  `;

  constructor() {
    super();
    this.notes = [];
    this.regionName = "";
    this.ppqn = 960;
    this._zoom = 0.25;    // pixels per tick
    this._scroll = 0;
    this._keyHeight = 14;
    this._pitchLo = 24;   // C1
    this._pitchHi = 108;  // C8
    this._onKeyboardSync = (ev) => {
      // Mirror the notes-scroll vertical offset onto the keyboard column.
      const kbd = this.renderRoot?.querySelector?.(".keyboard .keys");
      if (kbd) kbd.style.transform = `translateY(${-ev.currentTarget.scrollTop}px)`;
    };
  }

  _zoomLevels() {
    return [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];
  }

  render() {
    const visiblePitches = [];
    for (let p = this._pitchHi; p >= this._pitchLo; p--) visiblePitches.push(p);
    const notes = (this.notes || []).filter(
      (n) => n.pitch >= this._pitchLo && n.pitch <= this._pitchHi,
    );
    const totalTicks = notes.reduce(
      (m, n) => Math.max(m, (n.start_ticks || 0) + (n.length_ticks || 0)),
      8 * this.ppqn,
    );
    const canvasW = Math.max(600, totalTicks * this._zoom);
    const canvasH = visiblePitches.length * this._keyHeight;

    return html`
      <div class="toolbar">
        <span class="title">MIDI</span>
        <span>${this.regionName || "—"}</span>
        <span style="flex:1"></span>
        <span>Zoom</span>
        <input type="range" min="0" max="${this._zoomLevels().length - 1}" step="1"
               .value=${String(this._zoomLevels().indexOf(this._zoom))}
               @input=${(e) => { this._zoom = this._zoomLevels()[Number(e.currentTarget.value)]; }}>
        <span>${(this._zoom * this.ppqn).toFixed(1)} px/beat</span>
      </div>
      <div class="body" style="--key-h:${this._keyHeight}px">
        <div class="keyboard">
          <div class="keys" style="height:${canvasH}px">
            ${visiblePitches.map((p) => html`
              <div class="key ${isBlackKey(p) ? "black" : ""} ${p % 12 === 0 ? "c-row" : ""}"
                   title=${keyLabel(p)}>
                ${p % 12 === 0 ? keyLabel(p) : ""}
              </div>
            `)}
          </div>
        </div>
        <div class="notes-scroll" @scroll=${this._onKeyboardSync}>
          ${notes.length === 0
            ? html`<div class="empty">
                ${icon("sparkles", 14)}
                This region has no notes yet.<br>
                MIDI note extraction from the shim lands alongside the
                region/note emission work.
              </div>`
            : html`<div class="notes-canvas" style="width:${canvasW}px;height:${canvasH}px">
                ${notes.map((n) => {
                  const row = this._pitchHi - n.pitch;
                  const x = (n.start_ticks || 0) * this._zoom;
                  const w = Math.max(2, (n.length_ticks || 0) * this._zoom);
                  const y = row * this._keyHeight;
                  const h = this._keyHeight - 1;
                  // Velocity shading: bright top = hot hit.
                  const alpha = 0.35 + (n.velocity || 0) / 127 * 0.65;
                  return html`
                    <div class="note"
                         title="${keyLabel(n.pitch)} · vel ${n.velocity} · ${n.length_ticks}t"
                         style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:${alpha}"></div>
                  `;
                })}
              </div>`
          }
        </div>
      </div>
    `;
  }
}
customElements.define("foyer-midi-editor", MidiEditor);

/** Open the MIDI editor for `region` in a floating tile. `region.notes`
 *  feeds the initial render; subsequent updates arrive via the store. */
export function openMidiEditor(region) {
  const el = document.createElement("foyer-midi-editor");
  el.notes = region?.notes || [];
  el.regionName = region?.name || "";
  return el;
}
