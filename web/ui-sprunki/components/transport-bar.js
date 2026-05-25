// Sprunki transport bar.
//
// Two distinct play modes:
//   * Play Section — loops just the active pattern's bar. Best for
//                    authoring; "drop a kick on step 5 → hear it
//                    every loop". Always loops while pressed.
//   * Play All     — plays the full arrangement (Intro→Verse→
//                    Chorus→Drop, 4 bars). Loop toggle controls
//                    whether playback wraps at the arrangement end.
//
// All transport state lives on the BACKEND (transport.playing,
// transport.position, transport.tempo, transport.looping +
// loop_start/end). This component is just a UI veneer that issues
// `control_set` + `set_loop_range` commands and reads back the
// echoed state from `__foyer.store`.

import { LitElement, html } from "lit";
import { transportStyles } from "../styles.js";
import { BARS_PER_PATTERN, DEFAULT_BPM, DEFAULT_PATTERNS } from "./sound-catalog.js";
import { sprunkiStore } from "../state-store.js";
import { patternBarOffset, barsToSamples } from "../setup.js";

// Each section/pattern is BARS_PER_PATTERN bars long; the full
// arrangement is that × the section count. Currently 4 × 4 = 16
// bars (OG sprunki feels more like 8-bar continuous; we'll
// collapse sections into a single loop once the arrangement
// palette lands — see SPRUNKI_VISION.md → "auto-captured loops").
const ARRANGEMENT_BARS = DEFAULT_PATTERNS.length * BARS_PER_PATTERN;
const BAR_BEATS = 4;

export class TransportBar extends LitElement {
  static styles = transportStyles;

  static properties = {
    /** Currently selected pattern (set by the parent app shell). */
    patternId: { type: String },
    /** Category → { track_id, region_id } map; needed for sample-rate-aware
     *  loop math when we add per-track loop sometime later. Currently
     *  unused but kept on the element so the parent can pass it
     *  without a separate prop refactor. */
    ids: { type: Object },
    /* internal reactive */
    _playing: { type: Boolean, state: true },
    _bpm: { type: Number, state: true },
    _position: { type: String, state: true },
    _sampleRate: { type: Number, state: true },
    _section: { type: Boolean, state: true },  // "section" mode if true, "all" if false
    _loop: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.patternId = "intro";
    this.ids = {};
    this._playing = false;
    this._bpm = DEFAULT_BPM;
    this._position = "1.1.1";
    this._sampleRate = 48000;
    const t = sprunkiStore().transport;
    this._section = t.mode === "section";
    this._loop = !!t.loop;
    this._onStoreChange = () => this._readState();
  }

  connectedCallback() {
    super.connectedCallback();
    const s = globalThis.__foyer?.store;
    s?.addEventListener?.("change", this._onStoreChange);
    s?.addEventListener?.("control", this._onStoreChange);
    this._readState();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    const s = globalThis.__foyer?.store;
    s?.removeEventListener?.("change", this._onStoreChange);
    s?.removeEventListener?.("control", this._onStoreChange);
  }

  _readState() {
    const s = globalThis.__foyer?.store;
    if (!s) return;
    // `transport.playing` lands as a bool from set_control + the
    // shim echo. Coerce to Boolean — Number(true) is 1 but
    // Number(false) is 0, and we don't care about velocity.
    this._playing = !!s.get?.("transport.playing");
    const t = Number(s.get?.("transport.tempo")) || DEFAULT_BPM;
    if (t > 0) this._bpm = t;
    const sr = Number(s.get?.("audio.sample_rate"));
    if (sr > 0) this._sampleRate = sr;

    // Position display in bars.beats.sixteenths.
    const samples = Number(s.get?.("transport.position")) || 0;
    const beatSamples = (60 / this._bpm) * this._sampleRate;
    const totalBeats = samples / beatSamples;
    const bars = Math.floor(totalBeats / BAR_BEATS);
    const beatsIn = Math.floor(totalBeats % BAR_BEATS);
    const sixteenths = Math.floor(((totalBeats % 1) * 4));
    this._position = `${bars + 1}.${beatsIn + 1}.${sixteenths + 1}`;
  }

  _ws() { return globalThis.__foyer?.ws; }

  /** Compute (start, end) sample range for the current play mode.
   *  Section mode loops one pattern, which now spans BARS_PER_PATTERN
   *  bars (not 1). All mode plays the full ARRANGEMENT_BARS sweep. */
  _loopRangeSamples() {
    const beat = (60 / this._bpm) * this._sampleRate;
    const oneBar = BAR_BEATS * beat;
    if (this._section) {
      const offset = patternBarOffset(this.patternId);
      return [offset * oneBar, (offset + BARS_PER_PATTERN) * oneBar];
    }
    return [0, ARRANGEMENT_BARS * oneBar];
  }

