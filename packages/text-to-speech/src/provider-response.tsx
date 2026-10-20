import type {SpeechProviderResponse} from "@machdoch/speech";
import {Fragment} from "react";

const TOKEN_FIELDS=[
  ["promptTokenCount","Prompt tokens"],["cachedContentTokenCount","Cached prompt tokens"],
  ["candidatesTokenCount","Output tokens"],["toolUsePromptTokenCount","Tool prompt tokens"],
  ["thoughtsTokenCount","Thinking tokens"],["totalTokenCount","Total tokens"],
] as const;

export function ProviderResponseFields({response}:{response:SpeechProviderResponse|undefined}){
  if(!response)return null;
  if(response.provider==="openai")return <>
    {response.requestId&&<><dt>Provider request</dt><dd>{response.requestId}</dd></>}
    {response.processingMs!==undefined&&<><dt>Provider processing</dt><dd>{response.processingMs.toLocaleString()} ms</dd></>}
  </>;
  if(response.provider==="sglang")return <>
    <dt>Runtime request</dt><dd>{response.requestId}</dd>
    {([["input_tokens","Input tokens"],["output_tokens","Output tokens"],["total_tokens","Total tokens"]] as const).map(([key,label])=>response.usage?.[key]===undefined?null:<Fragment key={key}><dt>{label}</dt><dd>{response.usage[key]!.toLocaleString()}</dd></Fragment>)}
  </>;
  return <>
    {response.modelVersion&&<><dt>Returned model version</dt><dd>{response.modelVersion}</dd></>}
    {response.responseId&&<><dt>Provider response</dt><dd>{response.responseId}</dd></>}
    {TOKEN_FIELDS.map(([key,label])=>response.usageMetadata?.[key]===undefined?null:<Fragment key={key}><dt>{label}</dt><dd>{response.usageMetadata[key]!.toLocaleString()}</dd></Fragment>)}
  </>;
}
