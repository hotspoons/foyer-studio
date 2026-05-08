// Tiny Web Audio synth used as the "local monitor" for MIDI tracks
// during recording. The backend's egress path adds 200+ ms of
// round-trip latency (encode + WS + jitter buffer + worklet) which
// makes overdubbing impossible — every note arrives behind the
// metronome. Rendering the same notes locally with an instantaneous
// synth gives the player a foreground voice they can lock to, even
// if the timbre doesn't match the engine-side instrument exactly.
//
// Design notes:
//
//   * Polyphonic, one voice per held note. Voices are torn down on
//     note-off + a short release tail so a fast trill doesn't choke.
//
//   * Sound is intentionally generic — triangle oscillator with a
//     soft attack + decay + release envelope. We're going for "sounds
//     like a synth note" rather than "sounds like the engine's
//     instrument"; the player only needs a phase reference, not a
//     production tone. A future iteration could swap in a SoundFont
//     player for a closer match, but that's payload + complexity we
//     don't need to ship today.
//
//   * The `AudioContext` is created lazily on the first `feed()` to
//     avoid spinning up Web Audio for every page load. Browsers
//     require a user gesture before resuming a fresh context — the
//     callsite (the panel toggle) handles that explicitly via
//     `resume()`. After that, every subsequent `feed()` is on the
//     hot path and just twiddles oscillator nodes.

const ATTACK_S  = 0.005;
const DECAY_S   = 0.15;
const SUSTAIN   = 0.7;
const RELEASE_S = 0.15;
// Loud enough to feel "front of mix" against any backend audio that
// happens to leak through. The engine track is muted while local
// monitor is active so doubling shouldn't happen, but if a future
// session lands with mute already overridden by solo we still want
// the local synth to be clearly audible.
const MASTER_GAIN = 0.55;

function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export class LocalSynth {
  constructor() {
    this._ctx = null;
    this._master = null;
    /** Map<midiNote, { osc, env }>. */
    this._voices = new Map();
  }

  /** True iff a Web Audio context has been allocated. */
  get active() {
    return !!this._ctx;
  }

  /**
   * Resume / start the audio context. Must be called from a user
   * gesture (button click, keypress) on browsers that require one
   * (Chrome, Safari). Idempotent — calling on an already-running
   * context is a no-op. Returns the resulting context state, or
   * `"unsupported"` when the platform has no Web Audio.
   */
  async resume() {
    if (typeof window === "undefined") return "unsupported";
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return "unsupported";
    if (!this._ctx) {
      this._ctx = new Ctx();
      this._master = this._ctx.createGain();
      this._master.gain.value = MASTER_GAIN;
      this._master.connect(this._ctx.destination);
    }
    if (this._ctx.state === "suspended") {
      try { await this._ctx.resume(); } catch {}
    }
    return this._ctx.state;
  }

  /**
   * Feed a 1–3 byte channel-voice MIDI message. Note-on with
   * velocity 0 is treated as note-off (running-status convention).
   * Silently ignores anything that isn't a note message.
   */
  feed(bytes) {
    if (!bytes || bytes.length < 2) return;
    const status = bytes[0] & 0xf0;
    const note = bytes[1] & 0x7f;
    const vel = bytes.length >= 3 ? (bytes[2] & 0x7f) : 0;
    if (status === 0x90 && vel > 0) this._noteOn(note, vel);
    else if (status === 0x80 || (status === 0x90 && vel === 0)) this._noteOff(note);
    // Other statuses (CC, pitch bend, aftertouch) are noise for a
    // monitor synth — ignore.
  }

  _noteOn(note, velocity) {
    if (!this._ctx) return;
    if (this._voices.has(note)) this._stopVoice(note, /* fast */ true);
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const peak = (velocity / 127) * 0.6;
    const sustain = peak * SUSTAIN;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = midiToHz(note);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + ATTACK_S);
    env.gain.linearRampToValueAtTime(sustain, now + ATTACK_S + DECAY_S);
    osc.connect(env).connect(this._master);
    osc.start(now);
    this._voices.set(note, { osc, env });
  }

  _noteOff(note) {
    const v = this._voices.get(note);
    if (!v) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;
    // Smooth the release from current envelope value (avoids a
    // click when the user lifts during the attack/decay portion).
    const cur = v.env.gain.value;
    v.env.gain.cancelScheduledValues(now);
    v.env.gain.setValueAtTime(cur, now);
    v.env.gain.linearRampToValueAtTime(0, now + RELEASE_S);
    try { v.osc.stop(now + RELEASE_S + 0.02); } catch {}
    this._voices.delete(note);
  }

  _stopVoice(note, fast) {
    const v = this._voices.get(note);
    if (!v) return;
    try {
      if (fast) v.osc.stop();
    } catch {}
    this._voices.delete(note);
  }

  /** Stop every active voice immediately. Used on disarm / page-hide. */
  panic() {
    for (const note of Array.from(this._voices.keys())) {
      this._stopVoice(note, true);
    }
  }
}
