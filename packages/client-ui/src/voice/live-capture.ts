export interface LiveVoiceCaptureOptions {
  signal: AbortSignal;
  sampleRate: 16000 | 24000;
  inputDeviceId?: string | null | undefined;
  onSpeechStart: () => void;
  onAudio: (audio: string) => void;
  onSpeechEnd: () => void;
  onError: (error: Error) => void;
}

export function supportsLiveVoice(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

export function encodeVoicePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(
      index * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

export const voiceProcessorSource = `class VoiceCapture extends AudioWorkletProcessor {
 constructor(){super();this.frames=[];this.length=0;this.voiced=0;this.silence=0;this.duration=0;this.active=false;this.noise=0.003;}
 flush(){if(!this.length)return;const audio=new Float32Array(this.length);let offset=0;for(const frame of this.frames){audio.set(frame,offset);offset+=frame.length;}this.port.postMessage({kind:"audio",audio},[audio.buffer]);this.frames=[];this.length=0;}
 process(inputs){
  const samples=inputs[0]?.[0];if(!samples)return true;
  let energy=0;for(const value of samples)energy+=value*value;
  const level=Math.sqrt(energy/samples.length);
  const loud=level>Math.max(0.012,this.noise*3);
  if(!this.active&&!loud)this.noise=this.noise*0.99+level*0.01;
  this.frames.push(samples.slice());this.length+=samples.length;
  this.voiced=loud?this.voiced+samples.length:0;
  if(!this.active&&this.voiced>=sampleRate*0.08){this.active=true;this.duration=this.length;this.port.postMessage({kind:"speech-start"});}
  if(!this.active){while(this.length>sampleRate*0.25&&this.frames.length>1)this.length-=this.frames.shift().length;return true;}
  this.duration+=samples.length;this.silence=loud?0:this.silence+samples.length;
  if(this.length>=sampleRate*0.04)this.flush();
  if(this.silence>=sampleRate*0.7||this.duration>=sampleRate*25){this.flush();this.port.postMessage({kind:"speech-end"});this.voiced=0;this.silence=0;this.duration=0;this.active=false;}
  return true;
 }
}
registerProcessor("machdoch-live-voice",VoiceCapture);`;

export async function startLiveVoiceCapture(
  options: LiveVoiceCaptureOptions,
): Promise<() => void> {
  if (!supportsLiveVoice())
    throw new Error(
      "Live voice needs microphone access in a secure browser or the desktop app.",
    );
  options.signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(options.inputDeviceId
        ? { deviceId: { exact: options.inputDeviceId } }
        : {}),
    },
  });
  let context: AudioContext | undefined;
  let processor: AudioWorkletNode | undefined;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    options.signal.removeEventListener("abort", stop);
    processor?.disconnect();
    processor?.port.close();
    stream.getTracks().forEach((track) => track.stop());
    if (context)
      void context
        .close()
        .catch((error: unknown) =>
          options.onError(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
  };
  const fail = (error: unknown): void => {
    stop();
    options.onError(error instanceof Error ? error : new Error(String(error)));
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) {
    stop();
    options.signal.throwIfAborted();
  }
  try {
    context = new AudioContext({ sampleRate: options.sampleRate });
    if (context.sampleRate !== options.sampleRate)
      throw new Error(
        "The microphone does not support the required sample rate.",
      );
    const url = URL.createObjectURL(
      new Blob([voiceProcessorSource], { type: "text/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    options.signal.throwIfAborted();
    processor = new AudioWorkletNode(context, "machdoch-live-voice");
    processor.port.onmessage = (event: MessageEvent): void => {
      if (stopped) return;
      try {
        if (event.data?.kind === "speech-start") options.onSpeechStart();
        else if (event.data?.kind === "speech-end") options.onSpeechEnd();
        else if (
          event.data?.kind === "audio" &&
          event.data.audio instanceof Float32Array
        )
          options.onAudio(encodeVoicePcm(event.data.audio));
      } catch (error) {
        fail(error);
      }
    };
    processor.onprocessorerror = () =>
      fail(new Error("Microphone processing stopped. Start live voice again."));
    context.createMediaStreamSource(stream).connect(processor);
    const silent = context.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(context.destination);
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (!stopped)
          fail(
            new Error(
              "The microphone disconnected. Reconnect it and start live voice again.",
            ),
          );
      };
    });
    await context.resume();
    options.signal.throwIfAborted();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
