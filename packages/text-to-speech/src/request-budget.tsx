import {speechVoiceWorkflowEstimate,type SpeechRequestPricing} from "@machdoch/speech";
import {Field} from "./controls.tsx";

export interface RequestBudgetDraft {priced:boolean;rate:string;currency:string;source:string;from:string;to:string;budget:string}
export const EMPTY_REQUEST_BUDGET:RequestBudgetDraft={priced:false,rate:"",currency:"",source:"",from:"",to:"",budget:""};

export function requestBudget(draft:RequestBudgetDraft):{pricing:SpeechRequestPricing|null;budgetLimit:number|null}{
  const pricing=draft.priced?{perRequest:draft.rate===""?NaN:Number(draft.rate),currency:draft.currency,source:draft.source,effectiveFrom:draft.from,effectiveTo:draft.to}:null;
  speechVoiceWorkflowEstimate(pricing);
  const budgetLimit=draft.budget===""?null:Number(draft.budget);
  if(budgetLimit!==null&&(!Number.isFinite(budgetLimit)||budgetLimit<0))throw new Error("Enter a nonnegative request budget.");
  if(budgetLimit!==null&&pricing===null)throw new Error("Add an account rate per request to enforce this budget.");
  return {pricing,budgetLimit};
}

export function RequestBudgetFields({draft,change}:{draft:RequestBudgetDraft;change(value:RequestBudgetDraft):void}){
  const patch=(value:Partial<RequestBudgetDraft>)=>change({...draft,...value});
  let amount:number|null=null;let error:string|null=null;
  try{amount=speechVoiceWorkflowEstimate(requestBudget(draft).pricing);}catch(failure){error=failure instanceof Error?failure.message:String(failure);}
  return <div className="tts-stack">
    <label className="tts-check"><input type="checkbox" checked={draft.priced} onChange={event=>patch({priced:event.target.checked})}/>Use account rate</label>
    {draft.priced&&<div className="tts-row">
      <Field label="Rate per request"><input type="number" min={0} step="any" required value={draft.rate} onChange={event=>patch({rate:event.target.value})}/></Field>
      <Field label="Currency"><input pattern="[A-Z]{3}" maxLength={3} required value={draft.currency} onChange={event=>patch({currency:event.target.value})}/></Field>
      <Field label="Rate source"><input maxLength={4096} required value={draft.source} onChange={event=>patch({source:event.target.value})}/></Field>
      <Field label="Effective from"><input type="date" required value={draft.from} onChange={event=>patch({from:event.target.value})}/></Field>
      <Field label="Effective to"><input type="date" required value={draft.to} onChange={event=>patch({to:event.target.value})}/></Field>
    </div>}
    <Field label="Request budget"><input type="number" min={0} step="any" value={draft.budget} onChange={event=>patch({budget:event.target.value})}/></Field>
    {error?<p role="alert">{error}</p>:<output>{amount===null?"Cost unavailable":`${amount.toLocaleString(undefined,{maximumSignificantDigits:6})} ${draft.currency} per request`}</output>}
  </div>;
}
