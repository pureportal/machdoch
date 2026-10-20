import { useCallback, useEffect, useRef, useState } from "react";
import { importSpeechRecording, speechPlayback, type SpeechReferenceImport, type SpeechRuntime, type SpeechOperations } from "@machdoch/speech";
import { Field, OWNER, type Run } from "./controls.tsx";
import { recordingDrafts, type RecordingDraft } from "./recording-drafts.ts";
import {waitForRecordingStep} from "./recording-start.ts";

interface Capture {
  stream: MediaStream; context: AudioContext; node: AudioWorkletNode; chunks: ArrayBuffer[];
  transcript: string; rightsEvidence: string; stopped: boolean;
}

interface StartingCapture{controller:AbortController;context:AudioContext;stream:MediaStream|null;closing:Promise<void>|null}

function closeStartingCapture(capture:StartingCapture):Promise<void>{
  capture.stream?.getTracks().forEach(track=>track.stop());
  capture.closing??=capture.context.state==="closed"?Promise.resolve():capture.context.close().catch(error=>{throw new Error("The microphone audio device could not close.",{cause:error});});
  return capture.closing;
}

export function ReferenceRecorder({ runtime, active, rights, permission, busy, run, report, imported }: {
  runtime: SpeechRuntime; active: boolean; rights: string; permission: boolean; busy: boolean; run: Run;
  report(error: unknown): void; imported(reference: SpeechReferenceImport): void;
}) {
  const [transcript, setTranscript] = useState("");
  const [recording, setRecording] = useState(false);
  const [startup,setStartup]=useState<"starting"|"cancelling"|null>(null);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<RecordingDraft[]>([]);
  const [pending, setPending] = useState<SpeechOperations["listRecordingUploads"]["output"]>([]);
  const [resumeDrafts, setResumeDrafts] = useState<Record<string, string>>({});
  const capture = useRef<Capture | null>(null);
  const starting=useRef<StartingCapture|null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const upload = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const [copies, uploads] = await Promise.all([recordingDrafts("list"), runtime.execute("listRecordingUploads", { owner: OWNER })]);
    if (mounted.current) { setDrafts(copies); setPending(uploads); }
  }, [runtime]);
  useEffect(() => { if (active) void refresh().catch(report); }, [active, refresh, report]);

  const stop = useCallback(() => {
    const pending=starting.current;
    if(pending){++generation.current;pending.controller.abort();if(mounted.current)setStartup("cancelling");void closeStartingCapture(pending).catch(()=>report(new Error("The microphone audio device could not close.")));}
    const current = capture.current;
    if (!current || current.stopped) return;
    current.stopped = true;
    current.stream.getTracks().forEach(track => track.stop());
    current.node.port.postMessage("stop");
    if (mounted.current) setRecording(false);
  }, [report]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++generation.current; stop(); upload.current?.abort(); };
  }, [stop]);
  useEffect(() => { if (!active) { ++generation.current; stop(); } }, [active, stop]);

  const save = async (draft: RecordingDraft): Promise<void> => {
    const controller = new AbortController();
    upload.current = controller;
    try {
      const result = await importSpeechRecording(runtime, draft.audio, {
        owner: OWNER, transcript: draft.transcript, rightsEvidence: draft.rightsEvidence, signal: controller.signal,
        onProgress: (bytes, total) => { if (mounted.current) setProgress(bytes / total); },
      });
      await recordingDrafts("delete", draft.id);
      if (mounted.current) imported(result);
    } finally {
      if (upload.current === controller) upload.current = null;
      if (mounted.current) setProgress(null);
      await refresh();
    }
  };

  const start = async (): Promise<void> => {
    if (!permission || !rights.trim() || !transcript.trim()) throw new Error("Confirm permission and enter the reference transcript before recording.");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("Microphone recording is unavailable in this client. Import a WAV reference.");
    const attempt = ++generation.current;
    speechPlayback.pause();
    const context = new AudioContext();
    const pending:StartingCapture={context,controller:new AbortController(),stream:null,closing:null};starting.current=pending;setStartup("starting");
    const signal=pending.controller.signal;
    const resumed=waitForRecordingStep(context.resume(),signal).then(()=>({error:null as unknown}),error=>({error}));
    let transferred=false;
    try {
      const stream=await waitForRecordingStep(navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}}),signal,stream=>stream.getTracks().forEach(track=>track.stop()));pending.stream=stream;
      await waitForRecordingStep(context.audioWorklet.addModule(new URL("./recording-worklet.js", import.meta.url).href),signal);
      const ready=await resumed;if(ready.error!==null)throw ready.error;
      signal.throwIfAborted();
      if (!mounted.current || attempt !== generation.current)return;
      const node = new AudioWorkletNode(context, "machdoch-speech-recorder");
      const current: Capture = { stream, context, node, chunks: [], transcript: transcript.trim(), rightsEvidence: rights.trim(), stopped: false };
      const source = context.createMediaStreamSource(stream);
      const fail = (): void => {
        current.stream.getTracks().forEach(track => track.stop());
        source.disconnect(); node.disconnect();
        if (capture.current === current) { capture.current = null; if (mounted.current) setRecording(false); }
        void context.close().catch(() => report(new Error("The microphone audio device could not close.")));
        report(new Error("Microphone capture failed. Start a new recording."));
      };
      node.onprocessorerror = fail;
      node.port.onmessage = (event: MessageEvent<{ type: string; buffer?: ArrayBuffer; frames?: number; channels?: number; sampleRate?: number }>) => {
        if (event.data.type === "chunk" && event.data.buffer) {
          current.chunks.push(event.data.buffer);
          if (mounted.current && capture.current === current) setSeconds((event.data.frames ?? 0) / context.sampleRate);
        } else if (event.data.type === "complete") {
          current.stream.getTracks().forEach(track => track.stop());
          source.disconnect(); node.disconnect();
          if (capture.current === current) { capture.current = null; if (mounted.current) setRecording(false); }
          void context.close().catch(() => report(new Error("The microphone audio device could not close.")));
          const worker = new Worker(new URL("./recording-worker.ts", import.meta.url), { type: "module" });
          worker.onmessage = (message: MessageEvent<{ buffer?: ArrayBuffer; error?: string }>) => {
            worker.terminate();
            if (!message.data.buffer) { report(new Error(message.data.error ?? "The recording could not be encoded.")); return; }
            const draft: RecordingDraft = { id: crypto.randomUUID(), audio: new Blob([message.data.buffer], { type: "audio/wav" }), transcript: current.transcript, rightsEvidence: current.rightsEvidence, createdAt: new Date().toISOString() };
            void recordingDrafts("save", draft).then(copies => { if (mounted.current) setDrafts(copies); }).catch(report);
          };
          worker.onerror = () => { worker.terminate(); report(new Error("The recording encoder failed. Start another recording.")); };
          worker.postMessage({ chunks: current.chunks, frames: event.data.frames, channels: event.data.channels, sampleRate: event.data.sampleRate }, current.chunks);
        } else if (event.data.type === "error") fail();
      };
      speechPlayback.pause();source.connect(node);node.connect(context.destination);capture.current=current;transferred=true;starting.current=null;
      if (mounted.current) { setSeconds(0);setStartup(null); setRecording(true); }
    } catch (error) { if(!signal.aborted)throw error; }
    finally{
      try{if(!transferred)await closeStartingCapture(pending);}
      finally{if(starting.current===pending){starting.current=null;if(mounted.current)setStartup(null);}}
    }
  };

  return <div className="tts-stack">
    <Field label="Recording transcript"><textarea value={transcript} dir="auto" onChange={event => setTranscript(event.target.value)} /></Field>
    <div className="tts-row">
      <button type="button" disabled={!recording && (busy || startup!==null || !permission || !rights.trim() || !transcript.trim())} onClick={() => recording ? stop() : void run(start)}>{recording ? "Stop recording" : "Record reference"}</button>
      {startup&&<button type="button" disabled={startup==="cancelling"} onClick={stop}>{startup==="cancelling"?"Cancelling recording setup":"Cancel recording setup"}</button>}
      {recording && <output aria-label="Recording duration" aria-live="off">{seconds.toFixed(1)} s</output>}
      <Field label="WAV recording"><input type="file" accept=".wav,audio/wav" disabled={busy || !permission || !rights.trim() || !transcript.trim()} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        void run(async () => {
          if (file.size > 16 * 1024 * 1024) throw new Error("Choose a WAV recording below the local 16 MiB reference guard.");
          const draft: RecordingDraft = { id: crypto.randomUUID(), audio: file, transcript: transcript.trim(), rightsEvidence: rights.trim(), createdAt: new Date().toISOString() };
          await recordingDrafts("save", draft);
          await save(draft);
        });
      }} /></Field>
    </div>
    {progress !== null && <progress aria-label="Recording import" value={progress} max={1} />}
    {drafts.map(draft => <div className="tts-row" key={draft.id}>
      <span>{draft.transcript.slice(0, 100)}</span>
      <button disabled={busy} type="button" onClick={() => void run(() => save(draft))}>Import recording</button>
      <button disabled={busy} type="button" onClick={() => void run(async () => {
        if (!window.confirm("Delete this unsaved recording?")) return;
        setDrafts(await recordingDrafts("delete", draft.id));
      })}>Delete recording</button>
    </div>)}
    {pending.map(item => <div className="tts-row" key={item.id}>
      <span>{item.offset} / {item.bytes} bytes</span>
      <Field label="Recording to resume"><select value={resumeDrafts[item.id] ?? ""} onChange={event => setResumeDrafts(values => ({ ...values, [item.id]: event.target.value }))}>
        <option value="">Choose recording</option>{drafts.filter(draft => draft.audio.size === item.bytes).map(draft => <option key={draft.id} value={draft.id}>{draft.transcript.slice(0, 80)}</option>)}
      </select></Field>
      <button type="button" disabled={busy || !resumeDrafts[item.id]} onClick={() => void run(async () => {
        const draft = drafts.find(draft => draft.id === resumeDrafts[item.id]);
        if (!draft) throw new Error("Choose the original recording to resume this import.");
        const controller = new AbortController();
        upload.current = controller;
        try {
          const result = await importSpeechRecording(runtime, draft.audio, { owner: OWNER, transcript: item.transcript, rightsEvidence: item.rightsEvidence, resume: item, signal: controller.signal, onProgress: (bytes, total) => { if (mounted.current) setProgress(bytes / total); } });
          await recordingDrafts("delete", draft.id); if (mounted.current) imported(result);
        } finally { if (mounted.current) setProgress(null); upload.current = null; await refresh(); }
      })}>Resume import</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => { await runtime.execute("cancelRecording", { owner: OWNER, id: item.id }); await refresh(); })}>Cancel import</button>
    </div>)}
  </div>;
}
