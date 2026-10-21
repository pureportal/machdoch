// @vitest-environment jsdom

import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {SpeechProfile} from "@machdoch/speech";
import type {FinalAnswerStreamSnapshot} from "@machdoch/fleet-protocol/task-thinking";
import type {ChatSessionMessage,ShellVoiceSettings} from "../../chat-session.model";
import type {UserVoiceSettings} from "../../runtime";
import {useChatSessionVoice,type UseChatSessionVoiceOptions} from "./use-chat-session-voice";

const mocks=vi.hoisted(()=>({execute:vi.fn(),play:vi.fn(),stop:vi.fn(),players:[] as Array<{update:ReturnType<typeof vi.fn>;retract:ReturnType<typeof vi.fn>;open:ReturnType<typeof vi.fn>}>,render:vi.fn(),cached:vi.fn()}));
vi.mock("../../speech-runtime",()=>({speechRuntime:{transport:"native",execute:mocks.execute},speechAssetUrl:(path:string)=>path}));
vi.mock("@machdoch/speech",async importOriginal=>{
  const original=await importOriginal<typeof import("@machdoch/speech")>();
  const handle={play:async()=>{},pause:()=>{},stop:()=>{},seek:()=>{},setRate:()=>{},setVolume:()=>{},onState:()=>()=>{}};
  return {...original,createSpeechPlayback:mocks.render,createAudioPlaybackHandle:mocks.cached,
    StreamingAnswerPlayback:class{update=vi.fn();retract=vi.fn();open=vi.fn(async()=>handle);constructor(){mocks.players.push(this);}},
    speechPlayback:{play:mocks.play,stop:mocks.stop,subscribe:()=>()=>{},snapshot:()=>({owner:null,itemId:null,status:"idle"}),pause:vi.fn(),resume:vi.fn(),setRate:vi.fn()},
  };
});

