import {useRef,useState} from "react";
import {planSpeechExportGroups,speechRenderSegment,type CompiledSpeech,type SpeechExportGroup,type SpeechExportGroupKind,type SpeechExportPreset,type SpeechProject,type SpeechRuntime,type SpeechTake} from "@machdoch/speech";
import {Field,type Run} from "./controls.tsx";

export function BatchExports({takes,compiled,settings,runtime,stored,ready,busy,run}:{takes:SpeechTake[];compiled:CompiledSpeech;settings:SpeechExportPreset;runtime:SpeechRuntime;stored():Promise<SpeechProject>;ready:boolean;busy:boolean;run:Run}){
  const [groupBy,setGroupBy]=useState<SpeechExportGroupKind>("chapter");
  const [directory,setDirectory]=useState("");
  const [overwrite,setOverwrite]=useState(false);
  const [plan,setPlan]=useState<SpeechExportGroup[]>([]);
  const [results,setResults]=useState<string[]>([]);
  const [exporting,setExporting]=useState(false);
  const stopped=useRef(false);
  async function prepare(current:SpeechProject):Promise<SpeechExportGroup[]>{
    if(!ready)throw new Error("Wait for the current script analysis before planning exports.");
    const groups=planSpeechExportGroups({project:current,takes,compiled,groupBy,settings,outputDirectory:directory,overwrite});
    if(groupBy==="speaker"){
      const selected=new Set(groups.flatMap(group=>group.request.clipIds?current.timeline.filter(clip=>group.request.clipIds!.includes(clip.id)).map(clip=>clip.takeId):group.request.takeIds));
      const segments=new Map(compiled.segments.map(segment=>[segment.id,segment]));
      for(const id of selected){
        const take=takes.find(take=>take.id===id)!;
        const request=await runtime.execute("takeRequest",{id});
        const expected=speechRenderSegment(segments.get(take.segmentId)!);
        for(const field of ["text","spokenText","voiceIds","referenceAssetIds","referenceGroups"] as const){
          if(JSON.stringify(request.segment[field]??null)!==JSON.stringify(expected[field]??null))throw new Error("A selected take has different voice provenance. Select a matching solo take before exporting speaker stems.");
        }
      }
    }
    return groups;
  }
  return <section className="tts-stack">
    <div className="tts-grid">
      <Field label="Group selected speech"><select value={groupBy} disabled={busy} onChange={event=>{setGroupBy(event.target.value as SpeechExportGroupKind);setPlan([]);}}><option value="chapter">Chapters</option><option value="scene">Scenes</option><option value="speaker">Speaker stems</option></select></Field>
      <Field label="Batch output directory"><input value={directory} disabled={busy} onChange={event=>{setDirectory(event.target.value);setPlan([]);}} /></Field>
    </div>
    <label className="tts-check"><input type="checkbox" checked={overwrite} disabled={busy} onChange={event=>{setOverwrite(event.target.checked);setPlan([]);}}/>Replace existing batch files</label>
    <button type="button" disabled={busy||!ready||!directory.trim()||settings.format==="archive"} onClick={()=>void run(async()=>{setResults([]);setPlan(await prepare(await stored()));})}>Preview batch files</button>
    {plan.length>0&&<>
      <p>These files contain selected speech. Background tracks are excluded.</p>
      <ol>{plan.map(item=><li key={item.id}>{item.title}<br/><code>{item.request.outputPath}</code></li>)}</ol>
      <button type="button" disabled={busy} onClick={()=>void run(async()=>{
        const current=await stored();
        const next=await prepare(current);
        const content=(items:SpeechExportGroup[])=>JSON.stringify(items.map(item=>{const {revisionId,...request}=item.request;return request;}));
        if(content(next)!==content(plan)){setPlan(next);throw new Error("The batch changed. Review the updated files before exporting.");}
        stopped.current=false;setExporting(true);setResults([]);
        try{for(const item of next){if(stopped.current)break;const result=await runtime.execute("export",item.request);setResults(items=>[...items,result.path]);}}
        finally{setExporting(false);}
      })}>Export batch files</button>
    </>}
    {exporting&&<button type="button" onClick={()=>{stopped.current=true;}}>Stop after current file</button>}
    {results.length>0&&<output aria-live="polite">{results.length} of {plan.length} files exported</output>}
  </section>;
}
