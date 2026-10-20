import {test} from "node:test";
import assert from "node:assert/strict";
import {performanceDirection,estimateSpeechPerformance} from "./performance.ts";
import type {SpeechTakeRequest,SpeechPreferences} from "./runtime.ts";

const request:SpeechTakeRequest={segment:{id:"segment",text:"<|speaker:0|>Hello 世界. 🚀",spokenText:"Hello 世界. 🚀",chapter:null,voiceIds:["voice"],referenceAssetIds:[]},profile:{id:"profile",name:"Source",backend:"fish-cloud",model:"drama-3",voiceId:"voice",direction:"calm",temperature:0.7,topP:0.7,chunkLength:200,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1},dictionaries:[],references:{},connection:{backend:"fish-cloud",model:"drama-3",url:null,runtimeVersion:null}};
const price:NonNullable<SpeechPreferences["pricing"]>={unit:"characters",perMillion:1_000_000,currency:"USD",source:"Synthetic account quote",effectiveFrom:"2000-01-01",effectiveTo:"2099-01-01"};

test("director note counts include the exact transmitted Unicode direction without changing the source",()=>{
  const before=structuredClone(request),note="thoughtful 世界";
  const text=`[calm; ${note}]${request.segment.text}`;
  const estimate=estimateSpeechPerformance(request,note,2,price);
  assert.equal(estimate.direction,`calm; ${note}`);assert.equal(estimate.characters,Array.from(text).length*2);assert.equal(estimate.utf8Bytes,new TextEncoder().encode(text).length*2);assert.equal(estimate.amount,estimate.characters);assert.deepEqual(request,before);
  assert.equal(estimateSpeechPerformance(request,note,2,{...price,unit:"utf8Bytes"}).amount,estimate.utf8Bytes);
});

test("unknown and self-hosted prices remain unknown and do not select another provider",()=>{
  assert.equal(estimateSpeechPerformance(request,"quiet",1,null).amount,null);
  const local={...request,profile:{...request.profile,backend:"sglang" as const}};
  assert.equal(estimateSpeechPerformance(local,"quiet",1,price).amount,null);
  assert.throws(()=>estimateSpeechPerformance({...request,profile:{...request.profile,backend:"openai"}},"quiet",1,price),/Drama 3/u);
});

test("invalid notes, counts and quotes fail before a performance request",()=>{
  for(const note of [""," ","[whisper]","<soft>quiet</soft>","two\nlines","a\u0000b","🚀".repeat(1025)])assert.throws(()=>performanceDirection("calm",note));
  assert.equal(performanceDirection("","quiet"),"quiet");assert.throws(()=>performanceDirection("a".repeat(32768),"b"));
  for(const takes of [0,33,1.1,NaN])assert.throws(()=>estimateSpeechPerformance(request,"quiet",takes,price));
  for(const changes of [{perMillion:-1},{currency:"usd"},{source:""},{effectiveFrom:"2099-02-30"},{effectiveTo:"2000-01-01"}])assert.throws(()=>estimateSpeechPerformance(request,"quiet",1,{...price,...changes}));
});

test("a completed live source uses its exact full transcript for the new performance estimate",()=>{
  const live={...request,segment:{...request.segment,text:"Hello 世界.",spokenText:"Hello 世界.",liveFragments:["Hello ","世界."]}};
  const estimate=estimateSpeechPerformance(live,"quiet",1,price);
  assert.equal(estimate.characters,Array.from("[calm; quiet]Hello 世界.").length);
  assert.deepEqual(live.segment.liveFragments,["Hello ","世界."]);
});
