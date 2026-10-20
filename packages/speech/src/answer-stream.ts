import { answerSpeechRevision, IncrementalAnswerSpeech, isFinalAnswerEvent, markdownToSpeech, type FinalAnswerEvent } from "./answer.ts";
import { createPcmPlaybackHandle } from "./pcm.ts";
import type { PlaybackHandle } from "./playback.ts";
import type { SpeechOperations, SpeechRenderInput, SpeechRuntime } from "./runtime.ts";
import {retainSpeechPlayback} from "./playback-retention.ts";

export interface StreamingAnswerOptions {
  input:Omit<SpeechRenderInput,"segments"|"takes"|"reuseCache">;
  maxCharacters:number;
  rate:number;
  voiceIds:string[];
  referenceAssetIds:string[];
  onError(message:string):void;
}

function delay(signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const cancelled=():void=>{clearTimeout(timer);reject(new DOMException("Answer speech stopped.","AbortError"));};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",cancelled);resolve();},100);
    signal.addEventListener("abort",cancelled,{once:true});
    if(signal.aborted)cancelled();
  });
}

export class StreamingAnswerPlayback {
  private latest:FinalAnswerEvent|undefined;
  private previous:FinalAnswerEvent|undefined;
  private wake:(()=>void)|undefined;
  private readonly controller=new AbortController();
  private started=false;
  private failure:Error|undefined;
  private cancelled:Promise<unknown>|undefined;
  private jobId:string|undefined;
  private runtime:SpeechRuntime|undefined;
  private owner:string|undefined;
  private errorListener:((message:string)=>void)|undefined;

  update(event:FinalAnswerEvent):void{
    if(!isFinalAnswerEvent(event)||this.controller.signal.aborted)return;
    if(new TextEncoder().encode(event.markdown).length>1024*1024){this.retract("This answer exceeds the local streaming text limit. Read a shorter selection.");return;}
    const previous=this.previous;
    if(previous&&(previous.sessionId!==event.sessionId||previous.answerId!==event.answerId||previous.revision!==event.revision||!event.markdown.startsWith(previous.markdown)||previous.complete&&event.markdown!==previous.markdown)){
      this.retract("The answer changed after speech was committed. Replay the corrected answer deliberately.");return;
    }
    if(previous?.complete&&!event.complete)return;
    this.previous=event;
    this.latest=event;
    this.wake?.();
  }

  retract(message:string):void{
    if(this.controller.signal.aborted)return;
    this.failure=new Error(message);
    this.controller.abort();
    this.wake?.();
    this.errorListener?.(message);
    void this.cancel().catch(()=>this.errorListener?.("Speech cancellation could not reach the runtime. Stop the job in Jobs."));
  }

  private cancel():Promise<unknown>{
    if(!this.jobId||!this.runtime||!this.owner)return Promise.resolve();
    this.cancelled??=this.runtime.execute("cancel",{jobId:this.jobId,owner:this.owner});
    return this.cancelled;
  }