const profile:SpeechProfile={id:"fish",name:"Fish",backend:"fish-cloud",model:"drama-3",voiceId:"voice",direction:"",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1};
beforeEach(()=>{
  mocks.players.length=0;vi.clearAllMocks();
  mocks.execute.mockImplementation(async(operation:string)=>{
    if(operation==="listProfiles")return [profile,{...profile,id:"openai",backend:"openai",model:"gpt-4o-mini-tts"}];
    if(operation==="settings")return {answerCharacterLimit:10000,answerBudgetLimit:1,budgetLimit:2,cloudConsent:true};
    if(operation==="findAnswerAudio")return null;
    throw new Error("Unexpected speech operation "+operation);
  });
  mocks.play.mockImplementation(async(item:{open(signal:AbortSignal):Promise<unknown>})=>item.open(new AbortController().signal));
  mocks.render.mockResolvedValue({});mocks.cached.mockReturnValue({});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

function options(messages:ChatSessionMessage[]=[],settings:Partial<ShellVoiceSettings>={}):UseChatSessionVoiceOptions{return {activeSessionId:crypto.randomUUID(),settings:{autoSpeakResponses:true,speechProfileId:"fish",rate:1,answerMode:"streaming",...settings},aiVoiceSettings:{activeProvider:"fish",providerAvailability:[{provider:"fish",configured:true}]} as UserVoiceSettings,visibleMessages:messages,onSettingsChange:vi.fn(),onConversationAutoSpeakChange:vi.fn(),onConversationProfileChange:vi.fn()};}
function thinking(text:string,sequence=1,status:FinalAnswerStreamSnapshot["status"]="streaming",explicit=true):ChatSessionMessage{return {id:"thinking",taskId:"task",role:"agent",content:"Internal draft must not be spoken.",source:{kind:"thinking",thinking:{status:"running",mode:"machdoch",startedAt:0,timelineEvents:[],modelStream:{kind:"assistant",label:"Draft",content:"Internal model stream."},...(explicit?{finalAnswerStream:{source:"openai-responses",channel:"final_answer",responseId:"response",answerId:"item",sequence,text,status}}:{})}}} as ChatSessionMessage;}
function completed(markdown:string):ChatSessionMessage{return {id:"complete",taskId:"task",role:"agent",content:"Untrusted content.",source:{kind:"execution",execution:{status:"executed",response:{markdown}}}} as ChatSessionMessage;}

describe("Chat speech consumes explicit final snapshots",()=>{
  it("ignores model drafts, deduplicates snapshots and stops retracted final content",async()=>{
    const input=options();const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.streamingSupported).toBe(true));
    hook.rerender({...input,visibleMessages:[thinking("No final.",1,"streaming",false)]});expect(mocks.play).not.toHaveBeenCalled();
    hook.rerender({...input,visibleMessages:[thinking("Hello. ")]});await waitFor(()=>expect(mocks.play).toHaveBeenCalledOnce());
    expect(mocks.players[0]?.update).toHaveBeenCalledWith(expect.objectContaining({markdown:"Hello. ",complete:false}));
    const count=mocks.players[0]!.update.mock.calls.length;hook.rerender({...input,visibleMessages:[thinking("Hello. ")]});expect(mocks.players[0]!.update).toHaveBeenCalledTimes(count);
    hook.rerender({...input,visibleMessages:[thinking("",2,"retracted")]});expect(mocks.players[0]!.retract).toHaveBeenCalledOnce();expect(mocks.stop).toHaveBeenCalled();
    hook.rerender({...input,visibleMessages:[completed("Hello.")]});expect(mocks.render).not.toHaveBeenCalled();
  });

  it("primes existing history on entry and does not restart a stopped stream",async()=>{
    const input=options([thinking("Existing history. ")]);const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));expect(mocks.play).not.toHaveBeenCalled();
    const fresh={...thinking("New answer. "),taskId:"new-task",id:"new-thinking"};hook.rerender({...input,visibleMessages:[...input.visibleMessages,fresh]});await waitFor(()=>expect(mocks.play).toHaveBeenCalledOnce());
    act(()=>hook.result.current.stopSpeaking());hook.rerender({...input,visibleMessages:[...input.visibleMessages,{...fresh,source:thinking("New answer. Later.",2).source}]});expect(mocks.play).toHaveBeenCalledOnce();
  });

  it("stops a streamed answer on a new user turn and keeps late updates silent",async()=>{
    const input=options();const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));
    hook.rerender({...input,visibleMessages:[thinking("Answer. ")]});await waitFor(()=>expect(mocks.play).toHaveBeenCalledOnce());
    const user={id:"new-user",role:"user",content:"Next turn."} as ChatSessionMessage;
    hook.rerender({...input,visibleMessages:[thinking("Answer. "),user]});const count=mocks.players[0]!.update.mock.calls.length;
    hook.rerender({...input,visibleMessages:[thinking("Answer. Late.",2),user]});expect(mocks.players[0]!.update).toHaveBeenCalledTimes(count);expect(mocks.play).toHaveBeenCalledOnce();
  });

  it("uses completed mode deliberately and does not fall back when streaming is unavailable",async()=>{
    const input=options([],{speechProfileId:"openai"});const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));
    hook.rerender({...input,visibleMessages:[thinking("Final. ")]});expect(mocks.play).not.toHaveBeenCalled();expect(hook.result.current.errorText).toMatch(/Fish Cloud/);
    hook.rerender({...input,visibleMessages:[completed("Final.")]});expect(mocks.play).not.toHaveBeenCalled();
    const next={...input,activeSessionId:crypto.randomUUID(),settings:{...input.settings,answerMode:"completed" as const},visibleMessages:[]};hook.rerender(next);
    hook.rerender({...next,visibleMessages:[completed("Completed reply.")]});await waitFor(()=>expect(mocks.render).toHaveBeenCalledOnce());
  });

  it("manual replay uses a completed live take without another synthesis request",async()=>{
    const input=options();const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));
    mocks.execute.mockImplementation(async(operation:string)=>operation==="listProfiles"?[profile]:operation==="findAnswerAudio"?{asset:{path:"recorded.wav",duration:3}}:{answerCharacterLimit:10000});
    act(()=>hook.result.current.speakMessage(completed("Recorded answer.")));await waitFor(()=>expect(mocks.cached).toHaveBeenCalledOnce());expect(mocks.render).not.toHaveBeenCalled();
  });

  it("waits for the selected profile without losing a newly arriving final stream",async()=>{
    let release!:(value:SpeechProfile[])=>void;
    mocks.execute.mockImplementation(async(operation:string)=>operation==="listProfiles"?new Promise<SpeechProfile[]>(resolve=>{release=resolve;}):{answerCharacterLimit:10000});
    const input=options();const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});
    hook.rerender({...input,visibleMessages:[thinking("New final text. ")]});expect(mocks.play).not.toHaveBeenCalled();
    await act(async()=>release([profile]));await waitFor(()=>expect(mocks.play).toHaveBeenCalledOnce());
  });

  it("reports unavailable final-channel streaming without reading the completed result automatically",async()=>{
    const input=options();const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));
    hook.rerender({...input,visibleMessages:[completed("Completed by an adapter without final phase metadata.")]});
    expect(hook.result.current.errorText).toMatch(/did not provide a final-answer stream/);expect(mocks.play).not.toHaveBeenCalled();
  });

  it("keeps an older task silent when its first final event arrives after a new user turn",async()=>{
    const user={id:"newer-user",role:"user",content:"New request."} as ChatSessionMessage;
    const input=options([thinking("No explicit final channel.",1,"streaming",false),user]);
    const hook=renderHook(value=>useChatSessionVoice(value),{initialProps:input});await waitFor(()=>expect(hook.result.current.supported).toBe(true));
    hook.rerender({...input,visibleMessages:[thinking("Late first final. "),user]});expect(mocks.play).not.toHaveBeenCalled();
    hook.rerender({...input,visibleMessages:[completed("Late completed result."),user]});expect(mocks.play).not.toHaveBeenCalled();
  });
});
