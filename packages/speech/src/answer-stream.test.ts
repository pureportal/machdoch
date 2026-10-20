import assert from "node:assert/strict";
import {test} from "node:test";
import {StreamingAnswerPlayback,type StreamingAnswerOptions} from "./answer-stream.ts";
import {answerSpeechRevision,type FinalAnswerEvent} from "./answer.ts";
import type {SpeechOperations,SpeechRuntime} from "./runtime.ts";
import type {PlaybackHandle} from "./playback.ts";
import type {createPcmPlaybackHandle} from "./pcm.ts";

function fixture(){
  const calls:Array<{operation:string;input:unknown}>=[];
  const errors:string[]=[];
  let allow=true;
  const waiting=new Set<()=>void>();
  const runtime:SpeechRuntime={transport:"native",execute:async<K extends keyof SpeechOperations>(operation:K,input:SpeechOperations[K]["input"]):Promise<SpeechOperations[K]["output"]>=>{
    calls.push({operation,input:structuredClone(input)});for(const wake of waiting)wake();
    let value:unknown;
    if(operation==="beginLive")value={id:"job"};
    else if(operation==="retainPlayback")value={id:(input as {id:string}).id,expiresAt:new Date(Date.now()+600_000).toISOString()};
    else if(operation==="releasePlayback")value=undefined;
    else if(operation==="cancel")value={id:"job",state:"cancelled"};
    else if(operation==="appendLive"){const request=input as SpeechOperations["appendLive"]["input"];value={accepted:allow,nextSequence:request.sequence+(allow?1:0),finished:allow&&request.finish};}
    else throw new Error("Unexpected operation "+operation);
    return value as SpeechOperations[K]["output"];
  }};
  const handle:PlaybackHandle={play:async()=>{},pause:()=>{},stop:()=>{},seek:()=>{},setRate:()=>{},setVolume:()=>{},onState:()=>()=>{}};
  const playback:typeof createPcmPlaybackHandle=async()=>handle;
  const options:StreamingAnswerOptions={input:{owner:"chat:auto:session",projectId:null,revisionId:"stream",profileId:"fish",priority:100,cloudConsent:true,budgetLimit:1},voiceIds:["voice"],referenceAssetIds:[],maxCharacters:1000,rate:1,onError:message=>errors.push(message)};
  const event=(markdown:string,complete=false):FinalAnswerEvent=>({kind:"answer",channel:"final",audience:"user",sessionId:"session",answerId:"answer",revision:"response-item",markdown,complete});
  const until=async(condition:()=>boolean):Promise<void>=>{
    const deadline=AbortSignal.timeout(2000);
    while(!condition())await new Promise<void>((resolve,reject)=>{const cancelled=():void=>{waiting.delete(wake);reject(new Error("Expected stream condition was not reached."));};const wake=():void=>{waiting.delete(wake);deadline.removeEventListener("abort",cancelled);resolve();};waiting.add(wake);deadline.addEventListener("abort",cancelled,{once:true});if(condition())wake();});
  };
  return {runtime,calls,errors,options,playback,event,until,allow:(value:boolean)=>{allow=value;}};
}

test("stream starts from safe final text before completion and seals exact native input once",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();
  stream.update(f.event("Hello. More"));
  const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  assert.equal(f.calls[0]?.operation,"beginLive");assert.equal((f.calls[0]?.input as SpeechOperations["beginLive"]["input"]).segments[0]?.text,"Hello.");
  stream.update(f.event("Hello. More words.",true));
  await f.until(()=>f.calls.some(call=>call.operation==="appendLive"&&(call.input as {finish:boolean}).finish));
  const finish=f.calls.at(-1)?.input as SpeechOperations["appendLive"]["input"];
  assert.equal(finish.finalText,"Hello. More words.");assert.equal(finish.answerRevision,answerSpeechRevision("Hello. More words."));
  assert.ok(!f.calls.some(call=>call.operation==="render"));assert.deepEqual(f.errors,[]);handle.stop();
});

test("streaming answers carry the explicitly selected ordered reference binding without inventing a library voice",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();f.options.voiceIds=[];f.options.referenceAssetIds=["a".repeat(64),"b".repeat(64)];stream.update(f.event("Reference voice. Pending"));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  const request=f.calls.find(call=>call.operation==="beginLive")!.input as SpeechOperations["beginLive"]["input"];assert.deepEqual(request.segments[0]!.voiceIds,[]);assert.deepEqual(request.segments[0]!.referenceAssetIds,f.options.referenceAssetIds);handle.stop();
});

