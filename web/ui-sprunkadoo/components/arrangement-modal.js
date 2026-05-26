// Arrangement editor — full-screen modal for managing the
// multi-part song. Same visual language as the sequencer
// interior + settings panel: dimmed backdrop, big red close X,
// click-outside dismisses.
//
// Two-region layout — top "parts palette" (the reusable parts
// the kid has authored) sitting above a one-dimensional
// "timeline" strip (the order in which those parts play). Drag a
// part down onto a timeline slot to insert it (over an empty
// slot) or replace it (over a filled one). Drag two timeline
// slots over each other to reorder. Trash icon on each timeline
// slot removes it (won't shrink below 1 slot).
//
// The selected palette part also drives a detail panel below it
// (color + length + delete), inheriting the prior single-track
// arrangement editor's controls.

import { LitElement, html, css } from "lit";
import {
  sprunkiStore,
  ARRANGEMENT_COLORS,
  MIN_ARRANGEMENT_BARS,
  MAX_ARRANGEMENT_BARS,
} from "../state-store.js";

export class SprunkadooArrangementModal extends LitElement {
  static properties = {
    _rev: { type: Number, state: true },
    _selectedId: { type: String, state: true },
    _dragPayload: { type: Object, state: true },
    _dropTargetPos: { type: Number, state: true },
  };
  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.78);
      z-index: 9999;
      font-family: system-ui, sans-serif;
      color: #e5e8ee;
    }
    .panel {
      width: min(860px, 96vw);
      max-height: 92vh;
      overflow-y: auto;
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 14px;
      padding: 22px 26px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.5);
      position: relative;
    }
    h2 { margin: 0 0 4px; font-size: 18px; }
    h3 {
      margin: 22px 0 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
    }
    .sub {
      font-size: 12px;
      color: rgba(255,255,255,0.55);
      margin-bottom: 8px;
    }

    .close {
      position: absolute; top: 10px; right: 10px;
      width: 34px; height: 34px; border-radius: 999px;
      background: #e54d3a;
      color: #fff;
      font: 800 20px/1 system-ui, sans-serif;
      border: 2px solid rgba(255, 255, 255, 0.85);
      cursor: pointer;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      transition: transform 100ms ease, background 100ms ease;
    }
    .close:hover { background: #c33a28; transform: scale(1.08); }
    .close:active { transform: scale(0.94); }

    /* ── Parts palette ─────────────────────────────────────────── */
    .palette {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      padding: 6px 0 2px;
    }
    .part-tile {
      width: 64px; height: 84px;
      flex: 0 0 auto;
      border-radius: 12px;
      border: 3px solid transparent;
      background: var(--cc, #888);
      box-shadow: 0 4px 12px rgba(0,0,0,0.35),
                  inset 0 -8px 14px rgba(0,0,0,0.18);
      cursor: grab;
      position: relative;
      transition: transform 110ms cubic-bezier(0.2, 0.8, 0.2, 1.1),
                  box-shadow 120ms ease, border-color 120ms ease;
      padding: 0;
      color: #fff;
      font: 800 22px/1 system-ui, sans-serif;
      text-shadow: 0 1px 3px rgba(0,0,0,0.55);
    }
    .part-tile:active { cursor: grabbing; }
    .part-tile:hover {
      transform: translateY(-3px);
      box-shadow: 0 7px 18px rgba(0,0,0,0.45);
    }
    .part-tile.selected {
      border-color: rgba(255,255,255,0.9);
      transform: translateY(-3px);
    }
    .part-tile small {
      display: block;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      opacity: 0.78;
      margin-top: 2px;
    }
    .add-tile {
      width: 64px; height: 84px;
      flex: 0 0 auto;
      border-radius: 12px;
      border: 2px dashed rgba(255,255,255,0.30);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.62);
      font: 600 26px/1 system-ui, sans-serif;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 110ms ease;
    }
    .add-tile:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.55);
      color: #fff;
      transform: translateY(-3px);
    }

    /* ── Selected-part detail ──────────────────────────────────── */
    .detail {
      margin-top: 6px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .detail-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 8px 0;
      flex-wrap: wrap;
    }
    .detail-label {
      width: 90px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.62);
    }
    .swatches { display: flex; gap: 7px; flex-wrap: wrap; }
    .swatch-btn {
      width: 26px; height: 26px;
      border-radius: 999px;
      background: var(--sc, #888);
      border: 2px solid rgba(255,255,255,0.15);
      cursor: pointer;
      padding: 0;
      transition: transform 110ms ease, border-color 120ms ease;
    }
    .swatch-btn:hover { transform: scale(1.12); }
    .swatch-btn.active {
      border-color: rgba(255,255,255,0.95);
      box-shadow: 0 0 0 3px rgba(255,255,255,0.18);
    }
    .bars { display: flex; gap: 5px; }
    .bar-btn {
      width: 40px; height: 32px;
      border-radius: 7px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.78);
      cursor: pointer;
      font: 700 14px system-ui, sans-serif;
    }
    .bar-btn:hover { background: rgba(255,255,255,0.10); color: #fff; }
    .bar-btn.active {
      background: rgba(108, 92, 255, 0.45);
      border-color: rgba(108, 92, 255, 0.85);
      color: #fff;
    }
    .danger {
      background: rgba(229, 77, 58, 0.18);
      border: 1px solid rgba(229, 77, 58, 0.55);
      color: #ffcdc4;
      padding: 7px 14px;
      border-radius: 8px;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
    }
    .danger:hover:not(:disabled) { background: rgba(229, 77, 58, 0.32); color: #fff; }
    .danger:disabled { opacity: 0.4; cursor: not-allowed; }
    .small { font-size: 11px; color: rgba(255,255,255,0.55); }

    /* ── Timeline strip ────────────────────────────────────────── */
    .timeline-row {
      display: flex;
      align-items: stretch;
      gap: 6px;
      padding: 12px 0 4px;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    .tl-slot {
      flex: 0 0 auto;
      width: 88px;
      height: 86px;
      border-radius: 12px;
      background: var(--cc, #555);
      box-shadow: 0 3px 10px rgba(0,0,0,0.35),
                  inset 0 -6px 12px rgba(0,0,0,0.18);
      position: relative;
      border: 3px solid transparent;
      color: #fff;
      font: 800 18px/1 system-ui, sans-serif;
      text-shadow: 0 1px 3px rgba(0,0,0,0.55);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: grab;
      user-select: none;
    }
    .tl-slot:active { cursor: grabbing; }
    .tl-slot.drop-over {
      border-color: rgba(255,255,255,0.95);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.5),
                  0 0 0 4px rgba(108, 92, 255, 0.55);
    }
    .tl-slot small {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      opacity: 0.85;
      margin-top: 4px;
      display: block;
    }
    .tl-position {
      position: absolute;
      top: 4px; left: 6px;
      font: 700 10px/1 system-ui, sans-serif;
      color: rgba(255,255,255,0.78);
      letter-spacing: 0.06em;
    }
    .tl-remove {
      position: absolute;
      top: 4px; right: 4px;
      width: 20px; height: 20px;
      border-radius: 999px;
      background: #e54d3a;
      color: #fff;
      border: 2px solid rgba(255,255,255,0.85);
      cursor: pointer;
      font: 800 12px/1 system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      opacity: 0;
      transition: opacity 120ms ease, transform 110ms ease;
    }
    .tl-slot:hover .tl-remove { opacity: 1; }
    .tl-remove:hover { transform: scale(1.12); }
    .tl-add {
      flex: 0 0 auto;
      width: 88px;
      height: 86px;
      border-radius: 12px;
      border: 2px dashed rgba(255,255,255,0.30);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.62);
      font: 600 14px system-ui, sans-serif;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 8px;
    }
    .tl-add.drop-over {
      background: rgba(108, 92, 255, 0.20);
      border-color: rgba(108, 92, 255, 0.85);
      color: #fff;
    }
    .tl-total {
      margin-top: 10px;
      font-size: 12px;
      color: rgba(255,255,255,0.55);
    }
  `;

  constructor() {
    super();
    this._store = sprunkiStore();
    this._rev = 0;
    this._selectedId = null;
    this._dragPayload = null;   // { source: "palette"|"timeline", partId, position? }
    this._dropTargetPos = null; // current hover target; -1 = end-add zone
    this._listener = () => { this._rev++; this.requestUpdate(); };
    this._onHostClick = (e) => { if (e.target === this) this._close(); };
    this._onKey = (e) => { if (e.key === "Escape") this._close(); };
  }
  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("arrangements-changed", this._listener);
    this.addEventListener("click", this._onHostClick);
    document.addEventListener("keydown", this._onKey);
    this._selectedId = this._store.activeArrangementId;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("arrangements-changed", this._listener);
    this.removeEventListener("click", this._onHostClick);
    document.removeEventListener("keydown", this._onKey);
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
  _onPickPart(id) {
    this._selectedId = id;
    this._store.setActiveArrangement(id);
  }
  _onAdd() {
    const id = this._store.addArrangement();
    if (id) this._selectedId = id;
  }
  _onDeletePart(id) {
    if ((this._store.arrangements || []).length <= 1) return;
    if (!confirm("Delete this part? Its authored notes (across all timeline placements) are erased.")) return;
    this._store.removeArrangement(id);
    this._selectedId = this._store.activeArrangementId;
  }
  _onRecolor(id, color) { this._store.setArrangementColor(id, color); }
  _onResize(id, bars)   { this._store.setArrangementLengthBars(id, bars); }

  // ── drag & drop ───────────────────────────────────────────────
  _onDragStartPalette(e, partId) {
    this._dragPayload = { source: "palette", partId };
    e.dataTransfer.effectAllowed = "copy";
    // Firefox refuses to start a drag without setData.
    try { e.dataTransfer.setData("text/plain", partId); } catch {}
  }
  _onDragStartTimeline(e, partId, position) {
    this._dragPayload = { source: "timeline", partId, position };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", `${partId}@${position}`); } catch {}
  }
  _onDragOverSlot(e, position) {
    if (!this._dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = this._dragPayload.source === "palette" ? "copy" : "move";
    if (this._dropTargetPos !== position) {
      this._dropTargetPos = position;
    }
  }
  _onDragLeaveSlot(_e, position) {
    if (this._dropTargetPos === position) this._dropTargetPos = null;
  }
  _onDropSlot(e, position) {
    e.preventDefault();
    const payload = this._dragPayload;
    this._dragPayload = null;
    this._dropTargetPos = null;
    if (!payload) return;
    if (position === -1) {
      // End-add zone: append the dragged part. If it came from a
      // timeline slot we MOVE it to the end (drop original first).
      if (payload.source === "timeline") {
        this._store.moveTimelineSlot(payload.position, this._store.timeline.length - 1);
      } else {
        this._store.appendTimelineSlot(payload.partId);
      }
      return;
    }
    if (payload.source === "palette") {
      // Drop palette part onto an occupied slot → replace.
      this._store.setTimelineSlot(position, payload.partId);
      return;
    }
    // Timeline-to-timeline → reorder.
    if (payload.position !== position) {
      this._store.moveTimelineSlot(payload.position, position);
    }
  }
  _onDragEnd() {
    this._dragPayload = null;
    this._dropTargetPos = null;
  }

  render() {
    const parts = this._store.arrangements;
    const timeline = this._store.timeline;
    const selected = parts.find((p) => p.id === this._selectedId) || parts[0];
    const byId = new Map(parts.map((p) => [p.id, p]));
    const onlyOnePart = parts.length <= 1;
    const onlyOneSlot = timeline.length <= 1;
    const totalBars = timeline.reduce(
      (sum, pid) => sum + (byId.get(pid)?.length_bars || 0),
      0,
    );
    return html`
      <div class="panel" @click=${(e) => e.stopPropagation()}>
        <button class="close" title="Close (Esc)" aria-label="Close arrangement editor"
                @click=${this._close}>
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor"
               stroke-width="3" fill="none" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
        <h2>Song arrangement</h2>
        <div class="sub">
          Author parts in the palette, then drag them down into the timeline to
          build the song. The same part can play more than once — drag it into
          multiple slots.
        </div>

        <h3>Parts palette</h3>
        <div class="palette">
          ${parts.map((p) => html`
            <button
              class="part-tile ${p.id === selected?.id ? "selected" : ""}"
              style="--cc: ${p.color}"
              title=${`Tap to select • drag to timeline`}
              draggable="true"
              @click=${() => this._onPickPart(p.id)}
              @dragstart=${(e) => this._onDragStartPalette(e, p.id)}
              @dragend=${this._onDragEnd}
            >
              ${p.length_bars}
              <small>bars</small>
            </button>
          `)}
          <button class="add-tile" title="Add a new part" @click=${this._onAdd}>+</button>
        </div>

        ${selected ? html`
          <div class="detail">
            <div class="detail-row">
              <div class="detail-label">Color</div>
              <div class="swatches">
                ${ARRANGEMENT_COLORS.map((c) => html`
                  <button
                    class="swatch-btn ${c === selected.color ? "active" : ""}"
                    style="--sc: ${c}"
                    title=${c}
                    aria-label=${`Recolor to ${c}`}
                    @click=${() => this._onRecolor(selected.id, c)}
                  ></button>
                `)}
              </div>
            </div>
            <div class="detail-row">
              <div class="detail-label">Length</div>
              <div class="bars">
                ${Array.from({ length: MAX_ARRANGEMENT_BARS - MIN_ARRANGEMENT_BARS + 1 }, (_, i) => {
                  const n = MIN_ARRANGEMENT_BARS + i;
                  return html`
                    <button
                      class="bar-btn ${n === selected.length_bars ? "active" : ""}"
                      @click=${() => this._onResize(selected.id, n)}
                    >${n}</button>
                  `;
                })}
              </div>
              <span class="small">bars (1 tightest, 4 longest)</span>
            </div>
            <div class="detail-row">
              <div class="detail-label">Remove</div>
              <button
                class="danger"
                ?disabled=${onlyOnePart}
                title=${onlyOnePart ? "Can't delete the only part" : "Delete this part"}
                @click=${() => this._onDeletePart(selected.id)}
              >Delete part</button>
              <span class="small">${onlyOnePart ? "Add another part first." : "Every timeline placement of this part is also dropped."}</span>
            </div>
          </div>
        ` : ""}

        <h3>Timeline</h3>
        <div class="sub">
          Drag parts here. Drop on an existing slot to replace it; drop on the
          dashed slot at the end to add. Hover a slot to see its red ✕.
        </div>
        <div class="timeline-row" @dragend=${this._onDragEnd}>
          ${timeline.map((partId, idx) => {
            const part = byId.get(partId);
            if (!part) return "";
            const isDropOver = this._dropTargetPos === idx;
            return html`
              <div
                class="tl-slot ${isDropOver ? "drop-over" : ""}"
                style="--cc: ${part.color}"
                title=${`Position ${idx + 1} — ${part.length_bars} bar${part.length_bars === 1 ? "" : "s"}`}
                draggable="true"
                @dragstart=${(e) => this._onDragStartTimeline(e, partId, idx)}
                @dragover=${(e) => this._onDragOverSlot(e, idx)}
                @dragleave=${(e) => this._onDragLeaveSlot(e, idx)}
                @drop=${(e) => this._onDropSlot(e, idx)}
              >
                <span class="tl-position">${idx + 1}</span>
                <button
                  class="tl-remove"
                  title="Remove from timeline"
                  aria-label="Remove from timeline"
                  ?disabled=${onlyOneSlot}
                  @click=${(e) => { e.stopPropagation(); this._store.removeTimelineSlot(idx); }}
                >×</button>
                ${part.length_bars}
                <small>bars</small>
              </div>
            `;
          })}
          <button
            class="tl-add ${this._dropTargetPos === -1 ? "drop-over" : ""}"
            title="Drop a part here, or click to append the selected part"
            @click=${() => selected && this._store.appendTimelineSlot(selected.id)}
            @dragover=${(e) => this._onDragOverSlot(e, -1)}
            @dragleave=${(e) => this._onDragLeaveSlot(e, -1)}
            @drop=${(e) => this._onDropSlot(e, -1)}
          >+ Drop part here</button>
        </div>
        <div class="tl-total">Total: ${totalBars} bar${totalBars === 1 ? "" : "s"} across ${timeline.length} slot${timeline.length === 1 ? "" : "s"}</div>
      </div>
    `;
  }
}

customElements.define("sprunkadoo-arrangement-modal", SprunkadooArrangementModal);
