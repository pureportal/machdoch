import test from "node:test";
import assert from "node:assert/strict";
import {retainSpeechPlayback} from "./playback-retention.ts";
import type {PlaybackHandle,PlaybackState} from "./playback.ts";
import type {SpeechRuntime} from "./runtime.ts";

const flush=():Promise<void>=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const calls:Array<{operation:string;input:Record<string,unknown>}>=[],errors:string[]=[];
  const listeners=new Set<(state:Partial<PlaybackState>)=>void>();
  let opened=0,played=0,paused=0,stopped=0;
  let intercept:((operation:string,input:Record<string,unknown>)=>Promise<void>)|undefined;
  const runtime={transport:"native",execute:async(operation:string,input:Record<string,unknown>)=>{calls.push({operation,input});await intercept?.(operation,input);return operation==="retainPlayback"?{id:input.id,expiresAt:new Date(Date.now()+600_000).toISOString()}:undefined;}} as SpeechRuntime;
  const raw:PlaybackHandle={play:async()=>{played++;},pause:()=>{paused++;},stop:()=>{stopped++;},seek:()=>{},setRate:()=>{},setVolume:()=>{},onState:listener=>{listeners.add(listener);listener({status:"paused"});return()=>{listeners.delete(listener);};}};
  const controller=new AbortController();
  const open=()=>retainSpeechPlayback(runtime,{owner:"chat:one",assetIds:["asset","asset"],jobIds:["job"]},controller.signal,()=>{opened++;return raw;},message=>errors.push(message));
  return {calls,errors,controller,raw,open,emit:(state:Partial<PlaybackState>)=>{for(const listener of listeners)listener(state);},intercept:(value:typeof intercept)=>{intercept=value;},counts:()=>({opened,played,paused,stopped})};
}

test("playback acquires protection before opening and keeps renewing while paused",async context=>{
  context.mock.timers.enable({apis:["setInterval"]});const f=fixture();const handle=await f.open();
  assert.equal(f.calls[0]!.operation,"retainPlayback");assert.deepEqual(f.calls[0]!.input.assetIds,["asset"]);assert.deepEqual(f.calls[0]!.input.jobIds,["job"]);
  await handle.play();handle.pause();context.mock.timers.tick(60_000);await flush();
  assert.deepEqual(f.calls.at(-1)!.input.assetIds,[]);assert.deepEqual(f.calls.at(-1)!.input.jobIds,[]);assert.equal(f.counts().paused,1);
  handle.stop();await flush();assert.equal(f.calls.at(-1)!.operation,"releasePlayback");assert.deepEqual(f.errors,[]);
});

test("cancellation during acquisition releases late protection and never opens audio",async()=>{
  const f=fixture();let finish!:()=>void;f.intercept(async operation=>{if(operation==="retainPlayback")await new Promise<void>(resolve=>{finish=resolve;});});
  const opening=f.open();await flush();f.controller.abort();finish();await assert.rejects(opening,{name:"AbortError"});await flush();
  assert.equal(f.counts().opened,0);assert.deepEqual(f.calls.map(call=>call.operation),["retainPlayback","releasePlayback"]);
});

test("an in-flight renewal cannot recreate protection after stop",async context=>{
  context.mock.timers.enable({apis:["setInterval"]});const f=fixture();const handle=await f.open();let finish!:()=>void;
  f.intercept(async operation=>{if(operation==="retainPlayback")await new Promise<void>(resolve=>{finish=resolve;});});context.mock.timers.tick(60_000);await flush();handle.stop();finish();await flush();
  assert.equal(f.calls.at(-1)!.operation,"releasePlayback");const count=f.calls.length;context.mock.timers.tick(600_000);await flush();assert.equal(f.calls.length,count);assert.equal(f.counts().stopped,1);
});

test("renewal failures pause audio and expose recovery without generation",async context=>{
  context.mock.timers.enable({apis:["setInterval"]});const f=fixture();const handle=await f.open();const states:Array<Partial<PlaybackState>>=[];handle.onState(state=>states.push(state));
  f.intercept(async operation=>{if(operation==="retainPlayback")throw new Error("Cached audio expired. Open its saved take.");});context.mock.timers.tick(60_000);await flush();
  assert.equal(f.counts().paused,1);assert.equal(states.at(-1)!.status,"failed");assert.match(f.errors[0]!,/expired/u);assert.equal(f.calls.at(-1)!.operation,"releasePlayback");assert.ok(f.calls.every(call=>/^(retain|release)Playback$/u.test(call.operation)));handle.stop();await flush();
});

test("natural completion releases protection and deliberate replay acquires it again",async context=>{
  context.mock.timers.enable({apis:["setInterval"]});const f=fixture();const handle=await f.open();f.emit({status:"idle"});await flush();
  assert.equal(f.calls.at(-1)!.operation,"releasePlayback");const count=f.calls.length;context.mock.timers.tick(120_000);await flush();assert.equal(f.calls.length,count);
  await handle.play();assert.equal(f.calls.at(-1)!.operation,"retainPlayback");assert.deepEqual(f.calls.at(-1)!.input.assetIds,["asset"]);handle.stop();await flush();
});

test("an abort stops an opened player once and stale handles cannot resume",async()=>{
  const f=fixture();const handle=await f.open();f.controller.abort();handle.stop();await flush();await assert.rejects(handle.play(),{name:"AbortError"});assert.equal(f.counts().stopped,1);assert.equal(f.calls.at(-1)!.operation,"releasePlayback");
});

test("failed audio setup releases its lease and reports release failures",async()=>{
  const f=fixture();f.intercept(async operation=>{if(operation==="releasePlayback")throw new Error("disconnected");});
  await assert.rejects(retainSpeechPlayback({transport:"native",execute:async(operation:string)=>{if(operation==="releasePlayback")throw new Error("disconnected");return {};}} as SpeechRuntime,{owner:"chat:one",assetIds:["asset"]},f.controller.signal,()=>{throw new Error("No output device");},message=>f.errors.push(message)),/No output device/u);await flush();assert.match(f.errors[0]!,/expire.*ten minutes/u);
});
