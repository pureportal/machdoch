import {test} from "node:test";
import assert from "node:assert/strict";
import {estimateSpeechRender} from "./pricing.ts";
import type {SpeechProfile, SpeechPreferences} from "./runtime.ts";

const profile:SpeechProfile={id:"profile",name:"Test",backend:"fish-cloud",model:"drama-3",direction:"calm",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};
const pricing:NonNullable<SpeechPreferences["pricing"]>={unit:"characters",perMillion:10,currency:"USD",source:"Synthetic test rate",effectiveFrom:"2000-01-01",effectiveTo:"2099-01-01"};

test("render estimates include each segment's direction, Unicode units and explicit take count",()=>{
  const texts=["Hello 世界.","東京 🚀"],snapshot=JSON.stringify({texts,profile});
  const text=texts.map(text=>`[calm]${text}`).join("");
  const estimate=estimateSpeechRender(texts,profile,2,pricing);
  assert.equal(estimate.characters,[...text].length*2);assert.equal(estimate.utf8Bytes,new TextEncoder().encode(text).length*2);
  assert.equal(estimate.amount,estimate.characters/1_000_000*10);assert.equal(estimate.currency,"USD");
  assert.equal(estimateSpeechRender(texts,profile,2,{...pricing,unit:"utf8Bytes"}).amount,estimate.utf8Bytes/1_000_000*10);
  assert.equal(JSON.stringify({texts,profile}),snapshot);
});

test("rehearsal prices stay unavailable without an account rate and do not apply Fish rates to another backend",()=>{
  assert.equal(estimateSpeechRender(["Hello."],profile,1,null).amount,null);
  for(const backend of ["sglang","openai","google"] as const)assert.equal(estimateSpeechRender(["Hello."],{...profile,backend},1,pricing).amount,null);
  assert.throws(()=>estimateSpeechRender(["Hello."],profile,0,pricing),/takes/u);
  assert.throws(()=>estimateSpeechRender(["  "],profile,1,pricing),/text/u);
});
