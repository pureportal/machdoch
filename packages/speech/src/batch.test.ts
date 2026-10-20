import test from "node:test";
import assert from "node:assert/strict";
import {prepareSpeechBatch,submitSpeechBatch,type SpeechBatchFile} from "./batch.ts";
import {speechCastBindings} from "./scene-casting.ts";
import type {SpeechProfile,SpeechRuntime,SpeechBatchReceipt} from "./index.ts";

const profile:SpeechProfile={id:"fish",name:"Narrator",backend:"fish-cloud",model:"drama-3",voiceId:"voice",direction:"calm",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};
const cast=[{id:"narrator",name:"Narrator",voiceId:"voice",referenceAssetIds:[],direction:""}];
const pricing={unit:"characters" as const,perMillion:1_000_000,currency:"USD",source:"https://example.test/fixture-account-rate",effectiveFrom:"2000-01-01",effectiveTo:"2099-01-01"};
function options(){return {compile:{backend:profile.backend,cast:speechCastBindings(cast,id=>id)},profile,pricing,takes:2,cast,stripMetadata:false,mappings:{},bindings:{}};}
function files():SpeechBatchFile[]{return [{id:"one",name:"First.txt",source:"Hello 世界.",format:"text"},{id:"two",name:"Second.md",source:"# Chapter\nAnother 🚀.",format:"markdown"},{id:"three",name:"Third.txt",source:"Last script.",format:"text"}];}
function runtime(fail=false){
  const calls:Array<{operation:string;input:Record<string,unknown>}>=[];
  const runtime={transport:"native",async execute(operation:string,input:Record<string,unknown>){calls.push({operation,input:structuredClone(input)});if(operation==="saveProject"){const project=input.project as Record<string,unknown>;return {...project,revisionId:`revision-${project.id}`};}if(operation==="render"){if(fail&&calls.filter(call=>call.operation==="render").length===2)throw new Error("Admission response interrupted");return {id:`job-${calls.length}`,state:"queued"};}throw new Error("Unexpected batch operation");}} as SpeechRuntime;
  return {runtime,calls};
}
function submission(signal:AbortSignal,onProgress=(_:SpeechBatchReceipt)=>{}){return {id:"batch",profile,cast,takes:2,cloudConsent:true,budgetLimit:null,dictionaryRevisions:[],signal,onProgress};}

test("batch preparation preserves independent Unicode scripts, explicit table casting and exact total generation estimates",()=>{
  const input=files();input.push({id:"table",name:"Dialogue.csv",format:"csv",source:'Speaker,Text\n"Guest","Hallo, 世界."\n'});
  const prepared=prepareSpeechBatch(input,{...options(),mappings:{table:{header:true,textColumn:1,speakerColumn:0}},bindings:{Guest:"narrator"}});
  assert.equal(prepared.items.every(item=>item.errors.length===0),true);assert.equal(input[0]!.source,"Hello 世界.");
  assert.equal(prepared.items[3]!.source,"<|speaker:narrator|>Hallo, 世界.");assert.deepEqual(prepared.items[3]!.speakers,["Guest"]);assert.deepEqual(prepared.items[3]!.segments[0]!.voiceIds,["voice"]);
  assert.equal(prepared.estimate!.amount,prepared.items.reduce((sum,item)=>sum+item.estimate!.amount!,0));assert.ok(prepared.estimate!.utf8Bytes>prepared.estimate!.characters);
  const unmapped=prepareSpeechBatch(input,{...options(),mappings:{table:{header:true,textColumn:1,speakerColumn:0}}});assert.equal(unmapped.estimate,null);assert.match(unmapped.items[3]!.errors.join(" "),/Map Guest/u);assert.deepEqual(unmapped.items[3]!.speakers,["Guest"]);
});

