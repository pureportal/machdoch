import type {SpeechCastMember,SpeechProfile,SpeechRenderSegment} from "./runtime.ts";

export function speechProfileBinding(profile:SpeechProfile):Pick<SpeechRenderSegment,"voiceIds"|"referenceAssetIds">{
  const references=profile.referenceAssetIds??[];const voice=profile.voiceId?.trim();
  if(references.length&&voice)throw new Error("Choose a default voice ID or reference recordings for this profile.");
  if(references.length&&!['fish-cloud','sglang','drama3'].includes(profile.backend))throw new Error("Choose Drama 3 to use reference recordings.");
  return {voiceIds:voice?[voice]:[],referenceAssetIds:[...references]};
}

export function speechProfileCast(profile:SpeechProfile):SpeechCastMember[]{
  const binding=speechProfileBinding(profile);if(!binding.voiceIds.length&&!binding.referenceAssetIds.length)return [];
  return [{id:"narrator",name:"Narrator",...(binding.voiceIds[0]?{voiceId:binding.voiceIds[0]}:{}),referenceAssetIds:binding.referenceAssetIds,direction:""}];
}
