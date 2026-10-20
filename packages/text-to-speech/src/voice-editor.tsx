import {useRef,useState} from "react";
import type {SpeechRuntime,SpeechVoice,SpeechVoiceChanges} from "@machdoch/speech";
import {Field,type Run} from "./controls.tsx";
import {voiceMutationFailure,voiceUpdateConsequence} from "./voice-mutations.tsx";

export function VoiceEditor({voice,runtime,run,busy,onChanged}:{voice:SpeechVoice;runtime:SpeechRuntime;run:Run;busy:boolean;onChanged():void}){
  const [editing,setEditing]=useState(false);
  const button=useRef<HTMLButtonElement>(null);
  const close=()=>{setEditing(false);button.current?.focus();};
  return <><button ref={button} disabled={busy} aria-expanded={editing} onClick={event=>{event.stopPropagation();setEditing(value=>!value);}}>Edit voice</button>{editing&&<form className="tts-row" aria-label={`Edit ${voice.name}`} onClick={event=>event.stopPropagation()} onSubmit={event=>{
    event.preventDefault();const data=new FormData(event.currentTarget);const name=String(data.get("name")).trim();const visibility=String(data.get("visibility"));
    const changes:SpeechVoiceChanges={...(name!==voice.name?{name}:{}),...(visibility!==voice.visibility&&(visibility==="private"||visibility==="unlist")?{visibility}:{})};
    void run(async()=>{
      if(!Object.keys(changes).length){close();return;}
      if(!window.confirm(`Update Fish voice “${voice.name}”? ${voiceUpdateConsequence(changes.visibility)}`))return;
      const result=await runtime.execute("updateVoice",{id:voice.id,confirmed:true,changes});
      if(result.state!=="updated"){onChanged();throw new Error(voiceMutationFailure(result));}
      setEditing(false);onChanged();
    });
  }}><Field label="Voice name"><input name="name" defaultValue={voice.name} required autoFocus/></Field><Field label="Voice visibility"><select name="visibility" defaultValue={voice.visibility}>
    {voice.visibility!=="private"&&voice.visibility!=="unlist"&&<option value={voice.visibility}>{voice.visibility}</option>}<option value="private">Private</option><option value="unlist">Unlisted</option>
  </select></Field><button disabled={busy}>Save voice</button><button type="button" disabled={busy} onClick={close}>Cancel edit</button></form>}</>;
}
