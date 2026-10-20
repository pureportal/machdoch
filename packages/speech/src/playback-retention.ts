import type {PlaybackHandle,PlaybackState} from "./playback.ts";
import type {SpeechRuntime} from "./runtime.ts";

export async function retainSpeechPlayback(
  runtime:SpeechRuntime,
  resources:{owner:string;assetIds?:string[];jobIds?:string[]},
  signal:AbortSignal,
  open:()=>PlaybackHandle|Promise<PlaybackHandle>,
  onError:(message:string)=>void,
):Promise<PlaybackHandle>{
  signal.throwIfAborted();
  const id=crypto.randomUUID();
  const assetIds=[...new Set(resources.assetIds??[])],jobIds=[...new Set(resources.jobIds??[])];
  const listeners=new Set<(state:Partial<PlaybackState>)=>void>();
  let handle:PlaybackHandle|undefined,unlisten:(()=>void)|undefined;
  let timer:ReturnType<typeof setInterval>|undefined;
  let stopped=false,renewing=false,failure:string|null=null;
  let tail:Promise<unknown>=Promise.resolve();
  const ordered=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=tail.then(operation,operation);tail=result;return result;};
  const retain=(full:boolean):Promise<unknown>=>ordered(()=>runtime.execute("retainPlayback",{id,owner:resources.owner,assetIds:full?assetIds:[],jobIds:full?jobIds:[]}));
  const clear=():void=>{if(timer!==undefined)clearInterval(timer);timer=undefined;};
  const release=():void=>{void ordered(()=>runtime.execute("releasePlayback",{id,owner:resources.owner})).catch(()=>onError("Playback protection could not be released. The runtime will expire it after ten minutes."));};
  const failed=(error:unknown):void=>{
    if(stopped)return;
    clear();handle?.pause();failure=error instanceof Error?error.message:"Playback protection failed. Open the cached audio again.";
    for(const listener of listeners)listener({status:"failed",error:failure});
    onError(failure);release();
  };
  const renew=():void=>{if(timer!==undefined)return;timer=setInterval(()=>{if(renewing)return;renewing=true;void retain(false).catch(failed).finally(()=>{renewing=false;});},60_000);};
  const stop=():void=>{if(stopped)return;stopped=true;clear();signal.removeEventListener("abort",stop);unlisten?.();handle?.stop();listeners.clear();release();};
  signal.addEventListener("abort",stop,{once:true});
  try{
    await retain(true);
    if(stopped||signal.aborted)throw new DOMException("Speech playback stopped.","AbortError");
    handle=await open();
    if(stopped||signal.aborted){handle.stop();throw new DOMException("Speech playback stopped.","AbortError");}
    unlisten=handle.onState(state=>{
      if(state.status==="idle"){clear();release();}
      if(state.status==="failed"){clear();release();}
    });
    renew();
    const opened=handle;
    return {
      ...opened,
      play:async()=>{if(stopped)throw new DOMException("Speech playback stopped.","AbortError");try{await retain(true);}catch(error){failed(error);throw error;}if(stopped||signal.aborted)throw new DOMException("Speech playback stopped.","AbortError");failure=null;renew();await opened.play();},
      stop,
      onState:listener=>{listeners.add(listener);const unsubscribe=opened.onState(state=>{if(!stopped)listener(failure?{...state,status:"failed",error:failure}:state);});return()=>{listeners.delete(listener);unsubscribe();};},
    };
  }catch(error){stop();throw error;}
}