test("batch authoring rejects unsupported controls, malformed dialogue, invalid identities and oversized files before mutation",async()=>{
  for(const file of [{id:"bad",name:"Bad.txt",source:"<unknown>Text.</unknown>",format:"text" as const},{id:"bad",name:"Bad.csv",source:'Speaker,Text\nGuest,"unclosed',format:"csv" as const}]){
    const prepared=prepareSpeechBatch([file],{...options(),mappings:{bad:{header:true,textColumn:1,speakerColumn:0}},bindings:{Guest:"narrator"}});assert.equal(prepared.estimate,null);assert.ok(prepared.items[0]!.errors.length);
    const fixture=runtime();await assert.rejects(submitSpeechBatch(fixture.runtime,prepared,submission(new AbortController().signal)),/resolve/u);assert.equal(fixture.calls.length,0);
  }
  assert.throws(()=>prepareSpeechBatch([files()[0]!,files()[0]!],options()),/distinct/u);assert.throws(()=>prepareSpeechBatch([{...files()[0]!,source:"x".repeat(4*1024*1024+1)}],options()),/4 MiB/u);
  const table={id:"table",name:"Control.csv",format:"csv" as const,source:'Speaker,Text\nGuest,"[whisper]secret"'};
  assert.match(prepareSpeechBatch([table],{...options(),mappings:{table:{header:true,textColumn:1,speakerColumn:0}},bindings:{Guest:"narrator"}}).items[0]!.errors.join(" "),/literal/u);
});

test("batch consent and aggregate spending limit are checked before saving or queuing projects",async()=>{
  const prepared=prepareSpeechBatch(files(),options());const fixture=runtime();const input=submission(new AbortController().signal);
  await assert.rejects(submitSpeechBatch(fixture.runtime,prepared,{...input,cloudConsent:false}),/Allow/u);
  await assert.rejects(submitSpeechBatch(fixture.runtime,prepared,{...input,budgetLimit:prepared.estimate!.amount!-1}),/complete batch/u);
  const unknown=prepareSpeechBatch(files(),{...options(),pricing:null as unknown as typeof pricing});await assert.rejects(submitSpeechBatch(fixture.runtime,unknown,{...input,budgetLimit:1}),/account rate/u);assert.equal(fixture.calls.length,0);
});

test("batch submission creates distinct projects and durable canonical jobs with exact reviewed profiles and no autoplay or take selection",async()=>{
  const prepared=prepareSpeechBatch(files(),options());const fixture=runtime();const receipt=await submitSpeechBatch(fixture.runtime,prepared,{...submission(new AbortController().signal),budgetLimit:prepared.estimate!.amount});
  assert.equal(receipt.stopped,false);assert.equal(receipt.items.every(item=>item.state==="queued"&&item.jobId!==null),true);assert.equal(new Set(receipt.items.map(item=>item.projectId)).size,3);
  const renders=fixture.calls.filter(call=>call.operation==="render");assert.equal(renders.length,3);
  for(const [index,call] of renders.entries()){assert.deepEqual(call.input.expectedProfile,profile);assert.equal(call.input.reuseCache,false);assert.equal(call.input.takes,2);assert.equal(call.input.budgetLimit,prepared.items[index]!.estimate!.amount);assert.equal(call.input.owner,"text-to-speech:batch:batch");assert.deepEqual(call.input.segments,prepared.items[index]!.segments);}
  assert.equal(fixture.calls.filter(call=>call.operation==="saveProject").every(call=>Object.keys((call.input.project as {selectedTakes:object}).selectedTakes).length===0),true);
});

test("a partial admission failure preserves the receipt and never retries, deletes, or admits later scripts",async()=>{
  const fixture=runtime(true);const progress:SpeechBatchReceipt[]=[];const receipt=await submitSpeechBatch(fixture.runtime,prepareSpeechBatch(files(),options()),submission(new AbortController().signal,value=>progress.push(value)));
  assert.equal(receipt.stopped,true);assert.deepEqual(receipt.items.map(item=>item.state),["queued","failed","pending"]);assert.match(receipt.items[1]!.error!,/interrupted/u);assert.equal(fixture.calls.length,4);assert.equal(progress.at(-1)!.items[0]!.jobId,receipt.items[0]!.jobId);
});

test("stopping submission leaves admitted jobs intact and does not save or queue remaining scripts",async()=>{
  const fixture=runtime();const controller=new AbortController();const receipt=await submitSpeechBatch(fixture.runtime,prepareSpeechBatch(files(),options()),submission(controller.signal,value=>{if(value.items[0]!.state==="queued")controller.abort();}));
  assert.equal(receipt.stopped,true);assert.deepEqual(receipt.items.map(item=>item.state),["queued","pending","pending"]);assert.deepEqual(fixture.calls.map(call=>call.operation),["saveProject","render"]);
});
