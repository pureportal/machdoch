import type {SpeechBackend,SpeechJob,SpeechJobState,SpeechJobUsage,SpeechProviderResponse} from "./runtime.ts";

export interface SpeechGenerationPerformance{
  scope:"native-runtime";
  dispatches:Array<{ordinal:number;queuedAt:string;claimedAt:string;finishedAt:string|null;state:SpeechJobState;measurements:{queueClock:"utc";queueDelayMs:number|null;workerRunningMs:number|null;cancellationInitiatedMs:number|null;cancellationWorkerReleasedMs:number|null}}>;
  requestCount:number;
  recentRequests:Array<{segmentId:string;source:"provider"|"cache";backend:SpeechBackend;model:string;state:"completed"|"failed"|"cancelled";nativeTotalMs:number;transportPrepareToFirstFrameMs:number|null;producedAudioSeconds:number|null;renderSpeed:number|null;upstreamDispatched:boolean}>;
  recentSuccessfulProviderPercentiles:Array<{metric:"nativeTotalMs"|"transportPrepareToFirstFrameMs"|"renderSpeed";count:number;p50:number;p95:number}>;
}

export interface SpeechDiagnostics {
  schema:"machdoch-speech-diagnostics";version:1;createdAt:string;applicationVersion:string;
  platform:{os:string;architecture:string};
  settings:{cloudConsent:boolean;maxConcurrent:number;answerCharacterLimit:number;cacheRetentionDays:number};
  connections:Array<{backend:SpeechBackend;model:string;configured:boolean;healthy:boolean|null;runtimePinned:boolean;nativeRevision:boolean}>;
  playbackPerformance:{scope:"browser-runtime";sampleCount:number;oldestRecordedAt:string|null;newestRecordedAt:string|null;groups:Array<{transport:"pcm"|"html-audio"|"system"|"unreported";metric:string;aggregation:"session-maximum"|"event-observations";count:number;p50:number;p95:number}>};
  jobs:Array<{
    jobId:string;state:SpeechJobState;kind:SpeechJob["kind"]|null;backend:SpeechBackend|null;model:string|null;
    createdAt:string;updatedAt:string;attempt:number;completedSegments:number;totalSegments:number;
    providerResponseTakeCount:number;providerResponses:Array<{takeId:string;generatedAt:string;reused:boolean;response:SpeechProviderResponse}>;
    performance:SpeechGenerationPerformance;
    errorCategory:"missing-request"|"uncertain-completion"|"application-interrupted"|"request-failed"|"cancelled"|null;
    usage:Pick<SpeechJobUsage,"completedRequests"|"reusedSegments"|"uncertainRequests"|"characters"|"utf8Bytes"|"producedAudioSeconds"|"inputAudioSeconds">|null;
  }>;
}
