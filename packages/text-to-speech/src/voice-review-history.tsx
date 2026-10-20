import {useEffect,useState} from "react";
import type {SpeechOperations,SpeechRuntime} from "@machdoch/speech";
import {Field,errorText,type Run} from "./controls.tsx";

export function VoiceReviewHistory({runtime,active,busy,run,openProject}:{runtime:SpeechRuntime;active:boolean;busy:boolean;run:Run;openProject(id:string):Promise<void>}){
  const [open,setOpen]=useState(false);const [voice,setVoice]=useState("");const [language,setLanguage]=useState("");const [verdict,setVerdict]=useState<""|"approved"|"rejected">("");
  const [query,setQuery]=useState({voiceId:"",language:"",verdict:"" as ""|"approved"|"rejected"});const [page,setPage]=useState(0);const [refresh,setRefresh]=useState(0);
  const [result,setResult]=useState<SpeechOperations["listVoiceReviews"]["output"]>({reviews:[],total:0});const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    if(!active||!open)return;let disposed=false;setLoading(true);
    void runtime.execute("listVoiceReviews",{voiceId:query.voiceId||undefined,language:query.language||undefined,verdict:query.verdict||undefined,offset:page*20,limit:20}).then(value=>{if(!disposed){setResult(value);setError(null);}}).catch(failure=>{if(!disposed){setError(errorText(failure));setResult({reviews:[],total:0});}}).finally(()=>{if(!disposed)setLoading(false);});
    return()=>{disposed=true;};
  },[runtime,active,open,query,page,refresh]);
  return <details className="tts-stack" onToggle={event=>setOpen(event.currentTarget.open)}><summary>Listening review history</summary>
    <form className="tts-row" onSubmit={event=>{event.preventDefault();setPage(0);setQuery({voiceId:voice.trim(),language:language.trim(),verdict});setRefresh(value=>value+1);}}>
      <Field label="Reviewed voice ID"><input value={voice} maxLength={256} onChange={event=>setVoice(event.target.value)}/></Field>
      <Field label="Reviewed language"><input value={language} maxLength={64} pattern="[A-Za-z0-9-]*" onChange={event=>setLanguage(event.target.value)}/></Field>
      <Field label="Review verdict"><select value={verdict} onChange={event=>setVerdict(event.target.value as typeof verdict)}><option value="">All reviews</option><option value="approved">Approved</option><option value="rejected">Needs work</option></select></Field>
      <button disabled={loading||busy}>Search reviews</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    <div className="tts-table-scroll" aria-busy={loading}><table><caption>Voice and language listening reviews</caption><thead><tr><th>Voice</th><th>Language</th><th>Verdict</th><th>Model</th><th>Reviewer</th><th>Reviewed</th><th>Project</th></tr></thead><tbody>{result.reviews.map(({projectId,projectTitle,review})=><tr key={`${projectId}:${review.id}`}>
      <td>{review.voiceId}</td><td>{review.language}</td><td>{review.verdict==="approved"?"Approved":"Needs work"}</td><td>{review.backend} · {review.model}</td><td>{review.reviewer}</td><td><time dateTime={review.reviewedAt}>{new Date(review.reviewedAt).toLocaleString()}</time></td><td><button disabled={busy} onClick={()=>void run(()=>openProject(projectId))}>Open {projectTitle}</button></td>
    </tr>)}</tbody></table></div>
    {!loading&&!error&&!result.total&&<p>No listening reviews match this search.</p>}
    <div className="tts-row"><button disabled={loading||page===0} onClick={()=>setPage(value=>value-1)}>Previous reviews</button><output>Page {page+1} · {result.total.toLocaleString()} reviews</output><button disabled={loading||(page+1)*20>=result.total} onClick={()=>setPage(value=>value+1)}>Next reviews</button></div>
  </details>;
}
