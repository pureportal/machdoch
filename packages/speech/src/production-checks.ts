import type { CompiledSpeechSegment } from "./compiler.ts";
import type {
  SpeechAudioAnalysis,
  SpeechProject,
  SpeechTake,
} from "./runtime.ts";

export interface SpeechProductionFinding {
  segmentId: string;
  takeId?: string;
  severity: "error" | "review";
  code: string;
  message: string;
  position?: number;
}
export interface SpeechProductionCheckPolicy {
  silencePercent: number;
  truePeakDbtp: number;
  targetLufs: number | null;
  loudnessTolerance: number;
  durationTolerancePercent: number | null;
}
export const DEFAULT_PRODUCTION_CHECKS: SpeechProductionCheckPolicy = {
  silencePercent: 100,
  truePeakDbtp: 0,
  targetLufs: null,
  loudnessTolerance: 1,
  durationTolerancePercent: null,
};

export function speechProductionSelections(
  project: SpeechProject,
  takes: SpeechTake[],
  segments: readonly CompiledSpeechSegment[],
  limit = 100,
): {
  selected: Array<{ take: SpeechTake; segment: CompiledSpeechSegment }>;
  findings: SpeechProductionFinding[];
  truncated: boolean;
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Choose a production result limit from 1 to 1,000.");
  const byId = new Map(takes.map((take) => [take.id, take]));
  const rendered = new Set(
    takes
      .filter((take) => take.projectId === project.id)
      .map((take) => take.segmentId),
  );
  const selected: Array<{ take: SpeechTake; segment: CompiledSpeechSegment }> =
    [];
  const findings: SpeechProductionFinding[] = [];
  let truncated = false;
  const add = (finding: SpeechProductionFinding) => {
    if (findings.length < limit) findings.push(finding);
    else truncated = true;
  };
  for (const segment of segments) {
    const id = project.selectedTakes[segment.id];
    const take = id ? byId.get(id) : undefined;
    if (!id) {
      add({
        segmentId: segment.id,
        severity: "error",
        code: rendered.has(segment.id) ? "unselected" : "unrendered",
        message: rendered.has(segment.id)
          ? "Select a production take for this segment."
          : "Render this segment and select a take.",
      });
      continue;
    }
    if (
      !take ||
      take.projectId !== project.id ||
      take.segmentId !== segment.id
    ) {
      add({
        segmentId: segment.id,
        severity: "error",
        code: "unavailable",
        message:
          "The selected take is unavailable for this segment. Select another take.",
      });
      continue;
    }
    selected.push({ take, segment });
    if (take.spokenText !== segment.spokenText)
      add({
        segmentId: segment.id,
        takeId: take.id,
        severity: "error",
        code: "transcript",
        message:
          "The submitted transcript differs from this script segment. Render the current text.",
        position: 0,
      });
  }
  return { selected, findings, truncated };
}

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const words = (text: string) =>
  [...segmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter((word) => word.isWordLike)
    .map((word) => word.segment);
function counts(tokens: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

export function speechTakeProductionChecks(
  segment: CompiledSpeechSegment,
  take: SpeechTake,
  analysis: SpeechAudioAnalysis,
  policy: SpeechProductionCheckPolicy,
): SpeechProductionFinding[] {
  if (
    !Number.isFinite(policy.silencePercent) ||
    policy.silencePercent < 0 ||
    policy.silencePercent > 100 ||
    !Number.isFinite(policy.truePeakDbtp) ||
    policy.truePeakDbtp < -12 ||
    policy.truePeakDbtp > 0 ||
    !Number.isFinite(policy.loudnessTolerance) ||
    policy.loudnessTolerance < 0 ||
    (policy.targetLufs !== null &&
      (!Number.isFinite(policy.targetLufs) ||
        policy.targetLufs < -70 ||
        policy.targetLufs > 0)) ||
    (policy.durationTolerancePercent !== null &&
      (!Number.isFinite(policy.durationTolerancePercent) ||
        policy.durationTolerancePercent < 0))
  )
    throw new Error("Choose valid local production-check targets.");
  const result: SpeechProductionFinding[] = [];
  const add = (
    code: string,
    message: string,
    position = 0,
    severity: SpeechProductionFinding["severity"] = "review",
  ) =>
    result.push({
      segmentId: segment.id,
      takeId: take.id,
      code,
      message,
      position,
      severity,
    });
  const silence = (analysis.silentFrames / analysis.frames) * 100;
  if (analysis.silentFrames > 0 && silence >= policy.silencePercent)
    add(
      "silence",
      `${silence.toFixed(1)}% digital silence. Review the recording.`,
      analysis.leadingSilence > 0
        ? 0
        : Math.max(0, analysis.duration - analysis.trailingSilence),
    );
  if (analysis.clippedSamples > 0)
    add(
      "clipping",
      `${analysis.clippedSamples} samples reach or exceed full scale. Lower gain or render another take.`,
      (analysis.peaks.find((peak) => peak.min <= -1 || peak.max >= 1)
        ?.startFrame ?? 0) / analysis.sampleRate,
    );
  if (
    analysis.loudness.truePeakDbtp !== "-inf" &&
    analysis.loudness.truePeakDbtp > policy.truePeakDbtp
  )
    add(
      "true-peak",
      `True peak is ${analysis.loudness.truePeakDbtp.toFixed(2)} dBTP, above ${policy.truePeakDbtp} dBTP. Lower the export gain.`,
    );
  if (
    policy.targetLufs !== null &&
    (analysis.loudness.integratedLufs === "-inf" ||
      Math.abs(analysis.loudness.integratedLufs - policy.targetLufs) >
        policy.loudnessTolerance)
  )
    add(
      "loudness",
      `Measured loudness is ${analysis.loudness.integratedLufs} LUFS. Review the export loudness target.`,
    );
  if (
    policy.durationTolerancePercent !== null &&
    Number.isFinite(segment.estimatedDurationSeconds) &&
    segment.estimatedDurationSeconds > 0 &&
    (Math.abs(analysis.duration - segment.estimatedDurationSeconds) /
      segment.estimatedDurationSeconds) *
      100 >
      policy.durationTolerancePercent
  )
    add(
      "duration",
      `Duration is ${analysis.duration.toFixed(2)} s; the script estimate is ${segment.estimatedDurationSeconds.toFixed(2)} s. Listen for missing or repeated material.`,
    );
  if (!take.alignment.length) {
    add(
      "alignment-unavailable",
      "Word alignment is unavailable. Review the transcript while listening.",
    );
    return result;
  }
  const expected = words(take.spokenText),
    actual = take.alignment.flatMap((word) => words(word.text));
  const expectedCounts = counts(expected),
    actualCounts = counts(actual);
  const missing = [...expectedCounts]
    .filter(([token, count]) => (actualCounts.get(token) ?? 0) < count)
    .slice(0, 8)
    .map(([token]) => token);
  if (missing.length)
    add(
      "alignment-text",
      `Alignment does not include: ${missing.join(", ")}. Compare with the recording.`,
    );
  const trigrams = (tokens: string[]) =>
    counts(
      tokens
        .slice(0, -2)
        .map((_, index) => tokens.slice(index, index + 3).join(" ")),
    );
  const expectedPhrases = trigrams(expected),
    actualPhrases = trigrams(actual);
  const repeated = [...actualPhrases].find(
    ([phrase, count]) =>
      count >= 2 && count > (expectedPhrases.get(phrase) ?? 0),
  );
  if (repeated) {
    const first = repeated[0].split(" ")[0];
    const word = take.alignment.find((word) =>
      words(word.text).includes(first!),
    );
    add(
      "repetition",
      `Alignment repeats “${repeated[0].slice(0, 120)}” more often than the submitted text. Listen to confirm.`,
      word?.start ?? 0,
    );
  }
  return result;
}
