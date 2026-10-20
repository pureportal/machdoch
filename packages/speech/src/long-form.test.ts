import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { compileSpeechScript } from "./compiler.ts";

const cast = [{ id: "narrator", name: "Narrator", voiceId: "voice-a" }];

test("selection previews inherit the original chapter identity and submitted transcript", () => {
  const source = "# Chapter One\nEarlier paragraph.\n\nSelected paragraph.\n";
  const complete = compileSpeechScript(source, { cast });
  const from = source.indexOf("Selected");
  const selected = compileSpeechScript(source, { cast, selection:{ from, to:source.length } });
  assert.deepEqual(selected.segments[0]?.chapter,complete.segments[0]?.chapter);
  assert.equal(selected.segments[0]?.spokenText,"Selected paragraph.");
  assert.ok(selected.segments[0]?.sourceMap.every(range=>range.from>=from&&range.to<=source.length));
});

test("unchanged scenes keep their production identities after an earlier scene is inserted", () => {
  const source = "# Book\n## Arrival\nGood morning.\n## Departure\nAuf Wiedersehen.\n";
  const before = compileSpeechScript(source, { cast });
  const after = compileSpeechScript(source.replace("## Arrival", "## Prelude\n你好，世界。\n## Arrival"), { cast });
  assert.deepEqual(after.segments.slice(1).map(segment => segment.id), before.segments.map(segment => segment.id));
  assert.equal(after.diagnostics.length, 0);
});

test("a local segmentation target bounds book requests without inventing a backend limit", () => {
  const paragraph = "Dr. Müller arrived at 10:30. 今日はいい天気です。 The pump produces 42 kPa.\n\n";
  const source = `# Book\n${paragraph.repeat(6000)}`;
  const started = performance.now();
  const result = compileSpeechScript(source, { cast });
  const milliseconds = performance.now() - started;
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.segments.length > 20);
  assert.ok(result.segments.every(segment => segment.utf8Bytes <= 16_000));
  const recovered = result.segments.map(segment => segment.text.replace(/^<\|speaker:0\|>/u, "")).join("");
  assert.equal(recovered, paragraph.repeat(6000));
  assert.ok(result.segments.every(segment => !/[\uD800-\uDBFF]$/u.test(segment.text)));
  console.log(JSON.stringify({ case: "book-segmentation", sourceBytes: new TextEncoder().encode(source).length, segments: result.segments.length, milliseconds: Math.round(milliseconds), heapBytes: process.memoryUsage().heapUsed }));
});

test("delivery scopes remain whole across local segment boundaries", () => {
  const source = "One paragraph.\n\n<whisper>Quiet. Very quiet.</whisper>\n\nLast paragraph.";
  const result = compileSpeechScript(source, { cast, segmentTargetUtf8Bytes: 50 });
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.segments.some(segment => segment.text.includes("<whisper>Quiet. Very quiet.</whisper>")));
  assert.equal(result.segments.map(segment => segment.text.replace(/^<\|speaker:0\|>/u, "")).join(""), source);
});
