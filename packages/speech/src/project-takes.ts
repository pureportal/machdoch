import type {SpeechProject,SpeechRuntime,SpeechTake} from "./runtime.ts";

export function speechProjectTakeIds(project:SpeechProject):string[]{
  return [...new Set([...Object.values(project.selectedTakes),...project.timeline.map(clip=>clip.takeId),...Object.keys(project.timingSelections??{}),...(project.voiceAuditions??[]).map(review=>review.takeId),...(project.readingBookmarks??[]).map(bookmark=>bookmark.takeId)])].sort();
}

export async function resolveSpeechProjectTakes(runtime:SpeechRuntime,projectId:string,ids:readonly string[],signal?:AbortSignal):Promise<SpeechTake[]>{
  const distinct=[...new Set(ids)];
  if(distinct.length>10_000)throw new Error("Choose at most 10,000 production takes.");
  const takes:SpeechTake[]=[];
  let bytes=0;
  const encoder=new TextEncoder();
  for(let offset=0;offset<distinct.length;offset+=100){
    signal?.throwIfAborted();
    const requested=distinct.slice(offset,offset+100);
    const page=await runtime.execute("resolveTakes",{projectId,ids:requested});
    signal?.throwIfAborted();
    const byId=new Map(page.map(take=>[take.id,take]));
    if(page.length!==requested.length||byId.size!==page.length||page.some(take=>take.projectId!==projectId)||requested.some(id=>!byId.has(id)))throw new Error("The production take lookup returned missing, duplicate or unrelated audio. Reload the project.");
    bytes+=encoder.encode(JSON.stringify(page)).byteLength;
    if(bytes>64*1024*1024)throw new Error("The selected production metadata exceeds 64 MiB. Produce a smaller chapter or scene.");
    takes.push(...requested.map(id=>byId.get(id)!));
  }
  return takes;
}
