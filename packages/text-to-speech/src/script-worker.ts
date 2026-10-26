import {
  compileSpeechScript,
  type CompiledSpeech,
  type SpeechCompileOptions,
} from "@machdoch/speech/compiler";
import {
  readingSentences,
  type ReadingSentence,
} from "@machdoch/speech/imports";
import {
  speechRenderTargets,
  type SpeechRenderTarget,
} from "@machdoch/speech/render-targets";

export interface ScriptRequest {
  id: number;
  source: string;
  options: SpeechCompileOptions;
}
export type ScriptResult =
  | {
      id: number;
      ok: true;
      compiled: CompiledSpeech;
      sentences: ReadingSentence[];
      targets: SpeechRenderTarget[];
    }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<ScriptRequest>) => {
  const { id, source, options } = event.data;
  let result: ScriptResult;
  try {
    const compiled = compileSpeechScript(source, options);
    result = {
      id,
      ok: true,
      compiled,
      sentences: readingSentences(source),
      targets: compiled.script.diagnostics.some(
        (item) => item.severity === "error",
      )
        ? []
        : speechRenderTargets(compiled.script, options.cast),
    };
  } catch (error) {
    result = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(result);
};
