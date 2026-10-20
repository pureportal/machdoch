import {useCallback,useEffect,useRef,useState} from "react";
import type {SpeechProject,SpeechRevision,SpeechRevisionSummary,SpeechRuntime} from "@machdoch/speech";
import {Field,type Run} from "./controls.tsx";

const PAGE_SIZE=20;

export function RevisionHistory({runtime,project,save,restore,run,busy,close}:{runtime:SpeechRuntime;project:SpeechProject;save():Promise<SpeechProject|null>;restore(project:SpeechProject):Promise<void>;run:Run;busy:boolean;close():void}){
  const [page,setPage]=useState({revisions:[] as SpeechRevisionSummary[],offset:0,total:0});
  const [a,setA]=useState<SpeechRevisionSummary|null>(null),[b,setB]=useState<SpeechRevisionSummary|null>(null);
  const [sources,setSources]=useState<{a:SpeechRevision;b:SpeechRevision|null}|null>(null);
  const request=useRef(0);
  const projectId=project.id;
  const load=useCallback(async(offset:number)=>{
    const expected=++request.current;const result=await runtime.execute("revisions",{projectId,offset,limit:PAGE_SIZE});
    if(expected!==request.current)return;
    if(result.offset!==offset||result.limit!==PAGE_SIZE||!Number.isSafeInteger(result.total)||result.total<0||result.revisions.length>PAGE_SIZE||result.revisions.some(revision=>revision.projectId!==projectId))throw new Error("The revision page differs from this project. Reload its history.");
    setPage(result);setA(value=>value??result.revisions[0]??null);setB(value=>value??result.revisions[1]??null);
  },[runtime,projectId]);
  useEffect(()=>{setA(null);setB(null);setSources(null);setPage({revisions:[],offset:0,total:0});void run(()=>load(0));return()=>{request.current++;};},[load,run]);
  const choices=[...page.revisions];for(const selected of [a,b])if(selected&&!choices.some(revision=>revision.id===selected.id))choices.push(selected);
  const label=(revision:SpeechRevisionSummary)=>`${new Date(revision.createdAt).toLocaleString()} · ${revision.id.slice(0,8)}`;
  const select=(side:"a"|"b",id:string)=>{request.current++;setSources(null);const selected=choices.find(revision=>revision.id===id)??null;if(side==="a")setA(selected);else setB(selected);};
  const view=async(compare:boolean)=>{
    if(!a||compare&&!b)throw new Error("Choose the revisions to view.");const expected=++request.current;
    const [left,right]=await Promise.all([runtime.execute("getRevision",{projectId,revisionId:a.id}),compare?runtime.execute("getRevision",{projectId,revisionId:b!.id}):Promise.resolve(null)]);
    if(expected!==request.current)return;
    if(left.projectId!==projectId||left.id!==a.id||right&&(right.projectId!==projectId||right.id!==b?.id))throw new Error("The returned source differs from the selected revision.");
    setSources({a:left,b:right});
  };
  return <section className="tts-revisions" aria-label="Revision history">
    <div className="tts-row"><h2>Revisions</h2><button type="button" onClick={close}>Close history</button><button type="button" disabled={busy} onClick={()=>void run(()=>load(page.offset))}>Reload revisions</button></div>
    {(page.total>PAGE_SIZE||page.offset>0)&&<div className="tts-row" role="group" aria-label="Revision pages">
      <button type="button" disabled={busy||page.offset===0} onClick={()=>void run(()=>load(Math.max(0,page.offset-PAGE_SIZE)))}>Previous revisions</button>
      <span>Page {Math.floor(page.offset/PAGE_SIZE)+1} · {page.total} revisions</span>
      <button type="button" disabled={busy||page.offset+page.revisions.length>=page.total} onClick={()=>void run(()=>load(page.offset+PAGE_SIZE))}>Next revisions</button>
    </div>}
    <div className="tts-grid">{(["a","b"] as const).map(side=><Field key={side} label={`Revision ${side.toUpperCase()}`}><select disabled={busy} value={(side==="a"?a:b)?.id??""} onChange={event=>select(side,event.target.value)}><option value="">Choose revision</option>{choices.map(revision=><option key={revision.id} value={revision.id}>{label(revision)}</option>)}</select></Field>)}</div>
    <div className="tts-row">
      <button type="button" disabled={busy||!a} onClick={()=>void run(()=>view(false))}>View revision A</button>
      <button type="button" disabled={busy||!a||!b||a.id===b.id} onClick={()=>void run(()=>view(true))}>Compare revisions</button>
      <button type="button" disabled={busy||!a} onClick={()=>void run(async()=>{
        if(!a||!window.confirm("Replace the current project with this saved revision?"))return;
        const current=await save();if(!current||current.id!==projectId)throw new Error("Reopen the project before restoring a revision.");
        const restored=await runtime.execute("restoreRevision",{projectId,revisionId:a.id,expectedRevisionId:current.revisionId});await restore(restored);setA(null);setB(null);setSources(null);await load(0);
      })}>Restore revision A</button>
    </div>
    {sources&&<div className="tts-grid"><Field label="Revision A source"><textarea readOnly dir="auto" rows={8} value={sources.a.source}/></Field>{sources.b&&<Field label="Revision B source"><textarea readOnly dir="auto" rows={8} value={sources.b.source}/></Field>}</div>}
  </section>;
}
