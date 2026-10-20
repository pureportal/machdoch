export type Decibels = number | "-inf";
import type { SpeechAudioAnalysis, SpeechAsset } from "./runtime.ts";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid audio analysis.");
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid audio measurement.");
  }
  return value;
}

function integer(value: unknown): number {
  const result = finite(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid audio count.");
  return result;
}

function decibels(value: unknown): Decibels {
  return value === "-inf" ? value : finite(value);
}

export function parseAudioAnalysis(
  value: unknown,
  asset: Pick<SpeechAsset, "duration" | "sampleRate" | "channels">,
): SpeechAudioAnalysis {
  const data = record(value);
  const duration = finite(data.duration);
  const frames = integer(data.frames);
  const sampleRate = integer(data.sampleRate);
  const channels = integer(data.channels);
  const sampleCount = integer(data.sampleCount);
  const clippedSamples = integer(data.clippedSamples);
  const zeroSamples = integer(data.zeroSamples);
  const silentFrames = integer(data.silentFrames);
  const leadingSilence = finite(data.leadingSilence);
  const trailingSilence = finite(data.trailingSilence);
  if (
    channels !== asset.channels ||
    sampleRate !== asset.sampleRate ||
    Math.abs(duration - asset.duration) > 1 / sampleRate
  )
    throw new Error(
      "Audio analysis does not match the recording. Rebuild the audio analysis.",
    );
  if (
    silentFrames > frames ||
    zeroSamples < silentFrames * channels ||
    clippedSamples + zeroSamples > sampleCount ||
    leadingSilence < 0 ||
    trailingSilence < 0 ||
    leadingSilence > silentFrames / sampleRate ||
    trailingSilence > silentFrames / sampleRate ||
    (silentFrames < frames &&
      leadingSilence + trailingSilence > silentFrames / sampleRate + 1e-9)
  ) {
    throw new Error("Invalid silence measurements.");
  }
  if (
    duration <= 0 ||
    frames === 0 ||
    sampleRate === 0 ||
    channels === 0 ||
    sampleCount !== frames * channels ||
    clippedSamples > sampleCount ||
    zeroSamples > sampleCount ||
    Math.abs(duration - frames / sampleRate) > 1e-9
  ) {
    throw new Error("Invalid audio dimensions.");
  }
  if (
    !Array.isArray(data.peaks) ||
    data.peaks.length === 0 ||
    data.peaks.length > 4096
  ) {
    throw new Error("Invalid waveform.");
  }
  let endFrame = 0;
  const peaks = data.peaks.map(
    (value: unknown): SpeechAudioAnalysis["peaks"][number] => {
      const peak = record(value);
      const startFrame = integer(peak.startFrame);
      const nextFrame = integer(peak.endFrame);
      const min = finite(peak.min);
      const max = finite(peak.max);
      if (
        startFrame !== endFrame ||
        nextFrame <= startFrame ||
        nextFrame > frames ||
        min > max
      ) {
        throw new Error("Invalid waveform bounds.");
      }
      endFrame = nextFrame;
      return { startFrame, endFrame: nextFrame, min, max };
    },
  );
  if (endFrame !== frames) throw new Error("Incomplete waveform.");
  const loudness = record(data.loudness);
  return {
    duration,
    frames,
    sampleRate,
    channels,
    sampleCount,
    clippedSamples,
    zeroSamples,
    silentFrames,
    leadingSilence,
    trailingSilence,
    peaks,
    rmsDbfs: decibels(data.rmsDbfs),
    samplePeakDbfs: decibels(data.samplePeakDbfs),
    loudness: {
      integratedLufs: decibels(loudness.integratedLufs),
      truePeakDbtp: decibels(loudness.truePeakDbtp),
    },
  };
}
