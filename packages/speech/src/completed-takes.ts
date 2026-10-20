import type {SpeechJob,SpeechRuntime,SpeechTake} from "./runtime.ts";

export async function completedSpeechTakes(runtime:SpeechRuntime,job:SpeechJob,signal?:AbortSignal):Promise<SpeechTake[]>{
  if(job.state!=="completed"||!Number.isSafeInteger(job.totalSegments)||job.totalSegments<1||job.totalSegments>10000||job.completedSegments!==job.totalSegments||job.takeIds.length!==job.totalSegments||new Set(job.takeIds).size!==job.takeIds.length)throw new Error("This speech job has incomplete production takes. Inspect Jobs before retrying.");
  const expected=new Set(job.takeIds);const takes=new Map<string,SpeechTake>();
  for(let offset=0;offset<job.takeIds.length;offset+=500){
    signal?.throwIfAborted();const limit=Math.min(500,job.takeIds.length-offset);const page=await runtime.execute("listTakes",{jobId:job.id,offset,limit});signal?.throwIfAborted();
    if(page.length!==limit)throw new Error("The completed speech take page is incomplete. Reload Jobs before playback or export.");
    for(const take of page){if(!expected.has(take.id)||takes.has(take.id))throw new Error("The completed speech take pages contain a duplicate or unrelated take. Reload Jobs before playback or export.");takes.set(take.id,take);}
  }
  return job.takeIds.map(id=>takes.get(id)!);
}
