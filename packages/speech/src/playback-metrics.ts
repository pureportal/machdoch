export type PlaybackTransportKind = "pcm" | "html-audio" | "system";

export type PlaybackMeasurement =
  | { type: "first-render"; atMs: number }
  | { type: "first-samples"; atMs: number }
  | { type: "pause-ack" | "stop-ack"; requestedAtMs: number; atMs: number }
  | { type: "pcm-buffer"; atMs: number; sampleRate: number; maxBufferedFrames: number; underrunFrames: number; underrunCount: number };

export interface PlaybackMeasurementSource {
  readonly transport: PlaybackTransportKind;
  subscribe(listener: (measurement: PlaybackMeasurement) => void): () => void;
}

export class PlaybackMeasurements implements PlaybackMeasurementSource {
  readonly transport: PlaybackTransportKind;
  private readonly listeners = new Set<(measurement: PlaybackMeasurement) => void>();
  private firstSamples:Extract<PlaybackMeasurement,{type:"first-samples"}>|undefined;

  constructor(transport: PlaybackTransportKind) { this.transport = transport; }

  subscribe(listener: (measurement: PlaybackMeasurement) => void): () => void {
    this.listeners.add(listener);
    if(this.firstSamples)listener(this.firstSamples);
    return () => { this.listeners.delete(listener); };
  }

  emit(measurement: PlaybackMeasurement): void {
    if(measurement.type==="first-samples"){if(this.firstSamples)return;this.firstSamples=measurement;}
    for (const listener of this.listeners) listener(measurement);
  }

  close(): void { this.listeners.clear(); }
}

interface PlaybackMetricIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly atMs: number;
}

export type PlaybackMetricSample = PlaybackMetricIdentity & (
  | { readonly event: "intent" }
  | { readonly event: "opened"; readonly openLatencyMs: number; readonly outputTransport?: PlaybackTransportKind }
  | { readonly event: "first-render"; readonly outputTransport: PlaybackTransportKind; readonly timeToFirstAudioMs: number; readonly openToFirstAudioMs: number }
  | { readonly event: "first-samples"; readonly outputTransport: "pcm"; readonly timeToFirstSamplesMs: number }
  | { readonly event: "pause-ack" | "stop-ack"; readonly outputTransport: PlaybackTransportKind; readonly latencyMs: number }
  | { readonly event: "pcm-buffer"; readonly outputTransport: "pcm"; readonly sampleRate: number; readonly maxBufferedFrames: number; readonly maxBufferedAudioMs: number; readonly underrunFrames: number; readonly underrunCount: number }
);

export interface PlaybackMetricSession {
  opened(source?: PlaybackMeasurementSource): void;
}

export class PlaybackMetrics {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly samples: PlaybackMetricSample[] = [];
  private readonly listeners = new Set<(sample: PlaybackMetricSample) => void>();

  constructor(capacity = 256, now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error("Playback metric capacity must be from 1 to 4096.");
    this.capacity = capacity;
    this.now = now;
  }

  snapshot(): readonly PlaybackMetricSample[] { return [...this.samples]; }

  subscribe(listener: (sample: PlaybackMetricSample) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  startSession(): PlaybackMetricSession {
    const sessionId = crypto.randomUUID();
    const intentAtMs = this.now();
    this.append({ id: crypto.randomUUID(), sessionId, atMs: intentAtMs, event: "intent" });
    let openedAtMs: number | undefined;
    return {
      opened: source => {
        if (openedAtMs !== undefined) throw new Error("Playback metrics session is already open.");
        openedAtMs = this.now();
        this.append({
          id: crypto.randomUUID(), sessionId, atMs: openedAtMs, event: "opened",
          openLatencyMs: openedAtMs - intentAtMs,
          ...(source ? { outputTransport: source.transport } : {}),
        });
        if (!source) return;
        const opened = openedAtMs;
        let rendered = false;
        let stopped = false;
        const unsubscribe = source.subscribe(measurement => {
          if (stopped) return;
          const atMs = measurement.atMs;
          if (!Number.isFinite(atMs) || atMs < (measurement.type==="first-samples"?intentAtMs:opened)) throw new Error("Invalid playback measurement clock.");
          const identity = { id: crypto.randomUUID(), sessionId, atMs };
          switch (measurement.type) {
            case "first-samples":
              if(source.transport!=="pcm")throw new Error("Sample receipts require PCM playback.");
              this.append({...identity,event:"first-samples",outputTransport:"pcm",timeToFirstSamplesMs:atMs-intentAtMs});
              break;
            case "first-render":
              if (rendered) return;
              rendered = true;
              this.append({ ...identity, event: "first-render", outputTransport: source.transport, timeToFirstAudioMs: atMs - intentAtMs, openToFirstAudioMs: atMs - opened });
              break;
            case "pause-ack":
            case "stop-ack":
              if (!Number.isFinite(measurement.requestedAtMs) || measurement.requestedAtMs < opened || measurement.requestedAtMs > atMs) throw new Error("Invalid playback acknowledgement clock.");
              this.append({ ...identity, event: measurement.type, outputTransport: source.transport, latencyMs: atMs - measurement.requestedAtMs });
              if (measurement.type === "stop-ack") { stopped = true; unsubscribe(); }
              break;
            case "pcm-buffer": {
              const { sampleRate, maxBufferedFrames, underrunFrames, underrunCount } = measurement;
              if (source.transport !== "pcm" || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
                  !Number.isSafeInteger(maxBufferedFrames) || maxBufferedFrames < 0 || maxBufferedFrames > sampleRate * 5 ||
                  !Number.isSafeInteger(underrunFrames) || underrunFrames < 0 || !Number.isSafeInteger(underrunCount) || underrunCount < 0) throw new Error("Invalid PCM buffer measurement.");
              this.append({ ...identity, event: "pcm-buffer", outputTransport: "pcm", sampleRate, maxBufferedFrames, maxBufferedAudioMs: maxBufferedFrames / sampleRate * 1000, underrunFrames, underrunCount });
              break;
            }
          }
        });
      },
    };
  }

  private append(sample: PlaybackMetricSample): void {
    if (!Number.isFinite(sample.atMs) || sample.atMs < 0) throw new Error("Invalid playback metric clock.");
    const frozen = Object.freeze(sample);
    this.samples.push(frozen);
    if (this.samples.length > this.capacity) this.samples.shift();
    for (const listener of this.listeners) listener(frozen);
  }
}

export const speechPlaybackMetrics = new PlaybackMetrics();

export function persistPlaybackMetrics(metrics:PlaybackMetrics,write:(samples:readonly PlaybackMetricSample[])=>Promise<unknown>,report:(message:string)=>void):()=>void{
  const pending:PlaybackMetricSample[]=[];
  let writing=false;
  const drain=async()=>{
    if(writing)return;
    writing=true;
    try{
      while(pending.length){
        const batch=pending.splice(0,32);
        try{await write(batch);}catch{report("Speech playback measurements could not be stored. Prepare diagnostics after the connection recovers.");}
      }
    }finally{writing=false;}
  };
  const unsubscribe=metrics.subscribe(sample=>{
    if(pending.length===256){report("Speech playback measurement storage is overloaded; some observations were dropped.");return;}
    pending.push(sample);queueMicrotask(()=>void drain());
  });
  return()=>{unsubscribe();void drain();};
}
