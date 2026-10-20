import {Fragment} from "react";
import type {SpeechVoiceObservation} from "@machdoch/speech";

export function VoiceObservationFields({observations}:{observations:SpeechVoiceObservation[]|undefined}){
  return observations?.map(voice=><Fragment key={voice.id}>
    <dt>Voice source</dt><dd><a href={voice.evidence.url} target="_blank" rel="noreferrer">{voice.name} · {voice.id}</a></dd>
    {voice.author&&<><dt>Voice author</dt><dd>{voice.author}</dd></>}
    <dt>Voice visibility</dt><dd>{voice.visibility}</dd>
    {voice.rights&&<><dt>Voice rights</dt><dd>{voice.rights}</dd></>}
    <dt>Voice observed</dt><dd>{new Date(voice.evidence.observedAt).toLocaleString()}</dd>
    <dt>Voice metadata hash</dt><dd>{voice.evidence.responseSha256}</dd>
  </Fragment>)??null;
}
