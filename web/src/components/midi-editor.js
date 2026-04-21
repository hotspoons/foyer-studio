// MIDI piano roll editor — now with interactive editing.
//
// Interactions (the whole point — per Rich's "stop reward hacking"
// feedback, the read-only viewer was not enough):
//
//   * Click empty canvas           → add a note at cursor pitch / tick
//                                    (length = 1 beat; snap to grid).
//   * Click a note body            → select it (shift-click to multi).
//   * Drag selected note body      → move pitch + time; all selected
//                                    notes move together.
//   * Drag note left / right edge  → resize (start / length).
//   * Delete / Backspace           → remove selected.
//   * Shift-wheel on selected note → adjust velocity.
//   * Alt (Opt) held               → disable snap while dragging.
//
// All mutations are sent to the backend over the `add_note` /
// `update_note` / `delete_note` commands and land in Ardour's
// `MidiModel` via `NoteDiffCommand`. The backend echoes a
// `RegionUpdated` event with the fresh note list; this component
// reconciles against that by replacing `_localNotes` with the
// incoming `notes` prop whenever it changes.
//
// For responsiveness, we apply mutations to `_localNotes` immediately
// (optimistic) and fire the network command alongside — the echo
// arrives a few ms later and overwrites optimistic state with the
// authoritative note list.

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

const KEY_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

function isBlackKey(pitch) { return BLACK.has(pitch % 12); }
function keyLabel(pitch) {
  const octave = Math.floor(pitch / 12) - 1;
  return `${KEY_LABELS[pitch % 12]}${octave}`;
}

const H_ZOOM_LEVELS = [
  0.00833, 0.0167, 0.025, 0.033, 0.05, 0.0833,
  0.125, 0.1875, 0.25, 0.375, 0.5,
];
const V_ROW_HEIGHTS = [8, 10, 12, 14, 18, 22, 28];

// Snap values in fractions of a beat: 1 = quarter, 1/2 = eighth,
// 1/4 = sixteenth, 1/8 = 32nd.
const SNAP_OPTIONS = [
  { label: "1/4",  value: 1 },
  { label: "1/8",  value: 1 / 2 },
  { label: "1/16", value: 1 / 4 },
  { label: "1/32", value: 1 / 8 },
  { label: "Off",  value: 0 },
];

function nearestIdx(levels, value) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i] - value);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function randomNoteId(regionId) {
  // Mirrors the shim's "note.<region-pbd>.<event_id>" scheme — but
  // until the shim echoes with its own real event_id we use a local
  // random suffix so the optimistic note has a unique key.
  const rnd = Math.floor(Math.random() * 1e9).toString(36);
  return `note.opt.${regionId || "unknown"}.${rnd}`;
}

export class MidiEditor extends LitElement {
  static properties = {
    notes:       { attribute: false },
    regionId:    { type: String, attribute: "region-id" },
    regionName:  { type: String, attribute: "region-name" },
    ppqn:        { type: Number },
    _zoomIdx:    { state: true, type: Number },
    _rowIdx:     { state: true, type: Number },
    _pitchLo:    { state: true, type: Number },
    _pitchHi:    { state: true, type: Number },
    _selection:  { state: true, type: Object },
    _snapIdx:    { state: true, type: Number },
    _localNotes: { state: true, type: Array },
    _drag:       { state: true, type: Object },
  };

