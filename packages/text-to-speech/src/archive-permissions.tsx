import {useEffect,useRef,useState} from "react";
import {archiveReferencePermission,type SpeechArchiveReferences,type SpeechProject,type SpeechRuntime} from "@machdoch/speech";
import {Field} from "./controls.tsx";

export function useArchivePermissions(runtime:SpeechRuntime,projectId:string){
  const [inventory,setInventory]=useState<SpeechArchiveReferences|null>(null);
  const [approved,setApproved]=useState(false),[evidence,setEvidence]=useState("");
  const version=useRef(0);
  useEffect(()=>{version.current++;setInventory(null);setApproved(false);setEvidence("");return()=>{version.current++;};},[runtime,projectId]);
  const authorize=async(project:SpeechProject)=>{
    const expected=version.current;
    const next=await runtime.execute("archiveReferences",{projectId:project.id,revisionId:project.revisionId});
    if(expected!==version.current)throw new Error("The active project changed. Export the open project again.");
    if(next.projectId!==project.id||next.revisionId!==project.revisionId)throw new Error("The archive reference inventory differs from the saved revision.");
    if(!inventory||inventory.inventorySha256!==next.inventorySha256){
      setInventory(next);setApproved(false);setEvidence("");
      return archiveReferencePermission(next,false,"");
    }
    return archiveReferencePermission(next,approved,evidence);
  };
  return {inventory,approved,evidence,setApproved,setEvidence,authorize};
}

export function ArchivePermissions({inventory,approved,evidence,setApproved,setEvidence}:{inventory:SpeechArchiveReferences|null;approved:boolean;evidence:string;setApproved(value:boolean):void;setEvidence(value:string):void}){
  if(!inventory?.references.length)return null;
  return <fieldset className="tts-stack"><legend>Reference recordings</legend>
    <ul>{inventory.references.map(reference=><li key={reference.assetId}><details><summary>{reference.transcriptPreview??reference.assetId}</summary><code>{reference.assetId}</code>{reference.original&&<p>Original recording</p>}{reference.rightsEvidence&&<p>Recorded permission: {reference.rightsEvidence}</p>}</details></li>)}</ul>
    <label className="tts-check"><input type="checkbox" checked={approved} onChange={event=>setApproved(event.target.checked)}/>I have permission to include these recordings in the archive</label>
    <Field label="Redistribution permission"><textarea value={evidence} onChange={event=>setEvidence(event.target.value)} required rows={3}/></Field>
  </fieldset>;
}
