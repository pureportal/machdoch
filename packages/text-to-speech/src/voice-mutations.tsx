import {useEffect,useRef,useState} from "react";
import type {SpeechRuntime,SpeechVoiceMutation} from "@machdoch/speech";
import type {Run} from "./controls.tsx";

export function voiceMutationFailure(value:SpeechVoiceMutation):string{
  const action=value.operation==="delete"?"deletion":"update";
  if(value.state==="uncertain"||value.state==="pending")return `Fish did not confirm the ${action}. Check its status in Voices before retrying.`;
  if(value.state==="unavailable")return "Fish reports this voice as unavailable. Check the account and voice ID.";
  if(value.errorCategory==="authentication")return `Fish rejected the ${action}. Save an API key with access to this voice before retrying.`;
  if(value.errorCategory==="concurrency")return `Fish rejected the ${action} because its request limit was reached. Wait, then retry.`;
  return `Fish rejected the ${action}. Review the voice and account before retrying.`;
}

export function voiceUpdateConsequence(visibility:"private"|"unlist"|undefined):string{
  return visibility==="unlist"?"Anyone with the voice link can access it.":visibility==="private"?"Only the voice creator can access it.":"This changes the voice name on Fish.";
}

export function VoiceMutationHistory({runtime,active,reload,onChanged,run,busy,report}:{runtime:SpeechRuntime;active:boolean;reload:number;onChanged():void;run:Run;busy:boolean;report(error:unknown):void}){
  const [page,setPage]=useState(0);
  const [records,setRecords]=useState<SpeechVoiceMutation[]>([]);
  const [total,setTotal]=useState(0);
  const [now,setNow]=useState(Date.now());
  const region=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(!active)return;
    let disposed=false;let timer:number|undefined;
    const load=async()=>{
      try{const result=await runtime.execute("listVoiceMutations",{offset:page*20,limit:20});if(disposed)return;setRecords(result.mutations);setTotal(result.total);setNow(Date.now());timer=window.setTimeout(()=>void load(),3000);}
      catch(error){if(!disposed)report(error);}
    };
    void load();return ()=>{disposed=true;window.clearTimeout(timer);};
  },[runtime,active,reload,page,report]);
  if(!total)return null;
  return <section ref={region} tabIndex={-1} className="tts-stack" aria-label="Voice changes"><h2>Voice changes</h2>
    {(total>20||page>0)&&<nav className="tts-row" aria-label="Voice change pages"><button disabled={page===0} onClick={()=>setPage(value=>value-1)}>Previous changes</button><span>Page {page+1} · {total} changes</span><button disabled={(page+1)*20>=total} onClick={()=>setPage(value=>value+1)}>Next changes</button></nav>}
    {records.map(record=><article key={record.id} className="tts-voice"><div className="tts-row"><code>{record.voiceId}</code><span>{{pending:record.operation==="delete"?"Deleting":"Updating",uncertain:"Uncertain",deleted:"Deleted",updated:"Updated",unavailable:"Unavailable",rejected:"Rejected",superseded:"Retried"}[record.state]}</span></div>
      {record.changes&&<dl>{record.changes.name!==undefined&&<><dt>Name</dt><dd>{record.changes.name}</dd></>}{record.changes.visibility!==undefined&&<><dt>Visibility</dt><dd>{record.changes.visibility==="unlist"?"Unlisted":"Private"}</dd></>}</dl>}
      {record.state==="uncertain"&&<p>{record.operation==="delete"?"This voice cannot be assigned while deletion is unresolved; check its status or retry deletion.":"The update may have reached Fish. Check the current voice before retrying."}</p>}
      {record.remoteStatus!==null&&<p>{record.remoteStatus===200?record.remoteVoice?`Fish returns “${record.remoteVoice.name}” (${record.remoteVoice.visibility}).`:"Fish still returns this voice.":record.remoteStatus===404?"Fish reports this voice as unavailable.":`Status check returned HTTP ${record.remoteStatus}.`}</p>}
      {record.state==="rejected"&&<p>{voiceMutationFailure(record)}</p>}
      <div className="tts-row">
        {(record.state==="uncertain"||record.state==="pending")&&<button disabled={busy||record.state==="pending"&&now<Date.parse(record.retryAfter)} onClick={()=>void run(async()=>{await runtime.execute("checkVoiceMutation",{id:record.id});onChanged();})}>Check {record.operation==="delete"?"deletion":"update"}</button>}
        {(record.state==="uncertain"||record.state==="pending"||record.state==="rejected")&&<button disabled={busy||record.state==="pending"&&now<Date.parse(record.retryAfter)} onClick={()=>void run(async()=>{
          const consequence=record.operation==="delete"?"This deletes the remote voice.":voiceUpdateConsequence(record.changes?.visibility);
          if(!window.confirm(`Retry the ${record.operation==="delete"?"deletion":"update"} of Fish voice “${record.voiceId}”? The earlier request may already have reached Fish. ${consequence}`))return;
          const retry=record.state!=="rejected"?{retryMutationId:record.id}:{};
          const result=record.operation==="delete"?await runtime.execute("deleteVoice",{id:record.voiceId,confirmed:true,...retry}):await runtime.execute("updateVoice",{id:record.voiceId,confirmed:true,changes:record.changes!,...retry});onChanged();if(!["deleted","updated","unavailable"].includes(result.state))throw new Error(voiceMutationFailure(result));region.current?.focus();
        })}>Retry {record.operation==="delete"?"deletion":"update"}</button>}
      </div>
    </article>)}
  </section>;
}
