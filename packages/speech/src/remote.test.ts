import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteSpeechRuntime, type RemoteSpeechRequest, type RemoteSpeechResponse } from "./remote.ts";

const clientId = "12345678-1234-4123-8123-123456789abc";

test("remote voice recovery preserves explicit changes and never replays an uncertain mutation",async()=>{
  const calls:RemoteSpeechRequest[]=[];const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  await runtime.execute("listFavoriteVoices",{offset:20,limit:20,search:"voice"});await runtime.execute("listVoiceMutations",{offset:0,limit:20});await runtime.execute("checkVoiceMutation",{id:"attempt"});const deletion={id:"voice",confirmed:true,retryMutationId:"attempt"};await runtime.execute("deleteVoice",deletion);
  const update={...deletion,changes:{name:"New name",visibility:"unlist" as const}};await runtime.execute("updateVoice",update);
  assert.deepEqual(calls.filter(call=>call.kind==="invoke").map(call=>call.args?.request),[{operation:"listFavoriteVoices",input:{offset:20,limit:20,search:"voice"}},{operation:"listVoiceMutations",input:{offset:0,limit:20}},{operation:"checkVoiceMutation",input:{id:"attempt"}},{operation:"deleteVoice",input:deletion},{operation:"updateVoice",input:update}]);
  let requests=0;const uncertain=createRemoteSpeechRuntime(async()=>{requests++;throw new Error("Connection lost");},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});await assert.rejects(uncertain.execute("deleteVoice",deletion),/Connection lost/u);assert.equal(requests,1);await assert.rejects(uncertain.execute("updateVoice",update),/Connection lost/u);assert.equal(requests,2);
});

test("remote production lookup preserves exact project resources and bounded active job filters",async()=>{
  const calls:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify([])).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  const lookup={projectId:"project",ids:["old-selected","timeline"]};
  await runtime.execute("resolveTakes",lookup);await runtime.execute("listJobs",{projectId:"project",states:["queued","running"],offset:20,limit:21});
  assert.deepEqual(calls.filter(call=>call.kind==="invoke").map(call=>call.args?.request),[{operation:"resolveTakes",input:lookup},{operation:"listJobs",input:{projectId:"project",states:["queued","running"],offset:20,limit:21,owner:`remote:${clientId}`}}]);assert.deepEqual(lookup.ids,["old-selected","timeline"]);
});

test("remote playback leases pin their owner without changing explicit resource IDs",async()=>{
  const calls:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  const input={id:"player",owner:"foreign",assetIds:["asset"],jobIds:["job"]};await runtime.execute("retainPlayback",input);await runtime.execute("releasePlayback",{id:"player",owner:"foreign"});
  assert.deepEqual(calls.filter(call=>call.kind==="invoke").map(call=>call.args?.request),[{operation:"retainPlayback",input:{...input,owner:`remote:${clientId}`}},{operation:"releasePlayback",input:{id:"player",owner:`remote:${clientId}`}}]);assert.equal(input.owner,"foreign");
});

