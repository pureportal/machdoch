import assert from "node:assert/strict";
import test from "node:test";
import {speechRequestSchema} from "./speech.ts";
import {createRemoteSpeechRuntime} from "../../speech/src/remote.ts";

test("current speech resources, voice changes and measurements pass the actual Fleet invocation boundary",async()=>{
  const clientId="12345678-1234-4123-8123-123456789abc";const invocations:Array<{operation:string;input:Record<string,unknown>}>=[];
  const runtime=createRemoteSpeechRuntime(async original=>{
    const request=speechRequestSchema.parse(original);if(request.kind==="invoke")invocations.push(request.args.request);
    return {state:"complete",chunk:"bnVsbA==",offset:0,total:8};
  },{clientId,disconnectPolicy:"retain",onDiagnostic:message=>assert.fail(message)});
  await runtime.execute("getRevision",{projectId:"project",revisionId:"revision"});await runtime.execute("resolveTakes",{projectId:"project",ids:["older-selection"]});await runtime.execute("listFavoriteVoices",{offset:20,limit:20});await runtime.execute("listVoiceMutations",{offset:0,limit:20});await runtime.execute("checkVoiceMutation",{id:"attempt"});await runtime.execute("updateVoice",{id:"voice",confirmed:true,changes:{visibility:"unlist"},retryMutationId:"attempt"});await runtime.execute("duplicateProject",{id:"project",expectedRevisionId:"revision",title:"Copied narration"});await runtime.execute("recordPlaybackMetrics",{owner:"caller-controlled",samples:[{id:crypto.randomUUID(),sessionId:crypto.randomUUID(),atMs:0,event:"intent"}]});
  assert.deepEqual(invocations.map(request=>request.operation),["getRevision","resolveTakes","listFavoriteVoices","listVoiceMutations","checkVoiceMutation","updateVoice","duplicateProject","recordPlaybackMetrics"]);assert.equal(invocations.at(-1)!.input.owner,`remote:${clientId}`);assert.deepEqual(invocations[5]!.input.changes,{visibility:"unlist"});assert.deepEqual(invocations[6]!.input,{id:"project",expectedRevisionId:"revision",title:"Copied narration"});
  for(const operation of ["listVoiceDeletions","checkVoiceDeletion","setConnection"]){assert.equal(speechRequestSchema.safeParse({kind:"invoke",id:crypto.randomUUID(),command:"speech_execute",args:{clientId,disconnectPolicy:"retain",request:{operation,input:{}}}}).success,false);}
});
