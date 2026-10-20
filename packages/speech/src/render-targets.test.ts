import {test} from "node:test";
import assert from "node:assert/strict";
import {speechRenderTargets} from "./render-targets.ts";
import {parseSpeechScript} from "./script.ts";
import {compileSpeechScript,speechRenderSegment} from "./compiler.ts";

test("chapter targets retain all nested scenes and scene targets stop at either structural boundary",()=>{
  const source="# First\nIntro.\n## Repeated\nOne.\n## Repeated\nTwo.\n# Second\nEnd.";
  const targets=speechRenderTargets(parseSpeechScript(source),[]);
  const chapters=targets.filter(item=>item.kind==="chapter"),scenes=targets.filter(item=>item.kind==="scene");
  assert.deepEqual(chapters.map(item=>source.slice(item.from,item.to)),["Intro.\n## Repeated\nOne.\n## Repeated\nTwo.\n","End."]);
  assert.deepEqual(scenes.map(item=>source.slice(item.from,item.to)),["One.\n","Two.\n"]);
  assert.notEqual(scenes[0]!.id,scenes[1]!.id);
});

test("turn targets retain delivery and phoneme controls and inherit real speaker bindings",()=>{
  const source="# First\nNarration.\n<|speaker:a|>[calm]<soft>Hallo 世界.</soft>\n<|speaker:b|>Reply.\n## Later\nStill replying.";
  const cast=[{id:"a",name:"Anna",voiceId:"voice-a"},{id:"b",name:"Ben",voiceId:"voice-b"}];
  const targets=speechRenderTargets(parseSpeechScript(source),cast).filter(item=>item.kind==="turn");
  assert.equal(targets.length,4);assert.match(targets[1]!.title,/Anna/u);assert.match(targets[2]!.title,/Ben/u);
  const options={cast:cast.map(item=>({...item,referenceHashes:[]}))};
  const first=compileSpeechScript(source,{...options,selection:targets[1]});
  assert.equal(first.diagnostics.filter(item=>item.severity==="error").length,0);
  assert.match(first.segments[0]!.text,/\[calm\].*<soft>/u);assert.deepEqual(speechRenderSegment(first.segments[0]!).voiceIds,["voice-a"]);
  const later=compileSpeechScript(source,{...options,selection:targets[3]});
  assert.deepEqual(speechRenderSegment(later.segments[0]!).voiceIds,["voice-b"]);assert.equal(later.segments[0]!.spokenText,"Still replying.");
});

test("empty headings and performance-only regions do not become paid render targets",()=>{
  assert.deepEqual(speechRenderTargets(parseSpeechScript("# Empty\n## Also empty\n<!-- editorial -->\n[calm]"),[]),[]);
  assert.throws(()=>speechRenderTargets(parseSpeechScript("<soft>unfinished"),[]),/Resolve script errors/u);
});

test("large dialogue targeting scans every turn without dropping or duplicating ranges",()=>{
  const source=Array.from({length:10000},(_,index)=>`<|speaker:${index%2?"a":"b"}|>Turn ${index}.\n`).join("");
  const targets=speechRenderTargets(parseSpeechScript(source),[]).filter(item=>item.kind==="turn");
  assert.equal(targets.length,10000);assert.equal(targets.map(item=>source.slice(item.from,item.to)).join(""),source);
});

test("turn titles keep complete Unicode code points at the preview boundary",()=>{
  const source="a".repeat(79)+"🚀 next.";
  const [target]=speechRenderTargets(parseSpeechScript(source),[]);
  assert.equal(target!.title,"a".repeat(79)+"🚀");assert.equal(source.slice(target!.from,target!.to),source);
});
