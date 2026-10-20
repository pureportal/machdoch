import type { SpeechOperations, SpeechRuntime } from "./runtime.ts";

export interface RemoteSpeechRequest {
  kind: "invoke" | "read" | "release";
  id: string;
  command?: "speech_execute";
  args?: { clientId: string; disconnectPolicy: "cancel" | "retain"; request: { operation: string; input: Record<string, unknown> } };
  offset?: number;
}
export type RemoteSpeechResponse =
  | { state: "pending" }
  | { state: "failed"; error: unknown }
  | { state: "complete"; chunk: string; offset: number; total: number };
export type RemoteSpeechTransport = (request: RemoteSpeechRequest) => Promise<RemoteSpeechResponse>;
export interface RemoteSpeechOptions {
  clientId: string;
  disconnectPolicy: "cancel" | "retain";
  onDiagnostic: (message: string) => void;
}

const supported = new Set([
  "assist", "cancelAssistance", "settings", "listProfiles", "listDictionaries", "dictionaryRevisions", "archiveReferences", "listProjects", "getProject", "saveProject", "duplicateProject",
  "revisions", "getRevision", "restoreRevision", "listVoices", "getVoice", "favoriteVoice", "listFavoriteVoices", "listVoiceReviews", "render", "regenerate", "compareVoices", "align", "getTiming", "listTimings", "resolveTimings", "listJobs",
  "cancel", "readAudio", "listTakes", "resolveTakes", "asset", "readAsset", "downloadInfo", "analyzeAudio", "findAnswerAudio", "saveAnswerAudio", "takeRequest", "takeProvenance", "updateTake", "queue", "retry", "retainPlayback", "releasePlayback", "heartbeat", "disconnect", "beginLive", "appendLive",
  "saveSettings", "saveProfile", "deleteProfile", "saveDictionary", "deleteProject", "createVoice", "deleteVoice", "updateVoice", "checkVoiceMutation", "listVoiceMutations", "designVoice", "getVoiceWorkflow", "getDiagnostics", "importReference", "importAudioTrack", "previewTimeline", "listTemplates", "saveTemplate", "deleteTemplate", "testConnection", "mediaHandoff", "export", "importProject",
  "beginRecording", "writeRecording", "finishRecording", "cancelRecording", "trimReference", "listRecordingUploads", "listReferences",
  "recordPlaybackMetrics",
]);

export function createRemoteSpeechRuntime(transport: RemoteSpeechTransport, options: RemoteSpeechOptions): SpeechRuntime & {
  heartbeat(): Promise<void>;
  disconnect(): Promise<void>;
  readAsset(id: string, offset: number, maxBytes?: number): Promise<{ audioBase64: string; nextOffset: number; complete: boolean; mimeType: string; totalBytes: number }>;
  downloadInfo(id: string): Promise<{ id: string; bytes: number; mimeType: string; sha256: string }>;
} {
  const call = async (operation: string, original: Record<string, unknown>): Promise<unknown> => {
    if (!supported.has(operation)) throw new Error("Perform this speech operation on the owning device.");
    const input = { ...original };
    if (["recordPlaybackMetrics", "retainPlayback", "releasePlayback", "getDiagnostics", "designVoice", "createVoice", "getVoiceWorkflow", "findAnswerAudio", "saveAnswerAudio", "assist", "cancelAssistance", "render", "regenerate", "compareVoices", "align", "beginLive", "appendLive", "listJobs", "cancel", "readAudio", "retry", "beginRecording", "writeRecording", "finishRecording", "cancelRecording", "trimReference", "listRecordingUploads"].includes(operation)) input.owner = `remote:${options.clientId}`;
    const id = crypto.randomUUID();
    let submitted = false;
    try {
      let response = await transport({ kind: "invoke", id, command: "speech_execute", args: { clientId: options.clientId, disconnectPolicy: options.disconnectPolicy, request: { operation, input } } });
      submitted = true;
      const deadline = performance.now() + (operation === "assist" ? 20 * 60_000 : operation === "export" || operation === "importProject" || operation === "previewTimeline" || operation === "importAudioTrack" ? 12 * 3600_000 : 60_000);
      let content = "";
      let total: number | undefined;
      for (;;) {
        if (response.state === "failed") throw new Error(typeof response.error === "string" ? response.error : "Remote speech operation failed. Check the owning device before retrying.");
        if (response.state === "complete") {
          if (!Number.isSafeInteger(response.total) || response.total < 0 || response.total > 64 * 1024 * 1024 || response.offset !== content.length || (total !== undefined && response.total !== total) || response.chunk.length > response.total - response.offset || (response.chunk.length === 0 && response.offset !== response.total)) throw new Error("The remote speech response is malformed.");
          total = response.total;
          content += response.chunk;
          if (content.length === total) {
            const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
          }
        } else {
          if (performance.now() >= deadline) throw new Error("Remote speech completion is uncertain. Check Jobs before retrying.");
          await new Promise<void>(resolve => setTimeout(resolve, 50));
        }
        response = await transport({ kind: "read", id, offset: content.length });
      }
    } finally {
      if (submitted) {
        try {
          const released = await transport({ kind: "release", id });
          if (released.state === "failed") options.onDiagnostic("Remote speech response cleanup failed; the owning device will expire it.");
        } catch {
          options.onDiagnostic("Remote speech response cleanup was interrupted; the owning device will expire it.");
        }
      }
    }
  };
  return {
    transport: "remote",
    execute: <K extends keyof SpeechOperations>(operation: K, input: SpeechOperations[K]["input"]) => call(operation, input as Record<string, unknown>) as Promise<SpeechOperations[K]["output"]>,
    heartbeat: async () => { await call("heartbeat", {}); },
    disconnect: async () => { await call("disconnect", {}); },
    readAsset: (id, offset, maxBytes = 65_536) => call("readAsset", { id, offset, maxBytes }) as Promise<{ audioBase64: string; nextOffset: number; complete: boolean; mimeType: string; totalBytes: number }>,
    downloadInfo: id => call("downloadInfo", { id }) as Promise<{ id: string; bytes: number; mimeType: string; sha256: string }>,
  };
}
