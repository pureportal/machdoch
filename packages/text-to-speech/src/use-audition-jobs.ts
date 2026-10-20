import {useEffect,useRef,useState} from "react";
import type {SpeechRuntime,SpeechJob,SpeechTake,SpeechTakeProvenance} from "@machdoch/speech";
import {errorText} from "./controls.tsx";

export interface AuditionResult{job:SpeechJob;performances:Array<{take:SpeechTake;request:SpeechTakeProvenance}>}

export function useAuditionJobs(runtime:SpeechRuntime,owner:string,prefix:string,chosen:string[],active:boolean,maximumTakes:number){
  const [jobs,setJobs]=useState<SpeechJob[]>([]);
  const [results,setResults]=useState<Record<string,AuditionResult>>({});
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  const [page,setPage]=useState(0);const [hasMore,setHasMore]=useState(false);const [loading,setLoading]=useState(false);
  const cache=useRef(new Map<string,SpeechTakeProvenance>());
  const selected=JSON.stringify([...new Set(chosen.filter(Boolean))]);
  useEffect(()=>{
    if(!active)return;
    setLoading(true);
    let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const selectedIds=JSON.parse(selected) as string[];
    const poll=async()=>{
      try{
        const rows=await runtime.execute("listJobs",{owner,offset:page*20,limit:21});const recent=rows.slice(0,20).filter(job=>job.revisionId.startsWith(prefix));
        const next:Record<string,AuditionResult>={};const keep=new Map<string,SpeechTakeProvenance>();
        for(const id of selectedIds){
          const job=recent.find(job=>job.id===id)??(await runtime.execute("listJobs",{owner,id,limit:1})).find(job=>job.revisionId.startsWith(prefix));
          if(!job)throw new Error("This saved audition is unavailable. Refresh the audition history.");
          if(job.totalSegments>maximumTakes)throw new Error(`Choose an audition with no more than ${maximumTakes} takes for this view.`);
          if(!recent.some(item=>item.id===id))recent.push(job);
          const takes=job.completedSegments>0?await runtime.execute("listTakes",{jobId:id,limit:maximumTakes}):[];
          const positions=new Map(job.takeIds.map((id,index)=>[id,index]));
          if(takes.some(take=>!positions.has(take.id)))throw new Error("The audition take list differs from its job. Reload the audition history.");
          takes.sort((a,b)=>positions.get(a.id)!-positions.get(b.id)!);
          const performances=[];
          for(const take of takes){const request=cache.current.get(take.id)??await runtime.execute("takeProvenance",{id:take.id});keep.set(take.id,request);performances.push({take,request});}
          next[id]={job,performances};
        }
        if(disposed)return;
        cache.current=keep;setJobs(recent);setResults(next);setError(null);setHasMore(rows.length>20);setLoading(false);
        if(recent.some(job=>["queued","running"].includes(job.state)))timer=setTimeout(()=>{void poll();},1000);
      }catch(failure){if(!disposed){setError(errorText(failure));setLoading(false);}}
    };
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[runtime,owner,prefix,selected,active,maximumTakes,refresh,page]);
  return {jobs,results,error,page,hasMore,loading,setPage,reload:()=>{setPage(0);setRefresh(value=>value+1);}};
}