test("remote listening-review discovery preserves bounded filters and performs only its read operation",async()=>{
  const requests:RemoteSpeechRequest[]=[];const expected={reviews:[{projectId:"project",projectTitle:"Source",review:{id:"review",language:"de-DE"}}],total:1};
  const runtime=createRemoteSpeechRuntime(async request=>{requests.push(request);const content=Buffer.from(JSON.stringify(expected)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  const input={voiceId:"voice",language:"de",verdict:"approved" as const,offset:20,limit:20};assert.deepEqual(await runtime.execute("listVoiceReviews",input),expected);
  assert.deepEqual(requests.filter(request=>request.kind==="invoke").map(request=>request.args?.request),[{operation:"listVoiceReviews",input}]);assert.equal(requests.filter(request=>request.kind==="release").length,1);
});

test("remote multi-voice jobs preserve the passage, explicit voices and consent while provenance reads remain scoped by take",async()=>{
  const calls:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});
  const input={owner:"other",profileId:"profile",segment:{id:"source",text:"<|speaker:0|>Hello.",spokenText:"Hello.",voiceIds:["voice-a"],referenceAssetIds:[],chapter:null},voiceIds:["voice-a","voice-b"],cloudConsent:true,budgetLimit:2};
  await runtime.execute("compareVoices",input);await runtime.execute("takeProvenance",{id:"owned-take"});
  const invoked=calls.filter(call=>call.kind==="invoke");assert.deepEqual(invoked[0]?.args?.request.input,{...input,owner:`remote:${clientId}`});assert.deepEqual(invoked[1]?.args?.request.input,{id:"owned-take"});assert.equal(input.owner,"other");assert.equal(calls.filter(call=>call.kind==="release").length,2);
});

test("remote rehearsal preserves exact dictionary versions and owner while history stays read-only",async()=>{
  const requests:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{requests.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  const input={owner:"rehearsal",projectId:null,revisionId:"rehearsal-id",profileId:"profile",segments:[{id:"segment",text:"Hello.",spokenText:"Hello.",chapter:null,voiceIds:["voice"],referenceAssetIds:[]}],takes:1,priority:100,reuseCache:false,cloudConsent:true,budgetLimit:1,dictionaryRevisions:[{id:"dict",revision:"old"}]};
  await runtime.execute("render",input);await runtime.execute("dictionaryRevisions",{id:"dict",offset:50,limit:50});
  const invoked=requests.filter(item=>item.kind==="invoke");assert.deepEqual(invoked[0]?.args?.request.input,{...input,owner:`remote:${clientId}`});assert.deepEqual(invoked[1]?.args?.request.input,{id:"dict",offset:50,limit:50});assert.equal(input.owner,"rehearsal");assert.equal(requests.filter(item=>item.kind==="release").length,2);
});

test("remote director requests pin the owner and do not replay an uncertain paid request",async()=>{
  const requests:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{requests.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});
  const input={owner:"other",takeId:"original",note:"thoughtful",takes:2,cloudConsent:true,budgetLimit:5};
  await runtime.execute("regenerate",input);assert.deepEqual(requests[0]?.args?.request.input,{...input,owner:`remote:${clientId}`});assert.equal(input.owner,"other");
  let count=0;const uncertain=createRemoteSpeechRuntime(async()=>{count++;throw new Error("uncertain connection");},{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});
  await assert.rejects(uncertain.execute("regenerate",input),/uncertain connection/u);assert.equal(count,1);
});

test("remote timing pins the client owner and preserves explicit provider, consent and draft selections",async()=>{
  const requests:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{
    requests.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};
  },{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  const input={owner:"other",takeId:"take",provider:"openai" as const,model:"whisper-1" as const,language:"de",pricing:null,budgetLimit:null,cloudConsent:true,reuseCache:true};
  await runtime.execute("align",input);await runtime.execute("listTimings",{takeId:"take"});await runtime.execute("getTiming",{id:"timing"});await runtime.execute("resolveTimings",{projectId:"project",selections:{take:"timing"}});
  const invoked=requests.filter(request=>request.kind==="invoke");
  assert.deepEqual(invoked.map(request=>request.args?.request.operation),["align","listTimings","getTiming","resolveTimings"]);
  assert.deepEqual(invoked[0]?.args?.request.input,{...input,owner:`remote:${clientId}`});assert.equal(input.owner,"other");
  assert.deepEqual(invoked[3]?.args?.request.input,{projectId:"project",selections:{take:"timing"}});
  assert.ok(invoked.every(request=>request.args?.disconnectPolicy==="retain"));assert.equal(requests.filter(request=>request.kind==="release").length,4);
});

test("remote speech scopes the owner, reads fragmented receipts, and releases responses", async () => {
  const requests: RemoteSpeechRequest[] = [];
  const content = Buffer.from(JSON.stringify([{ id: "job-1", state: "queued" }])).toString("base64");
  const transport = async (request: RemoteSpeechRequest): Promise<RemoteSpeechResponse> => {
    requests.push(request);
    if (request.kind === "invoke") return { state: "pending" };
    if (request.kind === "release") return { state: "complete", chunk: "", offset: 0, total: 0 };
    const offset = request.offset!;
    return { state: "complete", chunk: content.slice(offset, offset + 8), offset, total: content.length };
  };
  const diagnostics: string[] = [];
  const runtime = createRemoteSpeechRuntime(transport, { clientId, disconnectPolicy: "cancel", onDiagnostic: message => diagnostics.push(message) });
  const jobs = await runtime.execute("listJobs", { owner: "some-other-owner" });
  assert.equal(jobs[0]?.id, "job-1");
  assert.equal(requests[0]?.args?.request.input.owner, `remote:${clientId}`);
  assert.equal(requests[0]?.args?.disconnectPolicy, "cancel");
  assert.equal(requests.at(-1)?.kind, "release");
  assert.deepEqual(diagnostics, []);
});

test("remote speech refuses secret mutation and does not replay uncertain requests", async () => {
  let requests = 0;
  const runtime = createRemoteSpeechRuntime(async () => { requests++; throw new Error("Connection lost"); }, { clientId, disconnectPolicy: "retain", onDiagnostic: () => {} });
  await assert.rejects(runtime.execute("setConnection", { backend: "fish-cloud", secret: "private" }), /owning device/u);
  assert.equal(requests, 0);
  await assert.rejects(runtime.execute("listJobs", {}), /Connection lost/u);
  assert.equal(requests, 1);
});

test("remote speech rejects malformed receipt offsets", async () => {
  const runtime = createRemoteSpeechRuntime(async request => request.kind === "release"
    ? { state: "complete", chunk: "", offset: 0, total: 0 }
    : { state: "complete", chunk: "AAAA", offset: 9, total: 4 }, { clientId, disconnectPolicy: "cancel", onDiagnostic: () => {} });
  await assert.rejects(runtime.execute("listProfiles", {}), /malformed/u);
});

test("remote live input and recorded-answer lookup use the requesting client owner",async()=>{
  const requests:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{
    requests.push(request);
    const value=request.kind==="release"?null:request.args?.request.operation==="beginLive"?{id:"stream",state:"queued"}:request.args?.request.operation==="appendLive"?{accepted:true,nextSequence:2,finished:false}:null;
    const content=Buffer.from(JSON.stringify(value)).toString("base64");
    return {state:"complete",chunk:content,offset:0,total:content.length};
  },{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});
  await runtime.execute("beginLive",{owner:"other-owner",projectId:null,revisionId:"revision",profileId:"fish",segments:[{id:"answer",text:"Hello.",spokenText:"Hello.",chapter:null,voiceIds:["voice"],referenceAssetIds:[]}],takes:1,reuseCache:false,priority:100,cloudConsent:true,budgetLimit:null,maxCharacters:100});
  await runtime.execute("appendLive",{owner:"other-owner",jobId:"stream",sequence:1,text:" More.",finish:false});
  await runtime.execute("findAnswerAudio",{owner:"other-owner",answerId:"answer",revision:"revision",source:"Hello. More.",profileId:"fish"});
  const invoked=requests.filter(request=>request.kind==="invoke");
  assert.deepEqual(invoked.map(request=>request.args?.request.operation),["beginLive","appendLive","findAnswerAudio"]);
  assert.ok(invoked.every(request=>request.args?.request.input.owner===`remote:${clientId}`&&request.args?.disconnectPolicy==="cancel"));
  assert.equal(requests.filter(request=>request.kind==="release").length,3);
});


