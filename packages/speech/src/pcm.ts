import type { PlaybackHandle, PlaybackState } from "./playback.ts";
import {PlaybackMeasurements} from "./playback-metrics.ts";

export type PcmPullSource = (offsetBytes: number, maxBytes: number, signal: AbortSignal) => Promise<{
  audioBase64: string;
  nextOffset: number;
  complete: boolean;
  sampleRate: number|null;
  channels: number|null;
}>;

const MAX_CHUNK_BYTES = 65_536;

export class Pcm16Decoder {
  private remainder = new Uint8Array(0);
  private finished = false;
  readonly channels: number;

  constructor(channels: number) {
    if (channels !== 1 && channels !== 2) throw new Error("PCM requires one or two channels.");
    this.channels = channels;
  }

  get pendingBytes(): number { return this.remainder.length; }

  decode(bytes: Uint8Array, complete = false): Float32Array {
    if (this.finished) throw new Error("PCM input is already complete.");
    const input = new Uint8Array(this.remainder.length + bytes.length);
    input.set(this.remainder);
    input.set(bytes, this.remainder.length);
    const alignedBytes = input.length - input.length % (this.channels * 2);
    if (complete && alignedBytes !== input.length) throw new Error("PCM ended with an incomplete sample or channel frame.");
    const samples = new Float32Array(alignedBytes / 2);
    const view = new DataView(input.buffer);
    for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
    this.remainder = input.slice(alignedBytes);
    this.finished = complete;
    return samples;
  }
}

function abortError(): DOMException { return new DOMException("PCM playback stopped.", "AbortError"); }

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener("abort", aborted); reject(abortError()); };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(value => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) reject(abortError()); else resolve(value);
    }, error => {
      signal.removeEventListener("abort", aborted);
      reject(signal.aborted ? abortError() : error);
    });
    if (signal.aborted) aborted();
  });
}

function readBytes(chunk: Awaited<ReturnType<PcmPullSource>>, offset: number, maxBytes: number, format?: { sampleRate: number; channels: number }): Uint8Array {
  if (typeof chunk.sampleRate!=="number" || !Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 192000) throw new Error("PCM sample rate must be an integer from 8000 to 192000 Hz.");
  if (chunk.channels !== 1 && chunk.channels !== 2) throw new Error("PCM requires one or two channels.");
  if (format && (format.sampleRate !== chunk.sampleRate || format.channels !== chunk.channels)) throw new Error("PCM format changed during playback.");
  if (typeof chunk.complete !== "boolean" || typeof chunk.audioBase64 !== "string") throw new Error("Invalid PCM source response.");
  if (chunk.audioBase64.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.audioBase64)) throw new Error("Invalid or oversized PCM chunk.");
  const binary = atob(chunk.audioBase64);
  if (binary.length > maxBytes || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset !== offset + binary.length) throw new Error("Invalid PCM byte offset or chunk size.");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function pendingFormat(chunk:Awaited<ReturnType<PcmPullSource>>,offset:number):boolean{
  if(chunk.sampleRate!==null||chunk.channels!==null)return false;
  if(chunk.audioBase64!==""||chunk.nextOffset!==offset||chunk.complete!==false)throw new Error("An unannounced PCM format cannot contain audio or completion.");
  return true;
}

interface WorkletState {
  id: number;
  bufferedFrames: number;
  playedFrames: number;
  underrunFrames: number;
  underrunCount: number;
  maxBufferedFrames: number;
  ended: boolean;
  error?: string;
}

export async function createPcmPlaybackHandle(source: PcmPullSource, signal: AbortSignal, workletUrl: string | URL = new URL("./pcm-worklet.js", import.meta.url)): Promise<PlaybackHandle> {
  let setOutputDevice: PlaybackHandle["setOutputDevice"];
  const handle = await openPcmPlaybackHandle(source, signal, workletUrl, setter => { setOutputDevice = setter; });
  return { ...handle, ...(setOutputDevice ? { setOutputDevice } : {}) };
}

