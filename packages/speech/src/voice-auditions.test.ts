import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSpeechVoiceAudition,
  createSpeechVoiceAudition,
  removeSpeechVoiceAudition,
  speechVoiceLanguageAuditionMatrix,
  validateSpeechVoiceAudition,
} from "./voice-auditions.ts";
import type {
  SpeechVoiceAudition,
  SpeechVoiceAuditionInput,
  SpeechVoiceAuditionTake,
} from "./voice-auditions.ts";

function evidence(): SpeechVoiceAuditionTake {
  const profile = {
    id: "profile", name: "Narration", backend: "fish-cloud" as const, model: "drama-3",
    voiceId: "voice-1", language: "en", direction: "", temperature: 0.7, topP: 0.7,
    chunkLength: 200, minChunkLength: 0, latency: "normal" as const,
    dictionaryIds: [], playbackRate: 1,
  };
  const segment = {
    id: "segment", text: "Guten Tag.", spokenText: "Guten Tag.", chapter: null,
    voiceIds: ["voice-1"], referenceAssetIds: [],
  };
  return {
    take: {
      id: "take-1", projectId: "project", revisionId: "revision", segmentId: segment.id,
      spokenText: segment.spokenText, chapter: null,
      asset: {
        id: "asset-1", sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 48044,
        duration: 1, sampleRate: 24000, channels: 1, path: "speech/audio.wav",
      },
      createdAt: "2026-10-19T10:00:00.000Z", generatedAt: "2026-10-19T10:00:00.000Z",
      reusedFromTakeId: null, backend: "fish-cloud", model: "drama-3",
      requestHash: "b".repeat(64), parentTakeId: null, favorite: false,
      rating: null, note: "", alignment: [],
    },
    request: {
      segment, profile, dictionaries: [], references: {},
      connection: { backend: "fish-cloud", model: "drama-3", url: null, runtimeVersion: null },
    },
  };
}

function input(): SpeechVoiceAuditionInput {
  return {
    id: "review-1", takeId: "take-1", voiceId: "voice-1", language: "de-de",
    reviewer: "Listener", reviewedAt: "2026-10-19T10:01:00.000Z",
    listened: true, verdict: "approved", note: " Clear pronunciation. ",
  };
}

test("a listening review captures the existing take and explicit language rather than profile normalization", () => {
  const source = evidence();
  const before = structuredClone(source);
  const review = createSpeechVoiceAudition(input(), [source]);
  assert.deepEqual(review, {
    ...input(), language: "de-DE", note: "Clear pronunciation.",
    assetId: source.take.asset.id, audioSha256: source.take.asset.sha256,
    requestHash: source.take.requestHash, backend: source.take.backend,
    model: source.take.model, generatedAt: source.take.generatedAt,
  });
  assert.equal(source.request.profile.language, "en");
  assert.deepEqual(source, before);
  validateSpeechVoiceAudition(review, [source]);
});

test("reviews require explicit listening, a reviewer, language, and a verdict", () => {
  for (const patch of [
    { listened: false }, { listened: "true" }, { reviewer: "" }, { reviewer: " " },
    { language: "" }, { language: "de_DE" }, { language: "not a tag" },
    { language: "und" }, { language: "mul" }, { language: "zxx" },
    { id: "" }, { verdict: "" }, { note: null },
  ]) {
    assert.throws(() => createSpeechVoiceAudition(
      { ...input(), ...patch } as SpeechVoiceAuditionInput, [evidence()],
    ));
  }
});

test("a missing or duplicated take cannot supply review evidence", () => {
  assert.throws(() => createSpeechVoiceAudition(input(), []), /existing take/);
  assert.throws(() => createSpeechVoiceAudition(input(), [evidence(), evidence()]), /existing take/);
  assert.throws(() => createSpeechVoiceAudition({ ...input(), takeId: "missing" }, [evidence()]), /existing take/);
});

test("only the single voice in the saved request can be reviewed", () => {
  assert.throws(() => createSpeechVoiceAudition({ ...input(), voiceId: "another" }, [evidence()]), /voice used/);
  for (const voiceIds of [[], ["voice-1", "voice-2"], ["voice-1", "voice-1"], [""]]) {
    const source = evidence();
    source.request.segment.voiceIds = voiceIds;
    assert.throws(() => createSpeechVoiceAudition(input(), [source]), /exactly one voice/);
  }
});

test("request, profile, backend, model, segment and spoken text must match the take", () => {
  const changes: Array<(source: SpeechVoiceAuditionTake) => void> = [
    source => { source.request.connection.backend = "sglang"; },
    source => { source.request.connection.model = "s2.1-pro"; },
    source => { source.request.profile.backend = "openai"; },
    source => { source.request.profile.model = "another"; },
    source => { source.request.segment.id = "another"; },
    source => { source.request.segment.spokenText = "Different audio text."; },
    source => { source.take.model = ""; },
    source => { source.take.backend = "unknown" as SpeechVoiceAuditionTake["take"]["backend"]; },
  ];
  for (const change of changes) {
    const source = evidence();
    change(source);
    assert.throws(() => createSpeechVoiceAudition(input(), [source]), /does not match/);
  }
});

test("audio and request hashes and a completed nonempty asset are required", () => {
  const changes: Array<(source: SpeechVoiceAuditionTake) => void> = [
    source => { source.take.asset.sha256 = "invalid"; },
    source => { source.take.requestHash = "invalid"; },
    source => { source.take.asset.id = ""; },
    source => { source.take.asset.bytes = 0; },
    source => { source.take.asset.bytes = 1.5; },
    source => { source.take.asset.duration = 0; },
    source => { source.take.asset.duration = NaN; },
  ];
  for (const change of changes) {
    const source = evidence();
    change(source);
    assert.throws(() => createSpeechVoiceAudition(input(), [source]));
  }
  const source = evidence();
  source.take.asset.sha256 = "A".repeat(64);
  source.take.requestHash = "B".repeat(64);
  const review = createSpeechVoiceAudition(input(), [source]);
  assert.equal(review.audioSha256, "a".repeat(64));
  assert.equal(review.requestHash, "b".repeat(64));
  validateSpeechVoiceAudition(review, [source]);
});