  static styles = css`
    :host {
      display: flex; flex-direction: column;
      width: 100%; height: 100%; min-height: 0;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: 11px;
    }
    .toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      flex: 0 0 auto;
    }
    .toolbar .title { color: var(--color-text); font-weight: 600; }
    .toolbar .group { display: flex; align-items: center; gap: 6px; }
    .toolbar .group.disabled { opacity: 0.4; pointer-events: none; }
    .toolbar .vel-value {
      font-variant-numeric: tabular-nums;
      color: var(--color-accent, #7c5cff);
      min-width: 22px;
      text-align: right;
    }
    .toolbar input[type="range"] { flex: 0 0 100px; }
    .toolbar select, .toolbar button {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      padding: 2px 8px;
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font: inherit; font-size: 11px;
    }
    .toolbar button:hover, .toolbar select:hover {
      background: var(--color-surface-muted);
    }
    .toolbar .count {
      font-variant-numeric: tabular-nums;
      color: var(--color-accent, #7c5cff);
    }
    .body {
      flex: 1; min-height: 0;
      display: flex;
      overflow: hidden;
    }
    .keyboard {
      flex: 0 0 56px;
      overflow: hidden;
      background: var(--color-surface-muted);
      border-right: 1px solid var(--color-border);
      position: relative;
    }
    .keyboard .keys {
      position: absolute; top: 0; left: 0; right: 0;
    }
    .key {
      display: flex; align-items: center; justify-content: flex-end;
      padding-right: 6px;
      font-size: 9px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.18);
      background: #efefef;
      color: #222;
      box-sizing: border-box;
    }
    .key.black {
      background: #2a2a2a;
      color: #eee;
      border-bottom-color: rgba(255, 255, 255, 0.05);
    }
    .key.c-row { font-weight: 700; }
    .notes-scroll {
      flex: 1; min-width: 0;
      overflow: auto;
      position: relative;
    }
    .notes-canvas {
      position: relative;
      background: repeating-linear-gradient(0deg,
        var(--color-surface-elevated),
        var(--color-surface-elevated) var(--row-h, 14px),
        var(--color-surface) var(--row-h, 14px),
        var(--color-surface) calc(var(--row-h, 14px) * 2));
      cursor: crosshair;
    }
    .notes-canvas.dragging { cursor: grabbing; }
    .notes-canvas .c-stripe {
      position: absolute;
      left: 0; right: 0;
      height: var(--row-h, 14px);
      background: rgba(99, 102, 241, 0.07);
      pointer-events: none;
    }
    .beat-line {
      position: absolute; top: 0; bottom: 0;
      width: 1px;
      background: rgba(255, 255, 255, 0.05);
      pointer-events: none;
    }
    .beat-line.bar { background: rgba(255, 255, 255, 0.14); }
    .note {
      position: absolute;
      border-radius: 2px;
      background: linear-gradient(180deg, var(--color-accent-2, #b084ff), var(--color-accent, #7c5cff));
      border: 1px solid color-mix(in oklab, var(--color-accent, #7c5cff) 60%, #000 40%);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
      cursor: grab;
    }
    .note:hover { filter: brightness(1.18); }
    .note.selected {
      outline: 1.5px solid var(--color-accent, #7c5cff);
      outline-offset: 1px;
      filter: brightness(1.12);
    }
    .note .grip {
      position: absolute; top: 0; bottom: 0;
      width: 4px;
      cursor: ew-resize;
    }
    .note .grip.left  { left: -2px; }
    .note .grip.right { right: -2px; }
    .note .vel-badge {
      position: absolute;
      top: -18px; left: 0;
      font-size: 9px;
      line-height: 1;
      padding: 2px 5px;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border-radius: 3px;
      border: 1px solid var(--color-border);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.08s ease;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .note:hover .vel-badge, .note.selected .vel-badge {
      opacity: 0.95;
    }
    .status {
      flex: 0 0 auto;
      padding: 4px 12px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text-muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      display: flex; align-items: center; gap: 14px;
    }
  `;

