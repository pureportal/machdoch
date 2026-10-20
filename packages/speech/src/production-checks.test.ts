import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRODUCTION_CHECKS,
  speechProductionSelections,
  speechTakeProductionChecks,
} from "./production-checks.ts";
import { parseAudioAnalysis } from "./audio-analysis.ts";
import type {
  SpeechAudioAnalysis,
  SpeechProject,
  SpeechTake,
} from "./runtime.ts";
import type { CompiledSpeechSegment } from "./compiler.ts";
const asset = { duration: 1, sampleRate: 24000, channels: 1 };
const analysis: SpeechAudioAnalysis = {
  ...asset,
  frames: 24000,
  sampleCount: 24000,
  clippedSamples: 0,
  zeroSamples: 0,
  silentFrames: 0,
  leadingSilence: 0,
  trailingSilence: 0,
  rmsDbfs: -20,
  samplePeakDbfs: -12,
  peaks: [{ startFrame: 0, endFrame: 24000, min: -0.25, max: 0.25 }],
  loudness: { integratedLufs: -16, truePeakDbtp: -12 },
};
const segment = {
  id: "segment",
  spokenText: "Read these words.",
  estimatedDurationSeconds: 1,
} as CompiledSpeechSegment;
const take = {
  id: "take",
  projectId: "book",
  segmentId: segment.id,
  spokenText: segment.spokenText,
  asset,
  alignment: [{ text: segment.spokenText, start: 0, end: 1 }],
} as SpeechTake;

test("production selections distinguish unrendered, unselected, stale and mismatched transcript", () => {
  const project = { id: "book", selectedTakes: {} } as SpeechProject;
  assert.equal(
    speechProductionSelections(project, [], [segment]).findings[0]!.code,
    "unrendered",
  );
  assert.equal(
    speechProductionSelections(project, [take], [segment]).findings[0]!.code,
    "unselected",
  );
  project.selectedTakes[segment.id] = "missing";
  assert.equal(
    speechProductionSelections(project, [take], [segment]).findings[0]!.code,
    "unavailable",
  );
  project.selectedTakes[segment.id] = take.id;
  assert.deepEqual(
    speechProductionSelections(project, [take], [segment]).findings,
    [],
  );
  assert.equal(
    speechProductionSelections(
      project,
      [{ ...take, spokenText: "Other words." }],
      [segment],
    ).findings[0]!.code,
    "transcript",
  );
});

test("production measurements report real silence, full scale, peak and optional duration/loudness targets", () => {
  assert.deepEqual(
    speechTakeProductionChecks(
      segment,
      take,
      analysis,
      DEFAULT_PRODUCTION_CHECKS,
    ),
    [],
  );
  const silence = {
    ...analysis,
    zeroSamples: 24000,
    silentFrames: 24000,
    leadingSilence: 1,
    trailingSilence: 1,
    rmsDbfs: "-inf",
    samplePeakDbfs: "-inf",
    loudness: { integratedLufs: "-inf", truePeakDbtp: "-inf" },
  } as SpeechAudioAnalysis;
  assert.ok(
    speechTakeProductionChecks(
      segment,
      take,
      silence,
      DEFAULT_PRODUCTION_CHECKS,
    ).some((finding) => finding.code === "silence"),
  );
  const clipped = {
    ...analysis,
    clippedSamples: 2,
    peaks: [{ startFrame: 12000, endFrame: 24000, min: -1, max: 1 }],
    loudness: { integratedLufs: -10, truePeakDbtp: 1 },
  };
  const findings = speechTakeProductionChecks(
    { ...segment, estimatedDurationSeconds: 4 },
    take,
    clipped,
    {
      ...DEFAULT_PRODUCTION_CHECKS,
      targetLufs: -16,
      durationTolerancePercent: 25,
    },
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["clipping", "true-peak", "loudness", "duration"],
  );
  assert.equal(findings[0]!.position, 0.5);
});

test("legitimate repeated wording is preserved and excess alignment repetition or omissions require review", () => {
  const repeated = "Read these words. Read these words.";
  const legitimate = {
    ...take,
    spokenText: repeated,
    alignment: [{ text: repeated, start: 0, end: 1 }],
  };
  assert.deepEqual(
    speechTakeProductionChecks(
      { ...segment, spokenText: repeated },
      legitimate,
      analysis,
      DEFAULT_PRODUCTION_CHECKS,
    ),
    [],
  );
  assert.ok(
    speechTakeProductionChecks(
      segment,
      { ...take, alignment: [{ text: repeated, start: 0, end: 1 }] },
      analysis,
      DEFAULT_PRODUCTION_CHECKS,
    ).some((finding) => finding.code === "repetition"),
  );
  assert.ok(
    speechTakeProductionChecks(
      segment,
      { ...take, alignment: [{ text: "Read words", start: 0, end: 1 }] },
      analysis,
      DEFAULT_PRODUCTION_CHECKS,
    ).some((finding) => finding.code === "alignment-text"),
  );
  assert.equal(
    speechTakeProductionChecks(
      segment,
      { ...take, alignment: [] },
      analysis,
      DEFAULT_PRODUCTION_CHECKS,
    )[0]!.code,
    "alignment-unavailable",
  );
});

test("analysis rejects corrupt dimensions, nonfinite peaks and a cache for a different asset", () => {
  assert.deepEqual(parseAudioAnalysis(analysis, asset), analysis);
  for (const patch of [
    { frames: 0 },
    { silentFrames: 24001 },
    { zeroSamples: -1 },
    { leadingSilence: 2 },
    { peaks: [{ startFrame: 0, endFrame: 24000, min: 0, max: Infinity }] },
    { duration: 2 },
  ])
    assert.throws(() => parseAudioAnalysis({ ...analysis, ...patch }, asset));
  assert.throws(
    () => parseAudioAnalysis(analysis, { ...asset, sampleRate: 48000 }),
    /does not match/,
  );
});

test("production findings are bounded with an explicit truncation result", () => {
  const project = { id: "book", selectedTakes: {} } as SpeechProject;
  const output = speechProductionSelections(
    project,
    [],
    Array.from({ length: 1000 }, (_, index) => ({
      ...segment,
      id: `segment-${index}`,
    })),
    10,
  );
  assert.equal(output.findings.length, 10);
  assert.equal(output.truncated, true);
});
