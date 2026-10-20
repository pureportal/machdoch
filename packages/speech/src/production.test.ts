import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEECH_EXPORT,
  orderedProductionTakes,
  validateSpeechExportPreset,
} from "./production.ts";
import type { SpeechProject, SpeechTake } from "./runtime.ts";

test("production takes follow the current script order and reject stale or mismatched selections", () => {
  const project = {
    id: "book",
    selectedTakes: { second: "b", first: "a", deleted: "old" },
  } as unknown as SpeechProject;
  const takes = [
    { id: "b", segmentId: "second", projectId: "book" },
    { id: "a", segmentId: "first", projectId: "book" },
  ] as SpeechTake[];
  assert.deepEqual(
    orderedProductionTakes(project, takes, ["first", "second"], true).map(
      (take) => take.id,
    ),
    ["a", "b"],
  );
  assert.throws(
    () => orderedProductionTakes(project, takes, ["first", "new"], true),
    /every current script segment/,
  );
  assert.deepEqual(
    orderedProductionTakes(project, takes, ["first", "new"], false).map(
      (take) => take.id,
    ),
    ["a"],
  );
  assert.throws(
    () => orderedProductionTakes(project, takes, ["deleted"], false),
    /unavailable/,
  );
  assert.throws(
    () =>
      orderedProductionTakes(
        project,
        [{ ...takes[1]!, projectId: "another" }],
        ["first"],
        true,
      ),
    /different segment/,
  );
});

test("export settings validate the paired normalization and compressed-format constraints", () => {
  validateSpeechExportPreset({ ...DEFAULT_SPEECH_EXPORT });
  validateSpeechExportPreset({
    ...DEFAULT_SPEECH_EXPORT,
    loudnessLufs: -16,
    truePeakDb: -1,
  });
  for (const value of [
    { sampleRate: 8000.5 },
    { channels: 3 },
    { bitrate: NaN },
    { format: "mp3", bitrate: 0 },
    { loudnessLufs: -16 },
    { truePeakDb: -1 },
    { loudnessLufs: -16, truePeakDb: NaN },
    { loudnessLufs: -16, truePeakDb: 1 },
  ])
    assert.throws(() =>
      validateSpeechExportPreset({
        ...DEFAULT_SPEECH_EXPORT,
        ...value,
      } as typeof DEFAULT_SPEECH_EXPORT),
    );
});
