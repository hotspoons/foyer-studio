// AudioWorkletProcessor for browser → DAW ingress capture.
//
// Reads incoming audio from the graph (usually a MediaStreamSource),
// accumulates into a fixed-size frame, and posts the frame as a
// Float32Array (mono) to the main thread for WS upload.

class FoyerIngressProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options?.processorOptions?.frameSize || 960; // 20 ms @ 48 kHz
    this.buffer = new Float32Array(this.frameSize);
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Channel 0 only (mono ingress).
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    for (let i = 0; i < ch0.length; i++) {
      this.buffer[this.writeIndex++] = ch0[i];
      if (this.writeIndex >= this.frameSize) {
        // Post a copy so the next frame can start accumulating
        // immediately.
        this.port.postMessage(this.buffer.slice());
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor("foyer-ingress", FoyerIngressProcessor);
