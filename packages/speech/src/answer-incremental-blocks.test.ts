import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IncrementalAnswerSpeech,
  markdownToSpeech,
  type FinalAnswerEvent,
} from "./answer.ts";
const event = (markdown: string, complete = false): FinalAnswerEvent => ({
  kind: "answer",
  channel: "final",
  audience: "user",
  sessionId: "session",
  answerId: "answer",
  revision: "revision",
  markdown,
  complete,
});

test("incremental tables wait for a block boundary and retain header semantics", () => {
  const parser = new IncrementalAnswerSpeech();
  for (const markdown of [
    "| Name | Value |\n",
    "| Name | Value |\n| --- | --- |\n",
    "| Name | Value |\n| --- | --- |\n| A | 2 |\n",
  ])
    assert.deepEqual(parser.update(event(markdown)).segments, []);
  const segments = parser.update(
    event("| Name | Value |\n| --- | --- |\n| A | 2 |\n\nDone."),
  );
  assert.equal(segments.segments.length, 1);
  assert.equal(segments.segments[0]!.text, "Name: A; Value: 2.");
  assert.equal(
    parser.update(
      event("| Name | Value |\n| --- | --- |\n| A | 2 |\n\nDone.", true),
    ).segments[0]!.text,
    "Done.",
  );
});

test("incremental math never leaks partial formula syntax and currency stays literal", () => {
  const parser = new IncrementalAnswerSpeech();
  assert.deepEqual(parser.update(event("Here is $x. ")).segments, []);
  const segment = parser.update(event("Here is $x. y$ explained. "))
    .segments[0]!;
  assert.equal(segment.text, "Here is Math omitted. explained.");
  assert.equal(markdownToSpeech("It costs $5 and $6."), "It costs $5 and $6.");
  const currency = new IncrementalAnswerSpeech();
  assert.equal(
    currency.update(event("It costs $5.", true)).segments[0]!.text,
    "It costs $5.",
  );
});

test("completion treats an unclosed fenced code block as omitted code", () => {
  const parser = new IncrementalAnswerSpeech();
  const markdown = "Here is code:\n```ts\nsecret();";
  const first = parser
    .update(event(markdown))
    .segments.map((segment) => segment.text)
    .join(" ");
  const last = parser
    .update(event(markdown, true))
    .segments.map((segment) => segment.text)
    .join(" ");
  assert.match(first + last, /Code sample omitted/);
  assert.doesNotMatch(first + last, /secret|```/);
});
