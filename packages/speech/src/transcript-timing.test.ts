import {test} from "node:test";
import assert from "node:assert/strict";
import {speechTimingViews, speechTimingEstimate, type SpeechTimingResult} from "./transcript-timing.ts";
import type {SpeechTake} from "./runtime.ts";
import {exportSubtitles} from "./alignment.ts";

const take: SpeechTake = {
  id:"take",projectId:"project",revisionId:"revision",segmentId:"segment",spokenText:"Intended words.",chapter:null,
  asset:{id:"asset",sha256:"a".repeat(64),mimeType:"audio/wav",bytes:100,duration:3,sampleRate:16000,channels:1,path:"audio.wav"},
  createdAt:"2026-10-19T12:00:00Z",generatedAt:"2026-10-19T12:00:00Z",reusedFromTakeId:null,backend:"fish-cloud",model:"drama-3",requestHash:"request",parentTakeId:null,favorite:false,rating:null,note:"",
  alignment:[{text:"Synthesis",start:0,end:1}],
};
const timing: SpeechTimingResult = {
  id:"timing",takeId:take.id,assetId:take.asset.id,assetSha256:take.asset.sha256,provider:"openai",model:"whisper-1",languageHint:null,
  transcript:"Real real words.",words:[{text:"Real",start:0.25,end:0.5},{text:"real",start:0.6,end:1},{text:"words.",start:1.1,end:2}],
  createdAt:take.createdAt,measuredAt:take.createdAt,jobId:"job",requestHash:"timing-request",reusedFromTimingId:null,pricing:null,estimatedCost:null,
  provenance:{encoderSha256:"f".repeat(64),sourceDuration:3,admittedAt:take.createdAt,sampleRate:16000,channels:1,pipeline:1,chunks:[]},
};

test("explicit word timing changes only the presentation and subtitle words",()=>{
  const original=structuredClone(take);
  const [view]=speechTimingViews([take],{take:"timing"},[timing]);
  assert.deepEqual(take,original);
  assert.equal(view!.spokenText,"Intended words.");
  assert.equal(view!.requestHash,take.requestHash);
  assert.deepEqual(view!.alignment,timing.words);
  assert.match(exportSubtitles(view!.alignment,"srt"),/00:00:00,250 --> 00:00:02,000\nReal real words\./u);
  assert.equal(speechTimingViews([take],{},[timing])[0],take);
});

test("selected timing has no implicit provider substitution while loading or missing",()=>{
  assert.deepEqual(speechTimingViews([take],{take:"timing"},null)[0]!.alignment,[]);
  assert.throws(()=>speechTimingViews([take],{take:"timing"},[]),/Reload word timing/u);
  for(const changes of [{takeId:"other"},{assetSha256:"changed"},{assetId:"changed"},{provenance:{...timing.provenance,sourceDuration:4}}]) {
    assert.throws(()=>speechTimingViews([take],{take:"timing"},[{...timing,...changes}]),/Reload word timing/u);
  }
});

test("selected timestamps must have actual words and remain ordered within the audio",()=>{
  for(const words of [[],[{text:" ",start:0,end:1}],[{text:"outside",start:0,end:4}],[{text:"bad",start:NaN,end:1}],[{text:"second",start:1,end:2},{text:"first",start:0,end:1}]]) {
    assert.throws(()=>speechTimingViews([take],{take:"timing"},[{...timing,words}]),/timing/u);
  }
});

test("duration estimates include overlap and per-request billing increments without inventing a price",()=>{
  assert.deepEqual(speechTimingEstimate(1201,null),{uploadSeconds:1205,billedSeconds:null,amount:null,currency:null});
  const pricing={perMinute:0.5,billingIncrementSeconds:60,currency:"EUR",source:"Synthetic account quote",effectiveFrom:"2026-01-01",effectiveTo:"2026-12-31"};
  assert.deepEqual(speechTimingEstimate(1201,pricing,"2026-10-19"),{uploadSeconds:1205,billedSeconds:1380,amount:11.5,currency:"EUR"});
  for (const changes of [{perMinute:NaN},{billingIncrementSeconds:0},{currency:"usd"},{source:""},{effectiveFrom:"2026-02-30"},{effectiveTo:"2026-10-18"}]) assert.throws(()=>speechTimingEstimate(1,{...pricing,...changes},"2026-10-19"));
});
