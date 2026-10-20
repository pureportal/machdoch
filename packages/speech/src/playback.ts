import { PlaybackMeasurements, speechPlaybackMetrics } from "./playback-metrics.ts";
import type { PlaybackMeasurementSource, PlaybackMetrics } from "./playback-metrics.ts";

export * from "./playback-metrics.ts";

export interface PlaybackLoop {
  start: number;
  end: number;
}

export interface PlaybackState {
  owner: string | null;
  itemId: string | null;
  status: "idle" | "loading" | "playing" | "paused" | "blocked" | "failed";
  position: number;
  duration: number | null;
  error: string | null;
  seekable?: boolean;
  rate?: number;
  volume?: number;
  loop?: PlaybackLoop | null;
  loopAvailable?: boolean;
  outputDeviceSupported?: boolean;
  outputDeviceId?: string;
}
export interface PlaybackHandle {
  readonly measurements?: PlaybackMeasurementSource;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  setLoop?(selection: PlaybackLoop | null): void;
  setOutputDevice?(deviceId: string): Promise<void>;
  onState(listener: (state: Partial<PlaybackState>) => void): () => void;
}
export interface ForegroundPlayback {
  owner: string;
  itemId: string;
  open(signal: AbortSignal): Promise<PlaybackHandle>;
}

export function validatePlaybackLoop(selection: PlaybackLoop, duration: number | null | undefined): void {
  if (!Number.isFinite(duration) || duration! <= 0 || !Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > duration!) {
    throw new Error("Choose a loop within the completed audio duration.");
  }
}

export class SpeechPlaybackCoordinator {
  private readonly instanceId = crypto.randomUUID();
  private channel: BroadcastChannel | undefined;
  private decision = { time: 0, instanceId: "" };
  private readonly channelFactory: (() => BroadcastChannel) | undefined;
  private readonly metrics:PlaybackMetrics;
  private generation = 0;
  private controller: AbortController | undefined;
  private handle: PlaybackHandle | undefined;
  private paused = false;
  private rate: number | undefined;
  private volume: number | undefined;
  private outputVersion = 0;
  private unlisten: (() => void) | undefined;
  private readonly listeners = new Set<(state: PlaybackState) => void>();
  private state: PlaybackState = { owner: null, itemId: null, status: "idle", position: 0, duration: null, error: null, seekable: false, loop: null, loopAvailable: false, outputDeviceSupported: false };

  constructor(channelFactory?: () => BroadcastChannel, metrics: PlaybackMetrics = speechPlaybackMetrics) { this.channelFactory=channelFactory;this.metrics=metrics; }

  private publish(action: "claim" | "pause"): void {
    if (!this.channelFactory) return;
    if (!this.channel) {
      this.channel = this.channelFactory();
      this.channel.onmessage = event => {
        const value: unknown = event.data;
        if (!value || typeof value !== "object") return;
        const message = value as { action?: unknown; time?: unknown; instanceId?: unknown };
        if ((message.action !== "claim" && message.action !== "pause") || typeof message.time !== "number" || !Number.isFinite(message.time) || typeof message.instanceId !== "string" || message.instanceId === this.instanceId) return;
        if (message.time < this.decision.time || (message.time === this.decision.time && message.instanceId <= this.decision.instanceId)) return;
        this.decision = {time:message.time,instanceId:message.instanceId};
        if (message.action === "claim") this.stop();
        else this.applyPause();
      };
    }
    this.decision = {time:Math.max(performance.timeOrigin+performance.now(),this.decision.time+0.001),instanceId:this.instanceId};
    this.channel.postMessage({...this.decision,action});
  }