test("duplicate snapshots and split control markup never duplicate or inject committed speech",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();
  stream.update(f.event("Hello. <|spe"));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  stream.update(f.event("Hello. <|spe"));stream.update(f.event("Hello. <|speaker:9|> unsafe [whisper].",true));
  await f.until(()=>f.calls.some(call=>call.operation==="appendLive"&&(call.input as {finish:boolean}).finish));
  const requests=f.calls.filter(call=>call.operation==="appendLive").map(call=>call.input as SpeechOperations["appendLive"]["input"]);
  assert.doesNotMatch(requests.map(request=>request.text).join(""),/[<>[\]]/u);
  assert.equal(f.calls.filter(call=>call.operation==="beginLive").length,1);assert.deepEqual(f.errors,[]);handle.stop();
});

test("revisions cancel unsent work and require deliberate replay",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();
  stream.update(f.event("Original. Pending"));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  stream.update(f.event("Corrected. Pending"));
  await f.until(()=>f.calls.some(call=>call.operation==="cancel"));
  stream.update(f.event("Corrected. Complete.",true));
  assert.equal(f.calls.filter(call=>call.operation==="beginLive").length,1);assert.match(f.errors[0]!,/changed/);handle.stop();
});

test("native backpressure keeps a single pending text fragment with stable sequence",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();
  stream.update(f.event("First. "));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);f.allow(false);
  stream.update(f.event("First. Second. "));
  await f.until(()=>f.calls.some(call=>call.operation==="appendLive"));
  stream.update(f.event("First. Second. Third. "));stream.update(f.event("First. Second. Third. Fourth.",true));
  assert.equal(f.calls.filter(call=>call.operation==="appendLive").length,1);f.allow(true);
  await f.until(()=>f.calls.some(call=>call.operation==="appendLive"&&(call.input as {finish:boolean}).finish));
  const requests=f.calls.filter(call=>call.operation==="appendLive").map(call=>call.input as SpeechOperations["appendLive"]["input"]);
  assert.equal(requests[0]?.sequence,requests[1]?.sequence);assert.equal(requests.at(-1)?.finalText,"First. Second. Third. Fourth.");handle.stop();
});

test("the answer cap stops new text without another provider or completed fallback",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();f.options.maxCharacters=10;
  stream.update(f.event("First. "));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  stream.update(f.event("First. This exceeds the limit.",true));await f.until(()=>f.calls.some(call=>call.operation==="cancel"));
  assert.match(f.errors.at(-1)??"",/limit/);assert.equal(f.calls.filter(call=>call.operation==="beginLive").length,1);assert.ok(!f.calls.some(call=>call.operation==="render"));handle.stop();
});

test("Unicode fragments preserve complete code points within the native per-fragment guard",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();f.options.maxCharacters=2000;
  const markdown="😀".repeat(700)+".";stream.update(f.event(markdown,true));const handle=await stream.open(f.runtime,f.options,controller.signal,f.playback);
  await f.until(()=>f.calls.some(call=>call.operation==="appendLive"&&(call.input as {finish:boolean}).finish));
  const begin=f.calls[0]?.input as SpeechOperations["beginLive"]["input"];
  const fragments=[begin.segments[0]!.text,...f.calls.filter(call=>call.operation==="appendLive").map(call=>(call.input as {text:string}).text)];
  assert.equal(fragments.join(""),markdown);for(const fragment of fragments){assert.ok(Array.from(fragment).length<=512);assert.equal(fragment.isWellFormed(),true);}handle.stop();
});

test("stop while beginning cancels the arriving job and opens no late playback",async()=>{
  const f=fixture(),stream=new StreamingAnswerPlayback(),controller=new AbortController();
  let release!:(value:unknown)=>void;let opened=false;
  const runtime:SpeechRuntime={transport:"native",execute:((operation: string,input:unknown)=>operation==="beginLive"?new Promise(resolve=>{release=resolve;}):f.runtime.execute(operation as keyof SpeechOperations,input as never)) as SpeechRuntime["execute"]};
  stream.update(f.event("Hello. "));const ready=stream.open(runtime,f.options,controller.signal,async()=>{opened=true;return f.playback(null as never,controller.signal);});
  controller.abort();release({id:"late"});await assert.rejects(ready);
  assert.equal(opened,false);assert.equal(f.calls.filter(call=>call.operation==="cancel").length,1);assert.deepEqual(f.errors,[]);
});