test("review time must follow generation and timestamps must be real UTC instants", () => {
  for (const reviewedAt of ["yesterday", "2026-02-30T10:00:00.000Z", "2026-10-19T09:59:59.999Z"]) {
    assert.throws(() => createSpeechVoiceAudition({ ...input(), reviewedAt }, [evidence()]));
  }
  const source = evidence();
  source.take.generatedAt = "invalid";
  assert.throws(() => createSpeechVoiceAudition(input(), [source]), /Generation time/);
});

test("adding and removing reviews is immutable and reports duplicate or missing IDs", () => {
  const reviews = Object.freeze([createSpeechVoiceAudition(input(), [evidence()])]);
  const added = addSpeechVoiceAudition(reviews, { ...input(), id: "review-2", verdict: "rejected" }, [evidence()]);
  assert.equal(reviews.length, 1);
  assert.equal(added.length, 2);
  assert.equal(added[1]!.verdict, "rejected");
  assert.throws(() => addSpeechVoiceAudition(reviews, input(), [evidence()]), /already exists/);
  assert.deepEqual(removeSpeechVoiceAudition(added, "review-1"), [added[1]]);
  assert.equal(added.length, 2);
  assert.throws(() => removeSpeechVoiceAudition(added, "missing"), /unavailable/);
  assert.throws(() => removeSpeechVoiceAudition([reviews[0]!, reviews[0]!], "review-1"), /duplicated/);
});

test("saved reviews cannot substitute provenance or bypass listening confirmation", () => {
  const review = createSpeechVoiceAudition(input(), [evidence()]);
  const patches = [
    { assetId: "another" }, { audioSha256: "c".repeat(64) }, { requestHash: "d".repeat(64) },
    { backend: "sglang" }, { model: "another" }, { voiceId: "another" },
    { generatedAt: "2026-10-19T09:00:00.000Z" }, { listened: false },
    { language: "de-de" }, { reviewer: "" }, { verdict: "unknown" },
  ];
  for (const patch of patches) {
    assert.throws(() => validateSpeechVoiceAudition({ ...review, ...patch } as SpeechVoiceAudition, [evidence()]));
  }
});

test("changed or removed take evidence invalidates a saved language review", () => {
  const review = createSpeechVoiceAudition(input(), [evidence()]);
  const source = evidence();
  source.take.asset.sha256 = "c".repeat(64);
  assert.throws(() => validateSpeechVoiceAudition(review, [source]), /does not match/);
  assert.throws(() => validateSpeechVoiceAudition(review, []), /existing take/);
  const replacement = evidence();
  replacement.take.requestHash = "d".repeat(64);
  assert.throws(() => speechVoiceLanguageAuditionMatrix([review], [replacement]), /does not match/);
});

test("unreviewed takes never populate the voice-language matrix", () => {
  assert.deepEqual(speechVoiceLanguageAuditionMatrix([], [evidence()]), []);
});

test("the matrix keeps approved and rejected human reviews without turning either into model capability", () => {
  const source = evidence();
  const approved = createSpeechVoiceAudition(input(), [source]);
  const rejected = createSpeechVoiceAudition({
    ...input(), id: "review-2", verdict: "rejected", reviewer: "Second listener",
  }, [source]);
  const matrix = speechVoiceLanguageAuditionMatrix([approved, rejected], [source]);
  assert.deepEqual(matrix, [{
    backend: "fish-cloud", model: "drama-3", voiceId: "voice-1", language: "de-DE",
    reviews: [approved, rejected],
  }]);
  matrix[0]!.reviews[0]!.note = "Changed view";
  assert.equal(approved.note, "Clear pronunciation.");
});

test("matrix entries stay separate for backend, model, voice and language", () => {
  const sources = [evidence(), evidence(), evidence(), evidence()];
  sources.forEach((source, index) => {
    source.take.id = "take-" + index;
    if (index === 1) {
      source.take.backend = "sglang";
      source.request.connection.backend = "sglang";
      source.request.profile.backend = "sglang";
    }
    if (index === 2) {
      source.take.model = "pinned-drama";
      source.request.connection.model = "pinned-drama";
      source.request.profile.model = "pinned-drama";
    }
    if (index === 3) source.request.segment.voiceIds = ["voice-2"];
  });
  const reviews = sources.map((source, index) => createSpeechVoiceAudition({
    ...input(), id: "review-" + index, takeId: source.take.id,
    voiceId: source.request.segment.voiceIds[0]!,
  }, sources));
  reviews.push(createSpeechVoiceAudition({
    ...input(), id: "review-ja", takeId: sources[0]!.take.id, language: "ja",
  }, sources));
  assert.equal(speechVoiceLanguageAuditionMatrix(reviews, sources).length, 5);
});

test("the matrix rejects duplicate IDs and invalid review evidence instead of omitting errors", () => {
  const review = createSpeechVoiceAudition(input(), [evidence()]);
  assert.throws(() => speechVoiceLanguageAuditionMatrix([review, review], [evidence()]), /Duplicate review/);
  assert.throws(() => speechVoiceLanguageAuditionMatrix([
    { ...review, listened: false } as unknown as SpeechVoiceAudition,
  ], [evidence()]), /confirm listening/);
});