async function openPcmPlaybackHandle(source: PcmPullSource, signal: AbortSignal, workletUrl: string | URL, configureOutput: (setter: NonNullable<PlaybackHandle["setOutputDevice"]>) => void): Promise<PlaybackHandle> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) controller.abort();
  let context: AudioContext | undefined;
  const measurements = new PlaybackMeasurements("pcm");
  try {
    controller.signal.throwIfAborted();
    let first = await abortable(source(0, MAX_CHUNK_BYTES, controller.signal), controller.signal);
    while(pendingFormat(first,0)){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await abortable(new Promise<void>(resolve=>{timer=setTimeout(resolve,40);}),controller.signal);}finally{clearTimeout(timer);}
      first=await abortable(source(0,MAX_CHUNK_BYTES,controller.signal),controller.signal);
    }
    const bytes = readBytes(first, 0, MAX_CHUNK_BYTES);
    const format = { sampleRate: first.sampleRate!, channels: first.channels! };
    const decoder = new Pcm16Decoder(format.channels);
    let pendingSamples: Float32Array | undefined = decoder.decode(bytes, first.complete);
    if(pendingSamples.length>0)measurements.emit({type:"first-samples",atMs:performance.now()});
    let complete = first.complete;
    let offset = first.nextOffset;
    let receivedFrames = pendingSamples.length / format.channels;
    const capacityFrames = format.sampleRate * 5;
    context = new AudioContext({ sampleRate: format.sampleRate });
    const audioContext = context;
    const output = audioContext as AudioContext & { sinkId?: string; setSinkId?: (deviceId: string) => Promise<void> };
    const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (audioContext.sampleRate !== format.sampleRate) throw new Error("The audio device does not support the PCM source sample rate.");
    await abortable(audioContext.audioWorklet.addModule(workletUrl), controller.signal);
    controller.signal.throwIfAborted();
    const node = new AudioWorkletNode(audioContext, "speech-pcm", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [format.channels],
      processorOptions: { channels: format.channels, capacityFrames },
    });
    const gain = audioContext.createGain();
    node.connect(gain);
    gain.connect(audioContext.destination);
    const listeners = new Set<(state: Partial<PlaybackState>) => void>();
    let state: Partial<PlaybackState> = { status: "paused", position: 0, duration: complete ? receivedFrames / format.sampleRate : null, error: null, seekable: false, loop: null, loopAvailable: false, outputDeviceSupported: typeof output.setSinkId === "function", outputDeviceId: output.sinkId };
    let disposed = false;
    let desiredPlaying = false;
    let failure: Error | undefined;
    let messageId = 0;
    let awaiting: { id: number; resolve: (value: WorkletState) => void; reject: (reason: Error) => void } | undefined;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumeAttempt: Promise<void> | undefined;
    let intentVersion = 0;
    let bufferedFrames = 0;
    let lastUnderrunFrames = 0;
    let lastUnderrunCount = 0;
    let maxBufferedFrames = 0;
    let lastMetricAt = -Infinity;
    let firstRendered = false;
    const emit = (patch: Partial<PlaybackState>): void => {
      if (disposed) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener({ ...state });
    };
    let deviceVersion = 0;
    if (typeof output.setSinkId === "function") configureOutput(async deviceId => {
      controller.signal.throwIfAborted();
      const expected = ++deviceVersion;
      await output.setSinkId!(deviceId);
      if (!disposed && expected === deviceVersion) emit({ outputDeviceId: deviceId });
    });
    const deviceChanged = (): void => {
      const deviceId = output.sinkId;
      if (!deviceId || deviceId === "default" || !devices) return;
      const expected = deviceVersion;
      void devices.enumerateDevices().then(async available => {
        if (disposed || expected !== deviceVersion || output.sinkId !== deviceId || available.some(device => device.kind === "audiooutput" && device.deviceId === deviceId)) return;
        desiredPlaying = false;
        ++intentVersion;
        await audioContext.suspend();
        if (!disposed) emit({ status: "blocked", error: "The audio output device disconnected. Choose an output device and press Play." });
      }).catch(error => {
        if (!disposed) emit({ status: "blocked", error: error instanceof Error ? error.message : "Unable to check the audio output device." });
      });
    };
    if (typeof output.setSinkId === "function") devices?.addEventListener("devicechange", deviceChanged);
    const release = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const wait = (milliseconds?: number): Promise<void> => new Promise(resolve => {
      wake = resolve;
      if (milliseconds !== undefined) timer = setTimeout(release, milliseconds);
    });
    const dispose = (reason: Error): void => {
      if (disposed) return;
      const requestedAtMs = performance.now();
      disposed = true;
      desiredPlaying = false;
      signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", stopped);
      controller.abort();
      release();
      awaiting?.reject(reason);
      awaiting = undefined;
      pendingSamples = undefined;
      node.port.onmessage = null;
      node.port.onmessageerror = null;
      node.onprocessorerror = null;
      audioContext.onstatechange = null;
      devices?.removeEventListener("devicechange", deviceChanged);
      node.port.close();
      node.disconnect();
      gain.disconnect();
      listeners.clear();
      measurements.emit({type:"pcm-buffer",atMs:performance.now(),sampleRate:format.sampleRate,maxBufferedFrames,underrunFrames:lastUnderrunFrames,underrunCount:lastUnderrunCount});
      void audioContext.close().then(() => {
        measurements.emit({type:"stop-ack",requestedAtMs,atMs:performance.now()});
        measurements.close();
      }, error => {
        measurements.close();
        if (!failure) failure = error instanceof Error ? error : new Error(String(error));
      });
    };
    const fail = (error: unknown): void => {
      if (disposed) return;
      failure = error instanceof Error ? error : new Error(String(error));
      emit({ status: "failed", error: failure.message });
      dispose(failure);
    };
    function stopped(): void { dispose(abortError()); }
    controller.signal.addEventListener("abort", stopped, { once: true });
    const exchange = (samples?: Float32Array): Promise<WorkletState> => {
      if (disposed || controller.signal.aborted) return Promise.reject(abortError());
      if (awaiting) return Promise.reject(new Error("PCM acknowledgement is still pending."));
      return new Promise((resolve, reject) => {
        const id = ++messageId;
        awaiting = { id, resolve, reject };
        try {
          if (samples) node.port.postMessage({ type: "append", id, samples, complete }, [samples.buffer as ArrayBuffer]);
          else node.port.postMessage({ type: "state", id });
        } catch (error) {
          awaiting = undefined;
          reject(error);
        }
      });
    };
    node.port.onmessage = event => {
      if (disposed || controller.signal.aborted) return;
      if (event.data?.type === "first-render") {
        if (!firstRendered) {firstRendered=true;measurements.emit({type:"first-render",atMs:performance.now()});}
        return;
      }
      const report = event.data as WorkletState;
      if (!awaiting || report.id !== awaiting.id) { fail(new Error("Unexpected PCM acknowledgement.")); return; }
      const response = awaiting;
      awaiting = undefined;
      if (report.error) { response.reject(new Error(report.error)); return; }
      if (!Number.isInteger(report.bufferedFrames) || report.bufferedFrames < 0 || report.bufferedFrames > capacityFrames ||
          !Number.isFinite(report.playedFrames) || report.playedFrames < (state.position ?? 0) * format.sampleRate - 0.000001 ||
          report.playedFrames > receivedFrames + 0.000001 || !Number.isSafeInteger(report.underrunFrames) ||
          report.underrunFrames < lastUnderrunFrames || !Number.isSafeInteger(report.underrunCount) || report.underrunCount < lastUnderrunCount ||
          !Number.isSafeInteger(report.maxBufferedFrames) || report.maxBufferedFrames < maxBufferedFrames || report.maxBufferedFrames > capacityFrames || typeof report.ended !== "boolean") {
        response.reject(new Error("Invalid PCM acknowledgement."));
        return;
      }
      bufferedFrames = report.bufferedFrames;
      lastUnderrunFrames = report.underrunFrames;
      lastUnderrunCount = report.underrunCount;
      maxBufferedFrames = report.maxBufferedFrames;
      const measuredAt = performance.now();
      if (measuredAt-lastMetricAt>=1000) {
        lastMetricAt=measuredAt;
        measurements.emit({type:"pcm-buffer",atMs:measuredAt,sampleRate:format.sampleRate,maxBufferedFrames,underrunFrames:lastUnderrunFrames,underrunCount:lastUnderrunCount});
      }
      emit({
        position: report.playedFrames / format.sampleRate,
        duration: complete ? receivedFrames / format.sampleRate : null,
        status: desiredPlaying && audioContext.state === "running" ? (report.bufferedFrames === 0 && !report.ended ? "loading" : "playing") : state.status,
      });
      response.resolve(report);
    };
    node.port.onmessageerror = () => fail(new Error("PCM worklet message could not be decoded."));
    node.onprocessorerror = () => fail(new Error("PCM audio processor failed."));
    audioContext.onstatechange = () => {
      if (disposed) return;
      release();
      if (audioContext.state === "closed") fail(new Error("The PCM audio context closed unexpectedly."));
      else if (audioContext.state !== "running" && desiredPlaying) emit({ status: "blocked", error: "Press Play to resume audio." });
    };
    const pump = async (): Promise<void> => {
      while (!disposed) {
        if (!desiredPlaying || audioContext.state !== "running") { await wait(); continue; }
        if (pendingSamples !== undefined) {
          const samples = pendingSamples;
          pendingSamples = undefined;
          const report = await exchange(samples);
          if (disposed) return;
          if (report.ended) { emit({ status: "idle" }); dispose(abortError()); return; }
          continue;
        }
        const freeFrames = capacityFrames - bufferedFrames;
        if (!complete && freeFrames > 0) {
          const maxBytes = Math.min(MAX_CHUNK_BYTES, freeFrames * format.channels * 2 - decoder.pendingBytes);
          let chunk: Awaited<ReturnType<PcmPullSource>> | undefined;
          let readFailure: unknown;
          let ready = false;
          void abortable(source(offset, maxBytes, controller.signal), controller.signal).then(value => {
            chunk = value;
            ready = true;
            release();
          }, error => {
            readFailure = error;
            ready = true;
            release();
          });
          while (!ready && !disposed) {
            await wait(desiredPlaying && audioContext.state === "running" ? 40 : undefined);
            if (!ready && !disposed && desiredPlaying && audioContext.state === "running") await exchange();
          }
          if (disposed) return;
          if (readFailure !== undefined) throw readFailure;
          if (!chunk) throw new Error("PCM source returned no chunk.");
          if(pendingFormat(chunk,offset)){await wait(40);continue;}
          const nextBytes = readBytes(chunk, offset, maxBytes, format);
          pendingSamples = decoder.decode(nextBytes, chunk.complete);
          if(pendingSamples.length>0)measurements.emit({type:"first-samples",atMs:performance.now()});
          receivedFrames += pendingSamples.length / format.channels;
          offset = chunk.nextOffset;
          complete = chunk.complete;
          if (nextBytes.length === 0 && !complete) await wait(40);
          continue;
        }
        await wait(40);
        if (disposed || !desiredPlaying || audioContext.state !== "running") continue;
        const report = await exchange();
        if (disposed) return;
        if (report.ended) { emit({ status: "idle" }); dispose(abortError()); return; }
      }
    };
    void pump().catch(error => { if (!disposed) fail(error); });
    const ensureAvailable = (): void => {
      if (failure) throw failure;
      if (disposed || controller.signal.aborted) throw abortError();
    };
    return {
      measurements,
      play: () => {
        try { ensureAvailable(); } catch (error) { return Promise.reject(error); }
        if (resumeAttempt && desiredPlaying) return resumeAttempt;
        desiredPlaying = true;
        const intent = ++intentVersion;
        const attempt = (async (): Promise<void> => {
          try {
            const resumed = audioContext.resume();
            let blockedTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await abortable(Promise.race([
                resumed,
                new Promise<void>((resolve, reject) => {
                  blockedTimer = setTimeout(() => {
                    if (audioContext.state === "running") resolve();
                    else reject(new DOMException("Press Play to enable audio.", "NotAllowedError"));
                  }, 1000);
                }),
              ]), controller.signal);
            } finally {
              if (blockedTimer !== undefined) clearTimeout(blockedTimer);
            }
            ensureAvailable();
            if (!desiredPlaying || intent !== intentVersion) return;
            if (audioContext.state !== "running") throw new DOMException("Press Play to enable audio.", "NotAllowedError");
            node.parameters.get("playing")!.setValueAtTime(1, audioContext.currentTime);
            emit({ status: bufferedFrames > 0 ? "playing" : "loading", error: null });
            release();
          } catch (error) {
            if (intent !== intentVersion && !disposed) return;
            if (!disposed && error instanceof Error && error.name === "NotAllowedError") {
              desiredPlaying = false;
              node.parameters.get("playing")!.setValueAtTime(0, audioContext.currentTime);
              emit({ status: "blocked", error: "Press Play to enable audio." });
            } else if (!disposed) fail(error);
            throw error;
          }
        })();
        resumeAttempt = attempt;
        void attempt.then(() => { if (resumeAttempt === attempt) resumeAttempt = undefined; }, () => { if (resumeAttempt === attempt) resumeAttempt = undefined; });
        return attempt;
      },
      pause: () => {
        ensureAvailable();
        const requestedAtMs = performance.now();
        desiredPlaying = false;
        ++intentVersion;
        resumeAttempt = undefined;
        node.parameters.get("playing")!.setValueAtTime(0, audioContext.currentTime);
        emit({ status: "paused" });
        release();
        void audioContext.suspend().then(() => {if(!disposed)measurements.emit({type:"pause-ack",requestedAtMs,atMs:performance.now()});},error => { if (!disposed) fail(error); });
      },
      stop: stopped,
      seek: () => { throw new Error("Seeking is unavailable for streaming PCM. Replay the audio to start again."); },
      setRate: rate => {
        ensureAvailable();
        if (!Number.isFinite(rate) || rate <= 0 || rate > 4) throw new Error("Use a playback rate above 0 and at most 4.");
        node.parameters.get("playbackRate")!.setValueAtTime(rate, audioContext.currentTime);
      },
      setVolume: volume => {
        ensureAvailable();
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Use a volume from 0 to 1.");
        gain.gain.setValueAtTime(volume, audioContext.currentTime);
      },
      onState: listener => {
        if (disposed) return () => {};
        listeners.add(listener);
        listener({ ...state });
        return () => { listeners.delete(listener); };
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    controller.abort();
    if (context && context.state !== "closed") {
      try { await context.close(); } catch (closeError) {
        throw new AggregateError([error, closeError], "PCM initialization and audio context cleanup failed.");
      }
    }
    throw error;
  }
}
