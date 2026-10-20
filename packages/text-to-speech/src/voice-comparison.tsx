import {useState} from "react";
import {compileSpeechAudition,estimateSpeechRender,createAudioPlaybackHandle,speechPlayback,retainSpeechPlayback,type SpeechVoice,type SpeechProfile,type SpeechSettings,type SpeechRuntime,type SpeechRenderSegment,type PhonemeAlphabet} from "@machdoch/speech";
import {Field,OWNER,errorText,type Run} from "./controls.tsx";
import {useAuditionJobs} from "./use-audition-jobs.ts";
import {SpeechJobControls,AuditionHistoryPages} from "./job-controls.tsx";

const JOB_OWNER="text-to-speech:voice-comparison";

export function VoiceComparison({runtime,active,voices,remove,profiles,settings,assetUrl,run,busy,assign}:{
  runtime:SpeechRuntime;active:boolean;voices:SpeechVoice[];remove(id:string):void;profiles:SpeechProfile[];settings:SpeechSettings|null;assetUrl(path:string):string;run:Run;busy:boolean;assign?: (id:string)=>void;
}){
  const [open,setOpen]=useState(false);
  const [source,setSource]=useState("");
  const [profileId,setProfileId]=useState("");
  const [alphabet,setAlphabet]=useState<PhonemeAlphabet>("arpabet");
  const [consent,setConsent]=useState(false);
  const [budget,setBudget]=useState("");
  const [jobId,setJobId]=useState("");
  const [choice,setChoice]=useState({A:"",B:""});
  const [matched,setMatched]=useState(true);
  const auditions=useAuditionJobs(runtime,JOB_OWNER,"comparison-",[jobId],active&&open,32);
  const result=auditions.results[jobId];
  const performances=result?.performances??[];
  const eligible=profiles.filter(profile=>profile.backend==="fish-cloud"&&profile.model==="drama-3");
  const profile=eligible.find(profile=>profile.id===profileId)??(profileId===""?eligible[0]:undefined);
  const connection=settings?.connections.find(connection=>connection.backend==="fish-cloud");
  let segment:SpeechRenderSegment|null=null;let estimate:ReturnType<typeof estimateSpeechRender>|null=null;let issue:string|null=null;
  if(open&&profile&&voices.length>0&&source.trim()){try{
    segment=compileSpeechAudition(source,profile,{voiceIds:[voices[0]!.id],referenceAssetIds:[]},connection,alphabet);
    estimate=estimateSpeechRender([segment.text],profile,voices.length,settings?.pricing??null);
  }catch(failure){issue=errorText(failure);}}
  const play=async(id:string)=>{
    const performance=performances.find(item=>item.take.id===id);if(!performance)throw new Error("Choose a completed comparison take.");
    const state=speechPlayback.snapshot();const {take,request}=performance;
    const position=matched&&state.owner===OWNER&&performances.some(item=>item.take.id===state.itemId)?Math.min(state.position,Math.max(0,take.asset.duration-0.01)):0;
    await speechPlayback.play({owner:OWNER,itemId:id,open:signal=>retainSpeechPlayback(runtime,{owner:JOB_OWNER,assetIds:[take.asset.id]},signal,()=>{const handle=createAudioPlaybackHandle(assetUrl(take.asset.path),{signal,rate:request.profile.playbackRate,duration:take.asset.duration});handle.seek(position);return handle;},message=>void run(async()=>{throw new Error(message);}))});
  };
  const voiceName=(id:string)=>voices.find(voice=>voice.id===id)?.name??id;
  return <details className="tts-stack" onToggle={event=>setOpen(event.currentTarget.open)}><summary>Voice comparison</summary>
    <ul>{voices.map(voice=><li key={voice.id}>{voice.name}<button disabled={busy} aria-label={`Remove ${voice.name} from comparison`} onClick={()=>remove(voice.id)}>Remove</button></li>)}</ul>
    {voices.length<2&&<p>Select at least two voices from the library to render a comparison.</p>}
    <Field label="Comparison profile"><select value={profile?.id??""} onChange={event=>setProfileId(event.target.value)}><option value="">Choose profile</option>{eligible.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
    {!profile&&<p>Save a Fish Cloud Drama 3 profile to compare voices.</p>}
    <Field label="Comparison passage"><textarea rows={4} dir="auto" value={source} onChange={event=>setSource(event.target.value)}/></Field>
    {source.includes("<|phoneme_start|>")&&<Field label="Comparison phoneme alphabet"><select value={alphabet} onChange={event=>setAlphabet(event.target.value as PhonemeAlphabet)}><option value="arpabet">ARPAbet</option><option value="pinyin">Pinyin</option><option value="romaji">Romaji</option></select></Field>}
    <Field label="Comparison budget"><input type="number" min={0} step="any" value={budget} onChange={event=>setBudget(event.target.value)}/></Field>
    <label className="tts-check"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow comparison passage in Fish Cloud</label>
    {!settings?.cloudConsent&&<p>Enable cloud synthesis in Settings before rendering a comparison.</p>}
    {estimate&&<output>{estimate.amount===null?"Cost unavailable. Add an account rate in Settings to estimate this comparison.":`Comparison estimate: ${estimate.amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${estimate.currency}`} · {voices.length} voices · {estimate.characters.toLocaleString()} characters · {estimate.utf8Bytes.toLocaleString()} UTF-8 bytes</output>}
    {issue&&<p role="alert">{issue}</p>}
    <button disabled={busy||voices.length<2||voices.length>32||!segment||!!issue||!consent||!settings?.cloudConsent||!connection?.configured} onClick={()=>void run(async()=>{
      if(!segment||!profile)throw new Error("Choose a profile and enter one audition passage.");
      const budgetLimit=budget===""?null:Number(budget);if(budgetLimit!==null&&(!Number.isFinite(budgetLimit)||budgetLimit<0))throw new Error("Enter a nonnegative comparison budget.");
      const job=await runtime.execute("compareVoices",{owner:JOB_OWNER,profileId:profile.id,segment,voiceIds:voices.map(voice=>voice.id),cloudConsent:consent,budgetLimit});setJobId(job.id);setChoice({A:"",B:""});auditions.reload();
    })}>Render voices</button>
    <Field label="Saved voice comparison"><select value={jobId} onChange={event=>{setJobId(event.target.value);setChoice({A:"",B:""});}}><option value="">Choose comparison</option>{auditions.jobs.map((job,index)=><option key={job.id} value={job.id}>{index+1} · {new Date(job.createdAt).toLocaleString()} · {job.state}</option>)}</select></Field>
    <button disabled={busy} onClick={auditions.reload}>Refresh comparisons</button>
    <AuditionHistoryPages page={auditions.page} hasMore={auditions.hasMore} busy={busy||auditions.loading} setPage={auditions.setPage}/>
    {auditions.error&&<p role="alert">{auditions.error}</p>}
    {result&&<>
      <SpeechJobControls label="audition" runtime={runtime} owner={JOB_OWNER} job={result.job} busy={busy} run={run} onRetry={job=>setJobId(job.id)} onChanged={auditions.reload}/>
      {(["A","B"] as const).map((side,index)=>{
        const selected=performances.find(item=>item.take.id===choice[side])??(choice[side]?undefined:performances[index]);
        return <fieldset className="tts-row" key={side}><legend>{side}</legend>
          <Field label={`${side} comparison voice`}><select value={selected?.take.id??""} onChange={event=>setChoice(value=>({...value,[side]:event.target.value}))}><option value="">Choose take</option>{performances.map(({take,request})=><option key={take.id} value={take.id}>{voiceName(request.segment.voiceIds[0]??take.id)} · {take.asset.duration.toFixed(2)} s</option>)}</select></Field>
          <button disabled={!selected} onClick={()=>{if(selected)void run(()=>play(selected.take.id));}}>Play voice {side}</button>
          {selected&&<><button aria-pressed={selected.take.favorite} disabled={busy} onClick={()=>void run(async()=>{await runtime.execute("updateTake",{id:selected.take.id,favorite:!selected.take.favorite});auditions.reload();})}>{selected.take.favorite?"Unsave audition":"Save audition"}</button>
          {assign&&selected.request.segment.voiceIds[0]&&<button onClick={()=>assign(selected.request.segment.voiceIds[0]!)}>Assign comparison voice</button>}</>}
        </fieldset>;
      })}
      <label className="tts-check"><input type="checkbox" checked={matched} onChange={event=>setMatched(event.target.checked)}/>Match voice playback position</label>
      {performances[0]&&<details><summary>Comparison text</summary><p dir="auto">{performances[0].request.segment.spokenText}</p><button disabled={busy} onClick={()=>setSource(performances[0]!.request.segment.text.replaceAll("<|speaker:0|>",""))}>Use comparison passage</button></details>}
    </>}
  </details>;
}