  constructor() {
    super();
    this.notes = [];
    this.regionId = "";
    this.regionName = "";
    this.ppqn = 960;
    this._zoomIdx = nearestIdx(H_ZOOM_LEVELS, 0.0167);
    this._rowIdx  = nearestIdx(V_ROW_HEIGHTS, 14);
    this._pitchLo = 21;
    this._pitchHi = 108;
    this._selection = new Set();
    this._snapIdx = 2;                  // 1/16 default
    this._localNotes = [];
    this._drag = null;                  // { kind, noteIds, origX, origY, origNotes }
    this._lastStatus = "";              // current cursor-at-grid readout

    // Clipboard: array of { pitch, velocity, start_ticks, length_ticks,
    // channel } with start_ticks re-anchored so the earliest note is at
    // 0 (so paste at cursor-tick gives the expected offset).
    this._clipboard = [];

    this._onKeyboardSync = (ev) => {
      const kbd = this.renderRoot?.querySelector?.(".keyboard .keys");
      if (kbd) kbd.style.transform = `translateY(${-ev.currentTarget.scrollTop}px)`;
    };
    this._onKeyDown = (e) => this._handleKeydown(e);
    // Track cursor position on the canvas so paste/duplicate can land
    // at the pointer even though the keyboard event carries no mouse
    // coordinates.
    this._onPointerMove = (ev) => {
      if (!this.isConnected) return;
      const r = this._canvasRect();
      if (!r) return;
      const inCanvas =
        ev.clientX >= r.left && ev.clientX <= r.right &&
        ev.clientY >= r.top  && ev.clientY <= r.bottom;
      if (inCanvas) {
        this._cursorTicks = this._xToTicks(ev.clientX);
        this._cursorPitch = this._yToPitch(ev.clientY);
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this.tabIndex = 0;       // allow focus → keydown handler
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("pointermove", this._onPointerMove);
    this.addEventListener("pointerenter", () => { this._mouseOver = true; });
    this.addEventListener("pointerleave", () => { this._mouseOver = false; });
  }
  firstUpdated() {
    // Wheel listener needs to be non-passive so preventDefault actually
    // stops the page / outer container from scrolling. Lit's `@wheel=`
    // attribute binds as passive by default, which made shift-scroll
    // for velocity look broken in one direction (the browser scrolled
    // the surrounding container instead of letting us consume the
    // event). Attach manually with { passive: false }.
    const scroll = this.renderRoot?.querySelector(".notes-scroll");
    if (scroll && !this._wheelBound) {
      scroll.addEventListener("wheel", (ev) => this._onNoteWheel(ev), { passive: false });
      this._wheelBound = true;
    }
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has("notes")) {
      // Reconcile with backend. Drop optimistic-only entries that the
      // backend didn't confirm (their ids start with "note.opt.") and
      // replace with authoritative notes.
      this._localNotes = Array.isArray(this.notes) ? [...this.notes] : [];
      // Prune selection entries that no longer exist.
      const live = new Set(this._localNotes.map((n) => n.id));
      const sel = new Set();
      for (const id of this._selection) if (live.has(id)) sel.add(id);
      this._selection = sel;

      const prev = changed.get("notes");
      if ((!prev || prev.length === 0) && this._localNotes.length > 0) {
        this._autoFitPitch();
      }
    }
  }

  _hzoom() { return H_ZOOM_LEVELS[this._zoomIdx] || H_ZOOM_LEVELS[1]; }
  _rowH()  { return V_ROW_HEIGHTS[this._rowIdx] || 14; }
  _snapTicks() {
    const frac = SNAP_OPTIONS[this._snapIdx]?.value ?? 0;
    if (!frac) return 1;
    return Math.max(1, Math.round(this.ppqn * frac));
  }
  _snap(ticks, disable = false) {
    const s = this._snapTicks();
    if (disable || s <= 1) return Math.max(0, Math.round(ticks));
    return Math.max(0, Math.round(ticks / s) * s);
  }

  _autoFitPitch() {
    const notes = this._localNotes || [];
    if (notes.length === 0) return;
    let lo = 127, hi = 0;
    for (const n of notes) {
      if (n.pitch < lo) lo = n.pitch;
      if (n.pitch > hi) hi = n.pitch;
    }
    this._pitchLo = Math.max(0, lo - 3);
    this._pitchHi = Math.min(127, hi + 3);
    this.updateComplete.then(() => {
      const scroll = this.renderRoot?.querySelector(".notes-scroll");
      if (scroll) scroll.scrollTop = 0;
    });
  }
  _resetPitch() {
    this._pitchLo = 21;
    this._pitchHi = 108;
  }

  // ── coordinate helpers ────────────────────────────────────────────
  _canvasRect() {
    return this.renderRoot?.querySelector(".notes-canvas")?.getBoundingClientRect();
  }
  _xToTicks(clientX) {
    const r = this._canvasRect();
    if (!r) return 0;
    return Math.max(0, (clientX - r.left) / this._hzoom());
  }
  _yToPitch(clientY) {
    const r = this._canvasRect();
    if (!r) return 60;
    const row = Math.floor((clientY - r.top) / this._rowH());
    return Math.min(127, Math.max(0, this._pitchHi - row));
  }

  // ── command plumbing ──────────────────────────────────────────────
  _send(body) {
    try { window.__foyer?.ws?.send(body); }
    catch (e) { console.warn("midi-editor: send failed", e); }
  }

  _addNote({ pitch, velocity, start_ticks, length_ticks, channel = 0 }) {
    if (!this.regionId) return null;
    const id = randomNoteId(this.regionId);
    const note = { id, pitch, velocity, start_ticks, length_ticks, channel };
    this._localNotes = [...this._localNotes, note];
    this._selection = new Set([id]);
    this._send({ type: "add_note", region_id: this.regionId, note });
    return note;
  }

  /**
   * Create a note optimistically but defer the AddNote network send
   * until the draw-drag completes. Used for click+drag placement so
   * the user sets the duration during the initial placement.
   */
  _addNoteLocal({ pitch, velocity, start_ticks, length_ticks, channel = 0 }) {
    if (!this.regionId) return null;
    const id = randomNoteId(this.regionId);
    const note = { id, pitch, velocity, start_ticks, length_ticks, channel };
    this._localNotes = [...this._localNotes, note];
    this._selection = new Set([id]);
    return note;
  }

  _deleteNotes(ids) {
    if (!this.regionId || !ids.length) return;
    const dropped = new Set(ids);
    this._localNotes = this._localNotes.filter((n) => !dropped.has(n.id));
    this._selection = new Set();
    for (const id of ids) {
      this._send({ type: "delete_note", region_id: this.regionId, note_id: id });
    }
  }

  _patchNote(noteId, patch) {
    if (!this.regionId) return;
    this._localNotes = this._localNotes.map(
      (n) => (n.id === noteId ? { ...n, ...patch } : n),
    );
    this._send({
      type: "update_note",
      region_id: this.regionId,
      note_id: noteId,
      patch,
    });
  }

  // ── mouse + keyboard ──────────────────────────────────────────────
  _noteIdFromEvent(ev) {
    let el = ev.target;
    while (el && el !== this) {
      if (el.dataset?.noteId) return el.dataset.noteId;
      el = el.parentElement;
    }
    return null;
  }

  _onCanvasDown(ev) {
    if (ev.button !== 0) return;
    const hitNoteId = this._noteIdFromEvent(ev);
    const gripDir = ev.target?.dataset?.grip || null;

    if (hitNoteId && gripDir) {
      // Resize handle.
      ev.preventDefault();
      if (!this._selection.has(hitNoteId)) {
        this._selection = new Set([hitNoteId]);
      }
      this._beginDrag(ev, { kind: gripDir === "left" ? "resize-l" : "resize-r" });
      return;
    }
    if (hitNoteId) {
      ev.preventDefault();
      this._selectNote(hitNoteId, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      this._beginDrag(ev, { kind: "move" });
      return;
    }
    // Empty canvas — create a note at the cursor AND start a
    // resize-r drag so the user sets the duration in one gesture.
    // On pointerup with no movement, the note keeps its default
    // length (one snap unit). On drag, the length grows with the
    // pointer. Alt disables snap for both the start and length.
    ev.preventDefault();
    const ticks = this._snap(this._xToTicks(ev.clientX), ev.altKey);
    const pitch = this._yToPitch(ev.clientY);
    // When Alt is held, use 1 tick as the minimum length floor so
    // very-short notes are placeable. Otherwise anchor to the snap.
    const length = ev.altKey ? Math.max(1, this._snapTicks()) : this._snapTicks();
    const note = this._addNoteLocal({
      pitch,
      velocity: 100,
      start_ticks: ticks,
      length_ticks: length,
      channel: 0,
    });
    if (note) {
      this._beginDrag(ev, { kind: "resize-r", created: true });
    }
  }

  _selectNote(id, additive) {
    const next = new Set(additive ? this._selection : []);
    if (additive && next.has(id)) next.delete(id);
    else next.add(id);
    this._selection = next;
  }

  _beginDrag(ev, params) {
    const notesById = Object.fromEntries(this._localNotes.map((n) => [n.id, n]));
    const ids = [...this._selection].filter((id) => notesById[id]);
    if (!ids.length) return;
    this._drag = {
      kind: params.kind,
      ids,
      origX: ev.clientX,
      origY: ev.clientY,
      orig: Object.fromEntries(ids.map((id) => [id, { ...notesById[id] }])),
      moved: false,
      altKey: ev.altKey,
      // When `created` is true the drag started by planting a new
      // note; on pointerup we send AddNote (with the final length)
      // instead of UpdateNote.
      created: !!params.created,
    };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup",   this._onDragUp);
  }

  _onDragMove = (ev) => {
    if (!this._drag) return;
    const d = this._drag;
    d.altKey = ev.altKey;
    const hzoom = this._hzoom();
    const rowH = this._rowH();
    const dTicks = (ev.clientX - d.origX) / hzoom;
    const dRows  = Math.round((ev.clientY - d.origY) / rowH);
    const snap = (t) => this._snap(t, ev.altKey);
    const next = this._localNotes.map((n) => {
      const o = d.orig[n.id];
      if (!o) return n;
      if (d.kind === "move") {
        const start = snap(o.start_ticks + dTicks);
        const pitch = Math.min(127, Math.max(0, o.pitch - dRows));
        return { ...n, start_ticks: start, pitch };
      }
      if (d.kind === "resize-r") {
        const minLen = this._snapTicks();
        const length = Math.max(minLen, snap(o.length_ticks + dTicks));
        return { ...n, length_ticks: length };
      }
      if (d.kind === "resize-l") {
        const startRaw = snap(o.start_ticks + dTicks);
        const maxStart = o.start_ticks + o.length_ticks - this._snapTicks();
        const start = Math.max(0, Math.min(startRaw, maxStart));
        const length = o.length_ticks + (o.start_ticks - start);
        return { ...n, start_ticks: start, length_ticks: length };
      }
      return n;
    });
    if (Math.abs(ev.clientX - d.origX) + Math.abs(ev.clientY - d.origY) > 2) d.moved = true;
    this._localNotes = next;
  };

  _onDragUp = (ev) => {
    if (!this._drag) return;
    const d = this._drag;
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup",   this._onDragUp);
    if (d.created) {
      // Click+drag placement — commit a single AddNote with the
      // final length that the user drew out. (If they clicked
      // without moving, we just send the default-length note.)
      for (const id of d.ids) {
        const cur = this._localNotes.find((n) => n.id === id);
        if (!cur) continue;
        this._send({
          type: "add_note",
          region_id: this.regionId,
          note: {
            id: cur.id,
            pitch: cur.pitch,
            velocity: cur.velocity,
            start_ticks: cur.start_ticks,
            length_ticks: cur.length_ticks,
            channel: cur.channel || 0,
          },
        });
      }
    } else if (d.moved) {
      // Existing-note drag: send UpdateNote per changed note.
      for (const id of d.ids) {
        const orig = d.orig[id];
        const cur  = this._localNotes.find((n) => n.id === id);
        if (!orig || !cur) continue;
        const patch = {};
        if (cur.pitch        !== orig.pitch)        patch.pitch        = cur.pitch;
        if (cur.start_ticks  !== orig.start_ticks)  patch.start_ticks  = cur.start_ticks;
        if (cur.length_ticks !== orig.length_ticks) patch.length_ticks = cur.length_ticks;
        if (cur.velocity     !== orig.velocity)     patch.velocity     = cur.velocity;
        if (Object.keys(patch).length > 0) {
          this._send({
            type: "update_note",
            region_id: this.regionId,
            note_id: id,
            patch,
          });
        }
      }
    }
    this._drag = null;
    ev.stopPropagation?.();
  };

  _handleKeydown(e) {
    if (!this.renderRoot) return;
    const active = document.activeElement;
    const tag = (active?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    // Most shortcuts only fire when the editor is the visible
    // focus area — otherwise typing in some other tile would delete
    // notes out from under you. Check if the editor or any window
    // wrapping it is in the foreground path of document.activeElement.
    const ours = this === active || this.contains?.(active) || this.renderRoot?.contains?.(active);
    if (!ours && !this._mouseOver) return;

    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this._selection.size > 0) {
        e.preventDefault();
        this._deleteNotes([...this._selection]);
      }
    } else if (e.key === "Escape") {
      this._selection = new Set();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this._selection = new Set(this._localNotes.map((n) => n.id));
    } else if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this._copySelection();
    } else if (mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      this._copySelection();
      this._deleteNotes([...this._selection]);
    } else if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      this._paste();
    } else if (mod && e.key.toLowerCase() === "d") {
      // Duplicate: copy + paste right-after the selection.
      e.preventDefault();
      this._copySelection();
      this._paste({ afterSelection: true });
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this._send({ type: "undo" });
    } else if (mod && (e.shiftKey && e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      this._send({ type: "redo" });
    }
  }

