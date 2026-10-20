import { z } from "zod";
import { operationReadSchema, operationReleaseSchema, operationResponseSchema } from "@machdoch/fleet-protocol/operation";

export const speechCapability = "speech.v1";
export const remoteSpeechOperations = [
  "assist", "cancelAssistance", "settings", "listProfiles", "listDictionaries", "dictionaryRevisions", "archiveReferences", "listProjects", "getProject", "saveProject", "duplicateProject",
  "revisions", "getRevision", "restoreRevision", "listVoices", "getVoice", "favoriteVoice", "listFavoriteVoices", "listVoiceReviews", "render", "regenerate", "compareVoices", "align", "getTiming", "listTimings", "resolveTimings",
  "listJobs", "cancel", "readAudio", "listTakes", "resolveTakes", "asset", "readAsset", "downloadInfo", "analyzeAudio", "beginLive", "appendLive",
  "findAnswerAudio", "saveAnswerAudio", "takeRequest", "takeProvenance", "updateTake", "queue", "retry", "retainPlayback", "releasePlayback", "heartbeat", "disconnect",
  "saveSettings", "saveProfile", "deleteProfile", "saveDictionary", "deleteProject", "createVoice", "deleteVoice", "updateVoice", "listVoiceMutations", "checkVoiceMutation", "recordPlaybackMetrics", "designVoice", "getVoiceWorkflow", "getDiagnostics", "importReference", "importAudioTrack", "previewTimeline", "listTemplates", "saveTemplate", "deleteTemplate", "testConnection", "mediaHandoff", "export", "importProject",
  "beginRecording", "writeRecording", "finishRecording", "cancelRecording", "trimReference", "listRecordingUploads", "listReferences",
] as const;

export const speechInvocationSchema = z.strictObject({
  clientId: z.string().uuid(),
  disconnectPolicy: z.enum(["cancel", "retain"]),
  request: z.strictObject({
    operation: z.enum(remoteSpeechOperations),
    input: z.record(z.string(), z.json()),
  }),
});

export const speechRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("invoke"), id: z.string().uuid(), command: z.literal("speech_execute"), args: speechInvocationSchema }),
  operationReadSchema,
  operationReleaseSchema,
]);
export const speechResponseSchema = operationResponseSchema;
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export type SpeechResponse = z.infer<typeof speechResponseSchema>;
