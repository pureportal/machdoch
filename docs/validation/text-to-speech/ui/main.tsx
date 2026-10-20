import { createRoot } from "react-dom/client";
import { TextToSpeechStudio } from "@machdoch/text-to-speech";
import {speechCastBindings,compileSpeechScript,speechRenderSegment,speechPlayback,performanceDirection,type SpeechOperations,type SpeechProfile,type SpeechProject,type SpeechRevision,type SpeechRuntime,type SpeechSettings,type SpeechTake,type SpeechProjectTemplate,type SpeechTimingResult,type SpeechJob,type SpeechTakeRequest} from "@machdoch/speech";

import {speechDrafts} from "../../../../packages/text-to-speech/src/drafts.ts";
const draftWrites:Array<{length:number;tail:string}>=[];let completedDraftWrites=0;
let draftGate:{promise:Promise<void>;release():void}|null=null;
const originalDraftSave=speechDrafts.save;
speechDrafts.save=async draft=>{draftWrites.push({length:draft.project.source.length,tail:draft.project.source.slice(-100)});if(draftGate)await draftGate.promise;await originalDraftSave(draft);completedDraftWrites++;};
function holdDrafts(){draftWrites.length=0;completedDraftWrites=0;let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});draftGate={promise,release};}
function releaseDrafts(){const pending=draftGate;draftGate=null;pending?.release();}

