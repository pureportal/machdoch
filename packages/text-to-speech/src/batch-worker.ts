import { prepareSpeechBatch } from "@machdoch/speech/batch";

export type BatchWorkerInput = {
  id: number;
  files: Parameters<typeof prepareSpeechBatch>[0];
  options: Parameters<typeof prepareSpeechBatch>[1];
};
export type BatchWorkerOutput = {
  id: number;
  result?: ReturnType<typeof prepareSpeechBatch>;
  error?: string;
};

self.onmessage = (event: MessageEvent<BatchWorkerInput>) => {
  const { id, files, options } = event.data;
  let output: BatchWorkerOutput;
  try {
    output = { id, result: prepareSpeechBatch(files, options) };
  } catch (failure) {
    output = {
      id,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
  self.postMessage(output);
};
