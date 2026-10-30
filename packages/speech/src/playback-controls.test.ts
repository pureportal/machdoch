import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudioPlaybackHandle, createSystemSpeechHandle, SpeechPlaybackCoordinator, type PlaybackHandle, type PlaybackState } from "./playback.ts";
import { createAudioSequencePlaybackHandle } from "./audio-sequence.ts";
import { createPcmPlaybackHandle } from "./pcm.ts";

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  static supportsOutput = true;
  static duration = 5;
  preload = "";
  currentTime = 0;
  duration = FakeAudio.duration;
  playbackRate = 1;
  volume = 1;
  sinkId = "";
  ended = false;
  plays = 0;
  pauses = 0;
  loads = 0;
  removed = false;
  rejectPlay: Error | undefined;
  rejectOutput: Error | undefined;
  setSinkId: ((deviceId: string) => Promise<void>) | undefined;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeAudio.instances.push(this);
    if (FakeAudio.supportsOutput) this.setSinkId = async deviceId => {
      if (this.rejectOutput) throw this.rejectOutput;
      this.sinkId = deviceId;
    };
  }
  async play(): Promise<void> {
    ++this.plays;
    if (this.rejectPlay) throw this.rejectPlay;
    this.ended = false;
  }
  pause(): void { ++this.pauses; this.dispatchEvent(new Event("pause")); }
  removeAttribute(): void { this.removed = true; }
  load(): void { ++this.loads; }
  tick(seconds: number): void { this.currentTime = seconds; this.dispatchEvent(new Event("timeupdate")); }
  finish(): void { this.currentTime = this.duration; this.ended = true; this.dispatchEvent(new Event("ended")); }
}

class FakeDevices extends EventTarget {
  available = [{kind:"audiooutput",deviceId:"speaker"}];
  async enumerateDevices(): Promise<Array<{kind:string;deviceId:string}>> { return this.available; }
}

class FakeContext {
  static instances: FakeContext[] = [];
  state = "suspended";
  sampleRate: number;
  sinkId = "";
  resumes = 0;
  closes = 0;
  onstatechange: (() => void) | null = null;
  destination = {};
  audioWorklet = {addModule: async () => {}};
  constructor(options: {sampleRate: number}) { this.sampleRate=options.sampleRate;FakeContext.instances.push(this); }
  createGain() { return {gain:{value:1,setValueAtTime() {}},connect() {},disconnect() {}}; }
  async resume(): Promise<void> { ++this.resumes;this.state="running";this.onstatechange?.(); }
  async suspend(): Promise<void> { this.state="suspended";this.onstatechange?.(); }
  async close(): Promise<void> { ++this.closes;this.state="closed";this.onstatechange?.(); }
  async setSinkId(deviceId: string): Promise<void> { this.sinkId=deviceId; }
}

