import test from "node:test";
import assert from "node:assert/strict";
import {speechVoiceWorkflowEstimate,type SpeechRequestPricing} from "./voice-workflows.ts";

const pricing:SpeechRequestPricing={perRequest:1.25,currency:"EUR",source:"Synthetic account contract",effectiveFrom:"2026-01-01",effectiveTo:"2026-12-31"};
test("voice design prices the documented request once, independently of its candidate count",()=>{
  assert.equal(speechVoiceWorkflowEstimate(pricing,"2026-10-20"),1.25);
  assert.equal(speechVoiceWorkflowEstimate({...pricing,perRequest:0},"2026-10-20"),0);
  assert.equal(speechVoiceWorkflowEstimate(null,"2026-10-20"),null);
});
test("voice workflow estimates require a complete effective account quote without guessing a billing rate",()=>{
  for(const changed of [{perRequest:NaN},{perRequest:-1},{perRequest:Infinity},{currency:"eur"},{source:""},{source:"bad\nsource"},{effectiveFrom:"2026-10-21"},{effectiveTo:"2026-10-19"},{effectiveFrom:"2026-02-30"}])assert.throws(()=>speechVoiceWorkflowEstimate({...pricing,...changed},"2026-10-20"));
});
