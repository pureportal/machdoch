import type {
  SpeechExportPreset,
  SpeechProject,
  SpeechTake,
} from "./runtime.ts";

export const DEFAULT_SPEECH_EXPORT: Readonly<SpeechExportPreset> =
  Object.freeze({
    format: "wav",
    sampleRate: 48000,
    channels: 2,
    bitrate: 192000,
    loudnessLufs: null,
    truePeakDb: null,
  });

export function validateSpeechExportPreset(value: SpeechExportPreset): void {
  if (
    ![
      "wav",
      "mp3",
      "opus",
      "flac",
      "m4b",
      "srt",
      "vtt",
      "txt",
      "json",
      "archive",
    ].includes(value.format)
  )
    throw new Error("Choose a supported export format.");
  if (
    !Number.isInteger(value.sampleRate) ||
    value.sampleRate < 8000 ||
    value.sampleRate > 192000 ||
    ![1, 2].includes(value.channels)
  )
    throw new Error(
      "Choose a sample rate from 8,000 to 192,000 Hz and one or two channels.",
    );
  if (
    !Number.isInteger(value.bitrate) ||
    value.bitrate < 0 ||
    value.bitrate > 512000 ||
    (["mp3", "opus", "m4b"].includes(value.format) && value.bitrate < 16000)
  )
    throw new Error(
      "Choose a compressed bitrate from 16,000 to 512,000 bits per second.",
    );
  if ((value.loudnessLufs === null) !== (value.truePeakDb === null))
    throw new Error(
      "Set both target loudness and true peak, or leave both unset.",
    );
  if (value.loudnessLufs !== null) {
    const peak = value.truePeakDb;
    if (
      !Number.isFinite(value.loudnessLufs) ||
      value.loudnessLufs < -70 ||
      value.loudnessLufs > -5 ||
      peak === null ||
      !Number.isFinite(peak) ||
      peak < -9 ||
      peak > 0
    )
      throw new Error(
        "Choose loudness from -70 to -5 LUFS and true peak from -9 to 0 dBTP.",
      );
  }
}

export function orderedProductionTakes(
  project: SpeechProject,
  takes: SpeechTake[],
  segments: readonly string[],
  complete: boolean,
): SpeechTake[] {
  const result: SpeechTake[] = [];
  const byId=new Map(takes.map(take=>[take.id,take]));
  for (const id of segments) {
    const selected = project.selectedTakes[id];
    if (!selected) {
      if (complete)
        throw new Error(
          "Select a take for every current script segment before producing the project.",
        );
      continue;
    }
    const take = byId.get(selected);
    if (!take||take.projectId!==project.id||take.segmentId!==id)
      throw new Error(
        "A selected production take is unavailable or belongs to a different segment. Select it again.",
      );
    result.push(take);
  }
  return result;
}
