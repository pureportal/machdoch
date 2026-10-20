import type {SpeechSceneOverride} from "./scene-casting.ts";
import type {SpeechVoiceAudition} from "./voice-auditions.ts";
import type {SpeechTimingInput, SpeechTimingResult, SpeechDurationPricing} from "./transcript-timing.ts";
import type {SpeechRequestPricing,SpeechVoiceWorkflowInput,SpeechVoiceWorkflowResult} from "./voice-workflows.ts";
import type {SpeechDiagnostics} from "./diagnostics.ts";
import type {SpeechArchiveReferences,SpeechArchiveReferencePermission} from "./archive-permissions.ts";
import type {PlaybackMetricSample} from "./playback-metrics.ts";
export type SpeechBackend = "drama3" | "fish-cloud" | "sglang" | "openai" | "google";
export interface SpeechChapter { id: string; title: string }
export interface SpeechCastMember { id: string; name: string; voiceId?: string; voiceObservation?:SpeechVoiceObservation; referenceAssetIds: string[]; direction: string; rightsEvidence?: string; sceneOverrides?:SpeechSceneOverride[] }
export interface SpeechProfile {
  id: string; name: string; backend: SpeechBackend; model: string; voiceId?: string;
  language?: string; normalize?: boolean; direction: string; temperature: number; topP: number;
  chunkLength: number; minChunkLength: number; latency: "normal" | "balanced" | "low";
  dictionaryIds: string[]; playbackRate: number;
  referenceAssetIds?:string[];
}
export interface SpeechClipTiming { id: string; start: number; in: number; out: number; gain: number; fadeIn: number; fadeOut: number; track: number }
export interface SpeechTimelineClip extends SpeechClipTiming { takeId: string }
export interface SpeechDucking { thresholdDbfs: number; reductionDb: number; attackMs: number; releaseMs: number }
export interface SpeechBackgroundClip extends SpeechClipTiming { assetId: string; name: string; role: "music" | "sfx"; ducking: SpeechDucking | null }
export interface SpeechExportPreset {
  format: "wav" | "mp3" | "opus" | "flac" | "m4b" | "srt" | "vtt" | "txt" | "json" | "archive";
  sampleRate: number; channels: number; bitrate: number; loudnessLufs: number | null; truePeakDb: number | null;
}
export interface SpeechProjectTemplate {
  id: string; name: string; source: string; cast: SpeechCastMember[]; profileId: string | null;
  exportSettings: SpeechExportPreset; revisionId: string; parentRevisionId: string | null;
  createdAt: string; updatedAt: string;
}
export interface SpeechReadingBookmark {
  id: string;
  label: string;
  takeId: string;
  assetSha256: string;
  seconds: number;
}
export interface SpeechProject {
  readingBookmarks?: SpeechReadingBookmark[];
  timingSelections?: Record<string, string>;
  voiceAuditions?:SpeechVoiceAudition[];
  exportSettings?: SpeechExportPreset;
  backgroundTracks?: SpeechBackgroundClip[];
  answerOrigin?: { sessionId: string; answerId: string; revision: string };
  id: string; title: string; source: string; cast: SpeechCastMember[]; profileId: string | null;
  revisionId: string; parentRevisionId: string | null; createdAt: string; updatedAt: string;
  archived: boolean; location: string | null; timeline: SpeechTimelineClip[]; selectedTakes: Record<string, string>;
  bookmarks: Array<{ id: string; label: string; offset: number }>;
  variants: Array<{ id: string; language: string; source: string }>;
}
export interface SpeechRevision { id: string; parentId: string | null; projectId: string; createdAt: string; source: string; contentHash: string }
export type SpeechProjectSummary=Pick<SpeechProject,"id"|"title"|"revisionId"|"updatedAt"|"archived"|"location"|"profileId">;
export type SpeechRevisionSummary=Omit<SpeechRevision,"source">;
export interface SpeechAsset { id: string; sha256: string; mimeType: string; bytes: number; duration: number; sampleRate: number; channels: number; path: string }
export interface SpeechTake {
  providerResponse?:SpeechProviderResponse;
  voiceObservations?:SpeechVoiceObservation[];
  spokenText: string; chapter: SpeechChapter | null;
  id: string; projectId: string | null; revisionId: string; segmentId: string; asset: SpeechAsset;
  createdAt: string; generatedAt: string; reusedFromTakeId: string | null; backend: SpeechBackend; model: string; requestHash: string; parentTakeId: string | null;
  favorite: boolean; rating: number | null; note: string;
  alignment: Array<{ text: string; start: number; end: number }>;
}
export interface SpeechTakeRequest {
  performanceNote?: string;
  segment: SpeechRenderSegment & {assistantRequest?: Record<string, unknown>}; profile: SpeechProfile; dictionaries: SpeechDictionary[];
  references: Record<string, { assetId: string; sha256: string; transcript: string; rights: string }>;
  connection: { backend: SpeechBackend; model: string; url: string | null; runtimeVersion: string | null };
}
export interface SpeechGoogleUsage {
  promptTokenCount?:number;cachedContentTokenCount?:number;candidatesTokenCount?:number;
  toolUsePromptTokenCount?:number;thoughtsTokenCount?:number;totalTokenCount?:number;
}
export type SpeechProviderResponse = {provider:"openai";requestId?:string;processingMs?:number}|{provider:"google";modelVersion?:string;responseId?:string;usageMetadata?:SpeechGoogleUsage}|{provider:"sglang";requestId:string;finishReason:"stop";usage?:{input_tokens?:number;output_tokens?:number;total_tokens?:number}};
export interface SpeechTakeProvenance {
  voiceObservations?:SpeechVoiceObservation[];
  segment:SpeechTakeRequest["segment"];
  profile:SpeechProfile;
  dictionaries:Array<Pick<SpeechDictionary,"id"|"name"|"revision">>;
  connection:SpeechTakeRequest["connection"];
  referenceHashes:Record<string,string>;
  performanceNote?:string;
}
export type SpeechJobState = "queued" | "running" | "completed" | "cancelled" | "failed" | "uncertain" | "interrupted";
export interface SpeechJobUsage {
  estimatedCommittedCost:number|null; estimatedUncertainCost:number|null; currency:string|null;
  pricing:SpeechPreferences["pricing"]|SpeechDurationPricing|SpeechRequestPricing|null;
  characters:number; utf8Bytes:number; completedRequests:number; reusedSegments:number; uncertainRequests:number;
  producedAudioSeconds:number; inputAudioSeconds:number;
}
export interface SpeechJob {
  kind?: "alignment"|"voice-design"|"voice-creation"; timingId?: string | null;
  id: string; owner: string; projectId: string | null; revisionId: string; state: SpeechJobState;
  completedSegments: number; totalSegments: number; takeIds: string[]; error: string | null;
  createdAt: string; updatedAt: string; priority: number; attempt: number; parentJobId: string | null;
  cancelRequestedAt?:string; usage?:SpeechJobUsage;
}
export interface SpeechVoice { id: string; name: string; author: string | null; languages: string[]; visibility: string; previewUrl: string | null; rights: string | null; favorite: boolean; evidence?:{provider:"fish-cloud";url:string;observedAt:string;responseSha256:string;authorId:string|null;source:string|null;providerCreatedAt:string|null;providerUpdatedAt:string|null} }
export type SpeechVoiceObservation=Omit<SpeechVoice,"previewUrl"|"favorite"|"evidence">&{evidence:NonNullable<SpeechVoice["evidence"]>};
export interface SpeechVoiceChanges {name?:string;visibility?:"private"|"unlist"}
export interface SpeechVoiceMutation{id:string;voiceId:string;operation:"delete"|"update";changes:SpeechVoiceChanges|null;state:"pending"|"uncertain"|"deleted"|"updated"|"unavailable"|"rejected"|"superseded";createdAt:string;updatedAt:string;retryAfter:string;parentId:string|null;httpStatus:number|null;remoteStatus:number|null;remoteVoice:{name:string;visibility:SpeechVoice["visibility"]}|null;errorCategory:string|null}
export interface SpeechDictionary { id: string; name: string; revision: string; rules: Array<{ id: string; text: string; phonemes: string; alphabet: "arpabet" | "pinyin" | "romaji"; caseSensitive: boolean }> }
export interface SpeechConnectionStatus { backend: SpeechBackend; configured: boolean; healthy: boolean | null; error: string | null; runtimeVersion: string | null; model: string; nativeRevision: boolean; maxTextBytes: number | null; maxSpeakers: number | null; url?: string }
export interface SpeechPreferences {
  cloudConsent: boolean;
  maxConcurrent: number;
  pricing: { unit: "characters" | "utf8Bytes"; perMillion: number; currency: string; source: string; effectiveFrom: string; effectiveTo: string } | null;
  budgetLimit: number | null;
  answerBudgetLimit: number | null;
  answerCharacterLimit: number;
  cacheRetentionDays: number;
}
export interface SpeechSettings extends SpeechPreferences { connections: SpeechConnectionStatus[]; modelRoot: string }
export interface SpeechRenderSegment { id: string; text: string; spokenText: string; chapter: SpeechChapter | null; voiceIds: string[]; referenceAssetIds: string[]; referenceGroups?: string[][]; liveFragments?:string[] }
export interface SpeechRenderInput {
  owner: string; projectId: string | null; revisionId: string; profileId: string;
  segments: SpeechRenderSegment[]; takes: number; priority: number; reuseCache: boolean;
  cloudConsent: boolean; budgetLimit: number | null; parentJobId?: string;
  dictionaryRevisions?: Array<{id:string;revision:string}>;
  expectedProfile?: SpeechProfile;
}
export interface SpeechExportInput extends SpeechExportPreset { projectId: string; revisionId?: string; takeIds: string[]; clipIds?:string[]; outputPath: string; overwrite: boolean; range?: { from: number; to: number }; includeBackground?: boolean;referencePermission?:SpeechArchiveReferencePermission }
export interface SpeechAudioAnalysis {
  peaks: Array<{ startFrame: number; endFrame: number; min: number; max: number }>;
  duration: number; frames: number; sampleRate: number; channels: number; sampleCount: number;
  samplePeakDbfs: number | "-inf"; rmsDbfs: number | "-inf";
  clippedSamples: number; zeroSamples: number; silentFrames: number;
  leadingSilence:number; trailingSilence:number;
  loudness: { integratedLufs: number | "-inf"; truePeakDbtp: number | "-inf" };
}
export interface Drama3ModelStatus { state: "idle" | "downloading" | "verifying" | "paused" | "failed" | "installed"; bytes: number; totalBytes: number; error: string | null; path: string; licenseUrl: string }
export interface SpeechOperations {
  runtimeModelStatus: { input: Record<string, never>; output: Drama3ModelStatus };
  runtimeInstallModel: { input: { acceptLicense: boolean }; output: Drama3ModelStatus };
  runtimeCancelDownload: { input: Record<string, never>; output: Drama3ModelStatus };
  runtimeRemoveModel: { input: Record<string, never>; output: Drama3ModelStatus };
  recordPlaybackMetrics:{input:{owner:string;samples:readonly PlaybackMetricSample[]};output:null};
  listFavoriteVoices:{input:{offset:number;limit:number;search?:string;language?:string};output:{favorites:Array<{id:string;voice:SpeechVoice|null}>;total:number;offset:number;limit:number}};
  archiveReferences:{input:{projectId:string;revisionId:string};output:SpeechArchiveReferences};
  retainPlayback:{input:{id:string;owner:string;assetIds:string[];jobIds:string[]};output:{id:string;expiresAt:string}};
  releasePlayback:{input:{id:string;owner:string};output:void};
  getDiagnostics:{input:{limit:number;owner?:string};output:SpeechDiagnostics};
  listVoiceReviews:{input:{voiceId?:string;language?:string;verdict?:"approved"|"rejected";offset:number;limit:number};output:{reviews:Array<{projectId:string;projectTitle:string;review:SpeechVoiceAudition}>;total:number}};
  compareVoices: {input:{owner:string;profileId:string;segment:SpeechRenderSegment;voiceIds:string[];cloudConsent:boolean;budgetLimit:number|null};output:SpeechJob};
  regenerate: { input: {owner:string; takeId:string; note:string; takes:number; cloudConsent:boolean; budgetLimit:number|null}; output:SpeechJob };
  align: { input: SpeechTimingInput; output: SpeechJob };
  getTiming: { input: { id: string }; output: SpeechTimingResult };
  listTimings: { input: { takeId: string }; output: SpeechTimingResult[] };
  resolveTimings: { input: { projectId: string; selections: Record<string, string> }; output: SpeechTimingResult[] };
  beginLive: { input: SpeechRenderInput & { maxCharacters:number }; output:SpeechJob };
  findAnswerAudio: { input:{ owner:string; alternateOwner?:string; answerId:string; revision:string; source:string; profileId:string }; output:SpeechTake|null };
  appendLive: { input: { jobId:string; owner:string; sequence:number; text:string; finish:boolean; answerRevision?:string; finalText?:string }; output:{ accepted:boolean; nextSequence:number; finished:boolean } };
  previewTimeline: { input: { projectId: string; revisionId: string; takeIds: string[]; sampleRate: number; channels: number; loudnessLufs: number | null; truePeakDb: number | null; range?: { from: number; to: number }; includeBackground: boolean; reuseCache: boolean }; output: { id: string; asset: SpeechAsset; projectId: string; revisionId: string } };
  importAudioTrack: { input: { path: string; rightsEvidence: string }; output: { asset: SpeechAsset; provenance: { sourceSha256: string; sourceBytes: number; rightsEvidence: string } } };
  listTemplates: { input: { search?: string }; output: SpeechProjectTemplate[] };
  saveTemplate: { input: { template: SpeechProjectTemplate; expectedRevisionId: string | null }; output: SpeechProjectTemplate };
  deleteTemplate: { input: { id: string; expectedRevisionId: string }; output: null };
  cleanCache: { input: { restart: boolean }; output: { assets: number; bytes: number; pending: boolean } };
  assist: { input: { owner: string; taskId: string; action: "direction" | "casting" | "pronunciation" | "localization"; source: string; instruction: string; language?: string; cast: SpeechCastMember[]; voices: Array<{ id: string; name: string; languages: string[] }> }; output: unknown };
  cancelAssistance: { input: { owner: string; taskId: string }; output: null };
  beginRecording: { input: { owner: string; bytes: number; sha256: string; transcript: string; rightsEvidence: string }; output: { id: string; offset: number } };
  listReferences: { input: { offset: number; limit: number }; output: { references: Array<{ asset: SpeechAsset; transcript: string; rightsEvidence: string }>; total: number } };
  writeRecording: { input: { owner: string; id: string; offset: number; audioBase64: string }; output: { offset: number } };
  finishRecording: { input: { owner: string; id: string }; output: SpeechReferenceImport };
  cancelRecording: { input: { owner: string; id: string }; output: null };
  listRecordingUploads: { input: { owner: string }; output: Array<{ id: string; owner: string; bytes: number; sha256: string; offset: number; transcript: string; rightsEvidence: string; createdAt: string }> };
  trimReference: { input: { owner: string; assetId: string; from: number; to: number; transcript: string }; output: SpeechReferenceImport };
  queue: { input: { paused?: boolean }; output: { paused: boolean } };
  analyzeAudio: { input: { assetId: string; buckets: number; reuseCache?:boolean }; output: SpeechAudioAnalysis };
  readAudio: { input: { jobId: string; owner: string; segmentId: string; offset: number; maxBytes: number }; output: { audioBase64: string; nextOffset: number; complete: boolean; sampleRate: number|null; channels: number|null } };
  listProjects: { input: { search?: string; archived?: boolean;id?:string;offset:number;limit:number }; output: {projects:SpeechProjectSummary[];total:number;offset:number;limit:number} };
  getProject: { input: { id: string }; output: SpeechProject };
  saveProject: { input: { project: SpeechProject; expectedRevisionId: string | null }; output: SpeechProject };
  duplicateProject: { input: { id: string; expectedRevisionId: string; title: string }; output: SpeechProject };
  deleteProject: { input: { id: string }; output: null };
  revisions: { input: { projectId: string;offset:number;limit:number }; output: {revisions:SpeechRevisionSummary[];total:number;offset:number;limit:number} };
  getRevision:{input:{projectId:string;revisionId:string};output:SpeechRevision};
  restoreRevision: { input: { projectId: string; revisionId: string; expectedRevisionId: string }; output: SpeechProject };
  listProfiles: { input: Record<string, never>; output: SpeechProfile[] };
  saveProfile: { input: { profile: SpeechProfile }; output: SpeechProfile };
  deleteProfile: { input: { id: string }; output: null };
  listDictionaries: { input: Record<string, never>; output: SpeechDictionary[] };
  dictionaryRevisions: { input: {id:string;offset:number;limit:number}; output: {revisions:SpeechDictionary[];total:number} };
  saveDictionary: { input: { dictionary: SpeechDictionary }; output: SpeechDictionary };
  render: { input: SpeechRenderInput; output: SpeechJob };
  retry: { input: { jobId: string; owner: string; confirmedUncertain: boolean }; output: SpeechJob };
  listJobs: { input: { owner?: string; projectId?: string; id?:string; limit?:number; offset?:number; kinds?:Array<NonNullable<SpeechJob["kind"]>>; states?:SpeechJobState[] }; output: SpeechJob[] };
  cancel: { input: { jobId: string; owner: string }; output: SpeechJob };
  listTakes: { input: { projectId?: string; jobId?: string; limit?:number; offset?:number }; output: SpeechTake[] };
  resolveTakes: { input: {projectId:string;ids:string[]}; output:SpeechTake[] };
  takeRequest: { input: { id: string }; output: SpeechTakeRequest };
  takeProvenance: {input:{id:string};output:SpeechTakeProvenance};
  saveAnswerAudio: { input: { owner: string; alternateOwner?: string; answerId: string; revision: string; source: string; title: string; sessionId: string }; output: SpeechProject };
  updateTake: { input: { id: string; favorite?: boolean; rating?: number | null; note?: string }; output: SpeechTake };
  asset: { input: { id: string }; output: SpeechAsset };
  importReference: { input: { path: string; transcript: string; rightsEvidence: string; cloudConsent: boolean }; output: SpeechAsset };
  listVoices: { input: { page: number; pageSize: number; search?: string; language?: string; own?: boolean }; output: { voices: SpeechVoice[]; total: number } };
  getVoice: { input: { id: string }; output: SpeechVoice };
  favoriteVoice: { input: { id: string; favorite: boolean }; output: null };
  createVoice: { input: SpeechVoiceWorkflowInput & { name: string; referenceAssetIds: string[]; transcripts: string[]; rightsEvidence: string; permissionConfirmed:boolean; designCandidateId?: string }; output: SpeechJob };
  deleteVoice: { input: { id: string; confirmed: boolean;retryMutationId?:string }; output: SpeechVoiceMutation };
  updateVoice:{input:{id:string;confirmed:boolean;changes:SpeechVoiceChanges;retryMutationId?:string};output:SpeechVoiceMutation};
  checkVoiceMutation:{input:{id:string};output:SpeechVoiceMutation};
  listVoiceMutations:{input:{offset:number;limit:number};output:{mutations:SpeechVoiceMutation[];total:number;offset:number;limit:number}};
  designVoice: { input: SpeechVoiceWorkflowInput & { description: string; text: string }; output: SpeechJob };
  getVoiceWorkflow: {input:{owner:string;jobId:string};output:SpeechVoiceWorkflowResult};
  settings: { input: Record<string, never>; output: SpeechSettings };
  saveSettings: { input: { settings: SpeechPreferences }; output: SpeechSettings };
  setConnection: { input: { backend: SpeechBackend; secret?: string; deleteSecret?: boolean; url?: string; runtimeVersion?: string; model?: string }; output: SpeechConnectionStatus };
  testConnection: { input: { backend: SpeechBackend }; output: SpeechConnectionStatus };
  export: { input: SpeechExportInput; output: { path: string; sha256: string; bytes: number } };
  importProject: { input: { path: string }; output: SpeechProject };
  mediaHandoff: { input: { projectId: string; takeId: string }; output: { assetId: string; sourceProjectId: string } };
}
export interface SpeechEvent {
  owner: string; sessionId: string; jobId: string; sequence: number;
  kind: "job" | "audio" | "alignment" | "usage" | "complete" | "error";
  data: unknown;
}
export interface SpeechRuntime {
  transport: "native" | "remote";
  execute<K extends keyof SpeechOperations>(operation: K, input: SpeechOperations[K]["input"]): Promise<SpeechOperations[K]["output"]>;
}
export interface SpeechReferenceImport {
  asset: SpeechAsset; originalAsset: SpeechAsset; quality: Omit<SpeechAudioAnalysis, "loudness">;
  transcript: string; rightsEvidence: string;
}
export type SpeechInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export function createSpeechRuntime(invoke: SpeechInvoke): SpeechRuntime {
  return { transport: "native", execute: (operation, input) => invoke("speech_execute", { request: { operation, input } }) };
}
