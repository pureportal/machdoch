import {useState} from "react";
import {estimateSpeechPerformance, type SpeechRuntime, type SpeechSettings, type SpeechTake, type SpeechTakeRequest} from "@machdoch/speech";
import {Field, OWNER, type Run} from "./controls.tsx";

export function DirectorNotes({runtime,take,settings,busy,run,onQueued}: {
  runtime:SpeechRuntime;take:SpeechTake;settings:SpeechSettings|null;busy:boolean;run:Run;onQueued():void;
}) {
  const [request,setRequest]=useState<SpeechTakeRequest|null>(null);
  const [note,setNote]=useState("");
  const [takes,setTakes]=useState(1);
  const [budget,setBudget]=useState("");
  const [consent,setConsent]=useState(settings?.cloudConsent??false);
  const [loading,setLoading]=useState(false);
  const load=async()=>{
    if(loading||request)return;
    setLoading(true);
    try{setRequest(await runtime.execute("takeRequest",{id:take.id}));}
    finally{setLoading(false);}
  };
  let estimate:ReturnType<typeof estimateSpeechPerformance>|null=null;
  let error:string|null=null;
  if(request&&note){try{estimate=estimateSpeechPerformance(request,note,takes,settings?.pricing??null);}catch(failure){error=failure instanceof Error?failure.message:String(failure);}}
  if(!["fish-cloud","sglang","drama3"].includes(take.backend)||take.model!=="drama-3")return null;
  return <details onToggle={event=>{if(event.currentTarget.open)void run(load);}}>
    <summary>Another performance</summary>
    {!request ? <button type="button" disabled={busy||loading} onClick={()=>void run(load)}>{loading?"Loading generation settings…":"Load generation settings"}</button> : <form className="tts-stack" onSubmit={event=>{
      event.preventDefault();void run(async()=>{
        estimateSpeechPerformance(request,note,takes,settings?.pricing??null);
        const budgetLimit=budget===""?null:Number(budget);
        if(budgetLimit!==null&&(!Number.isFinite(budgetLimit)||budgetLimit<0))throw new Error("Enter a nonnegative budget.");
        await runtime.execute("regenerate",{owner:OWNER,takeId:take.id,note,takes,cloudConsent:consent,budgetLimit});onQueued();
      });
    }}>
      {request.profile.direction&&<Field label="Original direction"><textarea readOnly dir="auto" rows={2} value={request.profile.direction}/></Field>}
      <Field label="Director note"><textarea required dir="auto" rows={2} value={note} onChange={event=>setNote(event.target.value)}/></Field>
      <Field label="New takes"><input type="number" min={1} max={32} step={1} required value={takes} onChange={event=>setTakes(event.target.valueAsNumber)}/></Field>
      <Field label="Performance budget"><input type="number" min={0} step="any" value={budget} onChange={event=>setBudget(event.target.value)}/></Field>
      {take.backend==="fish-cloud"&&<label className="tts-check"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>Allow cloud synthesis</label>}
      {error&&<p role="alert">{error}</p>}
      {estimate&&<output>{estimate.amount===null?(take.backend==="fish-cloud"?"Cost unavailable. Add an account rate in Settings to estimate this performance.":"Cost unavailable for this backend."):`New performance estimate: ${estimate.amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${estimate.currency}`}</output>}
      {settings&&!settings.cloudConsent&&take.backend==="fish-cloud"&&<p>Enable cloud synthesis in Settings before requesting a performance.</p>}
      <button disabled={busy||!note.trim()||!!error||!settings||take.backend==="fish-cloud"&&(!consent||!settings.cloudConsent)}>Request performance</button>
    </form>}
  </details>;
}
