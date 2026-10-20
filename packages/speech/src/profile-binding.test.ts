import test from "node:test";
import assert from "node:assert/strict";
import {speechProfileBinding,speechProfileCast} from "./profile-binding.ts";
import type {SpeechProfile} from "./runtime.ts";

const profile:SpeechProfile={id:"profile",name:"Narrator",backend:"fish-cloud",model:"drama-3",voiceId:"voice",direction:"calm",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};

test("shared profile reference bindings retain order and create the same default cast for answer and automation projects",()=>{
  const local={...profile,backend:"sglang" as const};delete local.voiceId;local.referenceAssetIds=["a".repeat(64),"b".repeat(64)];const binding=speechProfileBinding(local);assert.deepEqual(binding,{voiceIds:[],referenceAssetIds:local.referenceAssetIds});binding.referenceAssetIds.reverse();assert.deepEqual(local.referenceAssetIds,["a".repeat(64),"b".repeat(64)]);
  const cast=speechProfileCast(local);assert.deepEqual(cast,[{id:"narrator",name:"Narrator",referenceAssetIds:local.referenceAssetIds,direction:""}]);assert.equal(cast[0]!.voiceId,undefined);
  assert.deepEqual(speechProfileBinding(profile),{voiceIds:["voice"],referenceAssetIds:[]});assert.equal(speechProfileCast(profile)[0]!.voiceId,"voice");
});

test("mixed or unsupported reference bindings fail and an unbound profile does not invent a voice",()=>{
  assert.throws(()=>speechProfileBinding({...profile,referenceAssetIds:["a".repeat(64)]}),/voice ID or reference/u);
  const unsupported={...profile,backend:"openai" as const,referenceAssetIds:["a".repeat(64)]};delete unsupported.voiceId;assert.throws(()=>speechProfileBinding(unsupported),/Drama 3/u);
  const unbound={...profile};delete unbound.voiceId;assert.deepEqual(speechProfileCast(unbound),[]);
});
