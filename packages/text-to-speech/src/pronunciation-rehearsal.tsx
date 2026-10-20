import {useState} from "react";
import {compileSpeechAudition,speechProfileBinding,estimateSpeechRender,speechPlayback,createAudioPlaybackHandle,retainSpeechPlayback,type SpeechDictionary,type SpeechProfile,type SpeechSettings,type SpeechRuntime,type SpeechJob,type SpeechTake,type SpeechTakeProvenance,type SpeechRenderSegment,type PhonemeAlphabet} from "@machdoch/speech";
import {Field,OWNER,errorText,type Run} from "./controls.tsx";
import {useAuditionJobs} from "./use-audition-jobs.ts";
import {SpeechJobControls,AuditionHistoryPages} from "./job-controls.tsx";

const JOB_OWNER="text-to-speech:pronunciation";
type Side="A"|"B";
type Result={job:SpeechJob;take:SpeechTake|null;request:SpeechTakeProvenance|null};

export function PronunciationRehearsal({runtime,dictionary,companions,source,useSource,profiles,settings,assetUrl,run,busy}:{
  runtime:SpeechRuntime;dictionary:SpeechDictionary;companions:SpeechDictionary[];source:string;useSource(text:string):void;profiles:SpeechProfile[];settings:SpeechSettings|null;assetUrl(path:string):string;run:Run;busy:boolean;
}){
  const [open,setOpen]=useState(false);
  const [versions,setVersions]=useState<SpeechDictionary[]>([dictionary]);
  const [page,setPage]=useState({offset:0,total:1});
  const [profileId,setProfileId]=useState("");
  const [selected,setSelected]=useState({A:"",B:dictionary.revision});
  const [consent,setConsent]=useState(false);
  const [budget,setBudget]=useState("");
  const [chosen,setChosen]=useState({A:"",B:""});
  const [alphabet,setAlphabet]=useState<PhonemeAlphabet>("arpabet");
  const auditions=useAuditionJobs(runtime,JOB_OWNER,"rehearsal-",[chosen.A,chosen.B],open,1);
  const {jobs,error}=auditions;
  const results:Partial<Record<Side,Result>>={};
  for(const side of ["A","B"] as const){const result=auditions.results[chosen[side]];if(result){const performance=result.performances[0];results[side]={job:result.job,take:performance?.take??null,request:performance?.request??null};}}
  const [matched,setMatched]=useState(true);
  const eligible=profiles.filter(profile=>profile.backend==="fish-cloud"&&(profile.voiceId||profile.referenceAssetIds?.length));
  const profile=eligible.find(profile=>profile.id===profileId)??(profileId===""?eligible[0]:undefined);
  const connection=settings?.connections.find(connection=>connection.backend==="fish-cloud");
  const history=async(offset:number)=>{
    const next=await runtime.execute("dictionaryRevisions",{id:dictionary.id,offset,limit:50});
    setVersions(current=>[...new Map([...current.filter(item=>[selected.A,selected.B].includes(item.revision)),dictionary,...next.revisions].map(item=>[item.revision,item])).values()]);
    setPage({offset,total:next.total});
  };
  let compiled:SpeechRenderSegment|null=null;
  let estimate:ReturnType<typeof estimateSpeechRender>|null=null;
  let issue:string|null=null;
  if(open&&source.trim()&&profile){try{
    compiled=compileSpeechAudition(source,profile,speechProfileBinding(profile),connection,alphabet);
    estimate=estimateSpeechRender([compiled.text],profile,1,settings?.pricing??null);
  }catch(failure){issue=errorText(failure);}}
  const generate=async(side:Side)=>{
    if(!profile||!compiled||!estimate||issue)throw new Error(issue??"Choose a profile and enter rehearsal text.");
    const revision=selected[side];if(revision&&!versions.some(item=>item.revision===revision))throw new Error("Load the chosen dictionary revision before rendering.");
    const budgetLimit=budget===""?null:Number(budget);if(budgetLimit!==null&&(!Number.isFinite(budgetLimit)||budgetLimit<0))throw new Error("Enter a nonnegative rehearsal budget.");
    const job=await runtime.execute("render",{owner:JOB_OWNER,projectId:null,revisionId:`rehearsal-${crypto.randomUUID()}`,profileId:profile.id,segments:[compiled],takes:1,priority:100,reuseCache:false,cloudConsent:consent,budgetLimit,dictionaryRevisions:revision?[{id:dictionary.id,revision},...companions.map(item=>({id:item.id,revision:item.revision}))]:[]});
    setChosen(value=>({...value,[side]:job.id}));auditions.reload();
  };
  const play=async(result:Result)=>{
    if(!result.take||!result.request)throw new Error("Wait for the rehearsal audio to complete.");
    const take=result.take,state=speechPlayback.snapshot();
    const position=matched&&state.owner===OWNER&&Object.values(results).some(value=>value?.take?.id===state.itemId)?Math.min(state.position,Math.max(0,take.asset.duration-0.01)):0;
    await speechPlayback.play({owner:OWNER,itemId:take.id,open:signal=>retainSpeechPlayback(runtime,{owner:JOB_OWNER,assetIds:[take.asset.id]},signal,()=>{
      const handle=createAudioPlaybackHandle(assetUrl(take.asset.path),{signal,rate:result.request!.profile.playbackRate,duration:take.asset.duration});handle.seek(position);return handle;
    },message=>void run(async()=>{throw new Error(message);}))});
  };
  const comparable=results.A?.request&&results.B?.request?results.A.request.segment.spokenText===results.B.request.segment.spokenText&&results.A.request.segment.text===results.B.request.segment.text&&JSON.stringify({...results.A.request.profile,dictionaryIds:[]})===JSON.stringify({...results.B.request.profile,dictionaryIds:[]}):true;
  return <details className="tts-stack" onToggle={event=>{
    setOpen(event.currentTarget.open);if(event.currentTarget.open)void run(()=>history(0));
  }}><summary>Audio rehearsal</summary>
    <Field label="Rehearsal profile"><select value={profile?.id??""} onChange={event=>setProfileId(event.target.value)}><option value="">Choose profile</option>{eligible.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
    {!profile&&<p>Save a Fish Cloud profile with a voice or reference recordings to render a rehearsal.</p>}
    <div className="tts-row"><button disabled={busy||page.offset===0} onClick={()=>void run(()=>history(Math.max(0,page.offset-50)))}>Newer revisions</button><button disabled={busy||page.offset+50>=page.total} onClick={()=>void run(()=>history(page.offset+50))}>Older revisions</button><button disabled={busy} onClick={()=>void run(()=>history(0))}>Refresh revisions</button></div>
    {(["A","B"] as const).map(side=>{
      const result=results[side]?.job.id===chosen[side]?results[side]:undefined;
      return <fieldset className="tts-stack" key={side}><legend>{side}</legend>
        <Field label={`${side} dictionary revision`}><select disabled={busy} value={selected[side]} onChange={event=>setSelected(value=>({...value,[side]:event.target.value}))}><option value="">Without dictionaries</option>{versions.map(version=><option key={version.revision} value={version.revision}>{version.name} · {version.revision}{version.revision===dictionary.revision?" · current":""}</option>)}</select></Field>
        {selected[side]&&companions.length>0&&<dl><dt>Other dictionaries</dt><dd>{companions.map(item=>item.name+" · "+item.revision).join(", ")}</dd></dl>}
        <button disabled={busy||!estimate||!!issue||!consent||!settings?.cloudConsent||!connection?.configured} onClick={()=>void run(()=>generate(side))}>Render {side}</button>
        <Field label={`${side} saved rehearsal`}><select value={chosen[side]} onChange={event=>setChosen(value=>({...value,[side]:event.target.value}))}><option value="">Choose rehearsal</option>{jobs.map((job,index)=><option key={job.id} value={job.id}>{index+1} · {new Date(job.createdAt).toLocaleString()} · {job.state}</option>)}</select></Field>
        {result&&<>
          <SpeechJobControls label="audition" runtime={runtime} owner={JOB_OWNER} job={result.job} busy={busy} run={run} onRetry={job=>setChosen(value=>({...value,[side]:job.id}))} onChanged={auditions.reload}/>
          {result.request&&<p>{result.request.profile.name} · {result.request.dictionaries.map(item=>item.name+" · "+item.revision).join(", ")||"Without dictionary"}</p>}
          {result.request&&<details><summary>Rehearsal text</summary><p dir="auto">{result.request.segment.spokenText}</p><button disabled={busy} onClick={()=>useSource(result.request!.segment.text.replaceAll("<|speaker:0|>",""))}>Use {side} text</button></details>}
          <div className="tts-row"><button disabled={!result.take} onClick={()=>void run(()=>play(result))}>Play rehearsal {side}</button>
          </div>
        </>}
      </fieldset>;
    })}
    <label className="tts-check"><input type="checkbox" checked={matched} onChange={event=>setMatched(event.target.checked)}/>Match playback position</label>
    <button disabled={busy} onClick={auditions.reload}>Refresh rehearsals</button>
    <AuditionHistoryPages page={auditions.page} hasMore={auditions.hasMore} busy={busy||auditions.loading} setPage={auditions.setPage}/>
    {!comparable&&<p role="status">The passages or voice settings differ. Render A and B with the same text and profile to compare pronunciation.</p>}
    {source.includes("<|phoneme_start|>")&&<Field label="Rehearsal phoneme alphabet"><select value={alphabet} onChange={event=>setAlphabet(event.target.value as PhonemeAlphabet)}><option value="arpabet">ARPAbet</option><option value="pinyin">Pinyin</option><option value="romaji">Romaji</option></select></Field>}
    <Field label="Rehearsal budget"><input type="number" min={0} step="any" value={budget} onChange={event=>setBudget(event.target.value)}/></Field>
    <label className="tts-check"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow rehearsal text in Fish Cloud</label>
    {!settings?.cloudConsent&&<p>Enable cloud synthesis in Settings before rendering a rehearsal.</p>}
    {estimate&&<output>{estimate.amount===null?"Cost unavailable. Add an account rate in Settings to estimate a rehearsal.":`Each rehearsal: ${estimate.amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${estimate.currency}`} · {estimate.characters.toLocaleString()} characters · {estimate.utf8Bytes.toLocaleString()} UTF-8 bytes</output>}
    {issue&&<p role="alert">{issue}</p>}{error&&<p role="alert">{error}</p>}
    {error&&<button disabled={busy} onClick={auditions.reload}>Reload rehearsals</button>}
  </details>;
}