  _copySelection() {
    const picked = this._localNotes.filter((n) => this._selection.has(n.id));
    if (picked.length === 0) return;
    const earliest = picked.reduce((m, n) => Math.min(m, n.start_ticks || 0), Infinity);
    this._clipboard = picked.map((n) => ({
      pitch: n.pitch,
      velocity: n.velocity,
      channel: n.channel || 0,
      length_ticks: n.length_ticks,
      start_ticks: (n.start_ticks || 0) - earliest,
    }));
  }

  _paste({ afterSelection = false } = {}) {
    if (!this._clipboard?.length || !this.regionId) return;
    // Anchor: right after the selection if requested, else the current
    // cursor tick (set by the move handler), else 0.
    let anchor = 0;
    if (afterSelection && this._selection.size > 0) {
      let maxEnd = 0;
      for (const id of this._selection) {
        const n = this._localNotes.find((m) => m.id === id);
        if (n) maxEnd = Math.max(maxEnd, (n.start_ticks || 0) + (n.length_ticks || 0));
      }
      anchor = maxEnd;
    } else if (typeof this._cursorTicks === "number") {
      anchor = this._snap(this._cursorTicks, false);
    }
    const added = [];
    for (const clip of this._clipboard) {
      const note = {
        id: randomNoteId(this.regionId),
        pitch: clip.pitch,
        velocity: clip.velocity ?? 100,
        channel: clip.channel ?? 0,
        start_ticks: Math.max(0, anchor + (clip.start_ticks || 0)),
        length_ticks: Math.max(1, clip.length_ticks || this._snapTicks()),
      };
      added.push(note);
      this._send({ type: "add_note", region_id: this.regionId, note });
    }
    this._localNotes = [...this._localNotes, ...added];
    this._selection = new Set(added.map((n) => n.id));
  }

