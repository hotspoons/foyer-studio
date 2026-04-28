// Browser-side MIDI preview using WebAudio.
//
// This is a stop-gap: the real thing should route preview notes through
// the DAW so the user hears the actual instrument / routing. But that
// requires a new shim command + Ardour-side MIDI injection, which is a
// ~200 line slice of its own. In the meantime, this synthesises an
// audible click/tone so the user gets immediate feedback when they
// click a cell with the "preview" toggle on.
//
// Drum pitches (channel 9 in GM) map to a short percussive hit
// (filtered noise + short envelope). Melodic pitches map to a
// two-oscillator square+triangle voice that respects the pitch.

let _ctx = null;
let _master = null;

function ctx() {
  if (_ctx) return _ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  _ctx = new AC();
  _master = _ctx.createGain();
  _master.gain.value = 0.5;
  _master.connect(_ctx.destination);
  return _ctx;
}

/** Call from a user gesture (pointerdown on the preview toggle) to
 *  un-suspend the shared AudioContext. Chrome + Safari block auto-play
 *  until the first interaction. */
export async function resumePreviewCtx() {
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") {
    try { await c.resume(); } catch {}
  }
}

function pitchHz(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

function playDrum(pitch, velocity) {
  const c = ctx(); if (!c) return;
  const vel = Math.max(0.05, Math.min(1, (velocity || 100) / 127));
  const now = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vel * 0.9, now + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  g.connect(_master);

  // Kick-ish pitches get a sine thump. Snare/clap/hat pitches get
  // filtered noise. Rough map; good enough for a click preview.
  const isKick = pitch === 35 || pitch === 36;
  const isSnare = pitch === 38 || pitch === 39 || pitch === 40;
  const isHat = pitch === 42 || pitch === 44 || pitch === 46;
  const isCymbal = pitch === 49 || pitch === 51 || pitch === 52 || pitch === 55 || pitch === 57;

  if (isKick) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.12);
    osc.connect(g);
    osc.start(now);
    osc.stop(now + 0.25);
  } else {
    // Filtered noise burst.
    const bufSize = Math.floor(c.sampleRate * 0.3);
    const buf = c.createBuffer(1, bufSize, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = isCymbal ? "highpass" : isHat ? "highpass" : "bandpass";
    bp.frequency.value = isCymbal ? 6000 : isHat ? 8000 : isSnare ? 1800 : 1200;
    bp.Q.value = isSnare ? 1.2 : 0.7;
    src.connect(bp); bp.connect(g);
    src.start(now);
    src.stop(now + 0.3);
    // Snare gets a little pitched body too.
    if (isSnare) {
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 220;
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, now);
      og.gain.exponentialRampToValueAtTime(vel * 0.4, now + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(og); og.connect(_master);
      osc.start(now); osc.stop(now + 0.18);
    }
  }
}

function playPitched(pitch, velocity) {
  const c = ctx(); if (!c) return;
  const vel = Math.max(0.05, Math.min(1, (velocity || 100) / 127));
  const now = c.currentTime;
  const hz = pitchHz(pitch);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vel * 0.4, now + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = Math.min(c.sampleRate * 0.45, hz * 6);
  filt.Q.value = 0.7;
  g.connect(filt); filt.connect(_master);

  const osc1 = c.createOscillator();
  osc1.type = "square";
  osc1.frequency.value = hz;
  const osc2 = c.createOscillator();
  osc2.type = "triangle";
  osc2.frequency.value = hz * 2;
  const osc2g = c.createGain();
  osc2g.gain.value = 0.25;
  osc1.connect(g);
  osc2.connect(osc2g); osc2g.connect(g);
  osc1.start(now); osc1.stop(now + 0.4);
  osc2.start(now); osc2.stop(now + 0.4);
}

/** Preview a single MIDI note in the browser. channel 9 = drum bank. */
export function playPreviewNote({ pitch, velocity = 100, channel = 0 }) {
  if (channel === 9) playDrum(pitch, velocity);
  else playPitched(pitch, velocity);
}