  snapshot(): PlaybackState { return { ...this.state, loop: this.state.loop ? { ...this.state.loop } : null }; }
  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  async play(item: ForegroundPlayback): Promise<void> {
    this.stop();
    const measurement = this.metrics.startSession();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ owner: item.owner, itemId: item.itemId, status: "loading", error: null, seekable: false });
    try {
      this.publish("claim");
      const handle = await item.open(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) { handle.stop(); return; }
      this.handle = handle;
      measurement.opened(handle.measurements);
      this.unlisten = handle.onState(state => { if (generation === this.generation) this.update(state); });
      if (this.rate !== undefined) handle.setRate(this.rate);
      if (this.volume !== undefined) handle.setVolume(this.volume);
      this.update({ loopAvailable: this.state.seekable === true && !!handle.setLoop, outputDeviceSupported: !!handle.setOutputDevice });
      if (this.paused) { this.update({ status: "paused" }); return; }
      await handle.play();
      if (generation === this.generation && !this.paused && this.state.status !== "blocked" && this.state.status !== "failed") this.update({ status: "playing" });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.playFailed(error);
    }
  }
  async resume(): Promise<void> {
    this.paused = false;
    const generation = this.generation;
    try {
      if (this.state.owner !== null) this.publish("claim");
      if (!this.handle) { if (this.state.owner !== null) this.update({status:"loading"}); return; }
      this.update({ status: "loading", error: null });
      await this.handle.play();
      if (generation === this.generation && !this.paused && this.state.status !== "blocked" && this.state.status !== "failed") this.update({ status: "playing", error: null });
    } catch (error) { if (generation === this.generation) this.playFailed(error); }
  }
  private playFailed(error: unknown): void {
    const blocked = error instanceof Error && error.name === "NotAllowedError";
    this.update({ status: blocked ? "blocked" : "failed", error: blocked ? "Press Play to enable audio." : error instanceof Error ? error.message : "Audio playback failed. Check the output device and press Play." });
  }
  pause(): void { this.publish("pause"); this.applyPause(); }
  private applyPause(): void { this.paused = true; this.handle?.pause(); if (this.state.owner !== null) this.update({ status: "paused" }); }
  stop(owner?: string): void {
    if (owner !== undefined && this.state.owner !== owner) return;
    ++this.generation;
    ++this.outputVersion;
    this.paused = false;
    this.controller?.abort();
    this.controller = undefined;
    this.unlisten?.(); this.unlisten = undefined;
    this.handle?.stop(); this.handle = undefined;
    this.update({ owner: null, itemId: null, status: "idle", position: 0, duration: null, error: null, seekable: false, loop: null, loopAvailable: false, outputDeviceSupported: false, outputDeviceId: undefined });
  }
  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Seek to a nonnegative time.");
    if (!this.handle || !this.state.seekable) throw new Error("Seeking is unavailable for this playback. Choose completed audio.");
    if (this.state.duration !== null && seconds > this.state.duration) throw new Error("Seek within the completed audio duration.");
    this.handle.seek(seconds);
  }
  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4) throw new Error("Use a playback rate above 0 and at most 4.");
    this.handle?.setRate(rate);
    this.rate = rate;
    this.update({ rate });
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Use a volume from 0 to 1.");
    this.handle?.setVolume(volume);
    this.volume = volume;
    this.update({ volume });
  }
  setLoop(selection: PlaybackLoop | null): void {
    if (!this.handle?.setLoop || !this.state.seekable) throw new Error("Selection looping is unavailable for this playback. Choose completed seekable audio.");
    if (selection) validatePlaybackLoop(selection, this.state.duration);
    const loop = selection ? { ...selection } : null;
    this.handle.setLoop(loop);
    this.update({ loop });
  }
  async setOutputDevice(deviceId: string): Promise<void> {
    if (typeof deviceId !== "string") throw new Error("Choose an audio output device.");
    const handle = this.handle;
    const generation = this.generation;
    if (!handle?.setOutputDevice) throw new Error("Audio output selection is unavailable for this playback.");
    const version = ++this.outputVersion;
    await handle.setOutputDevice(deviceId);
    if (generation === this.generation && version === this.outputVersion) this.update({ outputDeviceId: deviceId });
  }
  private update(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    if (patch.seekable !== undefined) this.state.loopAvailable = patch.seekable && !!this.handle?.setLoop;
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

export const speechPlayback = new SpeechPlaybackCoordinator(typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? () => new BroadcastChannel("machdoch:speech:foreground:v1") : undefined);

export function createAudioPlaybackHandle(url: string, options: { rate?: number; volume?: number; duration?: number; signal?: AbortSignal } = {}): PlaybackHandle {
  const audio = new Audio(url);
  const measurements = new PlaybackMeasurements("html-audio");
  let rendered = false;
  const playing = (): void => {
    if (stopped || !desiredPlaying || rendered) return;
    rendered = true;
    measurements.emit({ type: "first-render", atMs: performance.now() });
  };
  const output = audio as HTMLAudioElement & { sinkId?: string; setSinkId?: (deviceId: string) => Promise<void> };
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  audio.preload = "metadata";
  audio.playbackRate = options.rate ?? 1;
  audio.volume = options.volume ?? 1;
  const listeners = new Set<(state: Partial<PlaybackState>) => void>();
  let loop: PlaybackLoop | null = null;
  let stopped = false;
  let desiredPlaying = false;
  let status: PlaybackState["status"] = "paused";
  let deviceVersion = 0;
  const emit = (patch: Partial<PlaybackState>): void => {
    if (stopped) return;
    if (patch.status) status = patch.status;
    for (const listener of listeners) listener({ ...patch, loop: loop ? { ...loop } : null });
  };
  const measuredDuration = (): number | null => options.duration ?? (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
  const changed = (): void => {
    const duration = measuredDuration();
    if (loop && (duration === null || loop.end > duration)) loop = null;
    if (loop && audio.currentTime >= loop.end) audio.currentTime = loop.start;
    const seekable = duration !== null && Number.isFinite(duration) && duration > 0;
    emit({ position: audio.currentTime, duration: seekable ? duration : null, seekable, loopAvailable: seekable, rate: audio.playbackRate, volume: audio.volume, outputDeviceSupported: typeof output.setSinkId === "function", outputDeviceId: output.sinkId });
  };
  const play = async (): Promise<void> => {
    if (stopped) throw new DOMException("Audio playback stopped.", "AbortError");
    if (loop && (audio.currentTime < loop.start || audio.currentTime >= loop.end)) audio.currentTime = loop.start;
    desiredPlaying = true;
    try { await audio.play(); }
    catch (error) { desiredPlaying = false; throw error; }
    if (!stopped && desiredPlaying) emit({ status: "playing", error: null });
  };
  const ended = (): void => {
    if (loop && desiredPlaying) {
      audio.currentTime = loop.start;
      changed();
      void play().catch(error => emit({ status: error instanceof Error && error.name === "NotAllowedError" ? "blocked" : "failed", error: error instanceof Error ? error.message : "Press Play to resume audio." }));
      return;
    }
    desiredPlaying = false;
    emit({ status: "idle", position: audio.currentTime });
  };
  const paused = (): void => {
    if (audio.ended || status === "failed" || status === "blocked") return;
    emit(desiredPlaying ? { status: "blocked", error: "Press Play to resume audio." } : { status: "paused" });
  };
  const failed = (): void => {
    desiredPlaying = false;
    audio.pause();
    emit({ status: "failed", error: "Audio playback failed. Check the output device and press Play." });
  };
  const deviceChanged = (): void => {
    const deviceId = output.sinkId;
    if (!deviceId || deviceId === "default" || !devices) return;
    const expected = deviceVersion;
    void devices.enumerateDevices().then(available => {
      if (stopped || expected !== deviceVersion || output.sinkId !== deviceId || available.some(device => device.kind === "audiooutput" && device.deviceId === deviceId)) return;
      desiredPlaying = false;
      audio.pause();
      emit({ status: "blocked", error: "The audio output device disconnected. Choose an output device and press Play." });
    }, error => emit({ error: error instanceof Error ? error.message : "Unable to check the audio output device." }));
  };
  audio.addEventListener("playing", playing);
  audio.addEventListener("timeupdate", changed);
  audio.addEventListener("durationchange", changed);
  audio.addEventListener("ended", ended);
  audio.addEventListener("pause", paused);
  audio.addEventListener("error", failed);
  if (typeof output.setSinkId === "function") devices?.addEventListener("devicechange", deviceChanged);
  const stop = (): void => {
    if (stopped) return;
    const requestedAtMs = performance.now();
    stopped = true;
    desiredPlaying = false;
    audio.pause();
    audio.removeEventListener("playing", playing);
    audio.removeEventListener("timeupdate", changed);
    audio.removeEventListener("durationchange", changed);
    audio.removeEventListener("ended", ended);
    audio.removeEventListener("pause", paused);
    audio.removeEventListener("error", failed);
    devices?.removeEventListener("devicechange", deviceChanged);
    options.signal?.removeEventListener("abort", stop);
    audio.removeAttribute("src"); audio.load(); listeners.clear();
    measurements.emit({ type: "stop-ack", requestedAtMs, atMs: performance.now() });
    measurements.close();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  return {
    measurements,
    play,
    pause: () => {
      if (stopped) return;
      const requestedAtMs = performance.now();
      desiredPlaying = false;
      audio.pause();
      measurements.emit({ type: "pause-ack", requestedAtMs, atMs: performance.now() });
      emit({ status: "paused" });
    },
    stop,
    seek: seconds => {
      const duration = measuredDuration();
      if (duration === null || !Number.isFinite(duration) || duration <= 0) throw new Error("Seeking is unavailable until completed audio is loaded.");
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) throw new Error("Seek within the completed audio duration.");
      if (loop && (seconds < loop.start || seconds >= loop.end)) throw new Error("Seek within the loop selection or clear the loop.");
      audio.currentTime = seconds;
      changed();
    },
    setRate: rate => { audio.playbackRate = rate; changed(); },
    setVolume: volume => { audio.volume = volume; changed(); },
    setLoop: selection => {
      if (selection) validatePlaybackLoop(selection, measuredDuration());
      loop = selection ? { ...selection } : null;
      if (loop && (audio.currentTime < loop.start || audio.currentTime >= loop.end)) audio.currentTime = loop.start;
      changed();
    },
    ...(typeof output.setSinkId === "function" ? {
      setOutputDevice: async (deviceId: string): Promise<void> => {
        const expected = ++deviceVersion;
        await output.setSinkId!(deviceId);
        if (!stopped && expected === deviceVersion) changed();
      },
    } : {}),
    onState: listener => { listeners.add(listener); changed(); return () => { listeners.delete(listener); }; },
  };
}

export function createSystemSpeechHandle(text: string, options: { voiceURI?: string; language?: string; rate?: number; signal?: AbortSignal } = {}): PlaybackHandle {
  if (typeof speechSynthesis === "undefined") throw new Error("System speech is unavailable on this device. Choose a configured speech provider.");
  const utterance = new SpeechSynthesisUtterance(text);
  const measurements = new PlaybackMeasurements("system");
  let rendered = false;
  utterance.onstart = () => {
    if (rendered) return;
    rendered = true;
    measurements.emit({ type: "first-render", atMs: performance.now() });
  };
  if (options.voiceURI) {
    const voice = speechSynthesis.getVoices().find(item => item.voiceURI === options.voiceURI);
    if (!voice) throw new Error("The selected system voice is unavailable. Choose a different voice.");
    utterance.voice = voice;
  }
  if (options.language) utterance.lang = options.language;
  utterance.rate = options.rate ?? 1;
  const listeners = new Set<(state: Partial<PlaybackState>) => void>();
  let started = false;
  let stopped=false;
  let pauseRequestedAtMs:number|undefined;
  let stopRequestedAtMs:number|undefined;
  utterance.onpause=()=>{if(pauseRequestedAtMs!==undefined){measurements.emit({type:"pause-ack",requestedAtMs:pauseRequestedAtMs,atMs:performance.now()});pauseRequestedAtMs=undefined;}};
  const settled=()=>{if(stopRequestedAtMs!==undefined)measurements.emit({type:"stop-ack",requestedAtMs:stopRequestedAtMs,atMs:performance.now()});measurements.close();utterance.onstart=null;utterance.onpause=null;utterance.onend=null;utterance.onerror=null;};
  utterance.onend = () => { if(!stopped)for (const listener of listeners) listener({ status: "idle" });settled(); };
  utterance.onerror = event => { if (!stopped&&event.error !== "canceled" && event.error !== "interrupted") for (const listener of listeners) listener({ status: "failed", error: "System speech failed. Check the selected voice and audio device." });settled(); };
  const stop = (): void => { if(stopped)return;stopped=true;stopRequestedAtMs=performance.now();utterance.onstart=null;utterance.onpause=null;speechSynthesis.cancel();listeners.clear();options.signal?.removeEventListener("abort", stop);if(!started)measurements.close(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  return {
    measurements,
    play: async () => { if (options.signal?.aborted) throw new DOMException("Speech cancelled", "AbortError"); if (started) speechSynthesis.resume(); else { speechSynthesis.speak(utterance); started = true; } },
    pause: () => {if(!stopped&&started){pauseRequestedAtMs=performance.now();speechSynthesis.pause();}}, stop,
    seek: () => { throw new Error("System voices do not support seeking. Replay or choose a generated audio voice."); },
    setRate: rate => { if (started) throw new Error("Replay system speech to change its rate."); utterance.rate = rate; },
    setVolume: volume => { utterance.volume = volume; },
    onState: listener => {
      listeners.add(listener);
      listener({ seekable: false, loopAvailable: false, loop: null, outputDeviceSupported: false, rate: utterance.rate, volume: utterance.volume });
      return () => { listeners.delete(listener); };
    },
  };
}
