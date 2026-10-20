import test from "node:test";
import assert from "node:assert/strict";
import {renderSpeech} from "./session.ts";
import {completedSpeechTakes} from "./completed-takes.ts";
import type {SpeechJob,SpeechRuntime,SpeechTake,SpeechRenderInput} from "./runtime.ts";

function job(count:number):SpeechJob{return {id:"job",owner:"owner",projectId:null,revisionId:"revision",state:"completed",completedSegments:count,totalSegments:count,takeIds:Array.from({length:count},(_,index)=>`take-${index}`),error:null,createdAt:"2026-10-20T00:00:00.000Z",updatedAt:"2026-10-20T00:00:00.000Z",priority:0,attempt:1,parentJobId:null};}
function take(id:string):SpeechTake{return {id,projectId:null,revisionId:"revision",segmentId:id,spokenText:"Synthetic",chapter:null,asset:{id:"a".repeat(64),sha256:"a".repeat(64),path:"synthetic.wav",bytes:46,mimeType:"audio/wav",duration:1/24000,sampleRate:24000,channels:1},createdAt:"2026-10-20T00:00:00.000Z",generatedAt:"2026-10-20T00:00:00.000Z",reusedFromTakeId:null,backend:"fish-cloud",model:"drama-3",requestHash:"b".repeat(64),parentTakeId:null,favorite:false,rating:null,note:"",alignment:[]};}
function runtime(read:(operation:string,input:Record<string,unknown>)=>unknown|Promise<unknown>):SpeechRuntime{return {transport:"native",execute:read} as SpeechRuntime;}

test("completed take reads use bounded pages and restore the durable job order",async()=>{
  const completed=job(501);const stored=completed.takeIds.toReversed().map(take);const calls:Record<string,unknown>[]=[];
  const result=await completedSpeechTakes(runtime((operation,input)=>{assert.equal(operation,"listTakes");calls.push(input);return stored.slice(Number(input.offset),Number(input.offset)+Number(input.limit));}),completed);
  assert.deepEqual(calls,[{jobId:"job",offset:0,limit:500},{jobId:"job",offset:500,limit:1}]);assert.deepEqual(result.map(take=>take.id),completed.takeIds);
});

test("missing, duplicate and unrelated completed takes fail explicitly without generation or partial playback",async()=>{
  for(const output of [[take("take-0")],[take("take-0"),take("take-0")],[take("take-0"),take("unrelated")]]){
    const calls:string[]=[];await assert.rejects(completedSpeechTakes(runtime(operation=>{calls.push(operation);return output;}),job(2)),/incomplete|duplicate or unrelated/u);assert.deepEqual(calls,["listTakes"]);
  }
  const incomplete=job(1);incomplete.state="uncertain";await assert.rejects(completedSpeechTakes(runtime(()=>{throw new Error("Unexpected read");}),incomplete),/incomplete/u);
});

test("an aborted take-page read cannot continue fetching or return late audio",async()=>{
  const completed=job(501);const controller=new AbortController();let calls=0;
  await assert.rejects(completedSpeechTakes(runtime(()=>{calls++;controller.abort();return completed.takeIds.slice(0,500).map(take);}),completed,controller.signal),{name:"AbortError"});assert.equal(calls,1);
});

test("foreground rendering polls only its own job and returns one ordered completed take page",async()=>{
  const completed=job(1);const calls:Array<{operation:string;input:Record<string,unknown>}>=[];const input:SpeechRenderInput={owner:"owner",projectId:null,revisionId:"revision",profileId:"profile",segments:[{id:"segment",text:"Synthetic",spokenText:"Synthetic",chapter:null,voiceIds:["voice"],referenceAssetIds:[]}],takes:1,priority:100,reuseCache:true,cloudConsent:true,budgetLimit:null};
  const result=await renderSpeech(runtime((operation,input)=>{calls.push({operation,input});if(operation==="render")return {...completed,state:"queued",completedSegments:0,takeIds:[]};if(operation==="listJobs")return [completed];if(operation==="listTakes")return [take("take-0")];throw new Error("Unexpected generation operation");}),input,new AbortController().signal);
  assert.deepEqual(result.map(take=>take.id),["take-0"]);assert.deepEqual(calls[1],{operation:"listJobs",input:{owner:"owner",id:"job",limit:1}});assert.deepEqual(calls[2],{operation:"listTakes",input:{jobId:"job",offset:0,limit:1}});
});
