import type {SpeechJobUsage} from "@machdoch/speech";

export function JobUsage({usage}:{usage:SpeechJobUsage|undefined}){
  if(!usage)return null;
  const cost=(value:number|null)=>value===null?"Unavailable":`${value.toLocaleString(undefined,{maximumSignificantDigits:6})}${usage.currency?` ${usage.currency}`:""}`;
  return <details><summary>Usage</summary><dl className="tts-grid">
    <dt>Generation estimate</dt><dd>{cost(usage.estimatedCommittedCost)}</dd>
    <dt>Uncertain request estimate</dt><dd>{cost(usage.estimatedUncertainCost)}</dd>
    <dt>Completed requests</dt><dd>{usage.completedRequests.toLocaleString()}</dd>
    <dt>Uncertain requests</dt><dd>{usage.uncertainRequests.toLocaleString()}</dd>
    <dt>Reused segments</dt><dd>{usage.reusedSegments.toLocaleString()}</dd>
    <dt>Characters</dt><dd>{usage.characters.toLocaleString()}</dd>
    <dt>UTF-8 bytes</dt><dd>{usage.utf8Bytes.toLocaleString()}</dd>
    <dt>Produced audio</dt><dd>{usage.producedAudioSeconds.toLocaleString()} s</dd>
    {usage.inputAudioSeconds>0&&<><dt>Transcribed audio</dt><dd>{usage.inputAudioSeconds.toLocaleString()} s</dd></>}
    {usage.pricing&&<><dt>Rate source</dt><dd>{usage.pricing.source}</dd><dt>Rate dates</dt><dd>{usage.pricing.effectiveFrom} – {usage.pricing.effectiveTo}</dd></>}
  </dl><p>Local estimates do not establish the provider’s billed charge.</p></details>;
}
