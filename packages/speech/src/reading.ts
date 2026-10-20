import { orderedProductionTakes } from "./production.ts";
import { speechContentHash } from "./compiler.ts";
import type { SpeechProject, SpeechReadingBookmark, SpeechTake } from "./runtime.ts";
import type { AlignedWord } from "./alignment.ts";

export interface SpeechReadingSequence {
  takes: SpeechTake[];
  offsets: number[];
  duration: number;
  signature: string;
}

export async function speechReadingSequence(
  project: SpeechProject,
  takes: SpeechTake[],
  segments: readonly string[],
): Promise<SpeechReadingSequence> {
  const ordered = orderedProductionTakes(project, takes, segments, true);
  if (!ordered.length)
    throw new Error("Select production takes before reading the project.");
  const offsets: number[] = [];
  let duration = 0;
  for (const take of ordered) {
    if (!Number.isFinite(take.asset.duration) || take.asset.duration <= 0)
      throw new Error(
        "Choose takes with measured audio durations before reading.",
      );
    offsets.push(duration);
    duration += take.asset.duration;
  }
  return {
    takes: ordered,
    offsets,
    duration,
    signature: await speechContentHash([
      project.id,
      ordered.map((take) => [take.id, take.asset.sha256, take.asset.duration]),
    ]),
  };
}

export function speechReadingCues(take: SpeechTake): AlignedWord[] {
  let previous = 0;
  for (const word of take.alignment) {
    if (
      typeof word.text !== "string" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previous ||
      word.end < word.start ||
      word.end > take.asset.duration + 1 / take.asset.sampleRate
    )
      throw new Error(
        "The take's measured alignment is invalid. Realign it before following the transcript.",
      );
    previous = word.start;
  }
  const boundaries = [
    ...new Intl.Segmenter("und", { granularity: "sentence" }).segment(
      take.alignment.map((word) => word.text).join(" "),
    ),
  ]
    .slice(1)
    .map((sentence) => sentence.index);
  const cues: AlignedWord[] = [];
  let parts: string[] = [];
  let start = 0;
  let end = 0;
  let cursor = 0;
  let boundary = 0;
  for (const word of take.alignment) {
    const sentenceBreak =
      boundary < boundaries.length && boundaries[boundary]! <= cursor;
    if (parts.length && (sentenceBreak || word.start - end > 1)) {
      cues.push({ text: parts.join(" "), start, end });
      parts = [];
    }
    while (boundary < boundaries.length && boundaries[boundary]! <= cursor)
      boundary++;
    if (!parts.length) {
      start = word.start;
      end = word.end;
    } else end = Math.max(end, word.end);
    parts.push(word.text);
    cursor += word.text.length + 1;
  }
  if (parts.length) cues.push({ text: parts.join(" "), start, end });
  return cues;
}

export function parseSpeechReadingPosition(
  value: unknown,
  sequence: SpeechReadingSequence,
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "The saved reading position is damaged. Clear it before resuming.",
    );
  const record = value as { signature?: unknown; seconds?: unknown };
  if (
    typeof record.signature !== "string" ||
    typeof record.seconds !== "number" ||
    !Number.isFinite(record.seconds) ||
    record.seconds < 0
  )
    throw new Error(
      "The saved reading position is damaged. Clear it before resuming.",
    );
  if (record.signature !== sequence.signature) return null;
  if (record.seconds > sequence.duration)
    throw new Error(
      "The saved reading position exceeds the measured audio. Clear it before resuming.",
    );
  return record.seconds;
}

export function createSpeechReadingBookmark(
  sequence: SpeechReadingSequence,
  seconds: number,
  id: string,
  label: string,
): SpeechReadingBookmark {
  if (!id.trim() || !label.trim())
    throw new Error("Enter a bookmark name before adding it.");
  if (new TextEncoder().encode(label.trim()).byteLength > 1024)
    throw new Error("Keep the bookmark name within 1,024 UTF-8 bytes.");
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > sequence.duration)
    throw new Error("Choose a position within the measured reading audio.");
  let index = 0;
  for (let next = 1; next < sequence.offsets.length; next++) {
    if (sequence.offsets[next]! > seconds) break;
    index = next;
  }
  const take = sequence.takes[index];
  const localSeconds = seconds - sequence.offsets[index]!;
  if (
    !take ||
    !Number.isFinite(localSeconds) ||
    localSeconds < 0 ||
    localSeconds > take.asset.duration
  )
    throw new Error("Choose a position within the measured reading audio.");
  return {
    id,
    label: label.trim(),
    takeId: take.id,
    assetSha256: take.asset.sha256,
    seconds: localSeconds,
  };
}

export function resolveSpeechReadingBookmark(
  sequence: SpeechReadingSequence,
  bookmark: SpeechReadingBookmark,
): { available: true; seconds: number } | { available: false; reason: string } {
  const index = sequence.takes.findIndex((take) => take.id === bookmark.takeId);
  if (index < 0)
    return {
      available: false,
      reason:
        "The bookmarked take is missing or no longer selected. Select it again or remove the bookmark.",
    };
  const take = sequence.takes[index]!;
  if (take.asset.sha256 !== bookmark.assetSha256)
    return {
      available: false,
      reason:
        "The bookmarked audio has changed. Remove this bookmark and add one from the current audio.",
    };
  if (
    !Number.isFinite(bookmark.seconds) ||
    bookmark.seconds < 0 ||
    bookmark.seconds > take.asset.duration
  )
    return {
      available: false,
      reason:
        "The bookmarked position is outside this take's measured audio. Remove it and add a bookmark at the current reading position.",
    };
  return { available: true, seconds: sequence.offsets[index]! + bookmark.seconds };
}
