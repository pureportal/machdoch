interface RecordingFrames { channels: number; sampleRate: number; frames: number; chunks: ArrayBuffer[] }
self.onmessage = (event: MessageEvent<RecordingFrames>): void => {
  try {
    const { channels, sampleRate, frames, chunks } = event.data;
    const bytes = frames * channels * 4;
    if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || bytes + 58 > 16 * 1024 * 1024) throw new Error("The recording exceeds the local reference format or size guard.");
    if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) !== bytes) throw new Error("The recording contains incomplete audio frames.");
    const buffer = new ArrayBuffer(bytes + 58);
    const view = new DataView(buffer);
    const four = (offset: number, value: string): void => { for (let index = 0; index < 4; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    four(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); four(8, "WAVE");
    four(12, "fmt "); view.setUint32(16, 18, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 0, true);
    four(38, "fact"); view.setUint32(42, 4, true); view.setUint32(46, frames, true);
    four(50, "data"); view.setUint32(54, bytes, true);
    let offset = 58;
    for (const chunk of chunks) for (const sample of new Float32Array(chunk)) {
      if (!Number.isFinite(sample)) throw new Error("The microphone returned invalid audio samples.");
      view.setFloat32(offset, sample, true); offset += 4;
    }
    self.postMessage({ buffer }, { transfer: [buffer] });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "The recording could not be encoded." }); }
};
