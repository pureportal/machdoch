import {test} from "node:test";
import assert from "node:assert/strict";
import {compileSpeechScript,type SpeechCastBinding} from "./compiler.ts";

test("segment identity depends on synthesis bindings and ignores display metadata and object field order",()=>{
  const source="<|speaker:narrator|>Hello world.";
  const first:SpeechCastBinding={id:"narrator",name:"Narrator",voiceId:"voice",direction:"",referenceHashes:[]};
  const second={direction:"",voiceId:"voice",name:"Renamed narrator",referenceHashes:[],id:"narrator",rightsEvidence:"Independent metadata"};
  const compile=(cast:SpeechCastBinding)=>compileSpeechScript(source,{cast:[cast]}).segments[0]!.id;
  assert.equal(compile(first),compile(second));
  assert.notEqual(compile(first),compile({...first,voiceId:"another"}));
  assert.notEqual(compile(first),compile({...first,direction:"quiet"}));
  assert.notEqual(compile({...first,voiceId:undefined,referenceHashes:["a"]}),compile({...first,voiceId:undefined,referenceHashes:["b"]}));
});
