import {previewPronunciation,type PronunciationDictionary,type PronunciationMatch} from "@machdoch/speech";

export interface PronunciationRequest{id:number;source:string;dictionaries:PronunciationDictionary[];page:number}
export interface PronunciationResult{id:number;from:number;to:number;matches:PronunciationMatch[];error:string|null}

self.onmessage=(event:MessageEvent<PronunciationRequest>)=>{
  const {id,source,dictionaries,page}=event.data;
  let from=page*2048,to=Math.min(source.length,from+2048);
  try{
    if(!Number.isSafeInteger(page)||page<0||from>source.length)throw new Error("Choose a text page within the pronunciation rehearsal.");
    const graphemes=new Intl.Segmenter("und",{granularity:"grapheme"}).segment(source);
    from=graphemes.containing(from)?.index??from;
    const ending=graphemes.containing(Math.max(0,to-1));if(ending)to=ending.index+ending.segment.length;
    const matches=previewPronunciation(source,dictionaries,{from,to});
    self.postMessage({id,from:Math.min(from,matches[0]?.from??from),to:Math.max(to,matches.at(-1)?.to??to),matches,error:null} satisfies PronunciationResult);
  }catch(failure){self.postMessage({id,from,to,matches:[],error:failure instanceof Error?failure.message:String(failure)} satisfies PronunciationResult);}
};
