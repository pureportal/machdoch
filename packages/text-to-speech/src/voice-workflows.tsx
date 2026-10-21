import {useEffect,useRef,useState} from "react";
import {createAudioPlaybackHandle,speechPlayback,type SpeechAsset,type SpeechJob,type SpeechRuntime,type SpeechSettings,type SpeechVoice,type SpeechVoiceWorkflowResult} from "@machdoch/speech";
import {Field,OWNER,type Run,errorText} from "./controls.tsx";
import {SpeechJobControls} from "./job-controls.tsx";
import {EMPTY_REQUEST_BUDGET,RequestBudgetFields,requestBudget} from "./request-budget.tsx";

export function VoiceWorkflows({runtime,active,settings,references,rights,permission,busy,run,assetUrl,openVoice}:{
  runtime:SpeechRuntime;active:boolean;settings:SpeechSettings|null;references:Array<{asset:SpeechAsset;transcript:string}>;rights:string;permission:boolean;busy:boolean;run:Run;
  assetUrl(path:string):string;openVoice(voice:SpeechVoice):void;
}){
  const [designBudget,setDesignBudget]=useState({...EMPTY_REQUEST_BUDGET});const [creationBudget,setCreationBudget]=useState({...EMPTY_REQUEST_BUDGET});
  const [designConsent,setDesignConsent]=useState(false);const [creationConsent,setCreationConsent]=useState(false);
  const [jobId,setJobId]=useState("");const [jobs,setJobs]=useState<SpeechJob[]>([]);const [result,setResult]=useState<SpeechVoiceWorkflowResult|null>(null);
  const [page,setPage]=useState(0);const [more,setMore]=useState(false);const [refresh,setRefresh]=useState(0);const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);
  const [open,setOpen]=useState(false);const [candidateId,setCandidateId]=useState("");const [source,setSource]=useState<"references"|"design">("references");const [matched,setMatched]=useState(true);
  const savedResult=useRef<SpeechVoiceWorkflowResult|null>(null);
  useEffect(()=>{setCandidateId("");setResult(null);savedResult.current=null;},[jobId,runtime]);
  useEffect(()=>{
    if(!active||!open)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;setLoading(true);
    const poll=async()=>{
      try{
        const rows=await runtime.execute("listJobs",{owner:OWNER,kinds:["voice-design","voice-creation"],offset:page*20,limit:21});
        const recent=rows.slice(0,20);let selected=recent.find(job=>job.id===jobId);
        if(jobId&&!selected){selected=(await runtime.execute("listJobs",{owner:OWNER,id:jobId,kinds:["voice-design","voice-creation"],limit:1}))[0];if(!selected)throw new Error("The voice request is unavailable. Refresh its history.");recent.push(selected);}
        const saved=selected?.completedSegments===1?savedResult.current?.jobId===selected.id?savedResult.current:await runtime.execute("getVoiceWorkflow",{owner:OWNER,jobId:selected.id}):null;
        if(disposed)return;
        savedResult.current=saved;setJobs(recent);setResult(saved);setMore(rows.length>20);setError(null);setLoading(false);
        if(recent.some(job=>["queued","running"].includes(job.state)))timer=setTimeout(()=>void poll(),1000);
      }catch(failure){if(!disposed){setError(errorText(failure));setLoading(false);}}
    };
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[runtime,active,open,page,jobId,refresh]);
  const queued=(job:SpeechJob)=>{setJobId(job.id);setPage(0);setOpen(true);setRefresh(value=>value+1);};
  const selected=jobs.find(job=>job.id===jobId);const candidates=result?.candidates??[];
  return <div className="tts-stack">
    <form aria-label="Voice design" className="tts-stack" onSubmit={event=>{
      event.preventDefault();const data=new FormData(event.currentTarget);
      void run(async()=>{queued(await runtime.execute("designVoice",{owner:OWNER,description:String(data.get("description")).trim(),text:String(data.get("text")).trim(),cloudConsent:designConsent,...requestBudget(designBudget)}));});
    }}>
      <h2>Voice design</h2>
      <Field label="Voice description"><textarea name="description" maxLength={2000} required/></Field>
      <Field label="Preview text"><textarea name="text" dir="auto" maxLength={150} required/></Field>
      <RequestBudgetFields draft={designBudget} change={setDesignBudget}/>
      <label className="tts-check"><input type="checkbox" checked={designConsent} onChange={event=>setDesignConsent(event.target.checked)}/>Send description and preview text to Fish Voice Design</label>
      <button disabled={busy||!settings?.cloudConsent||!designConsent}>Generate candidates</button>
      {!settings?.cloudConsent&&<p>Allow cloud processing in Settings to design a voice.</p>}
    </form>
    <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary>Voice jobs</summary>
      <Field label="Voice request"><select value={jobId} aria-busy={loading} onChange={event=>setJobId(event.target.value)}>
        <option value="">Choose request</option>{jobs.map(job=><option key={job.id} value={job.id}>{job.kind==="voice-design"?"Voice design":"Create voice"} · {new Date(job.createdAt).toLocaleString()} · {job.id}</option>)}
      </select></Field>
      <div className="tts-row"><button disabled={loading||page===0} onClick={()=>setPage(value=>value-1)}>Previous requests</button><output>Page {page+1}</output><button disabled={loading||!more} onClick={()=>setPage(value=>value+1)}>Next requests</button><button disabled={loading} onClick={()=>setRefresh(value=>value+1)}>Refresh requests</button></div>
      {error&&<p role="alert">{error}</p>}
      {selected&&<SpeechJobControls runtime={runtime} owner={OWNER} label="request" job={selected} busy={busy} run={run} onRetry={queued} onChanged={()=>setRefresh(value=>value+1)}/>}
      {candidates.length>0&&<div className="tts-stack">
        <Field label="Candidate preview text"><textarea readOnly dir="auto" value={candidates[0]!.previewText}/></Field>
        <label className="tts-check"><input type="checkbox" checked={matched} onChange={event=>setMatched(event.target.checked)}/>Match playback position</label>
        {candidates.map((candidate,index)=><div key={candidate.id} className="tts-stack">
          <div className="tts-row"><label className="tts-check"><input type="radio" name="voice-candidate" checked={candidateId===candidate.id} onChange={()=>{setCandidateId(candidate.id);setSource("design");}}/>Candidate {index+1}</label>
            <button onClick={()=>void run(async()=>{const playback=speechPlayback.snapshot();const position=matched&&playback.owner===OWNER&&candidates.some(item=>"candidate:"+item.id===playback.itemId)?Math.min(playback.position,Math.max(0,candidate.asset.duration-0.01)):0;await speechPlayback.play({owner:OWNER,itemId:"candidate:"+candidate.id,open:async signal=>{const handle=createAudioPlaybackHandle(assetUrl(candidate.asset.path),{signal,duration:candidate.asset.duration});if(position>0)handle.seek(position);return handle;}});})}>Preview candidate {index+1}</button></div>
          <details><summary>Candidate metadata</summary><pre>{JSON.stringify(candidate.metadata,null,2)}</pre></details>
        </div>)}
      </div>}
      {result?.voice&&<div className="tts-row"><span>{result.voice.name} · {result.voice.visibility}</span><button onClick={()=>openVoice(result.voice!)}>Open created voice</button>{result.voice.visibility!=="private"&&<p role="alert">Fish returned a non-private voice. Review its visibility in Fish before using it.</p>}</div>}
    </details>
    <form aria-label="Create voice" className="tts-stack" onSubmit={event=>{
      event.preventDefault();const data=new FormData(event.currentTarget);
      void run(async()=>{
        if(!permission||!rights.trim())throw new Error("Confirm permission before creating a voice.");
        if(source==="design"&&!candidates.some(candidate=>candidate.id===candidateId))throw new Error("Choose a saved design candidate from Voice jobs.");
        if(source==="references"&&!references.length)throw new Error("Choose reference recordings first.");
        queued(await runtime.execute("createVoice",{owner:OWNER,name:String(data.get("name")).trim(),referenceAssetIds:source==="references"?references.map(reference=>reference.asset.id):[],transcripts:source==="references"?references.map(reference=>reference.transcript):[],rightsEvidence:rights.trim(),permissionConfirmed:permission,cloudConsent:creationConsent,...requestBudget(creationBudget),...(source==="design"?{designCandidateId:candidateId}:{})}));
      });
    }}>
      <h2>Create voice</h2>
      <Field label="Voice name"><input name="name" maxLength={200} required/></Field>
      <Field label="Source"><select value={source} onChange={event=>setSource(event.target.value as typeof source)}><option value="references">Recordings</option><option value="design">Design candidate</option></select></Field>
      <RequestBudgetFields draft={creationBudget} change={setCreationBudget}/>
      <label className="tts-check"><input type="checkbox" checked={creationConsent} onChange={event=>setCreationConsent(event.target.checked)}/>Upload selected audio to Fish and create a private voice</label>
      <button disabled={busy||!permission||!rights.trim()||!settings?.cloudConsent||!creationConsent||source==="design"&&!candidateId||source==="references"&&!references.length}>Create voice</button>
      {!settings?.cloudConsent&&<p>Allow cloud processing in Settings to create a voice.</p>}
    </form>
  </div>;
}
