// Runs inside the browser's AudioWorkletGlobalScope — a dedicated
// real-time audio thread, *not* the main thread. This is why
// migrating here from the `setInterval(5 ms)` scheduler fixes the
// jitter-induced resets: `process()` is driven by the audio clock
// itself, not main-thread timers, so GC / layout / tab throttling
// can't starve it. Quantum is 128 frames (~2.67 ms @ 48 kHz).
//
// Protocol with the main thread:
//   · `port.postMessage({ ch0, ch1 })` — transfer two Float32Arrays
//     of deinterleaved PCM. `ch0.length === ch1.length`, any length.
//   · `port.postMessage({ cmd: "reset" })` — flush the ring.
//
// Backpressure: single-producer (main) / single-consumer (audio)
// model. No atomics needed — JS guarantees message-queue ordering
// between main and worklet threads, and `process()` only mutates
// `readIdx` + `available`. The main thread only mutates `writeIdx`
// + `available` inside the onmessage handler, which is itself
// run on the audio thread (worklet onmessage IS the audio thread).
// So all mutations are local to the audio thread — fully safe.

class FoyerPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 2-second ring @ 48 kHz. Enough slack for any realistic browser
    // hiccup; overflow drops oldest (the user was going to miss
    // something anyway, and the alternative — blocking the producer —
    // isn't available across threads).
    this.ringSize = 96000;
    this.ringCh0 = new Float32Array(this.ringSize);
    this.ringCh1 = new Float32Array(this.ringSize);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.available = 0;

    // Priming lead — don't start outputting until we have this much
    // buffered. Matches the 200 ms target from the old scheduler;
    // gives us cushion against WebSocket packet burst-gaps.
    this.primeSamples = Math.floor(sampleRate * 0.2);
    this.primed = false;

    // Stats — pushed back to main periodically for diagnostics.
    this.statsWritten = 0;
    this.statsRead = 0;
    this.statsUnderruns = 0;
    this.statsOverruns = 0;
    this.lastStatsFrame = 0;

    this.port.onmessage = (ev) => this._onMessage(ev.data);
  }

  _onMessage(data) {
    if (data && data.cmd === "reset") {
      this.writeIdx = 0;
      this.readIdx = 0;
      this.available = 0;
      this.primed = false;
      return;
    }
    const { ch0, ch1 } = data;
    if (!ch0 || !ch1) return;
    const n = ch0.length;
    this.statsWritten += n;
    for (let i = 0; i < n; i++) {
      this.ringCh0[this.writeIdx] = ch0[i];
      this.ringCh1[this.writeIdx] = ch1[i];
      this.writeIdx = this.writeIdx + 1;
      if (this.writeIdx === this.ringSize) this.writeIdx = 0;
      if (this.available < this.ringSize) {
        this.available++;
      } else {
        // Ring full → drop oldest by advancing readIdx past the
        // just-overwritten slot.
        this.readIdx = this.readIdx + 1;
        if (this.readIdx === this.ringSize) this.readIdx = 0;
        this.statsOverruns++;
      }
    }
  }

  process(_inputs, outputs, _params) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0]; // mono-output safety; we declare 2
    const n = l.length;

    if (!this.primed) {
      if (this.available >= this.primeSamples) {
        this.primed = true;
      } else {
        // Output silence while we fill the priming window.
        l.fill(0);
        if (r !== l) r.fill(0);
        return true;
      }
    }

    for (let i = 0; i < n; i++) {
      if (this.available > 0) {
        l[i] = this.ringCh0[this.readIdx];
        r[i] = this.ringCh1[this.readIdx];
        this.readIdx = this.readIdx + 1;
        if (this.readIdx === this.ringSize) this.readIdx = 0;
        this.available--;
        this.statsRead++;
      } else {
        l[i] = 0;
        r[i] = 0;
        this.statsUnderruns++;
      }
    }

    // Emit stats every ~1 s so the main thread can log them without
    // drowning the console.
    if (currentFrame - this.lastStatsFrame > sampleRate) {
      this.lastStatsFrame = currentFrame;
      this.port.postMessage({
        kind: "stats",
        written: this.statsWritten,
        read: this.statsRead,
        underruns: this.statsUnderruns,
        overruns: this.statsOverruns,
        buffered: this.available,
      });
    }

    return true;
  }
}

registerProcessor("foyer-pcm", FoyerPcmProcessor);
