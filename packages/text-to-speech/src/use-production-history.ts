import {useCallback,useEffect,useMemo,useState,type SetStateAction} from "react";
import {resolveSpeechProjectTakes,speechProjectTakeIds,type SpeechJob,type SpeechProject,type SpeechRuntime,type SpeechTake} from "@machdoch/speech";

const PAGE_SIZE=20;
const ACTIVE_STATES:Array<SpeechJob["state"]>=["queued","running"];
type HistoryPage={key:string;jobs:SpeechJob[];active:SpeechJob[];takes:SpeechTake[];moreJobs:boolean;moreActive:boolean;moreTakes:boolean};

export function useProductionHistory(runtime:SpeechRuntime,project:SpeechProject|null,pollKey:number,comparisonIds:string[],report:(error:unknown)=>void){
  const [jobPage,setJobPage]=useState(0);
  const [takePage,setTakePage]=useState(0);
  const [activeOnly,setActiveOnly]=useState(false);
  const [page,setPage]=useState<HistoryPage|null>(null);
  const [pinned,setPinned]=useState<{key:string;takes:SpeechTake[]}|null>(null);
  const [pollFailed,setPollFailed]=useState(false);
  const [queuePaused,setQueuePaused]=useState(false);
  const projectId=project?.id;
  const key=JSON.stringify([projectId,jobPage,takePage,activeOnly]);
  const requestedIds=JSON.stringify(project?[...new Set([...speechProjectTakeIds(project),...comparisonIds])].sort():[]);
  const pinnedKey=JSON.stringify([projectId,requestedIds]);
  useEffect(()=>{setJobPage(0);setTakePage(0);setActiveOnly(false);},[projectId]);
  useEffect(()=>{
    if(!projectId)return;
    const controller=new AbortController();
    void resolveSpeechProjectTakes(runtime,projectId,JSON.parse(requestedIds) as string[],controller.signal).then(takes=>{if(!controller.signal.aborted)setPinned({key:pinnedKey,takes});}).catch(error=>{if(!controller.signal.aborted)report(error);});
    return ()=>controller.abort();
  },[runtime,projectId,pinnedKey,requestedIds,report]);
  useEffect(()=>{
    if(!projectId)return;
    let disposed=false;
    let timer:number|undefined;
    setPollFailed(false);
    const poll=async()=>{
      try{
        const [jobs,takes,active,queue]=await Promise.all([
          runtime.execute("listJobs",{projectId,offset:jobPage*PAGE_SIZE,limit:PAGE_SIZE+1,...(activeOnly?{states:ACTIVE_STATES}:{})}),
          runtime.execute("listTakes",{projectId,offset:takePage*PAGE_SIZE,limit:PAGE_SIZE+1}),
          activeOnly?Promise.resolve([]):runtime.execute("listJobs",{projectId,states:ACTIVE_STATES,offset:0,limit:PAGE_SIZE+1}),
          runtime.execute("queue",{}),
        ]);
        if(disposed)return;
        setPage({key,jobs:jobs.slice(0,PAGE_SIZE),active:active.slice(0,PAGE_SIZE),takes:takes.slice(0,PAGE_SIZE),moreJobs:jobs.length>PAGE_SIZE,moreTakes:takes.length>PAGE_SIZE,moreActive:active.length>PAGE_SIZE});
        setQueuePaused(queue.paused);
        timer=window.setTimeout(()=>void poll(),1800);
      }catch(error){if(!disposed){setPollFailed(true);report(error);}}
    };
    void poll();
    return ()=>{disposed=true;window.clearTimeout(timer);};
  },[runtime,projectId,key,jobPage,takePage,activeOnly,pollKey,report]);
  const visible=page?.key===key?page:null;
  const jobs=useMemo(()=>[...new Map([...(visible?.active??[]),...(visible?.jobs??[])].map(job=>[job.id,job])).values()],[visible]);
  const rawTakes=useMemo(()=>[...new Map([...(pinned?.key===pinnedKey?pinned.takes:[]),...(visible?.takes??[])].map(take=>[take.id,take])).values()],[pinned,pinnedKey,visible]);
  const setTakes=useCallback((update:SetStateAction<SpeechTake[]>)=>{
    const replace=(items:SpeechTake[])=>typeof update==="function"?update(items):update;
    setPage(value=>value?{...value,takes:replace(value.takes)}:value);
    setPinned(value=>value?{...value,takes:replace(value.takes)}:value);
  },[]);
  const setJobs=useCallback((update:SetStateAction<SpeechJob[]>)=>setPage(value=>{
    if(!value)return value;
    const replace=(items:SpeechJob[])=>typeof update==="function"?update(items):update;
    return {...value,jobs:replace(value.jobs).slice(0,PAGE_SIZE),active:replace(value.active).filter(job=>ACTIVE_STATES.includes(job.state)).slice(0,PAGE_SIZE)};
  }),[]);
  const cancelAll=async()=>{
    if(!projectId)return;
    const candidates=new Map<string,SpeechJob>();
    for(let offset=0;;offset+=500){
      const rows=await runtime.execute("listJobs",{projectId,states:ACTIVE_STATES,offset,limit:500});
      for(const job of rows)if(!job.cancelRequestedAt)candidates.set(job.id,job);
      if(rows.length<500)break;
      if(offset>=9500)throw new Error("More than 10,000 jobs are active. Cancel a smaller batch before cancelling the remainder.");
    }
    const failures:string[]=[];
    for(const job of candidates.values()){
      try{const cancelled=await runtime.execute("cancel",{jobId:job.id,owner:job.owner});setJobs(items=>items.map(item=>item.id===cancelled.id?cancelled:item));}
      catch(error){failures.push(error instanceof Error?error.message:String(error));}
    }
    if(failures.length)throw new Error(`${failures.length} job cancellations failed: ${failures[0]}`);
  };
  return {jobs,rawTakes,visibleTakeIds:new Set(visible?.takes.map(take=>take.id)??[]),setJobs,setTakes,queuePaused,setQueuePaused,pollFailed,jobPage,setJobPage,takePage,setTakePage,activeOnly,
    showActive:(value:boolean)=>{setJobPage(0);setActiveOnly(value);},moreJobs:visible?.moreJobs??false,moreTakes:visible?.moreTakes??false,moreActive:visible?.moreActive??false,loading:!visible,cancelAll};
}
