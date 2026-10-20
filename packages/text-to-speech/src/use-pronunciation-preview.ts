import {useEffect,useRef,useState} from "react";
import type {PronunciationDictionary} from "@machdoch/speech";
import type {PronunciationRequest,PronunciationResult} from "./pronunciation-worker.ts";

export function usePronunciationPreview(source:string,dictionaries:PronunciationDictionary[],page:number){
  const transport=useRef<{worker:Worker;active:PronunciationRequest|null;pending:PronunciationRequest|null}|null>(null);
  const latest=useRef(0);
  const [result,setResult]=useState<{input:PronunciationRequest;output:PronunciationResult}|null>(null);
  const [failed,setFailed]=useState<string|null>(null);
  const [restart,setRestart]=useState(0);
  useEffect(()=>{
    const worker=new Worker(new URL("./pronunciation-worker.ts",import.meta.url),{type:"module"});
    const state={worker,active:null as PronunciationRequest|null,pending:null as PronunciationRequest|null};transport.current=state;setFailed(null);
    worker.onmessage=(event:MessageEvent<PronunciationResult>)=>{
      if(!state.active||event.data.id!==state.active.id){setFailed("Pronunciation preview returned an unexpected result. Reload the preview.");return;}
      if(event.data.id===latest.current)setResult({input:state.active,output:event.data});
      state.active=state.pending;state.pending=null;if(state.active)worker.postMessage(state.active);
    };
    worker.onerror=worker.onmessageerror=()=>{setFailed("Pronunciation preview stopped. Reload the preview.");worker.terminate();};
    return()=>{transport.current=null;worker.terminate();};
  },[restart]);
  useEffect(()=>{
    const state=transport.current;if(!state)return;
    const input={id:++latest.current,source,dictionaries,page};
    if(state.active)state.pending=input;else{state.active=input;state.worker.postMessage(input);}
  },[source,dictionaries,page,restart]);
  const current=result?.input.source===source&&result.input.dictionaries===dictionaries&&result.input.page===page?result.output:null;
  return {result:current,error:failed??current?.error??null,reload:()=>setRestart(value=>value+1)};
}
