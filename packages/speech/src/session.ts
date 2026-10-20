import type { SpeechJob, SpeechRuntime, SpeechTake, SpeechRenderInput } from "./runtime.ts";
import { createPcmPlaybackHandle } from "./pcm.ts";
import { createAudioPlaybackHandle, type PlaybackHandle } from "./playback.ts";
import { createAudioSequencePlaybackHandle } from "./audio-sequence.ts";
import {completedSpeechTakes} from "./completed-takes.ts";
import {retainSpeechPlayback} from "./playback-retention.ts";

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(new DOMException("Speech cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 150);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export async function renderSpeech(runtime: SpeechRuntime, input: SpeechRenderInput, signal: AbortSignal): Promise<SpeechTake[]> {
  if (signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
  const job = await runtime.execute("render", input);
  let cancellation: Promise<unknown> | undefined;
  const cancel = (): void => { cancellation ??= runtime.execute("cancel", { jobId: job.id, owner: input.owner }); void cancellation.catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    let current: SpeechJob = job;
    while (current.state === "queued" || current.state === "running") {
      if (signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
      await pollDelay(signal);
      const jobs = await runtime.execute("listJobs", { owner: input.owner,id:job.id,limit:1 });
      const next = jobs.find(item => item.id === job.id);
      if (!next) throw new Error("The speech job is missing. Reopen the Jobs panel before retrying.");
      current = next;
    }
    if (signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
    if (current.state !== "completed") throw new Error(current.error ?? `Speech job ${current.state}. Review it in Jobs before retrying.`);
    const takes = await completedSpeechTakes(runtime,current,signal);
    if (signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
    return takes;
  } catch (error) {
    if (cancellation) {
      try { await cancellation; }
      catch { throw new Error("Speech cancellation could not reach the runtime. Stop the job in Jobs.", {cause:error}); }
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function createSpeechPlayback(
  runtime: SpeechRuntime,
  input: SpeechRenderInput,
  signal: AbortSignal,
  options: { assetUrl: (path: string) => string; rate: number; onCancellationFailure: (message: string) => void },
): Promise<PlaybackHandle> {
  if (!input.segments.length || input.takes !== 1) throw new Error("Choose speech segments and one take for foreground preview.");
  const profiles = await runtime.execute("listProfiles", {});
  const profile = profiles.find(profile => profile.id === input.profileId);
  if (!profile) throw new Error("Choose a saved speech profile.");
  if (signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
  if (profile.backend !== "fish-cloud"&&profile.backend!=="sglang") {
    const takes = await renderSpeech(runtime,input,signal);
    const ordered = input.segments.map(segment => {
      const matches = takes.filter(take => take.segmentId === segment.id);
      if (matches.length !== 1) throw new Error("The speech preview did not return one complete take per segment.");
      return matches[0]!;
    });
    return retainSpeechPlayback(runtime,{owner:input.owner,assetIds:ordered.map(take=>take.asset.id)},signal,()=>ordered.length===1
      ?createAudioPlaybackHandle(options.assetUrl(ordered[0]!.asset.path),{rate:options.rate,signal,duration:ordered[0]!.asset.duration})
      :createAudioSequencePlaybackHandle(ordered.map(take=>({url:options.assetUrl(take.asset.path),duration:take.asset.duration})),{rate:options.rate,signal}),options.onCancellationFailure);
  }
  const job = await runtime.execute("render",input);
  let cancellation: Promise<unknown> | undefined;
  const cancel = (): void => {
    if (cancellation) return;
    cancellation = runtime.execute("cancel",{jobId:job.id,owner:input.owner});
    void cancellation.catch(() => options.onCancellationFailure("Speech cancellation could not reach the runtime. Stop the job in Jobs."));
  };
  signal.addEventListener("abort",cancel,{once:true});
  if (signal.aborted) cancel();
  try {
    let segmentIndex = 0;
    let segmentBase = 0;
    const handle = await retainSpeechPlayback(runtime,{owner:input.owner,jobIds:[job.id]},signal,()=>createPcmPlaybackHandle(async (offset,maxBytes,pullSignal) => {
      if (pullSignal.aborted) throw new DOMException("Speech cancelled","AbortError");
      const chunk = await runtime.execute("readAudio",{jobId:job.id,owner:input.owner,segmentId:input.segments[segmentIndex]!.id,offset:offset-segmentBase,maxBytes});
      const nextOffset = segmentBase + chunk.nextOffset;
      if (chunk.complete && segmentIndex < input.segments.length - 1) {
        segmentBase = nextOffset;
        segmentIndex++;
        return {...chunk,nextOffset,complete:false};
      }
      return {...chunk,nextOffset};
    },signal),options.onCancellationFailure);
    handle.setRate(options.rate);
    return { ...handle, stop: () => { handle.stop();signal.removeEventListener("abort",cancel);cancel(); } };
  } catch (error) {
    signal.removeEventListener("abort",cancel);
    cancel();
    throw error;
  }
}