test("remote durable voice design, candidate-based creation and saved results share the requesting owner",async()=>{
  const calls:RemoteSpeechRequest[]=[];
  const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify(null)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});
  const design={owner:"studio",description:"Warm",text:"Hallo.",pricing:null,budgetLimit:null,cloudConsent:true};
  await runtime.execute("designVoice",design);
  const create={owner:"studio",name:"Private",referenceAssetIds:[],transcripts:[],designCandidateId:"saved",rightsEvidence:"My candidate",permissionConfirmed:true,pricing:null,budgetLimit:null,cloudConsent:true};
  await runtime.execute("createVoice",create);await runtime.execute("getVoiceWorkflow",{owner:"studio",jobId:"design"});
  const requests=calls.filter(call=>call.kind==="invoke");assert.deepEqual(requests.map(request=>request.args?.request.input),[{...design,owner:`remote:${clientId}`},{...create,owner:`remote:${clientId}`},{owner:`remote:${clientId}`,jobId:"design"}]);assert.equal(design.owner,"studio");assert.equal(calls.filter(call=>call.kind==="release").length,3);
  let count=0;const failed=createRemoteSpeechRuntime(async()=>{count++;throw new Error("uncertain voice request");},{clientId,disconnectPolicy:"cancel",onDiagnostic:()=>{}});await assert.rejects(failed.execute("designVoice",design),/uncertain voice request/u);assert.equal(count,1);
});


test("remote diagnostics always projects the requesting client owner and does not request media grants",async()=>{
  const calls:RemoteSpeechRequest[]=[];
  const expected={schema:"machdoch-speech-diagnostics",version:1,jobs:[]};
  const runtime=createRemoteSpeechRuntime(async request=>{calls.push(request);const content=Buffer.from(JSON.stringify(expected)).toString("base64");return {state:"complete",chunk:content,offset:0,total:content.length};},{clientId,disconnectPolicy:"retain",onDiagnostic:()=>{}});
  assert.deepEqual(await runtime.execute("getDiagnostics",{limit:100}),expected);
  const invoked=calls.filter(call=>call.kind==="invoke");assert.deepEqual(invoked.map(call=>call.args?.request),[{operation:"getDiagnostics",input:{owner:`remote:${clientId}`,limit:100}}]);assert.equal(calls.filter(call=>call.kind==="release").length,1);
});