const profiles: SpeechProfile[] = JSON.parse(localStorage.getItem("speech-fixture-profiles")??"null")??[{ id:"fixture-fish",name:"Fish Drama 3",backend:"fish-cloud",model:"drama-3",voiceId:"fixture-voice",direction:"",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1 }];
const settings:SpeechSettings = JSON.parse(localStorage.getItem("speech-fixture-settings")??"null")??{connections:[{backend:"fish-cloud",configured:true,healthy:true,error:null,runtimeVersion:null,model:"drama-3",nativeRevision:false,maxTextBytes:null,maxSpeakers:null}],modelRoot:"D:\\Models\\machdoch",cloudConsent:true,maxConcurrent:1,pricing:null,budgetLimit:null,answerBudgetLimit:null,answerCharacterLimit:10000,cacheRetentionDays:7};
const calls:Array<{operation:string;input:unknown}>=[];
let projects:SpeechProject[]=JSON.parse(localStorage.getItem("speech-fixture-projects")??"[]");
const revisions:Record<string,Array<SpeechRevision&{snapshot:SpeechProject}>>={};
let revision=Math.max(0,...projects.map(project=>Number(/^revision-(\d+)$/u.exec(project.revisionId)?.[1]??0)));
let queuePaused=false;
const uploads=new Map<string,{metadata:Record<string,unknown>;bytes:Uint8Array;offset:number}>();
const references:SpeechOperations["listReferences"]["output"]["references"]=JSON.parse(localStorage.getItem("speech-fixture-references")??"[]");
const takes:SpeechTake[]=JSON.parse(localStorage.getItem("speech-fixture-takes")??"[]");
const timingResults:SpeechTimingResult[]=JSON.parse(localStorage.getItem("speech-fixture-timings")??"[]");
const jobs:SpeechJob[]=JSON.parse(localStorage.getItem("speech-fixture-rehearsal-jobs")??"[]");
const dictionaries:SpeechOperations["listDictionaries"]["output"]=JSON.parse(localStorage.getItem("speech-fixture-dictionaries")??"[]");
const dictionaryHistory:SpeechOperations["dictionaryRevisions"]["output"]["revisions"]=JSON.parse(localStorage.getItem("speech-fixture-dictionary-history")??"[]");
const takeRequests=new Map<string,SpeechTakeRequest>(JSON.parse(localStorage.getItem("speech-fixture-requests")??"[]"));
const libraryVoices:SpeechOperations["listVoices"]["output"]["voices"]=Array.from({length:21},(_,index)=>({id:`fixture-voice-${index+1}`,name:`Comparison voice ${index+1}`,author:"Synthetic fixture",languages:["en","de"],visibility:"public",previewUrl:null,rights:"Synthetic test data",favorite:false}));
const deletionVoices:SpeechOperations["getVoice"]["output"][]=JSON.parse(localStorage.getItem("speech-fixture-deletion-voices")??"[]");libraryVoices.push(...deletionVoices);
const voiceMutations:SpeechOperations["deleteVoice"]["output"][]=JSON.parse(localStorage.getItem("speech-fixture-voice-mutations")??"[]");
let failNextDeletion=false;
let failNextUpdate=false;
function prepareDeletionVoice(){const voice={id:"deletion-voice",name:"Deletion voice",author:"Synthetic fixture",languages:["de"],visibility:"private",previewUrl:null,rights:null,favorite:false};if(!libraryVoices.some(item=>item.id===voice.id)){libraryVoices.push(voice);deletionVoices.push(voice);localStorage.setItem("speech-fixture-deletion-voices",JSON.stringify(deletionVoices));}failNextDeletion=true;return voice.id;}
const favoriteVoiceIds=new Set<string>(JSON.parse(localStorage.getItem("speech-fixture-favorite-voice-ids")??"[]"));
const favoriteVoiceCache=new Map<string,SpeechOperations["getVoice"]["output"]>(JSON.parse(localStorage.getItem("speech-fixture-voice-cache")??"[]"));
function persistFavoriteVoices(){localStorage.setItem("speech-fixture-favorite-voice-ids",JSON.stringify([...favoriteVoiceIds]));localStorage.setItem("speech-fixture-voice-cache",JSON.stringify([...favoriteVoiceCache]));}
const voiceInputs=new Map<string,SpeechOperations["designVoice"]["input"]|SpeechOperations["createVoice"]["input"]>(JSON.parse(localStorage.getItem("speech-fixture-voice-inputs")??"[]"));
const voiceResults:SpeechOperations["getVoiceWorkflow"]["output"][]=JSON.parse(localStorage.getItem("speech-fixture-voice-results")??"[]");
let templates:SpeechProjectTemplate[]=JSON.parse(localStorage.getItem("speech-fixture-templates")??"[]");
const importedAssets=new Map<string,SpeechOperations["asset"]["output"]>();
function syntheticAsset(duration:number,identity?:string){
  const rate=24000,frames=Math.round(duration*rate),bytes=new Uint8Array(44+frames*2),view=new DataView(bytes.buffer);
  const text=(offset:number,text:string)=>{for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);};
  text(0,"RIFF");view.setUint32(4,bytes.length-8,true);text(8,"WAVEfmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,"data");view.setUint32(40,frames*2,true);
  for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.sin(i*Math.PI*2*440/rate)*1000,true);
  const id=identity??crypto.randomUUID().replaceAll("-","").repeat(2);
  const asset={id,sha256:id,mimeType:"audio/wav",bytes:bytes.length,duration,sampleRate:rate,channels:1,path:URL.createObjectURL(new Blob([bytes],{type:"audio/wav"}))};importedAssets.set(id,asset);return asset;
}
function persistAuditions(){
  localStorage.setItem("speech-fixture-takes",JSON.stringify(takes));localStorage.setItem("speech-fixture-requests",JSON.stringify([...takeRequests]));
  localStorage.setItem("speech-fixture-rehearsal-jobs",JSON.stringify(jobs.filter(job=>job.revisionId.startsWith("rehearsal-")||job.revisionId.startsWith("comparison-")||job.kind==="voice-design"||job.kind==="voice-creation")));
}
for(const take of takes)take.asset=syntheticAsset(take.asset.duration,take.asset.id);
for(const reference of references)reference.asset=syntheticAsset(reference.asset.duration,reference.asset.id);
for(const result of voiceResults){for(const candidate of result.candidates)candidate.asset=syntheticAsset(candidate.asset.duration,candidate.asset.id);if(result.voice)libraryVoices.push(result.voice);}
function completeVoiceWorkflow(id:string){
  const job=jobs.find(job=>job.id===id);const request=voiceInputs.get(id);if(!job||!request)throw new Error("Unknown synthetic voice workflow");
  const result:SpeechOperations["getVoiceWorkflow"]["output"]={jobId:id,kind:job.kind as "voice-design"|"voice-creation",createdAt:new Date().toISOString(),candidates:[],voice:null};
  if(job.kind==="voice-design"){
    const input=request as SpeechOperations["designVoice"]["input"];
    result.candidates=Array.from({length:2},(_,index)=>({id:`candidate-${id}-${index}`,asset:syntheticAsset(3),previewText:input.text,metadata:{...(index===0?{text:input.text,voice_design_signature:`synthetic-signature-${index}`}:{}) ,instruct:input.description,sample_rate:24000,duration_ms:3000}}));
  }else{
    const input=request as SpeechOperations["createVoice"]["input"];
    result.voice={id:`created-${id}`,name:input.name,author:"Synthetic fixture",languages:["de"],visibility:"private",previewUrl:null,rights:null,favorite:false};libraryVoices.push(result.voice);
  }
  voiceResults.push(result);job.state="completed";job.completedSegments=1;job.updatedAt=result.createdAt;persistAuditions();localStorage.setItem("speech-fixture-voice-results",JSON.stringify(voiceResults));
}
function prepareProviderResponses(){
  const project=projects[0];if(!project)throw new Error("Create a fixture project first");const now=new Date().toISOString();
  const responses:SpeechTake["providerResponse"][]=[{provider:"google",modelVersion:"gemini-3.1-flash-tts-preview-fixture",responseId:"google-fixture-response",usageMetadata:{promptTokenCount:3,candidatesTokenCount:0,totalTokenCount:3}},{provider:"openai",requestId:"req-fixture",processingMs:12.5}];
  for(const response of responses){if(!response)continue;const id=`provider-${response.provider}`;takes.push({id,projectId:project.id,revisionId:project.revisionId,segmentId:id,spokenText:"Synthetic provider metadata fixture.",chapter:null,asset:syntheticAsset(1),createdAt:now,generatedAt:now,reusedFromTakeId:null,backend:response.provider,model:response.provider==="google"?"gemini-3.1-flash-tts-preview":"gpt-4o-mini-tts",requestHash:"a".repeat(64),parentTakeId:null,favorite:false,rating:null,note:"",alignment:[],providerResponse:response});}
  const previous=takes.at(-1)!;takes.push({...previous,id:"voice-source",backend:"fish-cloud",model:"drama-3",providerResponse:undefined,voiceObservations:[{id:"observed-voice",name:"Observed voice",author:"Original author",languages:["de"],visibility:"private",rights:null,evidence:{provider:"fish-cloud",url:"https://api.fish.audio/model/observed-voice",observedAt:now,responseSha256:"b".repeat(64),authorId:"author-id",source:"voice_design",providerCreatedAt:null,providerUpdatedAt:null}}]});
  persistAuditions();
}
function prepareProfileReferences(){
  const added=Array.from({length:2},(_,index)=>({asset:syntheticAsset(2),transcript:`Default reference ${index+1}`,rightsEvidence:"Synthetic fixture permission"}));references.push(...added);localStorage.setItem("speech-fixture-references",JSON.stringify(references));return added.map(reference=>reference.asset.id);
}
async function prepareArchiveReferences(){
  const current=projects[0];if(!current)throw new Error("Create a fixture project first");const ids=prepareProfileReferences();
  return runtime.execute("saveProject",{expectedRevisionId:current.revisionId,project:{...current,cast:[{id:"narrator",name:"Narrator",referenceAssetIds:ids,direction:"",rightsEvidence:"Cloning permission only"}]}});
}
async function prepareProductionHistory(){
  const current=projects[0];if(!current)throw new Error("Create a fixture project first");
  const project=await runtime.execute("saveProject",{project:{...current,source:"# Chapter\nHello from the selected production take.",cast:[{id:"narrator",name:"Narrator",voiceId:"fixture-narrator",referenceAssetIds:[],direction:""}]},expectedRevisionId:current.revisionId});
  const segment=compileSpeechScript(project.source,{cast:speechCastBindings(project.cast,id=>id)}).segments[0];if(!segment)throw new Error("Synthetic production segment missing");
  const now=Date.now();const asset=syntheticAsset(10);
  for(let index=0;index<43;index++){
    const id=`history-take-${String(index).padStart(3,"0")}`,createdAt=new Date(now+(43-index)*1000).toISOString();
    takes.push({id,projectId:project.id,revisionId:project.revisionId,segmentId:segment.id,spokenText:segment.spokenText,chapter:segment.chapter,asset,createdAt,generatedAt:createdAt,reusedFromTakeId:null,backend:"fish-cloud",model:"drama-3",requestHash:"a".repeat(64),parentTakeId:null,favorite:false,rating:null,note:"",alignment:[]});
    jobs.push({id:`history-job-${String(index).padStart(3,"0")}`,owner:"text-to-speech",projectId:project.id,revisionId:project.revisionId,state:"completed",completedSegments:1,totalSegments:1,takeIds:[id],error:null,createdAt,updatedAt:createdAt,priority:0,attempt:0,parentJobId:null});
  }
  const old=takes.at(-1)!;
  const selected=await runtime.execute("saveProject",{project:{...project,selectedTakes:{[segment.id]:old.id},timeline:[{id:"old-production-clip",takeId:old.id,start:0,in:0,out:10,gain:1,fadeIn:0,fadeOut:0,track:0}]},expectedRevisionId:project.revisionId});
  const oldTime=new Date(now-1000).toISOString();jobs.push({id:"old-active-job",owner:"text-to-speech",projectId:project.id,revisionId:project.revisionId,state:"queued",completedSegments:0,totalSegments:1,takeIds:[],error:null,createdAt:oldTime,updatedAt:oldTime,priority:0,attempt:0,parentJobId:null});
  persistAuditions();return {projectId:selected.id,oldTakeId:old.id};
}
async function prepareHistoryPages(){
  let current=projects[0];if(!current)throw new Error("Create a fixture project first");
  for(let index=0;index<43;index++){current=await runtime.execute("saveProject",{project:{...current,source:`Revision ${index}. Grüß dich 世界.\n`+"Saved source text. ".repeat(100)},expectedRevisionId:current.revisionId});}
  const history=revisions[current.id]!;const oldest=history[1]!;const now=Date.now();
  const added=Array.from({length:45},(_,index)=>({...structuredClone(current),id:`synthetic-project-${index}`,title:`Project ${String(index).padStart(2,"0")}`,source:`Project source 世界 · searchable-token-${index}`,revisionId:`synthetic-revision-${index}`,parentRevisionId:null,archived:index>=40,updatedAt:new Date(now+1000*(index+1)).toISOString()}));
  projects=[...added,...projects];localStorage.setItem("speech-fixture-projects",JSON.stringify(projects));
  return {projectId:current.id,oldestId:oldest.id,oldestSource:oldest.source,currentId:current.revisionId,currentSource:current.source};
}
function prepareReading(){
  const project=projects[0]!;const previous=takes[0];if(!previous)throw new Error("Create the synthetic take fixture before preparing reading.");
  const compiled=compileSpeechScript(project.source,{cast:speechCastBindings(project.cast,id=>id)});
  project.selectedTakes={};
  compiled.segments.forEach((segment,index)=>{
    const take:SpeechTake={...previous,id:`reading-${index}`,segmentId:segment.id,spokenText:segment.spokenText,chapter:segment.chapter,asset:syntheticAsset(10,"4".repeat(64)),alignment:[{text:segment.spokenText,start:0.2,end:1}],projectId:project.id,revisionId:project.revisionId};
    takes.push(take);project.selectedTakes[segment.id]=take.id;
  });
  localStorage.setItem("speech-fixture-takes",JSON.stringify(takes));localStorage.setItem("speech-fixture-projects",JSON.stringify(projects));
}
let corruptAnalysis=false;
let renderTargetsEnabled=false;
let analysisGate:{promise:Promise<void>;release():void}|null=null;
const holdAnalysis=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});analysisGate={promise,release};};
const releaseAnalysis=()=>{const pending=analysisGate;analysisGate=null;pending?.release();};
let recordedBytes:number[]=[];
Object.assign(window,{speechFixture:{calls,takes,jobs,dictionaries,draftWrites,holdDrafts,releaseDrafts,get completedDraftWrites(){return completedDraftWrites;},dictionaryHistory,prepareReading,prepareProviderResponses,prepareProfileReferences,prepareArchiveReferences,prepareHistoryPages,prepareProductionHistory,prepareDeletionVoice,failVoiceUpdate:()=>{failNextUpdate=true;},clearVoiceCatalog:()=>{libraryVoices.splice(0);},completeVoiceWorkflow,holdAnalysis,releaseAnalysis,enableRenderTargets:()=>{renderTargetsEnabled=true;},corruptAnalysis:()=>{corruptAnalysis=true;},get projects(){return projects;},get templates(){return templates;},get playback(){return speechPlayback.snapshot();},get recordedBytes(){return recordedBytes;}}});

