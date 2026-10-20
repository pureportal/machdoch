import type { SpeechReferenceImport, SpeechRuntime, SpeechOperations } from "./runtime.ts";

export async function importSpeechRecording(runtime: SpeechRuntime, file: Blob, options: {
  owner: string; transcript: string; rightsEvidence: string; signal: AbortSignal;
  resume?: SpeechOperations["listRecordingUploads"]["output"][number];
  onProgress(bytes: number, total: number): void;
}): Promise<SpeechReferenceImport> {
  if (file.size < 44 || file.size > 16 * 1024 * 1024) throw new Error("Choose a WAV recording below the local 16 MiB reference guard.");
  options.signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (options.resume && (options.resume.sha256 !== sha256 || options.resume.bytes !== file.size)) throw new Error("Choose the original recording file to resume this import.");
  const upload = options.resume ?? await runtime.execute("beginRecording", { owner: options.owner, bytes: file.size, sha256, transcript: options.transcript, rightsEvidence: options.rightsEvidence });
  if (!Number.isSafeInteger(upload.offset) || upload.offset < 0 || upload.offset > bytes.length) throw new Error("The saved recording offset is invalid. Cancel the incomplete import and start again.");
  let offset = upload.offset;
  options.onProgress(offset, bytes.length);
  while (offset < bytes.length) {
    options.signal.throwIfAborted();
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 262_144));
    let binary = "";
    for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
    const progress = await runtime.execute("writeRecording", { owner: options.owner, id: upload.id, offset, audioBase64: btoa(binary) });
    if (progress.offset !== offset + chunk.length) throw new Error("The recording upload returned an inconsistent position. Reopen the pending import before resuming.");
    offset = progress.offset;
    options.onProgress(offset, bytes.length);
  }
  options.signal.throwIfAborted();
  return runtime.execute("finishRecording", { owner: options.owner, id: upload.id });
}
