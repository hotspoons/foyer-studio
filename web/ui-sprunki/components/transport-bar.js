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
import { DEFAULT_BPM, DEFAULT_PATTERNS } from "./sound-catalog.js";
import { sprunkiStore } from "../state-store.js";
import { patternBarOffset, barsToSamples } from "../setup.js";

const ARRANGEMENT_BARS = DEFAULT_PATTERNS.length; // 4 bars total
const BAR_BEATS = 4;
const STEPS_PER_BAR = 16;

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

  /** Compute (start, end) sample range for the current play mode. */
  _loopRangeSamples() {
    const beat = (60 / this._bpm) * this._sampleRate;
    const oneBar = BAR_BEATS * beat;
    if (this._section) {
      const offset = patternBarOffset(this.patternId);
      return [offset * oneBar, (offset + 1) * oneBar];
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
    const next = Math.max(40, Math.min(300, this._bpm + delta));
    this._ws()?.controlSet?.("transport.tempo", next);
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
        <span class="bpm-value">${this._bpm}</span>
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
