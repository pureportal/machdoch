import { createAudioPlaybackHandle, validatePlaybackLoop, type PlaybackHandle, type PlaybackLoop, type PlaybackState } from "./playback.ts";
import {PlaybackMeasurements} from "./playback-metrics.ts";

export function createAudioSequencePlaybackHandle(
  clips: ReadonlyArray<{url: string; duration: number}>,
  options: {rate: number; volume?: number; signal: AbortSignal},
): PlaybackHandle {
  if (!clips.length || clips.some(clip => !Number.isFinite(clip.duration) || clip.duration <= 0)) throw new Error("Choose nonempty audio clips with measured durations.");
  const offsets = [0];
  for (const clip of clips) offsets.push(offsets.at(-1)! + clip.duration);
  const duration = offsets.at(-1)!;
  const listeners = new Set<(state: Partial<PlaybackState>) => void>();
  const measurements=new PlaybackMeasurements("html-audio");
  let firstRendered=false;
  let unmeasure:(()=>void)|undefined;
  let state: Partial<PlaybackState> = {status:"paused",position:0,duration,seekable:true,loop:null,loopAvailable:true};
  let current!: PlaybackHandle;
  let unlisten: (() => void) | undefined;
  let index = 0;
  let generation = 0;
  let stopped = false;
  let playing = false;
  let rate = options.rate;
  let volume = options.volume ?? 1;
  let loop: PlaybackLoop | null = null;
  let outputDeviceId: string | undefined;
  let outputReady = Promise.resolve();
  const emit = (patch: Partial<PlaybackState>): void => {
    if (stopped) return;
    state = {...state,...patch,duration,seekable:true,loop:loop ? {...loop} : null,loopAvailable:true,rate,volume,outputDeviceId};
    for (const listener of listeners) listener({...state,loop:loop ? {...loop} : null});
  };
  const playCurrent = async (): Promise<void> => {
    const expected = generation;
    try {
      await outputReady;
      if (stopped || expected !== generation || !playing) return;
      await current.play();
    } catch(error) {if (!stopped && expected === generation) throw error;}
    if (!stopped && expected === generation && playing) emit({status:"playing",error:null});
  };
  const playFailed = (error: unknown): void => {
    if (stopped) return;
    playing = false;
    emit({status:error instanceof Error && error.name === "NotAllowedError" ? "blocked" : "failed",error:error instanceof Error ? error.message : "Audio playback failed. Check the output device and press Play."});
  };
  const open = (next: number, position = 0): void => {
    ++generation;
    unlisten?.();
    unmeasure?.();
    current?.stop();
    index = next;
    current = createAudioPlaybackHandle(clips[index]!.url,{rate,volume,duration:clips[index]!.duration,signal:options.signal});
    unmeasure=current.measurements?.subscribe(value=>{
      if(value.type==="stop-ack"&&!stopped)return;
      if(value.type==="first-render"){if(firstRendered)return;firstRendered=true;}
      measurements.emit(value);
    });
    if (position > 0) current.seek(position);
    const expected = generation;
    if (outputDeviceId !== undefined) {
      outputReady = current.setOutputDevice ? current.setOutputDevice(outputDeviceId) : Promise.reject(new Error("Audio output selection is unavailable for this playback."));
      void outputReady.catch(error => { if (expected === generation) playFailed(error); });
    } else outputReady = Promise.resolve();
    unlisten = current.onState(patch => {
      if (stopped || expected !== generation) return;
      const position = patch.position === undefined ? state.position ?? offsets[index]! : offsets[index]! + patch.position;
      if (loop && position >= loop.end && (playing || patch.status === "idle")) {
        const previousIndex = index;
        seek(loop.start);
        if (patch.status === "idle" && previousIndex === index && playing) void playCurrent().catch(playFailed);
        return;
      }
      if (patch.status === "idle" && index < clips.length - 1) {
        open(index + 1);
        if (playing) void playCurrent().catch(playFailed);
        return;
      }
      if (patch.status === "idle" || patch.status === "blocked" || patch.status === "failed") playing = false;
      emit({...patch,position});
    });
    emit({position:offsets[index]!+position});
  };
  const seek = (seconds: number): void => {
    if (stopped) throw new DOMException("Speech cancelled","AbortError");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) throw new Error("Seek within the measured audio duration.");
    if (loop && (seconds < loop.start || seconds >= loop.end)) throw new Error("Seek within the loop selection or clear the loop.");
    const next = offsets.findIndex((offset,position) => position > 0 && offset > seconds) - 1;
    const target = next < 0 ? clips.length - 1 : next;
    if (target === index) current.seek(seconds-offsets[index]!);
    else {open(target,seconds-offsets[target]!);if(playing)void playCurrent().catch(playFailed);}
    emit({position:seconds});
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    playing = false;
    ++generation;
    options.signal.removeEventListener("abort",stop);
    unlisten?.();
    current?.stop();
    unmeasure?.();measurements.close();
    listeners.clear();
  };
  options.signal.addEventListener("abort",stop,{once:true});
  if (options.signal.aborted) stop();
  else open(0);
  return {
    measurements,
    play: async () => {
      if (stopped) throw new DOMException("Speech cancelled","AbortError");
      if (state.status === "idle") seek(loop?.start ?? 0);
      playing = true;
      try {await playCurrent();} catch (error) {playing=false;throw error;}
    },
    pause: () => {playing=false;current?.pause();emit({status:"paused"});},
    stop,
    seek,
    setRate: value => {current?.setRate(value);rate=value;emit({});},
    setVolume: value => {current?.setVolume(value);volume=value;emit({});},
    setLoop: selection => {
      if (stopped) throw new DOMException("Speech cancelled","AbortError");
      if (selection) validatePlaybackLoop(selection,duration);
      loop = selection ? {...selection} : null;
      if (loop && ((state.position ?? 0) < loop.start || (state.position ?? 0) >= loop.end)) seek(loop.start);
      emit({});
    },
    ...(current?.setOutputDevice ? {
      setOutputDevice: async (deviceId: string): Promise<void> => {
        const expected = generation;
        outputReady = current.setOutputDevice!(deviceId);
        await outputReady;
        if (!stopped && expected === generation) {outputDeviceId=deviceId;emit({});}
      },
    } : {}),
    onState: listener => {listeners.add(listener);listener({...state,loop:loop ? {...loop} : null});return()=>{listeners.delete(listener);};},
  };
}
