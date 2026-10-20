import {compileSpeechScript,speechRenderSegment,type SpeechCompileOptions} from "./compiler.ts";
import {importDialogue,importSpeechDocument,parseDialogueTable,type DialogueMapping} from "./imports.ts";
import {estimateSpeechRender,type SpeechRenderEstimate} from "./pricing.ts";
import {validateSpeechCastStructure} from "./scene-casting.ts";
import type {SpeechCastMember,SpeechProfile,SpeechProject,SpeechRenderSegment,SpeechRuntime,SpeechSettings} from "./runtime.ts";

export interface SpeechBatchFile{id:string;name:string;source:string;format:"text"|"markdown"|"csv"|"tsv"}
export interface SpeechBatchMapping{header:boolean;textColumn:number;speakerColumn:number}
export interface SpeechBatchItem{id:string;name:string;source:string;segments:SpeechRenderSegment[];errors:string[];speakers:string[];columns:string[];estimate:SpeechRenderEstimate|null}
export interface SpeechBatchPreparation{items:SpeechBatchItem[];estimate:SpeechRenderEstimate|null}
export interface SpeechBatchReceipt{id:string;items:Array<{id:string;name:string;state:"pending"|"saving"|"saved"|"queuing"|"queued"|"failed";projectId:string;jobId:string|null;error:string|null}>;stopped:boolean}

export function prepareSpeechBatch(files:readonly SpeechBatchFile[],options:{compile:SpeechCompileOptions;profile:SpeechProfile;pricing:SpeechSettings["pricing"];takes:number;cast:SpeechCastMember[];stripMetadata:boolean;mappings:Record<string,SpeechBatchMapping>;bindings:DialogueMapping["castBindings"]}):SpeechBatchPreparation{
  if(files.length<1||files.length>32||new Set(files.map(file=>file.id)).size!==files.length)throw new Error("Choose 1 to 32 distinct script files for this batch.");
  const encoder=new TextEncoder();let bytes=0;
  for(const file of files){const size=encoder.encode(file.source).length;bytes+=size;if(!file.id||!file.name.trim()||file.name.length>4096||size>4*1024*1024||bytes>16*1024*1024)throw new Error("Keep each script within 4 MiB and this batch within 16 MiB.");}
  const items=files.map((file):SpeechBatchItem=>{
    let source=file.source;const errors:string[]=[];let speakers:string[]=[];let columns:string[]=[];
    try{
      if(file.format==="csv"||file.format==="tsv"){
        const mapping=options.mappings[file.id];if(!mapping)throw new Error("Choose the dialogue columns for this file.");
        const table=parseDialogueTable(source,file.format==="csv"?",":"\t");if(table.rows.length>10001||table.rows.some(row=>row.length>256))throw new Error("Keep dialogue files within 10,000 rows and 256 columns.");
        columns=(table.rows[0]??[]).map((value,index)=>mapping.header?value.slice(0,200):String(index+1));
        const rows=table.rows.slice(mapping.header?1:0);speakers=[...new Set(rows.flatMap(row=>typeof row[mapping.speakerColumn]==="string"?[row[mapping.speakerColumn]!]:[]))];
        if(speakers.length>256)throw new Error("Map no more than 256 distinct speaker names in one file.");
        const imported=importDialogue(rows,{textColumn:mapping.textColumn,speakerColumn:mapping.speakerColumn,castBindings:Object.fromEntries(Object.entries(options.bindings).filter(([,id])=>options.cast.some(member=>member.id===id)))});
        source=imported.source;errors.push(...table.diagnostics.map(item=>item.message),...imported.diagnostics.map(item=>item.message));
      }else if(file.format==="text"||file.format==="markdown"){
        const imported=importSpeechDocument(source,{format:file.format,stripStructuralMetadata:options.stripMetadata});source=imported.source;errors.push(...imported.diagnostics.map(item=>item.message));
      }else throw new Error("Choose text, Markdown, CSV or TSV scripts.");
      if(errors.length)return {id:file.id,name:file.name,source,segments:[],errors:errors.slice(0,100),speakers,columns,estimate:null};
      if(encoder.encode(source).length>4*1024*1024)throw new Error("Keep the resolved script within the local 4 MiB project limit.");
      validateSpeechCastStructure({source,cast:options.cast});
      const compiled=compileSpeechScript(source,options.compile);errors.push(...compiled.diagnostics.filter(item=>item.severity==="error").map(item=>item.message));
      if(!compiled.segments.length)errors.push("Include spoken text in this script.");
      const segments=errors.length?[]:compiled.segments.map(speechRenderSegment);
      if(segments.length*options.takes>10000)throw new Error("Keep each script within the local 10,000-take job guard.");
      return {id:file.id,name:file.name,source,segments,errors:errors.slice(0,100),speakers,columns,estimate:errors.length?null:estimateSpeechRender(segments.map(segment=>segment.text),options.profile,options.takes,options.pricing)};
    }catch(failure){errors.push(failure instanceof Error?failure.message:String(failure));return {id:file.id,name:file.name,source,segments:[],errors:errors.slice(0,100),speakers,columns,estimate:null};}
  });
  return {items,estimate:items.some(item=>item.errors.length)?null:estimateSpeechRender(items.flatMap(item=>item.segments.map(segment=>segment.text)),options.profile,options.takes,options.pricing)};
}

