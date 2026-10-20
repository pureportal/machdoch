import type {SpeechRuntime,SpeechJob} from "@machdoch/speech";
import type {Run} from "./controls.tsx";
import {JobUsage} from "./job-usage.tsx";

export function AuditionHistoryPages({page,hasMore,busy,setPage}:{page:number;hasMore:boolean;busy:boolean;setPage(page:number):void}){
  return <div className="tts-row"><button disabled={busy||page===0} onClick={()=>setPage(page-1)}>Previous auditions</button><output>Audition page {page+1}</output><button disabled={busy||!hasMore} onClick={()=>setPage(page+1)}>Next auditions</button></div>;
}

export function SpeechJobControls({runtime,owner,job,busy,run,onRetry,onChanged,label}:{runtime:SpeechRuntime;owner:string;job:SpeechJob;busy:boolean;run:Run;onRetry(job:SpeechJob):void;onChanged():void;label:"audition"|"request"}){
  return <div className="tts-stack">
    <output>{job.state==="running"&&job.cancelRequestedAt?"Cancelling":job.state} · {job.completedSegments}/{job.totalSegments}</output>
    {job.error&&<p role="alert">{job.error}</p>}
    <JobUsage usage={job.usage}/>
    {["queued","running"].includes(job.state)&&<button disabled={busy||!!job.cancelRequestedAt} onClick={()=>void run(async()=>{await runtime.execute("cancel",{jobId:job.id,owner});onChanged();})}>Cancel {label}</button>}
    {["failed","cancelled","interrupted","uncertain"].includes(job.state)&&<button disabled={busy} onClick={()=>void run(async()=>{
      const confirmedUncertain=job.state==="uncertain"&&window.confirm(`This ${label} may already have been billed. Retrying can create another charge. Retry?`);if(job.state==="uncertain"&&!confirmedUncertain)return;
      onRetry(await runtime.execute("retry",{jobId:job.id,owner,confirmedUncertain}));onChanged();
    })}>Retry {label}</button>}
  </div>;
}
