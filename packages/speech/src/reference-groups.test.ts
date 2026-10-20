import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSpeechScript, speechRenderSegment } from "./compiler.ts";

test("inline dialogue references retain speaker slots and separate each speaker's recording set",()=>{
  const first="a".repeat(64),second="b".repeat(64),third="c".repeat(64);
  const compiled=compileSpeechScript("<|speaker:first|>Hello.\n<|speaker:second|>Guten Tag.",{cast:[{id:"first",name:"First",referenceHashes:[first]},{id:"second",name:"Second",referenceHashes:[second,third]}]});
  assert.deepEqual(compiled.diagnostics.filter(item=>item.severity==="error"),[]);
  assert.equal(compiled.segments.length,1);
  const segment=speechRenderSegment(compiled.segments[0]!);
  assert.deepEqual(segment.referenceGroups,[[first],[second,third]]);
  assert.deepEqual(segment.referenceAssetIds,[first,second,third]);
  assert.deepEqual(segment.voiceIds,[]);
  assert.match(segment.text,/<\|speaker:0\|>/);
  assert.match(segment.text,/<\|speaker:1\|>/);
  const mixed=structuredClone(compiled.segments[0]!);mixed.speakers[0]!.voiceId="stored-voice";
  assert.throws(()=>speechRenderSegment(mixed),/every dialogue speaker/);
  const ambiguous=structuredClone(compiled.segments[0]!);for(const speaker of ambiguous.speakers)speaker.voiceId="stored-voice";
  assert.throws(()=>speechRenderSegment(ambiguous),/either a voice ID or a reference set/);
});