class FakeWorkletNode {
  parameters = new Map([["playing",{setValueAtTime(){}}],["rate",{setValueAtTime(){}}]]);
  port = {
    onmessage: null as ((event: {data: unknown}) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: (message: {id?:number;type:string;samples?:Float32Array}) => {
      if (message.id === undefined) return;
      queueMicrotask(() => this.port.onmessage?.({data:{id:message.id,bufferedFrames:message.samples ? message.samples.length : 1,playedFrames:0,underrunFrames:0,underrunCount:0,maxBufferedFrames:2,ended:false}}));
    },
    close() {},
  };
  onprocessorerror: (() => void) | null = null;
  connect() {}
  disconnect() {}
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function withAudio(run: (devices: FakeDevices) => Promise<void>): Promise<void> {
  const saved = new Map<string,PropertyDescriptor | undefined>();
  const devices = new FakeDevices();
  for (const [name,value] of Object.entries({Audio:FakeAudio,navigator:{mediaDevices:devices},AudioContext:FakeContext,AudioWorkletNode:FakeWorkletNode})) {
    saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  }
  FakeAudio.instances=[];
  FakeAudio.supportsOutput=true;
  FakeAudio.duration=5;
  FakeContext.instances=[];
  try { await run(devices); }
  finally {
    for (const [name,descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else Reflect.deleteProperty(globalThis,name);
    }
  }
}

test("coordinator preserves preferences, validates bounds and copies loop state", async () => withAudio(async () => {
  const coordinator = new SpeechPlaybackCoordinator();
  coordinator.setVolume(0.25);
  coordinator.setRate(1.5);
  let opens = 0;
  const item = {owner:"tts",itemId:"asset",open:async (signal:AbortSignal) => {++opens;return createAudioPlaybackHandle("asset.wav",{signal});}};
  await coordinator.play(item);
  const audio = FakeAudio.instances[0]!;
  assert.equal(audio.volume,0.25);
  assert.equal(audio.playbackRate,1.5);
  assert.equal(coordinator.snapshot().loopAvailable,true);
  coordinator.seek(1);
  assert.equal(coordinator.snapshot().position,1);
  assert.throws(() => coordinator.seek(6),/duration/);
  for (const value of [-1,2,NaN]) assert.throws(() => coordinator.setVolume(value),/volume/);
  for (const selection of [{start:-1,end:1},{start:1,end:1},{start:1,end:6},{start:NaN,end:2}]) assert.throws(() => coordinator.setLoop(selection),/loop/);
  const selection = {start:1,end:3};
  coordinator.setLoop(selection);
  selection.start=2;
  const snapshot = coordinator.snapshot();
  snapshot.loop!.start=2.5;
  assert.deepEqual(coordinator.snapshot().loop,{start:1,end:3});
  audio.tick(3.2);
  assert.equal(audio.currentTime,1);
  assert.throws(() => coordinator.seek(0),/loop/);
  coordinator.setLoop(null);
  coordinator.seek(4);
  await coordinator.setOutputDevice("speaker");
  assert.equal(coordinator.snapshot().outputDeviceId,"speaker");
  assert.equal(opens,1);
  coordinator.stop();
  assert.equal(coordinator.snapshot().loop,null);
  assert.equal(coordinator.snapshot().outputDeviceSupported,false);
}));

test("blocked playback, device loss and media errors recover on the same audio", async () => withAudio(async devices => {
  const coordinator = new SpeechPlaybackCoordinator();
  let opens=0;
  await coordinator.play({owner:"chat",itemId:"answer",open:async signal => {
    ++opens;
    const handle=createAudioPlaybackHandle("answer.wav",{signal});
    FakeAudio.instances[0]!.rejectPlay=new DOMException("Gesture required","NotAllowedError");
    return handle;
  }});
  const audio=FakeAudio.instances[0]!;
  assert.equal(coordinator.snapshot().status,"blocked");
  audio.rejectPlay=undefined;
  await coordinator.resume();
  coordinator.seek(2);
  await coordinator.setOutputDevice("speaker");
  devices.available=[];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.equal(coordinator.snapshot().status,"blocked");
  assert.equal(audio.currentTime,2);
  assert.equal(audio.removed,false);
  await coordinator.setOutputDevice("");
  await coordinator.resume();
  assert.equal(coordinator.snapshot().status,"playing");
  audio.dispatchEvent(new Event("error"));
  assert.equal(coordinator.snapshot().status,"failed");
  await coordinator.resume();
  assert.equal(coordinator.snapshot().status,"playing");
  assert.equal(opens,1);
  assert.equal(FakeAudio.instances.length,1);
  assert.equal(audio.loads,0);
  coordinator.stop();
}));

test("output selection is exposed only when supported and rejected choices keep the selected device", async () => withAudio(async () => {
  FakeAudio.supportsOutput=false;
  const coordinator=new SpeechPlaybackCoordinator();
  await coordinator.play({owner:"tts",itemId:"unsupported",open:async signal => createAudioPlaybackHandle("a.wav",{signal})});
  assert.equal(coordinator.snapshot().outputDeviceSupported,false);
  await assert.rejects(coordinator.setOutputDevice("speaker"),/unavailable/);
  coordinator.stop();
  FakeAudio.supportsOutput=true;
  await coordinator.play({owner:"tts",itemId:"supported",open:async signal => createAudioPlaybackHandle("b.wav",{signal})});
  const audio=FakeAudio.instances.at(-1)!;
  await coordinator.setOutputDevice("speaker");
  audio.rejectOutput=new DOMException("Denied","NotAllowedError");
  await assert.rejects(coordinator.setOutputDevice("missing"),/Denied/);
  assert.equal(coordinator.snapshot().outputDeviceId,"speaker");
  assert.equal(audio.sinkId,"speaker");
  coordinator.stop();
}));

test("audio loops at the end, pauses without restarting, clears and removes listeners on stop", async () => withAudio(async devices => {
  const handle=createAudioPlaybackHandle("loop.wav");
  const audio=FakeAudio.instances[0]!;
  let state:Partial<PlaybackState>={};
  handle.onState(patch => {state={...state,...patch};});
  handle.setLoop!({start:2,end:5});
  await handle.play();
  audio.finish();
  await settle();
  assert.equal(audio.currentTime,2);
  assert.equal(state.status,"playing");
  handle.pause();
  const plays=audio.plays;
  await settle();
  assert.equal(audio.plays,plays);
  handle.setLoop!(null);
  audio.finish();
  assert.equal(state.status,"idle");
  await handle.setOutputDevice!("speaker");
  handle.stop();
  devices.available=[];
  devices.dispatchEvent(new Event("devicechange"));
  audio.tick(4);
  await settle();
  assert.equal(audio.loads,1);
  assert.equal(state.status,"idle");
}));

test("unknown or unbounded media duration cannot be looped or sought", async () => withAudio(async () => {
  const handle=createAudioPlaybackHandle("live");
  const audio=FakeAudio.instances[0]!;
  for (const duration of [NaN,Infinity,0]) {
    audio.duration=duration;
    assert.throws(() => handle.setLoop!({start:0,end:1}),/completed/);
    assert.throws(() => handle.seek(1),/unavailable/);
  }
  handle.stop();
}));

test("sequence loops across clips and retains rate, volume and output for each clip", async () => withAudio(async () => {
  const handle=createAudioSequencePlaybackHandle([{url:"first.wav",duration:5},{url:"second.wav",duration:5}],{rate:1,signal:new AbortController().signal});
  let state:Partial<PlaybackState>={};
  handle.onState(patch => {state={...state,...patch};});
  handle.setVolume(0.4);
  handle.setRate(1.25);
  await handle.setOutputDevice!("speaker");
  handle.setLoop!({start:4,end:7});
  await handle.play();
  const first=FakeAudio.instances[0]!;
  assert.equal(first.currentTime,4);
  first.finish();
  await settle();
  const second=FakeAudio.instances[1]!;
  assert.equal(second.url,"second.wav");
  assert.equal(second.volume,0.4);
  assert.equal(second.playbackRate,1.25);
  assert.equal(second.sinkId,"speaker");
  assert.equal(second.plays,1);
  second.tick(2.1);
  await settle();
  const repeated=FakeAudio.instances[2]!;
  assert.equal(repeated.url,"first.wav");
  assert.equal(repeated.currentTime,4);
  assert.equal(repeated.sinkId,"speaker");
  assert.equal(state.position,4);
  assert.deepEqual(state.loop,{start:4,end:7});
  assert.throws(() => handle.seek(8),/loop/);
  handle.pause();
  const before=FakeAudio.instances.length;
  await handle.play();
  assert.equal(FakeAudio.instances.length,before);
  handle.stop();
}));

test("sequence ending at a clip boundary loops instead of advancing", async () => withAudio(async () => {
  const handle=createAudioSequencePlaybackHandle([{url:"first.wav",duration:5},{url:"second.wav",duration:5}],{rate:1,signal:new AbortController().signal});
  handle.setLoop!({start:2,end:5});
  await handle.play();
  FakeAudio.instances[0]!.finish();
  await settle();
  assert.equal(FakeAudio.instances.length,1);
  assert.equal(FakeAudio.instances[0]!.currentTime,2);
  handle.stop();
}));

test("output completion for a stopped item cannot overwrite the next item", async () => {
  const coordinator=new SpeechPlaybackCoordinator();
  let release!:()=>void;
  const stale:PlaybackHandle={
    play:async()=>{},pause:()=>{},stop:()=>{},seek:()=>{},setRate:()=>{},setVolume:()=>{},
    setOutputDevice:()=>new Promise<void>(resolve=>{release=resolve;}),
    onState:listener=>{listener({seekable:false});return()=>{};},
  };
  await coordinator.play({owner:"tts",itemId:"old",open:async()=>stale});
  const pending=coordinator.setOutputDevice("old-device");
  await coordinator.play({owner:"chat",itemId:"new",open:async()=>({...stale,setOutputDevice:undefined})});
  release();
  await pending;
  assert.equal(coordinator.snapshot().itemId,"new");
  assert.equal(coordinator.snapshot().outputDeviceId,undefined);
  coordinator.stop();
});

test("PCM suspend and device loss retain the source, context and queued playback", async () => withAudio(async devices => {
  const controller=new AbortController();
  const pulls:number[]=[];
  const handle=await createPcmPlaybackHandle(async offset => {
    pulls.push(offset);
    return {audioBase64:offset===0 ? "AAAAAA==" : "",nextOffset:4,complete:false,sampleRate:8000,channels:1};
  },controller.signal);
  try {
  let state:Partial<PlaybackState>={};
  handle.onState(patch=>{state={...state,...patch};});
  assert.equal(state.seekable,false);
  assert.equal(handle.setLoop,undefined);
  assert.throws(()=>handle.seek(1),/seek/i);
  await handle.setOutputDevice!("speaker");
  await handle.play();
  await settle();
  const context=FakeContext.instances[0]!;
  await context.suspend();
  assert.equal(state.status,"blocked");
  await handle.play();
  assert.equal(context.resumes,2);
  assert.equal(FakeContext.instances.length,1);
  assert.equal(context.closes,0);
  assert.equal(pulls.filter(offset=>offset===0).length,1);
  devices.available=[];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.equal(state.status,"blocked");
  assert.equal(context.closes,0);
  await handle.setOutputDevice!("");
  await handle.play();
  assert.equal(FakeContext.instances.length,1);
  assert.equal(context.resumes,3);
  } finally {controller.abort();}
}));

test("system speech reports seeking, looping and output selection unavailable", async () => {
  const savedSynth=Object.getOwnPropertyDescriptor(globalThis,"speechSynthesis");
  const savedUtterance=Object.getOwnPropertyDescriptor(globalThis,"SpeechSynthesisUtterance");
  class FakeUtterance { rate=1;volume=1; }
  let speaks=0;
  let resumes=0;
  Object.defineProperty(globalThis,"speechSynthesis",{value:{speak:()=>{++speaks;},resume:()=>{++resumes;},pause:()=>{},cancel:()=>{}},configurable:true});
  Object.defineProperty(globalThis,"SpeechSynthesisUtterance",{value:FakeUtterance,configurable:true});
  const coordinator=new SpeechPlaybackCoordinator();
  try {
    await coordinator.play({owner:"chat",itemId:"system",open:async()=>createSystemSpeechHandle("Hello")});
    assert.equal(coordinator.snapshot().seekable,false);
    assert.equal(coordinator.snapshot().loopAvailable,false);
    assert.equal(coordinator.snapshot().outputDeviceSupported,false);
    assert.throws(()=>coordinator.seek(1),/unavailable/);
    assert.throws(()=>coordinator.setLoop({start:0,end:1}),/unavailable/);
    await assert.rejects(coordinator.setOutputDevice("speaker"),/unavailable/);
    coordinator.pause();
    await coordinator.resume();
    assert.equal(speaks,1);
    assert.equal(resumes,1);
  } finally {
    coordinator.stop();
    if(savedSynth)Object.defineProperty(globalThis,"speechSynthesis",savedSynth);else Reflect.deleteProperty(globalThis,"speechSynthesis");
    if(savedUtterance)Object.defineProperty(globalThis,"SpeechSynthesisUtterance",savedUtterance);else Reflect.deleteProperty(globalThis,"SpeechSynthesisUtterance");
  }
});

test("sequence seeking uses measured clip durations before metadata loads", async () => withAudio(async () => {
  FakeAudio.duration=NaN;
  const handle=createAudioSequencePlaybackHandle([{url:"a.wav",duration:5},{url:"b.wav",duration:5}],{rate:1,signal:new AbortController().signal});
  handle.seek(7);
  assert.equal(FakeAudio.instances[1]!.currentTime,2);
  handle.setLoop!({start:6,end:9});
  await handle.play();
  FakeAudio.instances[1]!.tick(4.1);
  assert.equal(FakeAudio.instances[1]!.currentTime,1);
  handle.stop();
}));

test("creates a coordinator outside a secure context", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const { getRandomValues } = globalThis.crypto;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: getRandomValues.bind(globalThis.crypto) },
  });
  assert.doesNotThrow(() => new SpeechPlaybackCoordinator());
});
