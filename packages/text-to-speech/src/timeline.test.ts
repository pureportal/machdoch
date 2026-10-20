import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossfadeTimelineClips,
  insertTimelineSilence,
  replaceTimelineTake,
  splitTimelineClip,
} from "./timeline.ts";

const clip = {
  id: "first",
  takeId: "take",
  start: 10,
  in: 2,
  out: 12,
  gain: 0.8,
  fadeIn: 1,
  fadeOut: 2,
  track: 0,
};

test("splitting preserves every source frame and only the original outside fades", () => {
  const [first, second] = splitTimelineClip(clip, 14, "second");
  assert.equal(first.out, second.in);
  assert.equal(
    first.out - first.in + second.out - second.in,
    clip.out - clip.in,
  );
  assert.equal(first.start + first.out - first.in, second.start);
  assert.deepEqual(
    [first.fadeIn, first.fadeOut, second.fadeIn, second.fadeOut],
    [1, 0, 0, 2],
  );
  assert.deepEqual(clip, {
    id: "first",
    takeId: "take",
    start: 10,
    in: 2,
    out: 12,
    gain: 0.8,
    fadeIn: 1,
    fadeOut: 2,
    track: 0,
  });
  assert.throws(() => splitTimelineClip(clip, 10, "invalid"), /inside/);
  assert.throws(() => splitTimelineClip(clip, 10.5, "invalid"), /fades/);
});

test("inserting silence splits intersecting tracks and moves later clips together without changing their audio", () => {
  const later = { ...clip, id: "later", start: 25, track: 1 };
  const result = insertTimelineSilence([clip, later], 14, 3, () => "split");
  assert.deepEqual(
    result.map((value) => [value.id, value.start, value.in, value.out]),
    [
      ["first", 10, 2, 6],
      ["split", 17, 6, 12],
      ["later", 28, 2, 12],
    ],
  );
  assert.equal(
    result.reduce((sum, value) => sum + value.out - value.in, 0),
    20,
  );
  assert.throws(
    () => insertTimelineSilence([clip], 14, NaN, () => "invalid"),
    /duration/,
  );
});

test("crossfades overlap exactly their duration and replacement preserves nondestructive edits", () => {
  const next = {
    ...clip,
    id: "next",
    start: 20,
    in: 0,
    out: 7,
    fadeIn: 0,
    fadeOut: 0,
  };
  const [first, second] = crossfadeTimelineClips(clip, next, 2);
  assert.equal(first.start + first.out - first.in - second.start, 2);
  assert.equal(first.fadeOut, second.fadeIn);
  assert.deepEqual(replaceTimelineTake(second, "alternate", 7), {
    ...second,
    takeId: "alternate",
  });
  assert.throws(() => replaceTimelineTake(second, "short", 6), /trim/);
  assert.throws(
    () => crossfadeTimelineClips(clip, { ...next, track: 1 }, 2),
    /same track/,
  );
  assert.throws(() => crossfadeTimelineClips(clip, next, 8), /fit both/);
});
