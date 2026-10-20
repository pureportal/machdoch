import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpeechAssistance, applySuggestedCast, speechProposalDiff, validateSpeechAssistance, type SpeechAssistanceInput } from "./assistance.ts";
import type {SpeechProject} from "./runtime.ts";

const input: SpeechAssistanceInput = {owner:"test",taskId:"00000000-0000-4000-8000-000000000000",action:"direction",source:"# Chapter\n<|speaker:narrator|>Hello world.",instruction:"Read calmly",cast:[{id:"narrator",name:"Narrator",voiceId:"voice-one",referenceAssetIds:["reference"],direction:"",rightsEvidence:"Permission"}],voices:[{id:"voice-two",name:"Second voice",languages:["en"]}]};
const proposal = {source:"# Chapter\n<|speaker:narrator|>[calm]Hello <soft>world.</soft>",cast:[{id:"narrator",voiceId:"voice-one",direction:"measured"}],rules:[]};

test("direction proposals preserve literal words, structure, stable cast identity and reference rights",()=>{
  const result=validateSpeechAssistance(proposal,input);
  assert.equal(result.source,proposal.source);
  assert.deepEqual(applySuggestedCast(input.cast,result)[0],{...input.cast[0],direction:"measured"});
  for(const value of [{...proposal,source:proposal.source.replace("world","universe")},{...proposal,source:proposal.source.replace("Chapter","Renamed")},{...proposal,cast:[{id:"narrator",voiceId:"invented",direction:""}]},{...proposal,source:proposal.source.replace("<soft>","<unknown>")}])assert.throws(()=>validateSpeechAssistance(value,input));
});

test("casting candidates and phonetic suggestions are checked before review",()=>{
  assert.equal(validateSpeechAssistance({source:input.source,cast:[{id:"narrator",voiceId:"voice-two",direction:""}],rules:[]},{...input,action:"casting"}).cast[0]?.voiceId,"voice-two");
  assert.throws(()=>validateSpeechAssistance({source:input.source,cast:proposal.cast,rules:[{text:"world",phonemes:"<soft>",alphabet:"arpabet",caseSensitive:false}]},{...input,action:"pronunciation"}));
  const pronunciation=validateSpeechAssistance({source:input.source,cast:[{id:"narrator",voiceId:"voice-one",direction:""}],rules:[{text:"world",phonemes:"W ER1 L D",alphabet:"arpabet",caseSensitive:false}]},{...input,action:"pronunciation"});
  assert.equal(pronunciation.rules.length,1);
});

test("source review preserves Unicode characters and shows the exact replacement",()=>{
  const diff=speechProposalDiff("Hello 👩🏽‍🚀 world.","Hello 👩🏽‍🚀 <soft>world.</soft>");
  assert.equal(diff.unchanged+diff.removed+diff.trailing,"Hello 👩🏽‍🚀 world.");
  assert.equal(diff.unchanged+diff.added+diff.trailing,"Hello 👩🏽‍🚀 <soft>world.</soft>");
});

function book(source:string):SpeechProject{return {id:"book",source,cast:input.cast,variants:[],profileId:null} as unknown as SpeechProject;}

test("a bounded chapter proposal changes only its pinned range in a large book",()=>{
  const before="# Opening\n"+"Unchanged narration.\n".repeat(5000),after="\n# Closing\nKeep this chapter unchanged.";
  const project=book(before+input.source+after);const range={from:before.length,to:before.length+input.source.length};
  const result=applySpeechAssistance(project,input,proposal,range);
  assert.equal(result.source,before+proposal.source+after);assert.equal(project.source,before+input.source+after);
  assert.equal(result.cast[0]?.direction,"measured");assert.equal(result.id,project.id);
});

test("chapter localization adds a full parallel variant and preserves the original book and cast",()=>{
  const prefix="# Earlier\nEarlier text.\n",suffix="\n# Later\nLater text.";
  const project=book(prefix+input.source+suffix);const localization={...input,action:"localization" as const,language:"de-de"};
  const translated={source:input.source.replace("Hello world.","Hallo Welt."),cast:[{id:"narrator",voiceId:"voice-one",direction:""}],rules:[]};
  const result=applySpeechAssistance(project,localization,translated,{from:prefix.length,to:prefix.length+input.source.length});
  assert.equal(result.source,project.source);assert.deepEqual(result.cast,project.cast);assert.equal(project.variants.length,0);
  assert.equal(result.variants[0]?.source,prefix+translated.source+suffix);assert.equal(result.variants[0]?.language,"de-DE");
});

test("assistance cannot apply stale text, invalid ranges or a split surrogate boundary",()=>{
  const project=book("🙂"+input.source);const range={from:2,to:project.source.length};
  assert.throws(()=>applySpeechAssistance({...project,source:"🙂"+input.source.replace("Hello","Other")},input,proposal,range),/changed/u);
  for(const invalid of [{from:-1,to:10},{from:2,to:1},{from:1,to:project.source.length},{from:0,to:1},{from:2,to:project.source.length+1}])
    assert.throws(()=>applySpeechAssistance(project,input,proposal,invalid));
  assert.throws(()=>applySpeechAssistance(project,input,proposal),/changed/u);
});
