// On-screen MIDI keyboard. 2-octave range with white + black keys,
// mouse + touch + computer-keyboard input. Routes notes through the
// Web MIDI service's synthetic `virtual:keyboard` device so users
// without a hardware controller can still exercise the bridge —
// per-device config (force-channel, transpose, velocity curve)
// applies the same way it would for a real input.
//
// Computer-keyboard map follows the convention Live / Logic / Reaper
// all share so muscle memory carries over: A-S-D-F-G-H-J-K-L are
// white keys C..D2, W-E-T-Y-U-O-P are black keys, Z / X shift the
// octave down / up.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { getWebMidiService, VIRTUAL_KEYBOARD_ID } from "foyer-core/midi/web-midi.js";
import { chordIntervals } from "foyer-core/music-theory.js";

// Two octaves, C-major-relative semitone offsets for the white keys.
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
// Black keys with their visual position relative to the white-key
// grid. `whiteIndex` is the index into WHITE_OFFSETS the black key
// is "between" — visually anchored at the right edge of that white
// key. `semitone` is the actual MIDI offset.
const BLACK_KEYS = [
  { whiteIndex: 0, semitone: 1  },
  { whiteIndex: 1, semitone: 3  },
  { whiteIndex: 3, semitone: 6  },
  { whiteIndex: 4, semitone: 8  },
  { whiteIndex: 5, semitone: 10 },
  { whiteIndex: 7, semitone: 13 },
  { whiteIndex: 8, semitone: 15 },
  { whiteIndex: 10, semitone: 18 },
  { whiteIndex: 11, semitone: 20 },
  { whiteIndex: 12, semitone: 22 },
];

// Computer-keyboard mappings. Lower-case so keydown.key is normalized.
const COMPUTER_KEY_MAP = {
  "a": 0,  "w": 1,  "s": 2,  "e": 3,  "d": 4,
  "f": 5,  "t": 6,  "g": 7,  "y": 8,  "h": 9,
  "u": 10, "j": 11, "k": 12, "o": 13, "l": 14,
  "p": 15, ";": 16, "'": 17,
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4
  return `${name}${octave}`;
}

