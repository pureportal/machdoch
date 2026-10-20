class SpeechRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 0;
    this.frames = 0;
    this.used = 0;
    this.finished = false;
    this.pending = null;
    this.port.onmessage = event => { if (event.data === "stop") this.finish(); };
  }
  flush() {
    if (!this.used) return;
    const buffer = this.pending.slice(0, this.used).buffer;
    this.port.postMessage({ type: "chunk", buffer, frames: this.frames, channels: this.channels }, [buffer]);
    this.used = 0;
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ type: "complete", frames: this.frames, channels: this.channels, sampleRate });
  }
  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    if (!this.channels) {
      this.channels = channels.length;
      if (this.channels > 8) { this.port.postMessage({ type: "error" }); this.finished = true; return false; }
      this.pending = new Float32Array(4096 * this.channels);
      this.maximum = Math.min(Math.floor((16 * 1024 * 1024 - 58) / (4 * this.channels)), sampleRate * 60);
    }
    if (channels.length !== this.channels) { this.port.postMessage({ type: "error" }); this.finished = true; return false; }
    for (let frame = 0; frame < channels[0].length; frame++) {
      if (this.frames >= this.maximum) { this.finish(); return false; }
      for (let channel = 0; channel < this.channels; channel++) this.pending[this.used++] = channels[channel][frame];
      this.frames++;
      if (this.used === this.pending.length) this.flush();
    }
    return true;
  }
}
registerProcessor("machdoch-speech-recorder", SpeechRecorder);
