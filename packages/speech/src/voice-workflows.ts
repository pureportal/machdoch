import type {SpeechAsset, SpeechVoice} from "./runtime.ts";

export interface SpeechRequestPricing {
  perRequest:number; currency:string; source:string; effectiveFrom:string; effectiveTo:string;
}

export interface SpeechDesignCandidate {
  id:string; asset:SpeechAsset; previewText:string; metadata:Record<string,unknown>;
}

export interface SpeechVoiceWorkflowResult {
  jobId:string; kind:"voice-design"|"voice-creation"; createdAt:string;
  candidates:SpeechDesignCandidate[]; voice:SpeechVoice|null;
}

export interface SpeechVoiceWorkflowInput {
  owner:string; cloudConsent:boolean; budgetLimit:number|null; pricing:SpeechRequestPricing|null;
}

export function speechVoiceWorkflowEstimate(pricing:SpeechRequestPricing|null,at=new Date().toISOString().slice(0,10)):number|null{
  if(pricing===null)return null;
  if(!Number.isFinite(pricing.perRequest)||pricing.perRequest<0||pricing.perRequest>1_000_000||!/^[A-Z]{3}$/u.test(pricing.currency)||!pricing.source.trim()||pricing.source.length>4096||/\p{Cc}/u.test(pricing.source))throw new Error("Enter a complete account rate per request.");
  for(const value of [pricing.effectiveFrom,pricing.effectiveTo,at]){
    const date=new Date(value+"T00:00:00Z");
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error("Enter valid effective pricing dates.");
  }
  if(pricing.effectiveFrom>at||pricing.effectiveTo<at||pricing.effectiveFrom>pricing.effectiveTo)throw new Error("Verify an account rate effective today.");
  return pricing.perRequest;
}