  _onNoteWheel(ev) {
    // Ctrl/Cmd-wheel  → horizontal zoom
    // Ctrl/Cmd+Shift-wheel → vertical zoom (row height)
    // Shift-wheel anywhere → velocity adjust on selection or hovered note
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const dir = ev.deltaY < 0 ? +1 : -1;
      if (ev.shiftKey) {
        const max = V_ROW_HEIGHTS.length - 1;
        this._rowIdx = Math.min(max, Math.max(0, this._rowIdx + dir));
      } else {
        const max = H_ZOOM_LEVELS.length - 1;
        this._zoomIdx = Math.min(max, Math.max(0, this._zoomIdx + dir));
      }
      return;
    }
    if (ev.shiftKey) {
      ev.preventDefault();
      // Adjust velocity on selected notes; if none selected, adjust
      // the hovered note (and select it for visual feedback).
      let ids = [...this._selection];
      if (ids.length === 0) {
        const hover = this._noteIdFromEvent(ev);
        if (hover) {
          ids = [hover];
          this._selection = new Set(ids);
        }
      }
      if (ids.length === 0) return;
      const step = ev.deltaY < 0 ? +4 : -4;
      for (const id of ids) {
        const note = this._localNotes.find((n) => n.id === id);
        if (!note) continue;
        const velocity = Math.min(127, Math.max(1, (note.velocity || 0) + step));
        if (velocity !== note.velocity) this._patchNote(id, { velocity });
      }
    }
  }

  _setVelocityOnSelection(value) {
    const v = Math.min(127, Math.max(1, Math.round(Number(value) || 0)));
    for (const id of this._selection) {
      const note = this._localNotes.find((n) => n.id === id);
      if (!note || note.velocity === v) continue;
      this._patchNote(id, { velocity: v });
    }
  }

  render() {
    const rowH = this._rowH();
    const hzoom = this._hzoom();
    const visiblePitches = [];
    for (let p = this._pitchHi; p >= this._pitchLo; p--) visiblePitches.push(p);
    const notes = (this._localNotes || []).filter(
      (n) => n.pitch >= this._pitchLo && n.pitch <= this._pitchHi,
    );
    const ppqn = this.ppqn || 960;
    const totalTicks = Math.max(
      notes.reduce((m, n) => Math.max(m, (n.start_ticks || 0) + (n.length_ticks || 0)), 0),
      ppqn * 16,
    );
    const canvasW = Math.max(600, totalTicks * hzoom);
    const canvasH = visiblePitches.length * rowH;

    const beatLines = [];
    const totalBeats = Math.ceil(totalTicks / ppqn);
    for (let b = 0; b <= totalBeats; b++) {
      const x = b * ppqn * hzoom;
      const isBar = (b % 4) === 0;
      beatLines.push(html`<div class="beat-line ${isBar ? "bar" : ""}" style="left:${x}px"></div>`);
    }
    const cStripes = [];
    visiblePitches.forEach((p, i) => {
      if (p % 12 === 0) {
        cStripes.push(html`<div class="c-stripe" style="top:${i * rowH}px"></div>`);
      }
    });

    const selCount = this._selection.size;

    // Resolve a velocity value to display / use as the slider start.
    // If exactly one note is selected, show that; if multiple, show
    // the average (rounded); otherwise disable the slider.
    let selVelocity = null;
    if (selCount === 1) {
      const one = this._localNotes.find((n) => this._selection.has(n.id));
      if (one) selVelocity = one.velocity ?? 100;
    } else if (selCount > 1) {
      let sum = 0, count = 0;
      for (const id of this._selection) {
        const n = this._localNotes.find((m) => m.id === id);
        if (n) { sum += n.velocity || 0; count++; }
      }
      selVelocity = count ? Math.round(sum / count) : null;
    }

    return html`
      <div class="toolbar">
        <span class="title">MIDI</span>
        <span>${this.regionName || "—"}</span>
        <span style="flex:1"></span>

        <div class="group ${selVelocity == null ? "disabled" : ""}"
             title="Velocity of selected note${selCount > 1 ? "s (avg)" : ""}">
          <span>Vel</span>
          <input type="range" min="1" max="127" step="1"
                 ?disabled=${selVelocity == null}
                 .value=${String(selVelocity ?? 100)}
                 @input=${(e) => this._setVelocityOnSelection(e.currentTarget.value)}>
          <span class="vel-value">${selVelocity ?? "—"}</span>
        </div>

        <div class="group" title="Snap">
          <span>Snap</span>
          <select @change=${(e) => { this._snapIdx = Number(e.currentTarget.value); }}>
            ${SNAP_OPTIONS.map((s, i) => html`
              <option value=${i} ?selected=${i === this._snapIdx}>${s.label}</option>
            `)}
          </select>
        </div>

        <div class="group" title="Horizontal zoom (Ctrl-scroll)">
          <span>H</span>
          <input type="range" min="0" max="${H_ZOOM_LEVELS.length - 1}" step="1"
                 .value=${String(this._zoomIdx)}
                 @input=${(e) => { this._zoomIdx = Number(e.currentTarget.value); }}>
          <span>${(hzoom * ppqn).toFixed(0)} px/beat</span>
        </div>

        <div class="group" title="Vertical zoom (Ctrl+Shift-scroll)">
          <span>V</span>
          <input type="range" min="0" max="${V_ROW_HEIGHTS.length - 1}" step="1"
                 .value=${String(this._rowIdx)}
                 @input=${(e) => { this._rowIdx = Number(e.currentTarget.value); }}>
          <span>${rowH}px</span>
        </div>

        <button title="Fit to notes" @click=${() => this._autoFitPitch()}>
          ${icon("arrows-pointing-in", 12)} Fit
        </button>
        <button title="Reset to full piano" @click=${() => this._resetPitch()}>
          A0–C8
        </button>
        <button title="Undo (Ctrl+Z)" @click=${() => this._send({ type: "undo" })}>↶</button>
        <button title="Redo (Ctrl+Shift+Z / Ctrl+Y)" @click=${() => this._send({ type: "redo" })}>↷</button>
      </div>

      <div class="body" style="--row-h:${rowH}px">
        <div class="keyboard">
          <div class="keys" style="height:${canvasH}px">
            ${visiblePitches.map((p) => html`
              <div class="key ${isBlackKey(p) ? "black" : ""} ${p % 12 === 0 ? "c-row" : ""}"
                   style="height:${rowH}px"
                   title=${keyLabel(p)}>
                ${p % 12 === 0 ? keyLabel(p) : ""}
              </div>
            `)}
          </div>
        </div>
        <div class="notes-scroll" @scroll=${this._onKeyboardSync}>
          <div class="notes-canvas ${this._drag ? "dragging" : ""}"
               style="width:${canvasW}px;height:${canvasH}px"
               @pointerdown=${(e) => this._onCanvasDown(e)}>
            ${cStripes}
            ${beatLines}
            ${notes.length === 0 ? html`
              <div class="empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--color-text-muted);pointer-events:none">
                Click anywhere to add a note.
              </div>
            ` : null}
            ${notes.map((n) => {
              const row = this._pitchHi - n.pitch;
              const x = (n.start_ticks  || 0) * hzoom;
              const w = Math.max(3, (n.length_ticks || 0) * hzoom);
              const y = row * rowH;
              const h = rowH - 1;
              const alpha = 0.5 + (n.velocity || 0) / 127 * 0.5;
              const sel = this._selection.has(n.id);
              return html`
                <div class="note ${sel ? "selected" : ""}"
                     data-note-id=${n.id}
                     title="${keyLabel(n.pitch)} · vel ${n.velocity} · ${n.length_ticks}t"
                     style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:${alpha}">
                  <div class="vel-badge">${n.velocity ?? 0}</div>
                  <div class="grip left"  data-grip="left"></div>
                  <div class="grip right" data-grip="right"></div>
                </div>
              `;
            })}
          </div>
        </div>
      </div>

      <div class="status">
        <span>${this._localNotes.length} note${this._localNotes.length === 1 ? "" : "s"}</span>
        <span>${selCount > 0 ? `${selCount} selected` : "—"}</span>
        <span style="flex:1"></span>
        <span>Click+drag → add · Drag → move · Edge → resize · Shift-wheel → velocity · Ctrl-wheel → zoom · Del → remove · Alt → bypass snap · Ctrl+C/X/V → clipboard · Ctrl+D → duplicate · Ctrl+Z → undo</span>
      </div>
    `;
  }
}
customElements.define("foyer-midi-editor", MidiEditor);

/** Open the MIDI editor for `region` as a bare element (no chrome). Caller
 *  wraps in a `<foyer-window>` or similar container. */
export function openMidiEditor(region) {
  const el = document.createElement("foyer-midi-editor");
  el.notes      = region?.notes || [];
  el.regionId   = region?.id || "";
  el.regionName = region?.name || "";
  return el;
}
