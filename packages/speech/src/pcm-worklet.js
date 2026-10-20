export class PcmRing {
  constructor(capacityFrames, channels) {
    if (!Number.isSafeInteger(capacityFrames) || capacityFrames <= 0) throw new Error("PCM ring capacity must be a positive integer.");
    if (channels !== 1 && channels !== 2) throw new Error("PCM requires one or two channels.");
    this.capacityFrames = capacityFrames;
    this.channels = channels;
    this.samples = new Float32Array(capacityFrames * channels);
    this.readIndex = 0;
    this.bufferedFrames = 0;
    this.maxBufferedFrames = 0;
    this.playedFrames = 0;
    this.consumedFrames = 0;
    this.phase = 0;
  }

  write(samples) {
    if (!(samples instanceof Float32Array) || samples.length % this.channels !== 0) throw new Error("PCM chunk is not channel aligned.");
    const frames = samples.length / this.channels;
    if (frames > this.capacityFrames - this.bufferedFrames) throw new Error("PCM ring capacity exceeded.");
    for (let frame = 0; frame < frames; frame++) {
      const target = (this.readIndex + this.bufferedFrames + frame) % this.capacityFrames;
      for (let channel = 0; channel < this.channels; channel++) this.samples[target * this.channels + channel] = samples[frame * this.channels + channel];
    }
    this.bufferedFrames += frames;
    this.maxBufferedFrames = Math.max(this.maxBufferedFrames, this.bufferedFrames);
  }

  render(outputs, rate) {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4) throw new Error("Invalid PCM playback rate.");
    if (outputs.length !== this.channels || outputs.some(output => output.length !== outputs[0].length)) throw new Error("PCM output channels do not match.");
    for (const output of outputs) output.fill(0);
    let rendered = 0;
    while (rendered < outputs[0].length && this.bufferedFrames > 0) {
      const nextIndex = this.bufferedFrames > 1 ? (this.readIndex + 1) % this.capacityFrames : this.readIndex;
      for (let channel = 0; channel < this.channels; channel++) {
        const current = this.samples[this.readIndex * this.channels + channel];
        const next = this.samples[nextIndex * this.channels + channel];
        outputs[channel][rendered] = current + (next - current) * this.phase;
      }
      const advance = Math.min(rate, this.bufferedFrames - this.phase);
      this.phase += advance;
      const consumed = Math.floor(this.phase);
      this.readIndex = (this.readIndex + consumed) % this.capacityFrames;
      this.bufferedFrames -= consumed;
      this.phase -= consumed;
      this.consumedFrames += consumed;
      this.playedFrames = this.consumedFrames + this.phase;
      rendered++;
    }
    return rendered;
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class SpeechPcmProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: "playbackRate", defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
        { name: "playing", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      ];
    }

    constructor(options) {
      super();
      const { channels, capacityFrames } = options.processorOptions;
      if (capacityFrames > sampleRate * 5) throw new Error("PCM ring exceeds five seconds.");
      this.ring = new PcmRing(capacityFrames, channels);
      this.complete = false;
      this.failed = false;
      this.underrunFrames = 0;
      this.underrunCount = 0;
      this.underrunning = false;
      this.maxBufferedFrames = 0;
      this.rendered = false;
      this.port.onmessage = event => {
        const message = event.data;
        try {
          if (!Number.isSafeInteger(message.id)) throw new Error("Invalid PCM message ID.");
          if (message.type === "append") {
            if (this.complete) throw new Error("PCM input is already complete.");
            if (typeof message.complete !== "boolean" || message.samples.byteLength > 131072) throw new Error("Invalid PCM append.");
            this.ring.write(message.samples);
            this.maxBufferedFrames = Math.max(this.maxBufferedFrames, this.ring.bufferedFrames);
            this.complete = message.complete;
          } else if (message.type !== "state") throw new Error("Unknown PCM command.");
          this.port.postMessage({
            id: message.id,
            bufferedFrames: this.ring.bufferedFrames,
            playedFrames: this.ring.playedFrames,
            underrunFrames: this.underrunFrames,
            underrunCount: this.underrunCount,
            maxBufferedFrames: this.maxBufferedFrames,
            ended: this.complete && this.ring.bufferedFrames === 0,
          });
        } catch (error) {
          this.failed = true;
          this.port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
      };
    }

    process(inputs, outputs, parameters) {
      if (this.failed) return false;
      const output = outputs[0];
      if (parameters.playing[0] < 0.5) {
        this.underrunning = false;
        for (const channel of output) channel.fill(0);
        return true;
      }
      const rendered = this.ring.render(output, parameters.playbackRate[0]);
      if (rendered > 0 && !this.rendered) {
        this.rendered = true;
        this.port.postMessage({type:"first-render"});
      }
      const missing = this.complete ? 0 : output[0].length - rendered;
      this.underrunFrames += missing;
      if (missing > 0 && !this.underrunning) this.underrunCount++;
      this.underrunning = missing > 0;
      return true;
    }
  }

  registerProcessor("speech-pcm", SpeechPcmProcessor);
}
