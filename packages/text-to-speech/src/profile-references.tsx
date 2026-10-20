import {useEffect,useState} from "react";
import type {SpeechOperations,SpeechRuntime,SpeechAsset} from "@machdoch/speech";
import {errorText,type Run} from "./controls.tsx";

export function ProfileReferences({runtime,value,change,busy,run,play}:{runtime:SpeechRuntime;value:string[];change(value:string[]):void;busy:boolean;run:Run;play(asset:SpeechAsset):Promise<void>}){
  const [open,setOpen]=useState(false);const [page,setPage]=useState(0);const [refresh,setRefresh]=useState(0);const [result,setResult]=useState<SpeechOperations["listReferences"]["output"]>({references:[],total:0});const [error,setError]=useState<string|null>(null);const [loading,setLoading]=useState(false);
  useEffect(()=>{
    if(!open)return;let disposed=false;setLoading(true);void runtime.execute("listReferences",{offset:page*50,limit:50}).then(result=>{if(!disposed){setResult(result);setError(null);}}).catch(failure=>{if(!disposed)setError(errorText(failure));}).finally(()=>{if(!disposed)setLoading(false);});return()=>{disposed=true;};
  },[runtime,open,page,refresh]);
  return <details className="tts-stack" onToggle={event=>setOpen(event.currentTarget.open)}><summary>Default reference recordings</summary>
    <ol>{value.map((id,index)=><li key={id}><code>{id}</code><button type="button" disabled={busy||index===0} aria-label={`Move reference ${index+1} up`} onClick={()=>{const ordered=[...value];[ordered[index-1],ordered[index]]=[ordered[index]!,ordered[index-1]!];change(ordered);}}>Move up</button><button type="button" disabled={busy} aria-label={`Remove reference ${index+1}`} onClick={()=>change(value.filter(value=>value!==id))}>Remove</button></li>)}</ol>
    {error&&<p role="alert">{error}</p>}
    <ul aria-busy={loading}>{result.references.map(reference=><li key={reference.asset.id}><label><input type="checkbox" disabled={busy||value.length>=256&&!value.includes(reference.asset.id)} checked={value.includes(reference.asset.id)} onChange={event=>change(event.target.checked?[...value,reference.asset.id]:value.filter(id=>id!==reference.asset.id))}/>{reference.transcript.slice(0,160)} · {reference.asset.duration.toFixed(2)} s</label><button type="button" disabled={busy} onClick={()=>void run(()=>play(reference.asset))}>Play reference</button></li>)}</ul>
    <div className="tts-row"><button type="button" disabled={loading||page===0} onClick={()=>setPage(value=>value-1)}>Previous references</button><output>Page {page+1} · {result.total.toLocaleString()} recordings</output><button type="button" disabled={loading||(page+1)*50>=result.total} onClick={()=>setPage(value=>value+1)}>Next references</button><button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>Refresh references</button></div>
  </details>;
}
