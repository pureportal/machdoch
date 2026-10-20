import test from "node:test";
import assert from "node:assert/strict";
import {resolveSpeechProjectTakes,speechProjectTakeIds} from "./project-takes.ts";
import type {SpeechProject,SpeechRuntime,SpeechTake} from "./runtime.ts";

const take=(id:string)=>({id,projectId:"project"}) as SpeechTake;
function runtime(execute:(operation:string,input:Record<string,unknown>)=>unknown){return {transport:"native",execute} as unknown as SpeechRuntime;}

test("project resources include selected, timeline, reviewed and bookmarked takes with stable distinct IDs",()=>{
  const project={selectedTakes:{one:"old",two:"shared"},timeline:[{takeId:"shared"},{takeId:"timeline"}],timingSelections:{timed:"timing",shared:"shared-timing"},voiceAuditions:[{takeId:"reviewed"}],readingBookmarks:[{id:"bookmark",label:"Opening",takeId:"bookmarked",assetSha256:"hash",seconds:1},{id:"shared-bookmark",label:"Shared",takeId:"shared",assetSha256:"shared-hash",seconds:0}]} as SpeechProject;
  assert.deepEqual(speechProjectTakeIds(project),["bookmarked","old","reviewed","shared","timed","timeline"]);
  const {readingBookmarks:_bookmarks,timingSelections:_timing,...unbookmarked}=project;
  assert.deepEqual(speechProjectTakeIds(unbookmarked),["old","reviewed","shared","timeline"]);
});

test("production lookups use bounded exact pages and preserve requested order independently of history",async()=>{
  const calls:Record<string,unknown>[]=[];const ids=Array.from({length:203},(_,index)=>`take-${index}`);
  const resolved=await resolveSpeechProjectTakes(runtime((operation,input)=>{assert.equal(operation,"resolveTakes");calls.push(input);return (input.ids as string[]).map(take).reverse();}),"project",[...ids,ids[0]!]);
  assert.deepEqual(resolved.map(take=>take.id),ids);assert.deepEqual(calls.map(input=>(input.ids as string[]).length),[100,100,3]);assert.ok(calls.every(input=>input.projectId==="project"));
});

test("production lookups reject missing, duplicate and foreign project audio",async()=>{
  for(const response of [[take("one")],[take("one"),take("one")],[take("one"),take("foreign")],[take("one"),{...take("two"),projectId:"other"}]]){
    await assert.rejects(resolveSpeechProjectTakes(runtime(()=>response),"project",["one","two"]),/missing, duplicate or unrelated/);
  }
});

test("aborting an in-flight production lookup prevents additional reads",async()=>{
  const controller=new AbortController();let reads=0;
  await assert.rejects(resolveSpeechProjectTakes(runtime((_operation,input)=>{reads++;controller.abort();return (input.ids as string[]).map(take);}),"project",Array.from({length:101},(_,index)=>`take-${index}`),controller.signal),{name:"AbortError"});
  assert.equal(reads,1);
});
