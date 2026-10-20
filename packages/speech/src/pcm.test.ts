import assert from "node:assert/strict";
import test from "node:test";
import { createPcmPlaybackHandle, Pcm16Decoder } from "./pcm.ts";
import type { PcmPullSource } from "./pcm.ts";
import type { PlaybackState } from "./playback.ts";

const { PcmRing } = await import(new URL("./pcm-worklet.js", import.meta.url).href);

test("actual PCM processor measures first rendering and starvation bursts separately from append acknowledgments",async t=>{
  const names=["AudioWorkletProcessor","registerProcessor","sampleRate"] as const;
  const descriptors=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
  let Processor:new(options:unknown)=>{port:{onmessage(event:unknown):void};process(inputs:unknown[],outputs:Float32Array[][],parameters:Record<string,number[]>):boolean};
  const messages:Record<string,unknown>[]=[];
  class Base{port={onmessage:(_event:unknown)=>{},postMessage:(value:Record<string,unknown>)=>messages.push(value)};}
  Object.defineProperty(globalThis,"AudioWorkletProcessor",{configurable:true,value:Base});Object.defineProperty(globalThis,"sampleRate",{configurable:true,value:8000});Object.defineProperty(globalThis,"registerProcessor",{configurable:true,value:(_name:string,constructor:typeof Processor)=>{Processor=constructor;}});
  t.after(()=>{for(const [name,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
  await import(new URL("./pcm-worklet.js?measurement-verification",import.meta.url).href);
  const processor=new Processor!({processorOptions:{channels:1,capacityFrames:40000}});const outputs=[[new Float32Array(4)]];
  processor.process([],outputs,{playing:[1],playbackRate:[1]});assert.equal(messages.length,0);
  processor.port.onmessage({data:{type:"append",id:1,samples:new Float32Array([1,2,3,4,5]),complete:false}});assert.equal(messages.length,1);assert.equal(messages[0].playedFrames,0);
  processor.process([],outputs,{playing:[1],playbackRate:[1]});processor.process([],outputs,{playing:[1],playbackRate:[1]});processor.process([],outputs,{playing:[1],playbackRate:[1]});processor.port.onmessage({data:{type:"state",id:2}});
  assert.equal(messages.filter(value=>value.type==="first-render").length,1);assert.equal(messages.at(-1)!.maxBufferedFrames,5);assert.equal(messages.at(-1)!.underrunCount,2);assert.equal(messages.at(-1)!.underrunFrames,11);
});

function pcmBytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function response(bytes: Uint8Array, offset: number, complete = false) {
  return { audioBase64: Buffer.from(bytes).toString("base64"), nextOffset: offset + bytes.length, complete, sampleRate: 8000, channels: 1 };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

test("s16le mono and stereo decode across every split and single-byte fragments", () => {
  const samples = [-32768, 32767, -1, 0, 256, -256, 16384, -16384];
  const bytes = pcmBytes(samples);
  for (const channels of [1, 2]) {
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new Pcm16Decoder(channels);
      const actual = [...decoder.decode(bytes.slice(0, split)), ...decoder.decode(bytes.slice(split), true)];
      assert.deepEqual(actual, samples.map(sample => sample / 32768));
      assert.equal(decoder.pendingBytes, 0);
      assert.throws(() => decoder.decode(new Uint8Array()), /already complete/);
    }
    const decoder = new Pcm16Decoder(channels);
    const actual: number[] = [];
    for (let index = 0; index < bytes.length; index++) {
      actual.push(...decoder.decode(bytes.slice(index, index + 1), index === bytes.length - 1));
      assert.ok(decoder.pendingBytes < channels * 2);
    }
    assert.deepEqual(actual, samples.map(sample => sample / 32768));
  }
});

test("decoder rejects invalid channels, incomplete samples and incomplete stereo frames", () => {
  for (const channels of [0, 3, 1.5, NaN]) assert.throws(() => new Pcm16Decoder(channels), /one or two/);
  assert.throws(() => new Pcm16Decoder(1).decode(new Uint8Array([0]), true), /incomplete/);
  assert.throws(() => new Pcm16Decoder(2).decode(new Uint8Array([0, 0]), true), /incomplete/);
  const decoder = new Pcm16Decoder(2);
  decoder.decode(new Uint8Array([0, 0, 0]));
  assert.throws(() => decoder.decode(new Uint8Array(), true), /incomplete/);
});

test("ring wraps, preserves stereo ordering, and rejects overflow atomically", () => {
  const ring = new PcmRing(3, 2);
  ring.write(new Float32Array([1, -1, 2, -2]));
  const first = [new Float32Array(1), new Float32Array(1)];
  assert.equal(ring.render(first, 1), 1);
  assert.deepEqual(first.map(channel => [...channel]), [[1], [-1]]);
  ring.write(new Float32Array([3, -3, 4, -4]));
  assert.throws(() => ring.write(new Float32Array([5, -5])), /capacity/);
  assert.equal(ring.bufferedFrames, 3);
  const rest = [new Float32Array(4), new Float32Array(4)];
  assert.equal(ring.render(rest, 1), 3);
  assert.deepEqual(rest.map(channel => [...channel]), [[2, 3, 4, 0], [-2, -3, -4, 0]]);
  assert.equal(ring.playedFrames, 4);
  assert.equal(ring.bufferedFrames, 0);
  assert.throws(() => ring.write(new Float32Array([1])), /aligned/);
});

test("ring position counts consumed source frames, excluding underrun silence", () => {
  const ring = new PcmRing(4, 1);
  ring.write(new Float32Array([0, 1, 0, -1]));
  const slowed = [new Float32Array(4)];
  ring.render(slowed, 0.5);
  assert.deepEqual([...slowed[0]], [0, 0.5, 1, 0.5]);
  assert.equal(ring.playedFrames, 2);
  ring.render([new Float32Array(4)], 4);
  assert.equal(ring.playedFrames, 4);
  assert.equal(ring.bufferedFrames, 0);
  ring.render([new Float32Array(128)], 1);
  assert.equal(ring.playedFrames, 4);
  for (const rate of [0, -1, 5, NaN]) assert.throws(() => ring.render([new Float32Array(1)], rate), /rate/);
});


test("fractional rates retain exact source position after a long stream drains", () => {
  const ring = new PcmRing(8000, 1);
  const output = [new Float32Array(128)];
  for (let chunk = 0; chunk < 32; chunk++) {
    ring.write(new Float32Array(8000));
    while (ring.bufferedFrames > 0) ring.render(output, 0.1);
  }
  assert.equal(ring.playedFrames, 256000);
  assert.equal(ring.bufferedFrames, 0);
});

class FakeAudioParam {
  value = 1;
  setValueAtTime(value: number): void { this.value = value; }
}

class FakeGain {
  gain = new FakeAudioParam();
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

class FakeContext {
  static latest: FakeContext;
  static actualRate: number | undefined;
  sampleRate: number;
  state = "suspended";
  currentTime = 0;
  destination = {};
  gain = new FakeGain();
  onstatechange: (() => void) | null = null;
  blockResume = false;
  pendingResume = false;
  moduleUrl: string | URL | undefined;
  audioWorklet = { addModule: async (url: string | URL) => { this.moduleUrl = url; } };

  constructor(options: { sampleRate: number }) {
    FakeContext.latest = this;
    this.sampleRate = FakeContext.actualRate ?? options.sampleRate;
  }

  createGain(): FakeGain { return this.gain; }
  async resume(): Promise<void> {
    if (this.blockResume) throw new DOMException("Blocked", "NotAllowedError");
    if (this.pendingResume) await new Promise<void>(() => {});
    this.state = "running";
    this.onstatechange?.();
  }
  async suspend(): Promise<void> { this.state = "suspended"; this.onstatechange?.(); }
  async close(): Promise<void> { this.state = "closed"; this.onstatechange?.(); }
}

interface FakeMessage { type: string; id: number; samples?: Float32Array; complete?: boolean }

class FakeNode {
  static latest: FakeNode;
  ring: InstanceType<typeof PcmRing>;
  parameters = new Map([["playbackRate", new FakeAudioParam()], ["playing", new FakeAudioParam()]]);
  onprocessorerror: (() => void) | null = null;
  complete = false;
  maxBufferedFrames = 0;
  disconnected = false;
  closed = false;
  holdAcks = false;
  messages: FakeMessage[] = [];
  pending: FakeMessage | undefined;
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: (message: FakeMessage): void => {
      assert.equal(this.pending, undefined);
      this.messages.push(message);
      this.pending = message;
      if (!this.holdAcks) queueMicrotask(() => this.ack());
    },
    close: (): void => { this.closed = true; },
  };

  constructor(context: FakeContext, name: string, options: { processorOptions: { capacityFrames: number; channels: number } }) {
    assert.equal(name, "speech-pcm");
    assert.equal(context.sampleRate, 8000);
    FakeNode.latest = this;
    this.ring = new PcmRing(options.processorOptions.capacityFrames, options.processorOptions.channels);
  }

  ack(): void {
    const message = this.pending;
    if (!message || this.closed) return;
    this.pending = undefined;
    if (message.type === "append") {
      this.ring.write(message.samples);
      this.maxBufferedFrames=Math.max(this.maxBufferedFrames,this.ring.bufferedFrames);
      this.complete = message.complete!;
    }
    this.port.onmessage?.({ data: {
      id: message.id, bufferedFrames: this.ring.bufferedFrames, playedFrames: this.ring.playedFrames,
      underrunFrames: 0, underrunCount:0, maxBufferedFrames:this.maxBufferedFrames, ended: this.complete && this.ring.bufferedFrames === 0,
    } });
  }

  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

test("PCM playback lifecycle", async t => {
  const descriptors = ["AudioContext", "AudioWorkletNode"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, writable: true, value: FakeContext });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, writable: true, value: FakeNode });
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  await t.test("waits for an explicitly unannounced format and aborts without opening an audio device",async()=>{
    let pulls=0;const handle=await createPcmPlaybackHandle(async offset=>{pulls++;return pulls===1?{audioBase64:"",nextOffset:0,complete:false,sampleRate:null,channels:null}:response(pcmBytes([1,2]),offset,true);},new AbortController().signal);assert.equal(pulls,2);handle.stop();
    const previous=FakeContext.latest;const controller=new AbortController();const pending=createPcmPlaybackHandle(async()=>({audioBase64:"",nextOffset:0,complete:false,sampleRate:null,channels:null}),controller.signal);await settle();controller.abort();await assert.rejects(pending,{name:"AbortError"});assert.equal(FakeContext.latest,previous);
    await assert.rejects(createPcmPlaybackHandle(async()=>({audioBase64:"AA==",nextOffset:1,complete:false,sampleRate:null,channels:null}),new AbortController().signal),/unannounced/);
  });

  await t.test("an unannounced next-segment format preserves the current context and samples",async()=>{
    let pulls=0;let resumed!:()=>void;const available=new Promise<void>(resolve=>{resumed=resolve;});const handle=await createPcmPlaybackHandle(async offset=>{pulls++;if(pulls===2)return {audioBase64:"",nextOffset:offset,complete:false,sampleRate:null,channels:null};if(pulls===3)resumed();return response(pcmBytes([1]),offset,pulls===3);},new AbortController().signal);const context=FakeContext.latest;await handle.play();await available;await settle();assert.equal(FakeContext.latest,context);assert.equal(FakeNode.latest.ring.bufferedFrames,2);handle.stop();
  });

  await t.test("opens after one bounded pull, fills only five seconds, pauses, and aborts cleanly", async () => {
    const calls: Array<{ offset: number; maxBytes: number; signal: AbortSignal }> = [];
    const source: PcmPullSource = async (offset, maxBytes, signal) => {
      calls.push({ offset, maxBytes, signal });
      return response(new Uint8Array(maxBytes), offset);
    };
    const controller = new AbortController();
    const handle = await createPcmPlaybackHandle(source, controller.signal);
    const measurements:unknown[]=[];handle.measurements!.subscribe(value=>measurements.push(value));
    assert.equal(calls.length, 1);
    assert.equal(FakeContext.latest.moduleUrl!.toString().endsWith("/pcm-worklet.js"), true);
    await handle.play();
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].maxBytes, 65536);
    assert.equal(calls[1].maxBytes, 14464);
    assert.equal(FakeNode.latest.ring.bufferedFrames, 40000);
    assert.equal(measurements.some(value=>(value as {type:string}).type==="first-render"),false);
    FakeNode.latest.port.onmessage?.({data:{type:"first-render"}});
    assert.equal(measurements.filter(value=>(value as {type:string}).type==="first-render").length,1);
    handle.pause();
    await settle();
    assert.equal(FakeContext.latest.state, "suspended");
    assert.equal(measurements.filter(value=>(value as {type:string}).type==="pause-ack").length,1);
    assert.equal(FakeNode.latest.parameters.get("playing")!.value, 0);
    assert.equal(calls.length, 2);
    handle.setRate(2);
    handle.setVolume(0.25);
    assert.equal(FakeNode.latest.parameters.get("playbackRate")!.value, 2);
    assert.equal(FakeContext.latest.gain.gain.value, 0.25);
    assert.throws(() => handle.seek(0), /Seeking is unavailable/);
    controller.abort();
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(FakeNode.latest.closed, true);
    assert.equal(FakeNode.latest.disconnected, true);
    assert.equal(FakeContext.latest.state, "closed");
    await settle();assert.equal(measurements.filter(value=>(value as {type:string}).type==="stop-ack").length,1);
    await assert.rejects(handle.play(), { name: "AbortError" });
  });

  await t.test("autoplay rejection preserves the same handle and initial audio", async () => {
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async offset => {
      pulls++;
      return response(pcmBytes([1, 2]), offset, true);
    }, new AbortController().signal);
    FakeContext.latest.blockResume = true;
    await assert.rejects(handle.play(), { name: "NotAllowedError" });
    assert.equal(pulls, 1);
    assert.equal(FakeNode.latest.messages.length, 0);
    FakeContext.latest.blockResume = false;
    await handle.play();
    await settle();
    assert.equal(pulls, 1);
    assert.equal(FakeNode.latest.ring.bufferedFrames, 2);
    handle.stop();
  });

  await t.test("an unacknowledged chunk prevents another pull or queued message", async () => {
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async offset => {
      pulls++;
      return response(pcmBytes([1]), offset);
    }, new AbortController().signal);
    const node = FakeNode.latest;
    node.holdAcks = true;
    await handle.play();
    await settle();
    assert.equal(pulls, 1);
    assert.equal(node.messages.length, 1);
    node.ack();
    await settle();
    assert.equal(pulls, 2);
    assert.equal(node.messages.length, 2);
    handle.stop();
  });

  await t.test("stop aborts an in-flight pull and discards its late result", async () => {
    let finish: ((chunk: Awaited<ReturnType<PcmPullSource>>) => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async (offset, maxBytes, signal) => {
      pulls++;
      if (pulls === 1) return response(pcmBytes([1]), offset);
      activeSignal = signal;
      return new Promise<Awaited<ReturnType<PcmPullSource>>>(resolve => { finish = resolve; });
    }, new AbortController().signal);
    await handle.play();
    await settle();
    const messages = FakeNode.latest.messages.length;
    handle.stop();
    assert.equal(activeSignal!.aborted, true);
    finish!(response(pcmBytes([2]), 2, true));
    await settle();
    assert.equal(FakeNode.latest.messages.length, messages);
    assert.equal(FakeContext.latest.state, "closed");
  });


  await t.test("odd-byte stereo source fragments preserve complete channel frames", async () => {
    const bytes = pcmBytes([-32768, 32767, 1, -1]);
    const sizes = [1, 2, 1, 3, 1];
    const handle = await createPcmPlaybackHandle(async offset => {
      const size = sizes.shift()!;
      return { ...response(bytes.slice(offset, offset + size), offset, sizes.length === 0), channels: 2 };
    }, new AbortController().signal);
    await handle.play();
    await settle();
    await settle();
    const output = [new Float32Array(2), new Float32Array(2)];
    FakeNode.latest.ring.render(output, 1);
    assert.deepEqual(output.map(channel => [...channel]), [[-1, 1 / 32768], [32767 / 32768, -1 / 32768]]);
    handle.stop();
  });

  await t.test("pause holds one in-flight chunk without starting another pull", async () => {
    let finish: ((chunk: Awaited<ReturnType<PcmPullSource>>) => void) | undefined;
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async offset => {
      pulls++;
      if (pulls === 1) return response(pcmBytes([1]), offset);
      return new Promise<Awaited<ReturnType<PcmPullSource>>>(resolve => { finish = resolve; });
    }, new AbortController().signal);
    await handle.play();
    await settle();
    handle.pause();
    finish!(response(pcmBytes([2]), 2));
    await settle();
    assert.equal(pulls, 2);
    assert.equal(FakeNode.latest.messages.filter(message => message.type === "append").length, 1);
    await handle.play();
    await settle();
    assert.equal(FakeNode.latest.messages.filter(message => message.type === "append").length, 2);
    handle.stop();
  });

  await t.test("rapid pause and resume leave the context playing", async () => {
    const handle = await createPcmPlaybackHandle(async offset => response(pcmBytes([1, 2]), offset, true), new AbortController().signal);
    const firstPlay = handle.play();
    handle.pause();
    await handle.play();
    await firstPlay;
    await settle();
    assert.equal(FakeContext.latest.state, "running");
    assert.equal(FakeNode.latest.ring.bufferedFrames, 2);
    handle.stop();
  });

  await t.test("a pending autoplay resume reports blocked and preserves audio for retry", async () => {
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async offset => {
      pulls++;
      return response(pcmBytes([1]), offset, true);
    }, new AbortController().signal);
    FakeContext.latest.pendingResume = true;
    await assert.rejects(handle.play(), { name: "NotAllowedError" });
    assert.equal(pulls, 1);
    assert.equal(FakeNode.latest.messages.length, 0);
    FakeContext.latest.pendingResume = false;
    await handle.play();
    await settle();
    assert.equal(FakeNode.latest.ring.bufferedFrames, 1);
    handle.stop();
  });

  await t.test("consumed frame position and EOF duration exclude underrun silence", async () => {
    const handle = await createPcmPlaybackHandle(async offset => response(pcmBytes([1, 2]), offset, true), new AbortController().signal);
    await handle.play();
    await settle();
    const ended = new Promise<Partial<PlaybackState>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("PCM did not finish.")), 1000);
      handle.onState(state => {
        if (state.status === "idle") { clearTimeout(timeout); resolve(state); }
      });
    });
    FakeNode.latest.ring.render([new Float32Array(128)], 1);
    const state = await ended;
    assert.equal(state.position, 2 / 8000);
    assert.equal(state.duration, 2 / 8000);
    assert.equal(FakeContext.latest.state, "closed");
  });

  await t.test("rejects malformed offsets, excessive chunks, trailing samples and device rate mismatch", async () => {
    for (const result of [
      { ...response(pcmBytes([1]), 0), nextOffset: 3 },
      response(new Uint8Array(65538), 0),
      response(new Uint8Array([1]), 0, true),
      { ...response(new Uint8Array(), 0), channels: 3 },
    ]) {
      await assert.rejects(createPcmPlaybackHandle(async () => result, new AbortController().signal));
    }
    FakeContext.actualRate = 48000;
    try {
      await assert.rejects(createPcmPlaybackHandle(async () => response(pcmBytes([1]), 0, true), new AbortController().signal), /sample rate/);
      assert.equal(FakeContext.latest.state, "closed");
    } finally { FakeContext.actualRate = undefined; }
  });

  await t.test("format changes fail the active handle without swallowing the error", async () => {
    let pulls = 0;
    const handle = await createPcmPlaybackHandle(async offset => {
      pulls++;
      return { ...response(pcmBytes([1, 2]), offset), channels: pulls === 1 ? 1 : 2 };
    }, new AbortController().signal);
    const states: Array<Partial<PlaybackState>> = [];
    handle.onState(state => states.push(state));
    await handle.play();
    await settle();
    assert.ok(states.some(state => state.status === "failed" && state.error?.includes("format changed")));
    assert.equal(FakeContext.latest.state, "closed");
  });
});
