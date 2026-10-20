import {useEffect,useRef,useState} from "react";
import type {SpeechDiagnostics,SpeechRuntime} from "@machdoch/speech";
import type {Run} from "./controls.tsx";

export function SpeechDiagnosticsPanel({runtime,busy,run}:{runtime:SpeechRuntime;busy:boolean;run:Run}){
  const [preview,setPreview]=useState<{bundle:SpeechDiagnostics;url:string}|null>(null);
  const request=useRef(0);
  useEffect(()=>{++request.current;setPreview(null);return()=>{++request.current;};},[runtime]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  return <details><summary>Diagnostics</summary>
    <button type="button" disabled={busy} onClick={()=>void run(async()=>{
      const expected=++request.current;
      const bundle=await runtime.execute("getDiagnostics",{limit:100});
      if(expected!==request.current)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:"application/json"}));
      setPreview({bundle,url});
    })}>Prepare diagnostics</button>
    {preview&&<><pre aria-label="Diagnostic preview">{JSON.stringify(preview.bundle,null,2)}</pre><a href={preview.url} download={`machdoch-speech-diagnostics-${preview.bundle.createdAt.slice(0,10)}.json`}>Save diagnostics</a></>}
  </details>;
}
