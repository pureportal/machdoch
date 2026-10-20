import assert from "node:assert/strict";
import test from "node:test";
import {PlaybackMeasurements,PlaybackMetrics,persistPlaybackMetrics} from "./playback-metrics.ts";

test("playback measurements separate opening, first render and acknowledged control clocks",()=>{
  let now=100;const metrics=new PlaybackMetrics(20,()=>now);const session=metrics.startSession();now=130;
  const source=new PlaybackMeasurements("pcm");session.opened(source);
  assert.deepEqual(metrics.snapshot().map(value=>value.event),["intent","opened"]);
  source.emit({type:"first-render",atMs:170});source.emit({type:"first-render",atMs:171});
  source.emit({type:"pause-ack",requestedAtMs:180,atMs:193});source.emit({type:"pcm-buffer",atMs:200,sampleRate:8000,maxBufferedFrames:40000,underrunFrames:256,underrunCount:2});
  source.emit({type:"stop-ack",requestedAtMs:210,atMs:232});source.emit({type:"first-render",atMs:240});
  const samples=metrics.snapshot();const first=samples.find(sample=>sample.event==="first-render")!;assert.equal(first.timeToFirstAudioMs,70);assert.equal(first.openToFirstAudioMs,40);
  assert.equal(samples.filter(sample=>sample.event==="first-render").length,1);
  assert.equal(samples.find(sample=>sample.event==="pause-ack")!.latencyMs,13);assert.equal(samples.find(sample=>sample.event==="stop-ack")!.latencyMs,22);
  assert.equal(samples.find(sample=>sample.event==="pcm-buffer")!.maxBufferedAudioMs,5000);
  assert.equal(new Set(samples.map(sample=>sample.sessionId)).size,1);assert.equal(new Set(samples.map(sample=>sample.id)).size,samples.length);
  assert.equal(samples.some(sample=>Object.keys(sample).some(key=>["owner","itemId","script","audio","voiceId","url"].includes(key))),false);
});

test("valid sample receipt can precede handle opening and is distinct from rendering",()=>{
  let now=100;const metrics=new PlaybackMetrics(20,()=>now);const session=metrics.startSession();const source=new PlaybackMeasurements("pcm");source.emit({type:"first-samples",atMs:110});now=130;session.opened(source);source.emit({type:"first-samples",atMs:140});
  const samples=metrics.snapshot();const received=samples.find(value=>value.event==="first-samples")!;assert.equal(received.timeToFirstSamplesMs,10);assert.equal(samples.filter(value=>value.event==="first-samples").length,1);assert.equal(samples.filter(value=>value.event==="first-render").length,0);
});

test("metric retention is bounded and rejects invalid buffers and negative acknowledgments",()=>{
  const metrics=new PlaybackMetrics(2,()=>10);let notifications=0;const unsubscribe=metrics.subscribe(()=>notifications++);const source=new PlaybackMeasurements("pcm");metrics.startSession().opened(source);
  assert.throws(()=>source.emit({type:"pcm-buffer",atMs:11,sampleRate:8000,maxBufferedFrames:40001,underrunFrames:0,underrunCount:0}),/Invalid PCM/);
  assert.throws(()=>source.emit({type:"pause-ack",requestedAtMs:13,atMs:12}),/acknowledgement/);
  source.emit({type:"first-render",atMs:14});assert.equal(metrics.snapshot().length,2);assert.equal(notifications,3);unsubscribe();source.emit({type:"stop-ack",requestedAtMs:15,atMs:16});assert.equal(notifications,3);
  assert.ok(metrics.snapshot().every(Object.isFrozen));
});

test("persistent observations use bounded serialized writes and report failures without replay",async()=>{
  const metrics=new PlaybackMetrics(512,()=>10);const batches:number[]=[];const errors:string[]=[];let release!:()=>void;let writing=0;let maximum=0;
  const stop=persistPlaybackMetrics(metrics,async samples=>{writing++;maximum=Math.max(maximum,writing);batches.push(samples.length);if(batches.length===1)await new Promise<void>(resolve=>{release=resolve;});writing--;if(batches.length===2)throw new Error("Synthetic persistence failure");},message=>errors.push(message));
  metrics.startSession();await Promise.resolve();for(let i=0;i<300;i++)metrics.startSession();assert.ok(errors.some(message=>message.includes("overloaded")));release();for(let i=0;i<50;i++)await Promise.resolve();
  assert.equal(maximum,1);assert.ok(batches.every(length=>length<=32));assert.equal(batches.reduce((a,b)=>a+b,0),257);assert.equal(errors.filter(message=>message.includes("could not be stored")).length,1);const before=batches.length;stop();metrics.startSession();await Promise.resolve();assert.equal(batches.length,before);
});
