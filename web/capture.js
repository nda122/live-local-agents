class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const value of samples) {
        this.buffer[this.offset++] = value;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer.slice());
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("capture", Capture);
