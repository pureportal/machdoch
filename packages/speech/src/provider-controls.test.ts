import {test} from "node:test";
import assert from "node:assert/strict";
import {compileSpeechScript} from "./compiler.ts";

const cast = [{id: "n", name: "Narrator", voiceId: "cedar"}];

test("assistant providers accept structural metadata and report Fish controls at their source ranges", () => {
  const source = "# Chapter\n<!-- editorial -->\n<|speaker:n|>Hello. [quiet] <whisper>Stay.</whisper> <|phoneme_start|>HH AH0<|phoneme_end|>";
  for (const backend of ["openai", "google"] as const) {
    const result = compileSpeechScript(source, {cast, backend});
    const diagnostics = result.diagnostics.filter(item => item.code === "unsupported-provider-control");
    assert.equal(diagnostics.length, 4);
    assert.deepEqual(diagnostics.map(item => source.slice(item.from, item.to)), ["[quiet]", "<whisper>", "</whisper>", "<|phoneme_start|>HH AH0<|phoneme_end|>"]);
    const plain = compileSpeechScript("# Chapter\n<!-- editorial -->\n<|speaker:n|>Hello.\nGuten Tag. 東京 🚀", {cast, backend});
    assert.deepEqual(plain.diagnostics.filter(item => item.severity === "error"), []);
    assert.equal(plain.segments[0]!.spokenText, "Hello.\nGuten Tag. 東京 🚀");
    assert.doesNotMatch(plain.segments[0]!.text, /Chapter|editorial/u);
  }
  assert.equal(compileSpeechScript(source, {cast, backend: "fish-cloud"}).diagnostics.some(item => item.code === "unsupported-provider-control"), false);
});

test("assistant selection previews retain the provider check and reject scoped cast directions", () => {
  const source = "<|speaker:n|><soft>Quiet words.</soft>";
  const from = source.indexOf("Quiet");
  const result = compileSpeechScript(source, {cast, backend: "openai", selection: {from, to: from + "Quiet words.".length}});
  assert.ok(result.diagnostics.some(item => item.code === "unsupported-provider-control"));
  const directed = compileSpeechScript("Hello.", {cast: [{...cast[0]!, sceneOverrides: [{sceneId: "scene", direction: "calm"}]}], backend: "google"});
  assert.ok(directed.diagnostics.some(item => item.code === "unsupported-cast-direction"));
});

test("OpenAI's application segmentation keeps ordinary long passages under its character limit",()=>{
  const result=compileSpeechScript("A complete sentence for a long narration. ".repeat(600),{cast,backend:"openai"});
  assert.deepEqual(result.diagnostics.filter(item=>item.severity==="error"),[]);
  assert.ok(result.segments.length>1);assert.ok(result.segments.every(segment=>[...segment.spokenText].length<=4096));
});