  async open(runtime:SpeechRuntime,options:StreamingAnswerOptions,signal:AbortSignal,playback:typeof createPcmPlaybackHandle=createPcmPlaybackHandle):Promise<PlaybackHandle>{
    if(this.started)throw new Error("This answer stream already has a playback owner.");
    if(!Number.isSafeInteger(options.maxCharacters)||options.maxCharacters<1||options.maxCharacters>100_000)throw new Error("Choose an answer limit from 1 to 100,000 characters for streaming speech.");
    this.started=true;
    this.runtime=runtime;this.owner=options.input.owner;this.errorListener=options.onError;
    const stop=():void=>{this.controller.abort();this.wake?.();void this.cancel().catch(()=>options.onError("Speech cancellation could not reach the runtime. Stop the job in Jobs."));};
    signal.addEventListener("abort",stop,{once:true});
    if(signal.aborted)stop();
    const active=this.controller.signal;
    let resolveHandle!:(value:PlaybackHandle)=>void;
    let rejectHandle!:(error:unknown)=>void;
    const ready=new Promise<PlaybackHandle>((resolve,reject)=>{resolveHandle=resolve;rejectHandle=reject;});
    const pump=async():Promise<void>=>{
      const parser=new IncrementalAnswerSpeech();
      let sequence=1;
      let sent="";
      let opening:Promise<void>|undefined;
      const append=async(request:SpeechOperations["appendLive"]["input"]):Promise<void>=>{
        for(;;){
          active.throwIfAborted();
          const result=await runtime.execute("appendLive",request);
          active.throwIfAborted();
          if(result.accepted){if(result.nextSequence!==request.sequence+1||result.finished!==request.finish)throw new Error("The live answer acknowledgement is inconsistent. Stop and inspect Jobs.");return;}
          if(result.nextSequence!==request.sequence)throw new Error("The live answer sequence changed. Stop and replay deliberately.");
          await delay(active);
        }
      };
      for(;;){
        active.throwIfAborted();
        if(!this.latest){await new Promise<void>(resolve=>{this.wake=resolve;if(this.latest||active.aborted)resolve();});this.wake=undefined;continue;}
        const event=this.latest;this.latest=undefined;
        const parsed=parser.update(event);
        if(parsed.replaced)throw new Error("The answer changed. Replay the corrected answer deliberately.");
        for(const span of parsed.segments){
          const addition=(sent?" ":"")+span.text;
          if(Array.from(sent).length+Array.from(addition).length>options.maxCharacters)throw new Error("This answer reached the speech limit. Read a shorter selection or change the answer limit in Text to Speech.");
          const characters=Array.from(addition);
          for(let index=0;index<characters.length;index+=512){
            active.throwIfAborted();
            const text=characters.slice(index,index+512).join("");
            if(!this.jobId){
              const job=await runtime.execute("beginLive",{...options.input,maxCharacters:options.maxCharacters,takes:1,reuseCache:false,segments:[{id:event.answerId,text,spokenText:text,chapter:null,voiceIds:options.voiceIds,referenceAssetIds:options.referenceAssetIds}]});
              this.jobId=job.id;
              if(active.aborted){await this.cancel();active.throwIfAborted();}
              opening=retainSpeechPlayback(runtime,{owner:options.input.owner,jobIds:[job.id]},active,()=>playback((offset,maxBytes,pullSignal)=>{pullSignal.throwIfAborted();return runtime.execute("readAudio",{jobId:job.id,owner:options.input.owner,segmentId:event.answerId,offset,maxBytes});},active),options.onError).then(handle=>{
                if(active.aborted){handle.stop();active.throwIfAborted();}
                handle.setRate(options.rate);
                resolveHandle({...handle,stop:()=>{handle.stop();stop();signal.removeEventListener("abort",stop);}});
              });
              void opening.catch(error=>{this.failure=error instanceof Error?error:new Error("The speech device could not open.");stop();});
            }else await append({jobId:this.jobId,owner:options.input.owner,sequence:sequence++,text,finish:false});
            sent+=text;
          }
        }
        if(event.complete){
          if(!this.jobId)throw new Error("This answer has no speakable text.");
          const finalText=markdownToSpeech(event.markdown);
          if(sent.trim()!==finalText)throw new Error("The completed answer differs from committed speech. Replay the corrected answer deliberately.");
          await append({jobId:this.jobId,owner:options.input.owner,sequence,text:"",finish:true,answerRevision:answerSpeechRevision(event.markdown.trim()),finalText});
          await opening;
          return;
        }
      }
    };
    void pump().catch(async error=>{
      const failure=this.failure??error;
      this.controller.abort();
      try{await this.cancel();}catch{options.onError("Speech cancellation could not reach the runtime. Stop the job in Jobs.");}
      if(this.failure||!signal.aborted&&!(failure instanceof Error&&failure.name==="AbortError"))options.onError(failure instanceof Error?failure.message:"Streaming speech failed. Read the completed answer deliberately.");
      rejectHandle(failure);
      signal.removeEventListener("abort",stop);
    });
    return ready;
  }
}