export async function submitSpeechBatch(runtime:SpeechRuntime,prepared:SpeechBatchPreparation,options:{id:string;profile:SpeechProfile;cast:SpeechCastMember[];takes:number;cloudConsent:boolean;budgetLimit:number|null;dictionaryRevisions:Array<{id:string;revision:string}>;signal:AbortSignal;onProgress(receipt:SpeechBatchReceipt):void}):Promise<SpeechBatchReceipt>{
  if(!prepared.items.length||prepared.items.some(item=>item.errors.length||!item.segments.length)||!prepared.estimate)throw new Error("Review every script and resolve its errors before rendering this batch.");
  if(!options.id||!Number.isSafeInteger(options.takes)||options.takes<1||options.takes>32)throw new Error("Choose a batch identity and 1 to 32 takes.");
  if(options.budgetLimit!==null&&(!Number.isFinite(options.budgetLimit)||options.budgetLimit<0||prepared.estimate.amount===null||prepared.estimate.amount>options.budgetLimit))throw new Error("Verify an account rate and keep the complete batch estimate within its spending limit.");
  if(!["sglang","drama3"].includes(options.profile.backend)&&!options.cloudConsent)throw new Error("Allow these scripts and references in the selected cloud provider before rendering.");
  const receipt:SpeechBatchReceipt={id:options.id,items:prepared.items.map(item=>({id:item.id,name:item.name,state:"pending",projectId:crypto.randomUUID(),jobId:null,error:null})),stopped:false};
  const progress=()=>options.onProgress(structuredClone(receipt));progress();
  for(const [index,item] of prepared.items.entries()){
    if(options.signal.aborted){receipt.stopped=true;break;}
    const record=receipt.items[index]!;
    try{
      const now=new Date().toISOString();const project:SpeechProject={id:record.projectId,title:item.name.replace(/\.(?:txt|md|markdown|csv|tsv)$/iu,""),source:item.source,cast:structuredClone(options.cast),profileId:options.profile.id,revisionId:"",parentRevisionId:null,createdAt:now,updatedAt:now,archived:false,location:null,timeline:[],selectedTakes:{},bookmarks:[],variants:[]};
      record.state="saving";progress();const saved=await runtime.execute("saveProject",{project,expectedRevisionId:null});record.state="saved";progress();
      if(options.signal.aborted){receipt.stopped=true;break;}
      record.state="queuing";progress();
      const job=await runtime.execute("render",{owner:`text-to-speech:batch:${options.id}`,projectId:saved.id,revisionId:saved.revisionId,profileId:options.profile.id,expectedProfile:options.profile,segments:item.segments,takes:options.takes,priority:0,reuseCache:false,cloudConsent:options.cloudConsent,budgetLimit:options.budgetLimit===null?null:item.estimate!.amount,dictionaryRevisions:options.dictionaryRevisions});
      record.jobId=job.id;record.state="queued";progress();
    }catch(failure){record.state="failed";record.error=failure instanceof Error?failure.message:String(failure);receipt.stopped=true;break;}
  }
  progress();return receipt;
}
