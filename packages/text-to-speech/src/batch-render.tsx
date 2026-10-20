import {useEffect,useMemo,useRef,useState} from "react";
import {speechCastBindings,submitSpeechBatch,type SpeechBatchFile,type SpeechBatchMapping,type SpeechBatchPreparation,type SpeechBatchReceipt,type SpeechDictionary,type SpeechProfile,type SpeechProject,type SpeechRuntime,type SpeechSettings,type PhonemeAlphabet} from "@machdoch/speech";
import {Field,errorText,type Run} from "./controls.tsx";
import type {BatchWorkerInput,BatchWorkerOutput} from "./batch-worker.ts";

export function BatchRender({runtime,project,profiles,dictionaries,settings,run,busy,onProjects,openProject}:{runtime:SpeechRuntime;project:SpeechProject;profiles:SpeechProfile[];dictionaries:SpeechDictionary[];settings:SpeechSettings|null;run:Run;busy:boolean;onProjects():Promise<void>;openProject(id:string):Promise<void>}){
  const [files,setFiles]=useState<SpeechBatchFile[]>([]);const [mappings,setMappings]=useState<Record<string,SpeechBatchMapping>>({});const [bindings,setBindings]=useState<Record<string,string>>({});
  const [profileId,setProfileId]=useState("");const [stripMetadata,setStripMetadata]=useState(false);const [takes,setTakes]=useState(1);const [alphabet,setAlphabet]=useState<PhonemeAlphabet>("arpabet");
  const [consent,setConsent]=useState(false);const [budget,setBudget]=useState("");const [reading,setReading]=useState(false);const [reviewing,setReviewing]=useState(false);const [admitting,setAdmitting]=useState(false);
  const [error,setError]=useState<string|null>(null);const [receipt,setReceipt]=useState<SpeechBatchReceipt|null>(null);
  const [review,setReview]=useState<{files:SpeechBatchFile[];key:string;result:SpeechBatchPreparation}|null>(null);
  const worker=useRef<Worker|null>(null);const request=useRef<{id:number;files:SpeechBatchFile[];key:string}|null>(null);const sequence=useRef(0);const fileSequence=useRef(0);const controller=useRef<AbortController|null>(null);
  const profile=profiles.find(profile=>profile.id===(profileId||project.profileId));const connection=settings?.connections.find(connection=>connection.backend===profile?.backend);
  const cast=useMemo(()=>project.cast.map(({sceneOverrides,...member})=>member),[project.cast]);
  const dictionaryRevisions=profile?.dictionaryIds.flatMap(id=>{const dictionary=dictionaries.find(dictionary=>dictionary.id===id);return dictionary?[{id,revision:dictionary.revision}]:[]})??[];
  const key=JSON.stringify({profile,cast,mappings,bindings,stripMetadata,takes,alphabet,pricing:settings?.pricing,connection,dictionaryRevisions});
  const current=review?.files===files&&review.key===key?review.result:null;
  const preview=review?.files===files?review.result:null;
  const speakers=[...new Set(preview?.items.flatMap(item=>item.speakers)??[])];
  const unavailable=busy||reading||reviewing||admitting;
  useEffect(()=>{
    const instance=new Worker(new URL("./batch-worker.ts",import.meta.url),{type:"module"});worker.current=instance;
    instance.onmessage=(event:MessageEvent<BatchWorkerOutput>)=>{const active=request.current;if(!active||event.data.id!==active.id)return;request.current=null;setReviewing(false);if(event.data.result)setReview({...active,result:event.data.result});setError(event.data.error??null);};
    const failed=()=>{request.current=null;setReviewing(false);setError("Batch analysis stopped. Reopen Text to Speech and review the files again.");instance.terminate();worker.current=null;};instance.onerror=failed;instance.onmessageerror=failed;
    return()=>{worker.current=null;instance.terminate();fileSequence.current++;controller.current?.abort();};
  },[]);
  useEffect(()=>{setConsent(false);},[files,profileId,project.id]);
  const read=async(selected:File[])=>{
    const id=++fileSequence.current;setReading(true);setError(null);setReview(null);setReceipt(null);setFiles([]);setBindings({});
    try{
      if(selected.length<1||selected.length>32||selected.some(file=>file.size>4*1024*1024)||selected.reduce((total,file)=>total+file.size,0)>16*1024*1024)throw new Error("Choose 1–32 UTF-8 scripts, at most 4 MiB each and 16 MiB in total.");
      const formats:Record<string,SpeechBatchFile["format"]>={txt:"text",md:"markdown",markdown:"markdown",csv:"csv",tsv:"tsv"};const imported:SpeechBatchFile[]=[];
      for(const file of selected){const format=formats[file.name.split(".").at(-1)?.toLowerCase()??""];if(!format)throw new Error(`Choose a text, Markdown, CSV or TSV file instead of ${file.name}.`);const source=new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer());imported.push({id:crypto.randomUUID(),name:file.name,source,format});}
      if(id===fileSequence.current){setFiles(imported);setMappings(Object.fromEntries(imported.filter(file=>["csv","tsv"].includes(file.format)).map(file=>[file.id,{header:true,textColumn:-1,speakerColumn:-1}])));}
    }catch(failure){if(id===fileSequence.current)setError(errorText(failure));}finally{if(id===fileSequence.current)setReading(false);}
  };
  return <details className="tts-stack"><summary>Script batch</summary>
    <Field label="Batch files"><input type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv" disabled={unavailable} onChange={event=>{const selected=Array.from(event.target.files??[]);event.target.value="";if(selected.length)void read(selected);}}/></Field>
    <Field label="Batch profile"><select disabled={unavailable} value={profile?.id??""} onChange={event=>setProfileId(event.target.value)}><option value="">Choose profile</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
    {cast.length>0&&<dl><dt>Project cast</dt><dd>{cast.map(member=>member.name).join(", ")}</dd></dl>}
    <Field label="Batch takes"><input type="number" min={1} max={32} value={takes} disabled={unavailable} onChange={event=>setTakes(Number(event.target.value))}/></Field>
    <Field label="Batch phoneme alphabet"><select value={alphabet} disabled={unavailable} onChange={event=>setAlphabet(event.target.value as PhonemeAlphabet)}><option value="arpabet">ARPAbet</option><option value="pinyin">Pinyin</option><option value="romaji">Romaji</option></select></Field>
    {files.some(file=>file.format==="markdown")&&<label><input type="checkbox" disabled={unavailable} checked={stripMetadata} onChange={event=>setStripMetadata(event.target.checked)}/>Remove Markdown front matter and comments</label>}
    {files.map(file=>{const mapping=mappings[file.id];const item=preview?.items.find(item=>item.id===file.id);return <fieldset key={file.id}><legend>{file.name}</legend>
      {mapping&&<div className="tts-row"><label><input type="checkbox" disabled={unavailable} checked={mapping.header} onChange={event=>setMappings(values=>({...values,[file.id]:{...mapping,header:event.target.checked}}))}/>Header row</label>
        {(["textColumn","speakerColumn"] as const).map(column=><Field key={column} label={column==="textColumn"?"Text column":"Speaker column"}><input type="number" min={1} max={256} disabled={unavailable} value={mapping[column]<0?"":mapping[column]+1} onChange={event=>setMappings(values=>({...values,[file.id]:{...mapping,[column]:event.target.value===""?-1:Number(event.target.value)-1}}))}/></Field>)}
        {!!item?.columns.length&&<output>{item.columns.map((name,index)=>`${index+1}: ${name}`).join(" · ")}</output>}
      </div>}
      {item&&<><output>{item.segments.length} segments{item.estimate?` · ${item.estimate.characters.toLocaleString()} characters · ${item.estimate.utf8Bytes.toLocaleString()} UTF-8 bytes`:""}</output>
        {item.errors.map((error,index)=><p key={index} role="alert">{error}</p>)}<details><summary>Resolved script</summary><pre dir="auto">{item.source.slice(0,2048)}</pre></details></>}
    </fieldset>;})}
    {speakers.map(speaker=><Field key={speaker} label={`Cast for ${speaker}`}><select disabled={unavailable} value={bindings[speaker]??""} onChange={event=>setBindings(values=>({...values,[speaker]:event.target.value}))}><option value="">Choose cast member</option>{cast.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>)}
    <button disabled={unavailable||!files.length||!profile||!worker.current} onClick={()=>{if(!profile||!worker.current)return;setReviewing(true);setError(null);setReview(null);const id=++sequence.current;request.current={id,files,key};const input:BatchWorkerInput={id,files,options:{compile:{backend:profile.backend,cast:speechCastBindings(cast,id=>id),maxUtf8Bytes:connection?.maxTextBytes??undefined,maxSpeakers:connection?.maxSpeakers??undefined,phonemeAlphabet:alphabet},profile,pricing:settings?.pricing??null,takes,cast,stripMetadata,mappings,bindings}};worker.current.postMessage(input);}}>Review batch</button>
    {current?.estimate&&<output>{current.estimate.amount===null?"Batch cost unavailable. Verify an account rate in Settings to use a spending limit.":`Batch estimate: ${current.estimate.amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${current.estimate.currency}`}</output>}
    <Field label="Batch budget"><input type="number" min={0} step="any" disabled={unavailable} value={budget} onChange={event=>setBudget(event.target.value)}/></Field>
    {!["sglang","drama3"].includes(profile?.backend ?? "")&&<label><input type="checkbox" disabled={unavailable} checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow batch scripts and references in the selected cloud provider</label>}
    {!["sglang","drama3"].includes(profile?.backend ?? "")&&!settings?.cloudConsent&&<p>Enable cloud synthesis in Settings before rendering this batch.</p>}
    {error&&<p role="alert">{error}</p>}
    <button disabled={unavailable||!!receipt||!current?.estimate||!profile||!connection?.configured||(!["sglang","drama3"].includes(profile.backend)&&(!consent||!settings?.cloudConsent))} onClick={()=>void run(async()=>{
      if(!current||!profile)throw new Error("Review the batch before rendering.");if(dictionaryRevisions.length!==profile.dictionaryIds.length)throw new Error("Restore the profile's dictionaries before rendering.");
      const abort=new AbortController();controller.current=abort;setAdmitting(true);setError(null);
      try{await submitSpeechBatch(runtime,current,{id:crypto.randomUUID(),profile,cast,takes,cloudConsent:consent,budgetLimit:budget===""?null:Number(budget),dictionaryRevisions,signal:abort.signal,onProgress:setReceipt});}
      catch(failure){setError(errorText(failure));}finally{setAdmitting(false);controller.current=null;await onProjects();}
    })}>Render batch</button>
    {admitting&&<button onClick={()=>controller.current?.abort()}>Stop batch submission</button>}
    {receipt&&<section aria-label="Batch jobs"><ul>{receipt.items.map(item=><li key={item.id}>{item.name} · {item.state}{item.jobId&&<code>{item.jobId}</code>}{item.error&&<p role="alert">{item.error} Check this project for an admitted job before submitting it again.</p>}{item.state!=="pending"&&<button disabled={busy} onClick={()=>void run(()=>openProject(item.projectId))}>Open {item.name}</button>}</li>)}</ul>
      {receipt.stopped&&<p>Submission stopped. Already queued jobs continue.</p>}
      <button disabled={unavailable} onClick={()=>{setReceipt(null);setFiles([]);setReview(null);}}>Clear batch</button>
    </section>}
  </details>;
}
