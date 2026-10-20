import {compileSpeechScript,speechRenderSegment} from "./compiler.ts";
import type {SpeechConnectionStatus,SpeechProfile,SpeechRenderSegment} from "./runtime.ts";
import type {PhonemeAlphabet} from "./script.ts";

export function compileSpeechAudition(source:string,profile:SpeechProfile,binding:Pick<SpeechRenderSegment,"voiceIds"|"referenceAssetIds">,connection?:SpeechConnectionStatus,phonemeAlphabet:PhonemeAlphabet="arpabet"):SpeechRenderSegment{
  if(profile.backend!=="fish-cloud"||profile.model!=="drama-3")throw new Error("Choose a Fish Cloud Drama 3 profile for this audition.");
  const voiceId=binding.voiceIds[0];
  if(binding.voiceIds.length>1||binding.voiceIds.length===1&&(!voiceId||!voiceId.trim())||binding.voiceIds.length&&binding.referenceAssetIds.length||!binding.voiceIds.length&&!binding.referenceAssetIds.length)throw new Error("Choose one audition voice or a reference set.");
  if(new TextEncoder().encode(source).length>65536)throw new Error("Use an audition passage below the local 64 KiB limit.");
  const result=compileSpeechScript(source,{backend:"fish-cloud",cast:[{id:"voice",name:"Voice",...(voiceId?{voiceId}:{}),referenceHashes:binding.referenceAssetIds}],phonemeAlphabet,maxUtf8Bytes:connection?.maxTextBytes??undefined,maxSpeakers:connection?.maxSpeakers??undefined});
  const errors=result.diagnostics.filter(item=>item.severity==="error");if(errors.length)throw new Error(errors.map(item=>item.message).join(" "));
  if(result.segments.length!==1)throw new Error("Use one short passage for an audition.");
  return speechRenderSegment(result.segments[0]!);
}
