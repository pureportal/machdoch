import { test } from "node:test";
import assert from "node:assert/strict";
import {
  speechReadingSequence,
  speechReadingCues,
  parseSpeechReadingPosition,
  createSpeechReadingBookmark,
  resolveSpeechReadingBookmark,
  type SpeechReadingSequence,
} from "./reading.ts";
import type { SpeechProject, SpeechTake } from "./runtime.ts";

test("reading follows accepted takes with measured clip offsets and invalidates a changed selection", async () => {
  const project = {
    id: "book",
    selectedTakes: { second: "b", first: "a" },
  } as unknown as SpeechProject;
  const takes = [
    {
      id: "b",
      projectId: "book",
      segmentId: "second",
      asset: { duration: 5, sha256: "b" },
    },
    {
      id: "a",
      projectId: "book",
      segmentId: "first",
      asset: { duration: 3, sha256: "a" },
    },
  ] as SpeechTake[];
  const sequence = await speechReadingSequence(project, takes, [
    "first",
    "second",
  ]);
  assert.deepEqual(sequence.offsets, [0, 3]);
  assert.equal(sequence.duration, 8);
  assert.equal(
    parseSpeechReadingPosition(
      { signature: sequence.signature, seconds: 4.5 },
      sequence,
    ),
    4.5,
  );
  const changed = await speechReadingSequence(
    project,
    [
      { ...takes[0]!, asset: { ...takes[0]!.asset, sha256: "changed" } },
      takes[1]!,
    ],
    ["first", "second"],
  );
  assert.equal(
    parseSpeechReadingPosition(
      { signature: sequence.signature, seconds: 4.5 },
      changed,
    ),
    null,
  );
  for (const seconds of [-1, Infinity, NaN, 9, "3"])
    assert.throws(() =>
      parseSpeechReadingPosition(
        { signature: sequence.signature, seconds },
        sequence,
      ),
    );
});

test("reading cues use supplied alignment boundaries without inventing times inside a coarse snapshot", () => {
  const take = {
    asset: { duration: 10, sampleRate: 24000 },
    alignment: [
      { text: "Hello", start: 0.2, end: 0.6 },
      { text: "world.", start: 0.7, end: 1.2 },
      { text: "Another", start: 1.5, end: 1.9 },
      { text: "sentence.", start: 2, end: 2.7 },
      { text: "Coarse paragraph. Two sentences.", start: 4, end: 9 },
    ],
  } as SpeechTake;
  assert.deepEqual(speechReadingCues(take), [
    { text: "Hello world.", start: 0.2, end: 1.2 },
    { text: "Another sentence.", start: 1.5, end: 2.7 },
    { text: "Coarse paragraph. Two sentences.", start: 4, end: 9 },
  ]);
  assert.deepEqual(speechReadingCues({ ...take, alignment: [] }), []);
  assert.throws(
    () =>
      speechReadingCues({
        ...take,
        alignment: [{ text: "bad", start: 0, end: 11 }],
      }),
    /alignment/,
  );
  assert.deepEqual(
    speechReadingCues({
      ...take,
      alignment: [
        { text: "one", start: 1, end: 3 },
        { text: "overlap", start: 2, end: 4 },
      ],
    }),
    [{ text: "one overlap", start: 1, end: 4 }],
  );
});

const bookmarkSequence: SpeechReadingSequence = {
  takes: [
    {
      id: "first",
      asset: { sha256: "first-hash", duration: 3 },
      alignment: [],
    },
    {
      id: "second",
      asset: { sha256: "second-hash", duration: 5 },
      alignment: [],
    },
  ] as SpeechTake[],
  offsets: [0, 3],
  duration: 8,
  signature: "original",
};

test("reading bookmarks capture measured take-local seconds without word alignment", () => {
  assert.deepEqual(
    createSpeechReadingBookmark(bookmarkSequence, 4.25, "bookmark", "  Passage  "),
    {
      id: "bookmark",
      label: "Passage",
      takeId: "second",
      assetSha256: "second-hash",
      seconds: 1.25,
    },
  );
});

