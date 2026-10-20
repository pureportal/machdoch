export function waitForRecordingStep<T>(step:Promise<T>,signal:AbortSignal,releaseLate?:(value:T)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cancel=()=>{if(settled)return;settled=true;signal.removeEventListener("abort",cancel);reject(new DOMException("Recording setup cancelled.","AbortError"));};
    signal.addEventListener("abort",cancel,{once:true});
    void step.then(value=>{
      signal.removeEventListener("abort",cancel);
      if(settled||signal.aborted){releaseLate?.(value);return;}
      settled=true;resolve(value);
    },error=>{signal.removeEventListener("abort",cancel);if(!settled){settled=true;reject(error);}});
    if(signal.aborted)cancel();
  });
}