export class SoftKeyboard extends LitElement {
  static properties = {
    _baseOctave: { state: true, type: Number },
    _velocity: { state: true, type: Number },
    _held: { state: true, type: Object },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%; height: 100%;
      color: var(--color-text);
      font-size: var(--font-size-sm, 13px);
      user-select: none;
      -webkit-user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-2, var(--color-surface));
    }
    .head .label {
      flex: 0 0 auto;
      color: var(--color-text-muted);
    }
    .head .spacer { flex: 1 1 auto; }
    .head button {
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-xs, 3px);
      color: var(--color-text);
      padding: 2px 8px;
      cursor: pointer;
      font: inherit;
    }
    .head button:hover { background: var(--color-surface); }
    .head input[type="range"] { width: 90px; }
    .keyboard-wrap {
      flex: 1 1 auto;
      position: relative;
      padding: 12px;
      display: flex; align-items: stretch; justify-content: center;
      overflow: hidden;
    }
    .keyboard {
      position: relative;
      flex: 1 1 auto;
      max-width: 720px;
      min-height: 140px;
      touch-action: none;
    }
    .row {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: repeat(15, 1fr);
    }
    .white {
      background: linear-gradient(to bottom, #fafafa, #e8e8e8);
      border: 1px solid var(--color-border);
      border-radius: 0 0 var(--radius-sm, 4px) var(--radius-sm, 4px);
      cursor: pointer;
      position: relative;
      display: flex; align-items: flex-end; justify-content: center;
      padding-bottom: 4px;
      color: #555;
      font-size: 10px;
    }
    .white + .white { border-left: none; }
    .white.held {
      background: linear-gradient(to bottom, #b8d4ff, #8aaef0);
      color: #0a2050;
    }
    .black {
      position: absolute;
      top: 0;
      width: calc(100% / 15 * 0.6);
      height: 60%;
      background: linear-gradient(to bottom, #2a2a2a, #0a0a0a);
      border: 1px solid #000;
      border-radius: 0 0 var(--radius-xs, 3px) var(--radius-xs, 3px);
      cursor: pointer;
      z-index: 2;
      color: #ccc;
      font-size: 9px;
      display: flex; align-items: flex-end; justify-content: center;
      padding-bottom: 4px;
    }
    .black.held {
      background: linear-gradient(to bottom, #5b81d8, #3b5fa8);
      color: #fff;
    }
    .footer {
      padding: 6px 12px;
      border-top: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 11px;
      display: flex; gap: 12px; flex-wrap: wrap;
    }
    kbd {
      display: inline-block;
      padding: 0 4px;
      border: 1px solid var(--color-border);
      border-radius: 3px;
      background: var(--color-surface);
      font-family: inherit;
      font-size: 10px;
    }
  `;

  constructor() {
    super();
    this._svc = getWebMidiService();
    // C3 default — most synth basses sit here, lets the user reach
    // both bass-clef and treble-clef ranges with a single shift.
    this._baseOctave = 3;
    this._velocity = 100;
    /** @type {Set<number>} MIDI note numbers currently held. */
    this._held = new Set();
    /** @type {Set<string>} Pointer ids → last note number, for legato. */
    this._pointerNotes = new Map();
    /** @type {Set<string>} computer keys currently down (so autorepeat doesn't re-trigger). */
    this._keyboardKeysDown = new Set();
    /**
     * Digit keys (3..7, 9) currently held — same chord-on-press
     * convention the piano roll and beat sequencer use. While a
     * digit is down, the next key/click expands into a chord rooted
     * at the played pitch. Highest held digit wins (matches the
     * piano-roll precedence so muscle memory carries over).
     */
    this._heldDigits = new Set();
    /** @type {boolean} */ this._modShift = false;
    /** @type {boolean} */ this._modCtrl = false;
    /**
     * Map<rootPitch, number[]>: every pitch we emitted on the most
     * recent press of `rootPitch`. Drives release — when the user
     * lifts the same physical key, every member of the chord gets a
     * note-off, not just the root.
     */
    this._chordRoots = new Map();
    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => this._handleKeyUp(e);
    this._onPointerCancel = (e) => this._releasePointer(e.pointerId);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._releaseAllNotes.bind(this));
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this._releaseAllNotes();
    super.disconnectedCallback();
  }

  _baseMidi() {
    // MIDI: C-1 = 0, so octave N = N*12 + 12. C3 = 48.
    return (this._baseOctave + 1) * 12;
  }

  _shiftOctave(delta) {
    this._releaseAllNotes();
    const next = Math.max(0, Math.min(8, this._baseOctave + delta));
    this._baseOctave = next;
  }

  /**
   * Resolve the active chord intervals from the held-digit + mod
   * state. Returns `[0]` (just the root) when no digit is held.
   * Soft keyboard always uses chromatic stacking — there's no scale
   * picker on this surface yet, so the diatonic mode of
   * `chordIntervals` would silently fall back to chromatic anyway.
   */
  _activeIntervals() {
    if (this._heldDigits.size === 0) return [0];
    // Highest digit wins — same convention the piano roll uses.
    const digit = Math.max(...this._heldDigits);
    return chordIntervals(digit, this._modShift, this._modCtrl, 0, "chromatic", 0);
  }

  /**
   * Press a key. Resolves a chord from current modifier state and
   * emits a note-on for each member; tracks them under `rootNote`
   * so a future `_noteOff(rootNote)` can release the whole chord.
   * `rootNote` is the visually-clicked pitch — only that key
   * highlights, even if the chord contains more notes (matches the
   * piano roll where only the clicked cell is "the click target"
   * and the rest are derived).
   */
  _noteOn(rootNote, velocity = this._velocity) {
    if (rootNote < 0 || rootNote > 127) return;
    if (this._chordRoots.has(rootNote)) return;
    const intervals = this._activeIntervals();
    const emitted = [];
    for (const iv of intervals) {
      const n = rootNote + iv;
      if (n < 0 || n > 127) continue;
      if (this._held.has(n)) continue;
      this._svc.inject(VIRTUAL_KEYBOARD_ID, [0x90, n, velocity]);
      emitted.push(n);
      this._held.add(n);
    }
    if (emitted.length === 0) return;
    this._chordRoots.set(rootNote, emitted);
    this._held = new Set(this._held);
  }

  _noteOff(rootNote) {
    if (rootNote < 0 || rootNote > 127) return;
    const chord = this._chordRoots.get(rootNote);
    if (chord) {
      for (const n of chord) {
        this._svc.inject(VIRTUAL_KEYBOARD_ID, [0x80, n, 0]);
        this._held.delete(n);
      }
      this._chordRoots.delete(rootNote);
      this._held = new Set(this._held);
      return;
    }
    // Stray release (e.g. note triggered by a route we don't track):
    // best-effort cleanup of just the root.
    if (this._held.has(rootNote)) {
      this._svc.inject(VIRTUAL_KEYBOARD_ID, [0x80, rootNote, 0]);
      this._held.delete(rootNote);
      this._held = new Set(this._held);
    }
  }

  _releaseAllNotes() {
    for (const root of Array.from(this._chordRoots.keys())) this._noteOff(root);
    // Anything still held that wasn't a tracked root (defensive).
    for (const n of Array.from(this._held)) {
      this._svc.inject(VIRTUAL_KEYBOARD_ID, [0x80, n, 0]);
    }
    this._held = new Set();
    this._chordRoots.clear();
    this._pointerNotes.clear();
    this._keyboardKeysDown.clear();
  }

  _handleKeyDown(e) {
    // Skip if typing in an input/textarea/contenteditable. Window-
    // level keydown listeners receive the SHADOW-ROOT HOST as
    // `e.target` (the event is retargeted across the shadow
    // boundary), so a naïve `target.matches("input, …")` misses any
    // input that lives inside a `<foyer-window>` / `<foyer-modal>`
    // shadow root — exactly the case in the Layouts dialog. Walk
    // `composedPath()` to see the real in-shadow element and
    // surrender the keypress to it.
    if (e.repeat) return;
    if (_eventTargetsTextInput(e)) return;
    // Track shift/ctrl as chord-shape modifiers — values reflect
    // current key state; a chord triggered while holding shift
    // gets `modShift=true` even if the user toggled it after
    // pressing the digit (the modifier resolves at NOTE press, not
    // digit press).
    this._modShift = !!e.shiftKey;
    this._modCtrl = !!(e.ctrlKey || e.metaKey);
    const k = e.key.toLowerCase();
    if (k === "z") { this._shiftOctave(-1); e.preventDefault(); return; }
    if (k === "x") { this._shiftOctave(+1); e.preventDefault(); return; }
    // Chord modifier: 3..7, 9. (8 is reserved — `chordIntervals`
    // doesn't define it and including it would silently fall back
    // to "no chord", which would surprise users who guessed.)
    if (/^[34567]$/.test(k) || k === "9") {
      this._heldDigits.add(Number(k));
      e.preventDefault();
      return;
    }
    const offset = COMPUTER_KEY_MAP[k];
    if (offset === undefined) return;
    if (this._keyboardKeysDown.has(k)) return;
    this._keyboardKeysDown.add(k);
    this._noteOn(this._baseMidi() + offset);
    e.preventDefault();
  }

  _handleKeyUp(e) {
    // Mirror keydown's focus check — if the user is typing into a
    // text input, the matching key-up shouldn't release a phantom
    // note (the corresponding key-down was suppressed, but stray
    // releases would still toggle `_heldDigits` and `_keyboardKeysDown`).
    if (_eventTargetsTextInput(e)) return;
    this._modShift = !!e.shiftKey;
    this._modCtrl = !!(e.ctrlKey || e.metaKey);
    const k = e.key.toLowerCase();
    if (/^[34567]$/.test(k) || k === "9") {
      this._heldDigits.delete(Number(k));
      return;
    }
    const offset = COMPUTER_KEY_MAP[k];
    if (offset === undefined) return;
    this._keyboardKeysDown.delete(k);
    this._noteOff(this._baseMidi() + offset);
  }

  _onPointerDown(ev, note) {
    ev.preventDefault();
    ev.target.setPointerCapture?.(ev.pointerId);
    this._pointerNotes.set(ev.pointerId, note);
    this._noteOn(note);
  }

  _onPointerEnter(ev, note) {
    if (ev.buttons === 0 && !ev.pointerType) return;
    if (ev.buttons === 0 && !this._pointerNotes.has(ev.pointerId)) return;
    const prev = this._pointerNotes.get(ev.pointerId);
    if (prev === note) return;
    if (prev !== undefined) this._noteOff(prev);
    this._pointerNotes.set(ev.pointerId, note);
    this._noteOn(note);
  }

  _onPointerUp(ev) {
    this._releasePointer(ev.pointerId);
  }

  _releasePointer(pointerId) {
    const note = this._pointerNotes.get(pointerId);
    if (note === undefined) return;
    this._pointerNotes.delete(pointerId);
    this._noteOff(note);
  }

  render() {
    const base = this._baseMidi();
    return html`
      <div class="head">
        <span class="label">Octave</span>
        <button @click=${() => this._shiftOctave(-1)} title="Shift down (Z)">−</button>
        <span>C${this._baseOctave}</span>
        <button @click=${() => this._shiftOctave(+1)} title="Shift up (X)">+</button>
        <span class="spacer"></span>
        <span class="label">Velocity ${this._velocity}</span>
        <input type="range" min="1" max="127" step="1"
          .value=${String(this._velocity)}
          @input=${(e) => { this._velocity = Number(e.target.value); }}>
      </div>
      <div class="keyboard-wrap"
           @pointerup=${this._onPointerUp}
           @pointercancel=${this._onPointerCancel}
           @pointerleave=${this._onPointerCancel}>
        <div class="keyboard">
          <div class="row">
            ${WHITE_OFFSETS.map((off) => {
              const note = base + off;
              const held = this._held.has(note);
              return html`<div
                class="white ${held ? "held" : ""}"
                @pointerdown=${(e) => this._onPointerDown(e, note)}
                @pointerenter=${(e) => this._onPointerEnter(e, note)}
                @pointerup=${this._onPointerUp}
                title=${noteName(note)}>${noteName(note)}</div>`;
            })}
          </div>
          ${BLACK_KEYS.map((bk) => {
            const note = base + bk.semitone;
            const held = this._held.has(note);
            // Center the black key on the boundary between white
            // (whiteIndex) and the next white key. Width is 60% of
            // a single white-key slot, so left = (whiteIndex+1)/15
            // - 30%/15 of the parent width.
            const leftPct = ((bk.whiteIndex + 1) / 15) * 100 - (60 / 15) / 2;
            return html`<div
              class="black ${held ? "held" : ""}"
              style="left:${leftPct.toFixed(3)}%"
              @pointerdown=${(e) => this._onPointerDown(e, note)}
              @pointerenter=${(e) => this._onPointerEnter(e, note)}
              @pointerup=${this._onPointerUp}
              title=${noteName(note)}>${noteName(note)}</div>`;
          })}
        </div>
      </div>
      <div class="footer">
        <span><kbd>A</kbd>…<kbd>;</kbd> white keys</span>
        <span><kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd>
          <kbd>O</kbd> <kbd>P</kbd> black keys</span>
        <span><kbd>Z</kbd> / <kbd>X</kbd> octave</span>
        <span>hold <kbd>3</kbd>…<kbd>9</kbd> for chord
          (+<kbd>shift</kbd>/<kbd>ctrl</kbd> for variants)</span>
      </div>
    `;
  }
}

customElements.define("foyer-soft-keyboard", SoftKeyboard);

/// Return true if the keyboard event was directed at a text-input-like
/// element, even one nested inside a shadow root. Window-level
/// listeners see `e.target` retargeted to the shadow-host element, so
/// a plain `target.matches("input, textarea, …")` would miss the
/// `<input>` inside a `<foyer-window>` / `<foyer-modal>` / any custom
/// element. Walking `composedPath()` reveals the real in-shadow path.
function _eventTargetsTextInput(e) {
  const selector =
    'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), ' +
    'textarea, ' +
    "[contenteditable=''], [contenteditable='true']";
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  for (const el of path) {
    if (el && typeof el.matches === "function" && el.matches(selector)) return true;
  }
  // Fallback for engines without composedPath: best-effort target check.
  const t = e.target;
  if (t && typeof t.matches === "function" && t.matches(selector)) return true;
  return false;
}
