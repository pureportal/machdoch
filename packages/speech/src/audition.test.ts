import {test} from "node:test";
import assert from "node:assert/strict";
import {compileSpeechAudition} from "./audition.ts";
import type {SpeechProfile} from "./runtime.ts";

const profile:SpeechProfile={id:"profile",name:"Test",backend:"fish-cloud",model:"drama-3",voiceId:"default",direction:"calm",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};

test("voice auditions preserve one exact contextual passage and explicitly selected voice",()=>{
  const source="# Editorial title\n<!-- not spoken -->\n[thoughtful]Hello. Grüß dich 東京 🚀.";
  const a=compileSpeechAudition(source,profile,{voiceIds:["voice-a"],referenceAssetIds:[]}),b=compileSpeechAudition(source,profile,{voiceIds:["voice-b"],referenceAssetIds:[]});
  assert.equal(a.text,b.text);assert.equal(a.spokenText,b.spokenText);assert.equal(a.spokenText,"Hello. Grüß dich 東京 🚀.");
  assert.deepEqual(a.voiceIds,["voice-a"]);assert.deepEqual(b.voiceIds,["voice-b"]);assert.notEqual(a.id,b.id);assert.doesNotMatch(a.text,/Editorial title|not spoken/u);
  assert.deepEqual(a.referenceAssetIds,[]);assert.equal(profile.voiceId,"default");
});

test("auditions reject unsupported providers, missing voices, malformed scopes and oversized passages",()=>{
  const voice={voiceIds:["voice"],referenceAssetIds:[]};
  assert.throws(()=>compileSpeechAudition("Hello.",{...profile,backend:"openai"},voice),/Fish Cloud/u);
  assert.throws(()=>compileSpeechAudition("Hello.",profile,{voiceIds:[],referenceAssetIds:[]}),/voice/u);
  assert.throws(()=>compileSpeechAudition("Hello.",profile,{voiceIds:[""],referenceAssetIds:[]}),/voice/u);
  assert.throws(()=>compileSpeechAudition("<soft>Never closed.",profile,voice),/soft/u);
  assert.throws(()=>compileSpeechAudition("a".repeat(65537),profile,voice),/64 KiB/u);
  assert.throws(()=>compileSpeechAudition("One scene.\n".repeat(3000),profile,voice),/one short/u);
  assert.ok(compileSpeechAudition("<|phoneme_start|>ha0shi1ga0<|phoneme_end|>",profile,voice,undefined,"romaji").text.includes("ha0shi1ga0"));
});

test("reference-profile pronunciation auditions carry the saved reference set without a library voice",()=>{
  const binding={voiceIds:[],referenceAssetIds:["a".repeat(64),"b".repeat(64)]};const result=compileSpeechAudition("[careful]Grüß dich 世界.",profile,binding);assert.deepEqual(result.voiceIds,[]);assert.deepEqual(result.referenceAssetIds,binding.referenceAssetIds);assert.equal(result.spokenText,"Grüß dich 世界.");assert.ok(result.text.includes("[careful]"));
});
