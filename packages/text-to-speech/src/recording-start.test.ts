import test from "node:test";
import assert from "node:assert/strict";
import {waitForRecordingStep} from "./recording-start.ts";

test("cancelled recording setup settles immediately and releases a microphone that arrives later",async()=>{
  const controller=new AbortController();let resolve!:(value:{stop():void})=>void;let stopped=0;
  const device=new Promise<{stop():void}>(ready=>{resolve=ready;});const pending=waitForRecordingStep(device,controller.signal,value=>value.stop());controller.abort();await assert.rejects(pending,{name:"AbortError"});resolve({stop(){stopped++;}});await device;await Promise.resolve();assert.equal(stopped,1);
});

test("recording setup propagates acquisition failures and does not release adopted devices",async()=>{
  const controller=new AbortController();const failure=new Error("Device unavailable");await assert.rejects(waitForRecordingStep(Promise.reject(failure),controller.signal),error=>error===failure);
  let disposed=0;const value={id:"device"};assert.equal(await waitForRecordingStep(Promise.resolve(value),controller.signal,()=>{disposed++;}),value);controller.abort();assert.equal(disposed,0);
});

test("pre-cancelled setup releases late resolved values and handles late permission rejection",async()=>{
  const controller=new AbortController();controller.abort();let released=0;await assert.rejects(waitForRecordingStep(Promise.resolve("device"),controller.signal,()=>{released++;}),{name:"AbortError"});await Promise.resolve();assert.equal(released,1);
  let reject!:(error:unknown)=>void;const device=new Promise<void>((_,fail)=>{reject=fail;});const wait=waitForRecordingStep(device,controller.signal);await assert.rejects(wait,{name:"AbortError"});reject(new Error("Late permission rejection"));await device.catch(()=>{});
});