  _applyLoopAndPlay() {
    const ws = this._ws();
    if (!ws) return;
    const [start, end] = this._loopRangeSamples();
    // In Section mode loop is always on (that's the whole point —
    // hear the current bar over and over while authoring). In All
    // mode, the user's Loop toggle decides.
    const enabled = this._section ? true : this._loop;
    ws.send({
      type: "set_loop_range",
      start_samples: Math.round(start),
      end_samples: Math.round(end),
      enabled,
    });
    // Locate to the loop start so play picks up at the right bar
    // regardless of where the playhead was parked.
    ws.controlSet?.("transport.position", Math.round(start));
    ws.controlSet?.("transport.playing", true);
  }

  _playSection() {
    sprunkiStore().setTransport({ mode: "section", loop: true });
    this._section = true;
    this._loop = true;
    this._applyLoopAndPlay();
  }
  _playAll() {
    sprunkiStore().setTransport({ mode: "all", loop: this._loop });
    this._section = false;
    this._applyLoopAndPlay();
  }
  _stop() {
    const ws = this._ws();
    if (!ws) return;
    ws.controlSet?.("transport.playing", false);
  }
  _rewind() {
    const ws = this._ws();
    if (!ws) return;
    const [start] = this._loopRangeSamples();
    ws.controlSet?.("transport.position", Math.round(start));
  }
  _toggleLoop() {
    this._loop = !this._loop;
    sprunkiStore().setTransport({ loop: this._loop });
    // If we're already playing in "all" mode, update the loop
    // flag live so the change takes effect without forcing a
    // pause+resume.
    if (this._playing && !this._section) {
      const ws = this._ws();
      if (ws) {
        const [start, end] = this._loopRangeSamples();
        ws.send({
          type: "set_loop_range",
          start_samples: Math.round(start),
          end_samples: Math.round(end),
          enabled: this._loop,
        });
      }
    }
  }
  _setBpm(delta) {
    const next = Math.max(40, Math.min(300, Math.round(this._bpm) + delta));
    this._ws()?.controlSet?.("transport.tempo", next);
  }

  // ── click-and-drag on the BPM readout ─────────────────────────
  // Drag up to speed up, down to slow down. ~3 px per BPM unit
  // gives the kid plenty of throw for the 40–300 range without
  // crawling — ~85 px covers a 30 BPM swing.
  _onBpmPointerDown(e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("dragging");
    this._dragBpmStartY = e.clientY;
    this._dragBpmStart = Math.round(this._bpm);
    this._dragBpmLast = this._dragBpmStart;
    const move = (ev) => {
      const dy = this._dragBpmStartY - ev.clientY; // up = positive
      const next = Math.max(40, Math.min(300, this._dragBpmStart + Math.round(dy / 3)));
      if (next === this._dragBpmLast) return;
      this._dragBpmLast = next;
      // Optimistic local update for snappy feedback — the backend
      // echo will overwrite this in _readState once it lands.
      this._bpm = next;
      this._ws()?.controlSet?.("transport.tempo", next);
    };
    const up = (ev) => {
      el.releasePointerCapture?.(ev.pointerId);
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  render() {
    return html`
      <button class="transport-btn stop" title="Stop" @click=${this._stop}>⏹</button>
      <button class="transport-btn" title="Rewind" @click=${this._rewind}>⏮</button>
      <button
        class="transport-btn play ${this._playing && this._section ? 'playing' : ''}"
        title="Play current section (loops the active pattern)"
        @click=${this._playSection}
      >▶ Section</button>
      <button
        class="transport-btn play ${this._playing && !this._section ? 'playing' : ''}"
        title="Play the full arrangement"
        @click=${this._playAll}
      >▶ All</button>
      <button
        class="transport-btn ${this._loop ? 'on' : ''}"
        title="Loop the arrangement (Section mode always loops)"
        @click=${this._toggleLoop}
        ?disabled=${this._section}
      >🔁</button>

      <div class="bpm-display">
        <span class="bpm-label">BPM</span>
        <span
          class="bpm-value"
          title="Drag up/down to change tempo"
          @pointerdown=${this._onBpmPointerDown}
        >${Math.round(this._bpm)}</span>
        <div class="bpm-buttons">
          <button @click=${() => this._setBpm(1)}>▲</button>
          <button @click=${() => this._setBpm(-1)}>▼</button>
        </div>
      </div>

      <div class="position-display">${this._position}</div>
    `;
  }
}

customElements.define("sprunki-transport-bar", TransportBar);
