import { test } from "node:test";
import assert from "node:assert/strict";
import { openAnswerSpeechProject } from "./answer-project.ts";
import type { FinalAnswerEvent } from "./answer.ts";
import type { SpeechOperations, SpeechProject, SpeechRuntime } from "./runtime.ts";
import type {SpeechProfile} from "./runtime.ts";

test("opening an answer creates one durable script with explicit provenance and preserves studio edits", async () => {
  const answer: FinalAnswerEvent={kind:"answer",channel:"final",audience:"user",sessionId:"session",answerId:"answer",revision:"revision",markdown:"Hello **world**.\n\n<script>hidden</script>\n\n\u0060<|speaker:9|>\u0060",complete:true};
  const projects:SpeechProject[]=[];
  const operations:string[]=[];
  const runtime:SpeechRuntime={transport:"native",execute:async<K extends keyof SpeechOperations>(operation:K,input:SpeechOperations[K]["input"]):Promise<SpeechOperations[K]["output"]>=>{
    operations.push(operation);
    let result:unknown;
    if(operation==="listProjects"){const query=input as SpeechOperations["listProjects"]["input"];assert.equal(query.limit,1);assert.equal(query.offset,0);const matching=projects.filter(project=>project.id===query.id).map(({id,title,revisionId,updatedAt,archived,location,profileId})=>({id,title,revisionId,updatedAt,archived,location,profileId}));result={projects:matching,total:matching.length,offset:0,limit:1};}
    else if(operation==="getProject")result=projects.find(project=>project.id===(input as SpeechOperations["getProject"]["input"]).id);
    else if(operation==="saveProject"){const project=structuredClone((input as SpeechOperations["saveProject"]["input"]).project);projects.push(project);result=project;}
    else throw new Error("Unexpected operation "+operation);
    return structuredClone(result) as SpeechOperations[K]["output"];
  }};
  const saved=await openAnswerSpeechProject(runtime,answer,null);
  assert.deepEqual(saved.answerOrigin,{sessionId:"session",answerId:"answer",revision:"revision"});
  assert.doesNotMatch(saved.source,/[<>[\]]|hidden/u);
  assert.match(saved.source,/Hello world/u);
  assert.equal(saved.profileId,null);
  projects[0]!.source="Edits made in the studio";
  const reopened=await openAnswerSpeechProject(runtime,answer,null);
  assert.equal(reopened.id,saved.id);
  assert.equal(reopened.source,"Edits made in the studio");
  assert.equal(operations.filter(operation=>operation==="saveProject").length,1);
  assert.ok(!operations.includes("render"));
  await assert.rejects(openAnswerSpeechProject(runtime,{...answer,complete:false},null));
});

test("opening an answer carries an explicitly selected default reference profile without a substituted library voice",async()=>{
  const profile:SpeechProfile={id:"references",name:"Reference narrator",backend:"sglang",model:"drama-3",referenceAssetIds:["a".repeat(64)],direction:"",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};
  let saved:SpeechProject|undefined;const runtime={transport:"native",async execute(operation:string,input:{project?:SpeechProject}){if(operation==="listProjects")return {projects:[],total:0,offset:0,limit:1};if(operation==="saveProject"){saved=input.project;return input.project;}throw new Error("Unexpected operation");}} as SpeechRuntime;
  await openAnswerSpeechProject(runtime,{kind:"answer",channel:"final",audience:"user",sessionId:"session",answerId:"answer",revision:"new",markdown:"Hello.",complete:true},profile);assert.equal(saved?.profileId,profile.id);assert.deepEqual(saved?.cast,[{id:"narrator",name:"Narrator",referenceAssetIds:["a".repeat(64)],direction:""}]);
});
