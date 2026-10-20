import { useEffect, useRef, useState } from "react";
import { parseSpeechScript, type CompiledSpeech, type SpeechCompileOptions, type ReadingSentence, type SpeechRenderTarget } from "@machdoch/speech";
import type { ScriptRequest, ScriptResult } from "./script-worker.ts";

const EMPTY: CompiledSpeech = { script: parseSpeechScript(""), segments: [], diagnostics: [] };

export function useScript(source: string, options: SpeechCompileOptions) {
  const transport = useRef<{ worker: Worker; active: ScriptRequest | null; pending: ScriptRequest | null } | null>(null);
  const latest = useRef(0);
  const [result, setResult] = useState<{ source: string; options: SpeechCompileOptions; compiled: CompiledSpeech; sentences: ReadingSentence[]; targets: SpeechRenderTarget[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./script-worker.ts", import.meta.url), { type: "module" });
    const state = { worker, active: null as ScriptRequest | null, pending: null as ScriptRequest | null };
    transport.current = state;
    worker.onmessage = (event: MessageEvent<ScriptResult>) => {
      const active = state.active;
      if (!active || active.id !== event.data.id) { setError("The script worker returned an unexpected result. Reopen Text to Speech."); return; }
      if (active.id === latest.current) {
        if (event.data.ok) {
          setResult({ source: active.source, options: active.options, compiled: event.data.compiled, sentences: event.data.sentences, targets: event.data.targets });
          setError(null);
        } else setError(event.data.error);
      }
      state.active = state.pending;
      state.pending = null;
      if (state.active) worker.postMessage(state.active);
    };
    worker.onerror = () => { setError("Script analysis stopped. Reopen Text to Speech to restart it."); worker.terminate(); };
    worker.onmessageerror = () => { setError("Script analysis could not be read. Reopen Text to Speech."); worker.terminate(); };
    return () => { transport.current = null; worker.terminate(); };
  }, []);

  useEffect(() => {
    const state = transport.current;
    if (!state) return;
    const request = { id: ++latest.current, source, options };
    if (state.active) state.pending = request;
    else { state.active = request; state.worker.postMessage(request); }
  }, [source, options]);

  return { compiled: result?.compiled ?? EMPTY, sentences: result?.sentences ?? [], targets: result?.targets ?? [], ready: !error && result?.source === source && result.options === options, error };
}