test("reading bookmarks use the following take at boundaries and allow the measured end", () => {
  for (const [position, takeId, seconds] of [
    [0, "first", 0],
    [3, "second", 0],
    [8, "second", 5],
  ] as const) {
    const bookmark = createSpeechReadingBookmark(bookmarkSequence, position, "bookmark", "Passage");
    assert.equal(bookmark.takeId, takeId);
    assert.equal(bookmark.seconds, seconds);
    assert.deepEqual(resolveSpeechReadingBookmark(bookmarkSequence, bookmark), {
      available: true,
      seconds: position,
    });
  }
});

test("reading bookmarks reject invalid capture positions and empty names", () => {
  assert.throws(() => createSpeechReadingBookmark(bookmarkSequence, 1, "bookmark", "界".repeat(342)), /1,024 UTF-8 bytes/);
  for (const position of [-1, 8.01, NaN, Infinity, -Infinity])
    assert.throws(
      () => createSpeechReadingBookmark(bookmarkSequence, position, "bookmark", "Passage"),
      /position/,
    );
  assert.throws(
    () => createSpeechReadingBookmark(bookmarkSequence, 1, "bookmark", "  "),
    /name/,
  );
  assert.throws(
    () => createSpeechReadingBookmark({ takes: [], offsets: [], duration: 0, signature: "empty" }, 0, "bookmark", "Passage"),
    /position/,
  );
});

test("reading bookmarks retain their local position when earlier measured audio changes", () => {
  const bookmark = createSpeechReadingBookmark(bookmarkSequence, 4.25, "bookmark", "Passage");
  const changed: SpeechReadingSequence = {
    ...bookmarkSequence,
    takes: [
      {
        ...bookmarkSequence.takes[0]!,
        asset: { ...bookmarkSequence.takes[0]!.asset, sha256: "new-first-hash", duration: 9 },
      },
      bookmarkSequence.takes[1]!,
    ],
    offsets: [0, 9],
    duration: 14,
    signature: "changed",
  };
  assert.deepEqual(resolveSpeechReadingBookmark(changed, bookmark), {
    available: true,
    seconds: 10.25,
  });
  assert.equal(bookmark.seconds, 1.25);
});

test("reading bookmarks cannot resolve by hash alone or to changed audio under the same take ID", () => {
  const bookmark = createSpeechReadingBookmark(bookmarkSequence, 4.25, "bookmark", "Passage");
  for (const takes of [
    [bookmarkSequence.takes[0]!],
    [bookmarkSequence.takes[0]!, { ...bookmarkSequence.takes[1]!, id: "replacement" }],
  ]) {
    const result = resolveSpeechReadingBookmark({ ...bookmarkSequence, takes }, bookmark);
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /missing or no longer selected/);
  }
  const replaced = resolveSpeechReadingBookmark({
    ...bookmarkSequence,
    takes: [
      bookmarkSequence.takes[0]!,
      { ...bookmarkSequence.takes[1]!, asset: { ...bookmarkSequence.takes[1]!.asset, sha256: "replacement-hash" } },
    ],
  }, bookmark);
  assert.equal(replaced.available, false);
  if (!replaced.available) assert.match(replaced.reason, /audio has changed/);
});

test("reading bookmarks explicitly reject invalid or out-of-range take-local positions", () => {
  const bookmark = createSpeechReadingBookmark(bookmarkSequence, 4.25, "bookmark", "Passage");
  for (const seconds of [-1, 5.01, NaN, Infinity, -Infinity]) {
    const result = resolveSpeechReadingBookmark(bookmarkSequence, { ...bookmark, seconds });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /position.*measured audio/);
  }
  const shortened = resolveSpeechReadingBookmark({
    ...bookmarkSequence,
    takes: [
      bookmarkSequence.takes[0]!,
      { ...bookmarkSequence.takes[1]!, asset: { ...bookmarkSequence.takes[1]!.asset, duration: 1 } },
    ],
  }, bookmark);
  assert.equal(shortened.available, false);
  if (!shortened.available) assert.match(shortened.reason, /position.*measured audio/);
});