const runtime:SpeechRuntime={transport:"native",async execute<K extends keyof SpeechOperations>(operation:K,input:SpeechOperations[K]["input"]):Promise<SpeechOperations[K]["output"]>{
  calls.push({operation,input:structuredClone(input)});
  let result:unknown;
  const values=input as Record<string,unknown>;
  switch(operation){
    case "align":{
      const request=input as SpeechOperations["align"]["input"];
      if(!request.cloudConsent||request.provider!=="openai"||request.model!=="whisper-1")throw new Error("Confirm the explicit synthetic transcription request.");
      const take=takes.find(take=>take.id===request.takeId);if(!take)throw new Error("Unknown timing fixture take");
      const now=new Date().toISOString(),id=crypto.randomUUID(),jobId=crypto.randomUUID();
      const record:SpeechTimingResult={id,takeId:take.id,assetId:take.asset.id,assetSha256:take.asset.sha256,provider:"openai",model:"whisper-1",languageHint:request.language,transcript:"Measured repeated repeated words.",words:[{text:"Measured",start:1.25,end:1.6},{text:"repeated",start:1.7,end:2},{text:"repeated",start:2.1,end:2.4},{text:"words.",start:2.5,end:3}],createdAt:now,measuredAt:now,jobId,requestHash:"8".repeat(64),reusedFromTimingId:null,pricing:request.pricing,estimatedCost:null,provenance:{encoderSha256:"f".repeat(64),sourceDuration:take.asset.duration,admittedAt:now,sampleRate:16000,channels:1,pipeline:1,chunks:[]}};
      timingResults.push(record);localStorage.setItem("speech-fixture-timings",JSON.stringify(timingResults));
      const job:SpeechJob={id:jobId,kind:"alignment",timingId:id,owner:request.owner,projectId:take.projectId,revisionId:take.revisionId,state:"completed",completedSegments:1,totalSegments:1,takeIds:[take.id],error:null,createdAt:now,updatedAt:now,priority:50,attempt:1,parentJobId:null};jobs.push(job);result=job;break;
    }
    case "designVoice":case "createVoice":{
      const request=input as SpeechOperations["designVoice"]["input"]|SpeechOperations["createVoice"]["input"];
      if(!request.cloudConsent)throw new Error("Explicit voice workflow consent is required");
      if(operation==="createVoice"&&!(request as SpeechOperations["createVoice"]["input"]).permissionConfirmed)throw new Error("Permission is required");
      const now=new Date().toISOString(),id=crypto.randomUUID(),kind=operation==="designVoice"?"voice-design":"voice-creation";
      const job:SpeechJob={id,owner:request.owner,projectId:null,revisionId:`${kind}-${id}`,kind,state:"queued",completedSegments:0,totalSegments:1,takeIds:[],error:null,createdAt:now,updatedAt:now,priority:50,attempt:1,parentJobId:null};jobs.push(job);voiceInputs.set(id,structuredClone(request));persistAuditions();localStorage.setItem("speech-fixture-voice-inputs",JSON.stringify([...voiceInputs]));result=job;break;
    }
    case "getVoiceWorkflow":{const job=jobs.find(job=>job.id===values.jobId&&job.owner===values.owner);result=job?voiceResults.find(result=>result.jobId===job.id):undefined;if(!result)throw new Error("Unknown owned synthetic voice result");break;}
    case "recordPlaybackMetrics":result=null;break;
    case "getDiagnostics":result={schema:"machdoch-speech-diagnostics",version:1,createdAt:new Date().toISOString(),applicationVersion:"fixture",platform:{os:"windows",architecture:"fixture"},settings:{cloudConsent:settings.cloudConsent,maxConcurrent:settings.maxConcurrent,answerCharacterLimit:settings.answerCharacterLimit,cacheRetentionDays:settings.cacheRetentionDays},connections:settings.connections.map(connection=>({backend:connection.backend,model:connection.model,configured:connection.configured,healthy:connection.healthy,runtimePinned:!!connection.runtimeVersion,nativeRevision:connection.nativeRevision})),jobs:[],playbackPerformance:{scope:"browser-runtime",sampleCount:0,oldestRecordedAt:null,newestRecordedAt:null,groups:[]}};break;
    case "retainPlayback":result={id:values.id,expiresAt:new Date(Date.now()+600_000).toISOString()};break;
    case "releasePlayback":result=undefined;break;
    case "archiveReferences":{
      const project=projects.find(project=>project.id===values.projectId&&project.revisionId===values.revisionId);if(!project)throw new Error("Unknown saved archive revision");
      const ids=[...new Set(project.cast.flatMap(member=>[...member.referenceAssetIds,...(member.sceneOverrides??[]).flatMap(binding=>binding.referenceAssetIds)]))].sort();
      const inventory={projectId:project.id,revisionId:project.revisionId,references:ids.map(id=>{const reference=references.find(reference=>reference.asset.id===id);if(!reference)throw new Error("Missing synthetic archive reference");return {assetId:id,bytes:reference.asset.bytes,transcriptPreview:reference.transcript.slice(0,120),rightsEvidence:reference.rightsEvidence,original:false};})};
      const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({projectId:inventory.projectId,references:inventory.references})));result={...inventory,inventorySha256:Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("")};break;
    }
    case "getTiming":result=timingResults.find(item=>item.id===values.id);if(!result)throw new Error("Unknown timing fixture result");break;
    case "listTimings":result=timingResults.filter(item=>item.takeId===values.takeId);break;
    case "resolveTimings":{
      result=Object.entries(values.selections as Record<string,string>).map(([takeId,id])=>{const take=takes.find(item=>item.id===takeId&&item.projectId===values.projectId);const record=timingResults.find(item=>item.id===id&&item.takeId===takeId);if(!take||!record)throw new Error("Timing fixture source mismatch");return record;});break;
    }
    case "listJobs":{const matching=jobs.filter(item=>(!values.projectId||item.projectId===values.projectId)&&(!values.owner||item.owner===values.owner)&&(!values.id||item.id===values.id)&&(!values.kinds||(values.kinds as string[]).includes(item.kind??""))&&(!values.states||(values.states as string[]).includes(item.state))).toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));const start=Number(values.offset??0);result=matching.slice(start,values.limit===undefined?undefined:start+Number(values.limit));break;}
    case "takeProvenance":{
      const request=takeRequests.get(String(values.id));if(!request)throw new Error("Unknown pinned audition fixture request");
      result={segment:request.segment,profile:request.profile,dictionaries:request.dictionaries.map(({id,name,revision})=>({id,name,revision})),referenceHashes:Object.fromEntries(Object.entries(request.references).map(([id,reference])=>[id,reference.sha256])),connection:request.connection,...(request.performanceNote?{performanceNote:request.performanceNote}:{})};break;
    }
    case "updateTake":{const take=takes.find(take=>take.id===values.id);if(!take)throw new Error("Unknown fixture take");for(const key of ["favorite","rating","note"] as const)if(values[key]!==undefined)Object.assign(take,{[key]:values[key]});persistAuditions();result=take;break;}
    case "takeRequest":{
      if(takeRequests.has(String(values.id))){result=takeRequests.get(String(values.id));break;}
      const take=takes.find(take=>take.id===values.id);if(!take)throw new Error("Unknown fixture take");
      const project=projects.find(project=>project.id===take.projectId)!;
      const compiled=compileSpeechScript(project.source,{cast:speechCastBindings(project.cast,id=>id)});
      const segment=compiled.segments.find(segment=>segment.id===take.segmentId);if(!segment)throw new Error("The fixture take has no current script provenance");
      const request:SpeechTakeRequest={segment:speechRenderSegment(segment),profile:structuredClone(profiles[0]!),dictionaries:[],references:{},connection:{backend:take.backend,model:take.model,url:null,runtimeVersion:null}};
      takeRequests.set(take.id,request);result=request;break;
    }
    case "regenerate":{
      const request=input as SpeechOperations["regenerate"]["input"],source=takes.find(item=>item.id===request.takeId),original=takeRequests.get(request.takeId);
      if(!source||!original||!request.cloudConsent)throw new Error("Load and explicitly request the synthetic source performance.");
      const now=new Date().toISOString(),ids:string[]=[];
      for(let index=0;index<request.takes;index++){
        const take:SpeechTake={...structuredClone(source),id:crypto.randomUUID(),parentTakeId:source.id,requestHash:"c".repeat(64),createdAt:now,generatedAt:now,favorite:false,rating:null,note:"",alignment:[]};
        takes.push(take);ids.push(take.id);
        takeRequests.set(take.id,{...structuredClone(original),profile:{...original.profile,direction:performanceDirection(original.profile.direction,request.note)},performanceNote:request.note});
      }
      localStorage.setItem("speech-fixture-takes",JSON.stringify(takes));localStorage.setItem("speech-fixture-requests",JSON.stringify([...takeRequests]));
      const job:SpeechJob={id:crypto.randomUUID(),owner:request.owner,projectId:source.projectId,revisionId:source.revisionId,state:"completed",completedSegments:request.takes,totalSegments:request.takes,takeIds:ids,error:null,createdAt:now,updatedAt:now,priority:50,attempt:1,parentJobId:null};jobs.push(job);result=job;break;
    }
    case "export":result={path:String(values.outputPath),sha256:"7".repeat(64),bytes:48044};break;
    case "analyzeAudio":{
      if(analysisGate)await analysisGate.promise;
      const asset=importedAssets.get(String(values.assetId));if(!asset)throw new Error("Unknown analysis fixture asset");
      const frames=Math.round(asset.duration*asset.sampleRate);
      result={duration:asset.duration,frames,sampleRate:asset.sampleRate,channels:asset.channels,sampleCount:frames*asset.channels,clippedSamples:0,zeroSamples:0,silentFrames:0,leadingSilence:0,trailingSilence:0,rmsDbfs:-33,samplePeakDbfs:-30,peaks:[{startFrame:0,endFrame:frames,min:-0.04,max:0.04}],loudness:{integratedLufs:-31,truePeakDbtp:-30}};
      if(corruptAnalysis){corruptAnalysis=false;(result as Record<string,unknown>).sampleRate=48000;}
      break;
    }
    case "listTemplates":result=templates.filter(item=>item.name.toLowerCase().includes(String(values.search??"").toLowerCase()));break;
    case "saveTemplate":{const draft=values.template as SpeechProjectTemplate;const previous=templates.find(item=>item.id===draft.id);if((previous?.revisionId??null)!==values.expectedRevisionId)throw new Error("Template revision conflict");const saved={...draft,parentRevisionId:previous?.revisionId??null,revisionId:crypto.randomUUID()};templates=[saved,...templates.filter(item=>item.id!==draft.id)];localStorage.setItem("speech-fixture-templates",JSON.stringify(templates));result=saved;break;}
    case "deleteTemplate":templates=templates.filter(item=>item.id!==values.id);localStorage.setItem("speech-fixture-templates",JSON.stringify(templates));result=null;break;
    case "importAudioTrack":result={asset:syntheticAsset(10),provenance:{sourceSha256:"1".repeat(64),sourceBytes:480044,rightsEvidence:String(values.rightsEvidence)}};break;
    case "asset":result=importedAssets.get(String(values.id));if(!result)throw new Error("Unknown verification asset");break;
    case "previewTimeline":{const range=values.range as {from:number;to:number}|undefined;result={id:crypto.randomUUID(),asset:syntheticAsset(range?range.to-range.from:10),projectId:values.projectId,revisionId:values.revisionId};break;}
    case "cleanCache":result={assets:2,bytes:1024,pending:false};break;
    case "cancel":{
      const job=jobs.find(job=>job.id===values.jobId&&job.owner===values.owner);if(!job)throw new Error("Unknown synthetic cancellation job");
      if(job.state==="running"){job.cancelRequestedAt=new Date().toISOString();job.updatedAt=job.cancelRequestedAt;}
      else if(job.state==="queued")job.state="cancelled";persistAuditions();result=job;break;
    }
    case "assist":result={source:String(values.source).replace(/(<\|speaker:[^|]+\|>)/u,"$1[thoughtful]"),cast:(values.cast as SpeechProject["cast"]).map(member=>({id:member.id,direction:member.direction,...(member.voiceId?{voiceId:member.voiceId}:{})})),rules:[]};break;
    case "cancelAssistance":result=null;break;
    case "listVoices":{const matching=libraryVoices.filter(voice=>(!values.search||voice.name.toLowerCase().includes(String(values.search).toLowerCase()))&&(!values.language||voice.languages.includes(String(values.language)))&&(values.own?deletionVoices.some(own=>own.id===voice.id):voice.visibility==="public"));const start=(Number(values.page)-1)*Number(values.pageSize);const visible=matching.slice(start,start+Number(values.pageSize)).map(voice=>({...voice,favorite:favoriteVoiceIds.has(voice.id)}));for(const voice of visible)favoriteVoiceCache.set(voice.id,voice);persistFavoriteVoices();result={voices:visible,total:matching.length};break;}
    case "getVoice":{const voice=libraryVoices.find(voice=>voice.id===values.id);if(!voice)throw new Error("Unknown fixture voice");result={...voice,favorite:favoriteVoiceIds.has(voice.id)};favoriteVoiceCache.set(voice.id,result as SpeechOperations["getVoice"]["output"]);persistFavoriteVoices();break;}
    case "favoriteVoice":{if(values.favorite)favoriteVoiceIds.add(String(values.id));else favoriteVoiceIds.delete(String(values.id));persistFavoriteVoices();result=undefined;break;}
    case "deleteVoice":case "updateVoice":{
      if(values.confirmed!==true)throw new Error("Confirm the voice change");const action=operation==="deleteVoice"?"delete":"update";const changes=action==="update"?values.changes as SpeechOperations["updateVoice"]["input"]["changes"]:null;
      const active=voiceMutations.find(record=>record.voiceId===values.id&&(record.state==="pending"||record.state==="uncertain"));if(active&&(active.id!==values.retryMutationId||active.operation!==action||JSON.stringify(active.changes)!==JSON.stringify(changes)))throw new Error("Review the unresolved voice change before retrying it.");if(active)active.state="superseded";
      const failed=action==="delete"?failNextDeletion:failNextUpdate;const now=new Date().toISOString();const receipt:SpeechOperations["deleteVoice"]["output"]={id:crypto.randomUUID(),voiceId:String(values.id),operation:action,changes,state:failed?"uncertain":action==="delete"?"deleted":"updated",createdAt:now,updatedAt:now,retryAfter:new Date(Date.now()+120_000).toISOString(),parentId:active?.id??null,httpStatus:failed?null:200,remoteStatus:null,remoteVoice:null,errorCategory:failed?"network":null};failNextDeletion=false;failNextUpdate=false;voiceMutations.push(receipt);localStorage.setItem("speech-fixture-voice-mutations",JSON.stringify(voiceMutations));
      if(action==="update"){const voice=libraryVoices.find(item=>item.id===receipt.voiceId);if(!voice)throw new Error("Unknown voice");Object.assign(voice,changes);const owned=deletionVoices.find(item=>item.id===receipt.voiceId);if(owned)Object.assign(owned,changes);}
      if(receipt.state==="deleted"){for(const items of [libraryVoices,deletionVoices]){const index=items.findIndex(voice=>voice.id===receipt.voiceId);if(index>=0)items.splice(index,1);}}localStorage.setItem("speech-fixture-deletion-voices",JSON.stringify(deletionVoices));result=receipt;break;
    }
    case "checkVoiceMutation":{const record=voiceMutations.find(record=>record.id===values.id);if(!record)throw new Error("Unknown voice change");const voice=libraryVoices.find(voice=>voice.id===record.voiceId);record.remoteStatus=voice?200:404;record.remoteVoice=voice?{name:voice.name,visibility:voice.visibility}:null;record.updatedAt=new Date().toISOString();localStorage.setItem("speech-fixture-voice-mutations",JSON.stringify(voiceMutations));result=record;break;}
    case "listVoiceMutations":{const ordered=voiceMutations.toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));const offset=Number(values.offset),limit=Number(values.limit);result={mutations:ordered.slice(offset,offset+limit),total:ordered.length,offset,limit};break;}
    case "listFavoriteVoices":{const matching=[...favoriteVoiceIds].map(id=>({id,voice:favoriteVoiceCache.get(id)??null})).filter(item=>(!values.search||(item.voice?.name??item.id).toLowerCase().includes(String(values.search).toLowerCase())||item.id.toLowerCase().includes(String(values.search).toLowerCase()))&&(!values.language||item.voice?.languages.includes(String(values.language)))).toSorted((a,b)=>(a.voice?.name??a.id).localeCompare(b.voice?.name??b.id));const offset=Number(values.offset),limit=Number(values.limit);result={favorites:matching.slice(offset,offset+limit).map(item=>({...item,voice:item.voice?{...item.voice,favorite:true,previewUrl:null}:null})),total:matching.length,offset,limit};break;}
    case "listVoiceReviews":{
      const matching=projects.flatMap(project=>(project.voiceAuditions??[]).map(review=>({projectId:project.id,projectTitle:project.title,review}))).filter(item=>(!values.voiceId||item.review.voiceId===values.voiceId)&&(!values.language||item.review.language.toLowerCase()===String(values.language).toLowerCase()||item.review.language.toLowerCase().startsWith(String(values.language).toLowerCase()+"-"))&&(!values.verdict||item.review.verdict===values.verdict));
      result={reviews:matching.slice(Number(values.offset),Number(values.offset)+Number(values.limit)),total:matching.length};break;
    }
    case "listReferences":result={references:references.slice(Number(values.offset),Number(values.offset)+Number(values.limit)),total:references.length};break;
    case "listRecordingUploads":result=[...uploads.entries()].filter(([,item])=>item.metadata.owner===values.owner).map(([id,item])=>({...item.metadata,id,offset:item.offset}));break;
    case "beginRecording":{const id=crypto.randomUUID();uploads.set(id,{metadata:values,bytes:new Uint8Array(Number(values.bytes)),offset:0});result={id,offset:0};break;}
    case "writeRecording":{const upload=uploads.get(String(values.id));if(!upload||upload.offset!==values.offset||upload.metadata.owner!==values.owner)throw new Error("Upload ownership or offset mismatch");const bytes=Uint8Array.from(atob(String(values.audioBase64)),value=>value.charCodeAt(0));upload.bytes.set(bytes,upload.offset);upload.offset+=bytes.length;result={offset:upload.offset};break;}
    case "finishRecording":{
      const upload=uploads.get(String(values.id));if(!upload||upload.offset!==upload.bytes.length)throw new Error("Incomplete upload");
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",upload.bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
      if(digest!==upload.metadata.sha256)throw new Error("Digest mismatch");
      const view=new DataView(upload.bytes.buffer);if(new TextDecoder().decode(upload.bytes.slice(0,4))!=="RIFF"||view.getUint32(54,true)!==upload.bytes.length-58)throw new Error("Invalid captured WAV");
      const sampleRate=view.getUint32(24,true),channels=view.getUint16(22,true),frames=view.getUint32(46,true);
      const asset={id:digest,sha256:digest,mimeType:"audio/wav",bytes:upload.bytes.length,duration:frames/sampleRate,sampleRate,channels,path:URL.createObjectURL(new Blob([upload.bytes],{type:"audio/wav"}))};
      const reference={asset,transcript:String(upload.metadata.transcript),rightsEvidence:String(upload.metadata.rightsEvidence)};
      references.push(reference);localStorage.setItem("speech-fixture-references",JSON.stringify(references));recordedBytes=Array.from(upload.bytes);uploads.delete(String(values.id));
      result={...reference,originalAsset:asset,quality:{frames,silentFrames:0,clippedSamples:0,peak:0.2,rms:0.1,waveform:[]}};break;
    }
    case "cancelRecording":uploads.delete(String(values.id));result=null;break;
    case "queue":if(typeof values.paused==="boolean")queuePaused=values.paused;result={paused:queuePaused};break;
    case "listProjects":{
      const search=String(values.search??"").toLowerCase();const matching=projects.filter(project=>(values.archived===undefined||project.archived===values.archived)&&(!values.id||project.id===values.id)&&(project.title.toLowerCase().includes(search)||project.source.toLowerCase().includes(search))).toSorted((left,right)=>right.updatedAt.localeCompare(left.updatedAt)||left.id.localeCompare(right.id));const offset=Number(values.offset),limit=Number(values.limit);
      result={projects:matching.slice(offset,offset+limit).map(({id,title,revisionId,updatedAt,archived,location,profileId})=>({id,title,revisionId,updatedAt,archived,location,profileId})),offset,limit,total:matching.length};break;
    }
    case "listProfiles":result=profiles;break;
    case "saveProfile":{const profile=structuredClone(values.profile as SpeechProfile),index=profiles.findIndex(item=>item.id===profile.id);if(index<0)profiles.push(profile);else profiles[index]=profile;localStorage.setItem("speech-fixture-profiles",JSON.stringify(profiles));result=profile;break;}
    case "listTakes":{const matching=takes.filter(take=>(values.projectId===undefined||take.projectId===values.projectId)&&(values.jobId===undefined||jobs.find(job=>job.id===values.jobId)?.takeIds.includes(take.id)));const start=Number(values.offset??0);result=matching.slice(start,values.limit===undefined?undefined:start+Number(values.limit));break;}
    case "resolveTakes":{result=(values.ids as string[]).map(id=>{const take=takes.find(take=>take.id===id&&take.projectId===values.projectId);if(!take)throw new Error("A production take is unavailable or belongs to another project.");return take;});break;}
    case "listDictionaries":result=dictionaries;break;
    case "dictionaryRevisions":{const matching=dictionaryHistory.filter(item=>item.id===values.id).toReversed();result={revisions:matching.slice(Number(values.offset),Number(values.offset)+Number(values.limit)),total:matching.length};break;}
    case "saveDictionary":{
      const dictionary=structuredClone(values.dictionary as SpeechOperations["saveDictionary"]["input"]["dictionary"]);dictionary.revision=crypto.randomUUID();
      const index=dictionaries.findIndex(item=>item.id===dictionary.id);if(index<0)dictionaries.push(dictionary);else dictionaries[index]=dictionary;
      dictionaryHistory.push(structuredClone(dictionary));localStorage.setItem("speech-fixture-dictionaries",JSON.stringify(dictionaries));localStorage.setItem("speech-fixture-dictionary-history",JSON.stringify(dictionaryHistory));result=dictionary;break;
    }
    case "settings":result=settings;break;
    case "saveSettings":Object.assign(settings,values.settings);result=settings;break;
    case "getProject":result=projects.find(project=>project.id===values.id);if(!result)throw new Error("Project not found");break;
    case "duplicateProject":{
      const source=projects.find(project=>project.id===values.id);if(!source||source.revisionId!==values.expectedRevisionId)throw new Error("Source revision changed");
      if(takes.some(take=>take.projectId===source.id))throw new Error("Use the native duplication fixture to verify audio identity remapping.");
      result=await runtime.execute("saveProject",{project:{...structuredClone(source),id:crypto.randomUUID(),title:String(values.title),archived:false,location:null,revisionId:"",parentRevisionId:null},expectedRevisionId:null});break;
    }
    case "saveProject":{
      const draft=values.project as SpeechProject;
      const previous=projects.find(project=>project.id===draft.id);
      if((previous?.revisionId??null)!==values.expectedRevisionId)throw new Error("Revision conflict");
      const now=new Date().toISOString();
      const saved={...draft,parentRevisionId:previous?.revisionId??null,revisionId:`revision-${++revision}`,createdAt:previous?.createdAt??now,updatedAt:now};
      projects=[saved,...projects.filter(project=>project.id!==saved.id)];
      (revisions[saved.id]??=[]).push({id:saved.revisionId,projectId:saved.id,parentId:saved.parentRevisionId,createdAt:now,source:saved.source,contentHash:saved.revisionId,snapshot:structuredClone(saved)});
      localStorage.setItem("speech-fixture-projects",JSON.stringify(projects));result=saved;break;
    }
    case "revisions":{const matching=(revisions[String(values.projectId)]??[]).toReversed();const offset=Number(values.offset),limit=Number(values.limit);result={revisions:matching.slice(offset,offset+limit).map(({id,parentId,projectId,createdAt,contentHash})=>({id,parentId,projectId,createdAt,contentHash})),offset,limit,total:matching.length};break;}
    case "getRevision":{const found=revisions[String(values.projectId)]?.find(revision=>revision.id===values.revisionId);if(!found)throw new Error("Revision not found");const {snapshot,...revision}=found;result=revision;break;}
    case "restoreRevision":{const current=projects.find(project=>project.id===values.projectId),found=revisions[String(values.projectId)]?.find(revision=>revision.id===values.revisionId);if(!current||!found||current.revisionId!==values.expectedRevisionId)throw new Error("Revision conflict");result=await runtime.execute("saveProject",{project:{...structuredClone(found.snapshot),id:current.id,revisionId:current.revisionId,parentRevisionId:current.parentRevisionId},expectedRevisionId:current.revisionId});break;}
    case "compareVoices":{
      const request=input as SpeechOperations["compareVoices"]["input"];if(!request.cloudConsent||request.voiceIds.length<2)throw new Error("Confirm the synthetic voice comparison request.");
      const profile=structuredClone(profiles.find(profile=>profile.id===request.profileId)!);const now=new Date().toISOString(),jobId=crypto.randomUUID(),revisionId=`comparison-${jobId}`,ids:string[]=[];
      for(const voiceId of request.voiceIds){
        const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(voiceId));const segment={...structuredClone(request.segment),id:"voice-"+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join(""),voiceIds:[voiceId]};
        const id=crypto.randomUUID(),asset=syntheticAsset(2);const take:SpeechTake={id,projectId:null,revisionId,segmentId:segment.id,spokenText:segment.spokenText,chapter:segment.chapter,asset,createdAt:now,generatedAt:now,reusedFromTakeId:null,backend:profile.backend,model:profile.model,requestHash:"e".repeat(64),parentTakeId:null,favorite:false,rating:null,note:"",alignment:[]};takes.push(take);ids.push(id);
        takeRequests.set(id,{segment,profile,dictionaries:dictionaryHistory.filter(dictionary=>profile.dictionaryIds.includes(dictionary.id)&&dictionaries.some(current=>current.id===dictionary.id&&current.revision===dictionary.revision)),references:{},connection:{backend:profile.backend,model:profile.model,url:null,runtimeVersion:null}});
      }
      const job:SpeechJob={id:jobId,owner:request.owner,projectId:null,revisionId,state:"completed",completedSegments:ids.length,totalSegments:ids.length,takeIds:ids,error:null,createdAt:now,updatedAt:now,priority:75,attempt:1,parentJobId:null};jobs.push(job);persistAuditions();result=job;break;
    }
    case "render":{
      const request=input as SpeechOperations["render"]["input"],now=new Date().toISOString();
      if(request.revisionId.startsWith("rehearsal-")){
        if(!request.cloudConsent||request.segments.length!==1)throw new Error("Confirm the synthetic rehearsal request.");
        const profile=structuredClone(profiles.find(profile=>profile.id===request.profileId)!);const pinned=(request.dictionaryRevisions??[]).map(item=>dictionaryHistory.find(dictionary=>dictionary.id===item.id&&dictionary.revision===item.revision)!);profile.dictionaryIds=pinned.map(item=>item.id);
        const segment=request.segments[0]!,asset=syntheticAsset(2),id=crypto.randomUUID();
        const take:SpeechTake={id,projectId:null,revisionId:request.revisionId,segmentId:segment.id,spokenText:segment.spokenText,chapter:segment.chapter,asset,createdAt:now,generatedAt:now,reusedFromTakeId:null,backend:profile.backend,model:profile.model,requestHash:"d".repeat(64),parentTakeId:null,favorite:false,rating:null,note:"",alignment:[]};takes.push(take);
        takeRequests.set(id,{segment,profile,dictionaries:structuredClone(pinned),references:{},connection:{backend:profile.backend,model:profile.model,url:null,runtimeVersion:null}});
        const job:SpeechJob={id:crypto.randomUUID(),owner:request.owner,projectId:null,revisionId:request.revisionId,state:"completed",completedSegments:1,totalSegments:1,takeIds:[id],error:null,createdAt:now,updatedAt:now,priority:100,attempt:1,parentJobId:null};jobs.push(job);
        persistAuditions();result=job;break;
      }
      if(!renderTargetsEnabled)throw new Error("Fixture synthesis is disabled; this check verifies authoring and persistence interactions.");
      const job:SpeechJob={id:crypto.randomUUID(),owner:request.owner,projectId:request.projectId,revisionId:request.revisionId,state:"queued",completedSegments:0,totalSegments:request.segments.length*request.takes,takeIds:[],error:null,createdAt:now,updatedAt:now,priority:request.priority,attempt:1,parentJobId:null};jobs.push(job);result=job;break;
    }
    case "deleteProject":projects=projects.filter(project=>project.id!==values.id);localStorage.setItem("speech-fixture-projects",JSON.stringify(projects));result=null;break;
    default:throw new Error(`Unhandled verification operation: ${operation}`);
  }
  return structuredClone(result) as SpeechOperations[K]["output"];
}};
createRoot(document.getElementById("root")!).render(<TextToSpeechStudio runtime={runtime} assetUrl={path=>path}/>);
