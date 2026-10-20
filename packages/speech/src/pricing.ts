import type {SpeechPreferences, SpeechProfile} from "./runtime.ts";

export interface SpeechRenderEstimate {
  characters:number;
  utf8Bytes:number;
  amount:number|null;
  currency:string|null;
}

export function estimateSpeechRender(texts:readonly string[],profile:SpeechProfile,takes:number,pricing:SpeechPreferences["pricing"],at=new Date().toISOString().slice(0,10)):SpeechRenderEstimate{
  if(!Number.isSafeInteger(takes)||takes<1||takes>32)throw new Error("Choose 1 to 32 new takes.");
  const prefix=["fish-cloud","sglang","drama3"].includes(profile.backend)&&profile.direction?`[${profile.direction}]`:"";
  const encoder=new TextEncoder();let characters=0;let utf8Bytes=0;
  for(const source of texts){
    if(!source.trim())throw new Error("Enter nonempty speech text.");
    const text=prefix+source;
    for(const _ of text)characters++;
    utf8Bytes+=encoder.encode(text).length;
  }
  characters*=takes;utf8Bytes*=takes;
  if(profile.backend==="drama3")return {characters,utf8Bytes,amount:0,currency:null};
  if(pricing===null||profile.backend!=="fish-cloud")return {characters,utf8Bytes,amount:null,currency:null};
  if(!["characters","utf8Bytes"].includes(pricing.unit)||!Number.isFinite(pricing.perMillion)||pricing.perMillion<0||!/^[A-Z]{3}$/u.test(pricing.currency)||!pricing.source.trim()||pricing.source.length>4096||/\p{Cc}/u.test(pricing.source))throw new Error("Verify the account rate, billing unit, currency and source before estimating.");
  for(const value of [pricing.effectiveFrom,pricing.effectiveTo,at]){
    const date=new Date(value+"T00:00:00Z");
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error("Use valid YYYY-MM-DD pricing dates.");
  }
  if(pricing.effectiveFrom>at||pricing.effectiveTo<at||pricing.effectiveFrom>pricing.effectiveTo)throw new Error("Verify an account rate effective today.");
  const amount=(pricing.unit==="characters"?characters:utf8Bytes)/1_000_000*pricing.perMillion;
  if(!Number.isFinite(amount))throw new Error("The estimated amount exceeds the supported budget range.");
  return {characters,utf8Bytes,amount,currency:pricing.currency};
}
