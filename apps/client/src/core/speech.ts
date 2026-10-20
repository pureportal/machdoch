import { setTimeout as delay } from "node:timers/promises";
import { compileSpeechScript, speechRenderSegment } from "@machdoch/speech/compiler";
import type { SpeechExportInput, SpeechJob, SpeechRenderInput, SpeechRuntime, SpeechOperations } from "@machdoch/speech/runtime";
import { requestDesktopSettings } from "./desktop-bridge.js";
import {validateSpeechExportPreset} from "@machdoch/speech/production";
import {speechCastBindings,validateSpeechCastStructure} from "@machdoch/speech/scene-casting";
import {completedSpeechTakes} from "@machdoch/speech/completed-takes";
import {speechProfileCast} from "@machdoch/speech/profile-binding";

export const nativeSpeechRuntime: SpeechRuntime = {
  transport: "native",
  execute: async <K extends keyof SpeechOperations>(operation: K, input: SpeechOperations[K]["input"]): Promise<SpeechOperations[K]["output"]> => await requestDesktopSettings("speech", operation, input) as SpeechOperations[K]["output"],
};

export type SpeechExportOptions = Omit<SpeechExportInput, "projectId" | "takeIds" | "clipIds">;

export interface SpeechProductionRequest {
  projectId: string;
  revisionId: string;
  profileId: string;
  owner: string;
  takes: number;
  reuseCache: boolean;
  cloudConsent: boolean;
  budgetLimit: number | null;
  output: SpeechExportOptions;
}

const renderFields = ["projectId", "revisionId", "profileId", "owner", "takes", "reuseCache", "cloudConsent", "budgetLimit"];
const exportFields = ["outputPath", "format", "overwrite", "sampleRate", "channels", "bitrate", "loudnessLufs", "truePeakDb"];
const exportFormats: readonly string[] = ["wav", "mp3", "opus", "flac", "m4b", "srt", "vtt", "txt", "json", "archive"];

function exactObject(input: unknown, fields: readonly string[], label: string,optional:readonly string[]=[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be a JSON object.`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key=>!fields.includes(key)&&!optional.includes(key)) || fields.some(field => !Object.hasOwn(value, field))) throw new Error(`${label} must contain exactly: ${fields.join(", ")}${optional.length?`; optional: ${optional.join(", ")}`:""}.`);
  return value;
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number or null.`);
  return value;
}

export function parseSpeechExportOptions(input: unknown): SpeechExportOptions {
  const value = exactObject(input, exportFields, "Speech export options",["range","includeBackground","referencePermission"]);
  if (typeof value.format !== "string" || !exportFormats.includes(value.format)) throw new Error("Choose a supported speech export format.");
  if (value.channels !== 1 && value.channels !== 2) throw new Error("Speech export channels must be 1 or 2.");
  if(typeof value.bitrate!=="number"||!Number.isSafeInteger(value.bitrate)||value.bitrate<0)throw new Error("Speech bitrate must be a nonnegative integer.");
  const result:SpeechExportOptions={
    outputPath: nonemptyString(value.outputPath, "outputPath"),
    format: value.format as SpeechExportInput["format"],
    overwrite: boolean(value.overwrite, "overwrite"),
    sampleRate: positiveInteger(value.sampleRate, "sampleRate"),
    channels: value.channels,
    bitrate: value.bitrate,
    loudnessLufs: nullableNumber(value.loudnessLufs, "loudnessLufs"),
    truePeakDb: nullableNumber(value.truePeakDb, "truePeakDb"),
  };
  validateSpeechExportPreset(result);
  if(Object.hasOwn(value,"referencePermission")){
    if(result.format!=="archive")throw new Error("Reference redistribution permission applies only to portable archives.");
    const permission=exactObject(value.referencePermission,["inventorySha256","assetIds","rightsEvidence"],"Archive reference permission");
    if(typeof permission.inventorySha256!=="string"||!/^[a-f0-9]{64}$/u.test(permission.inventorySha256))throw new Error("Supply the reviewed archive reference inventory hash.");
    if(!Array.isArray(permission.assetIds)||!permission.assetIds.length||permission.assetIds.length>10000||permission.assetIds.some(id=>typeof id!=="string"||!/^[a-f0-9]{64}$/u.test(id))||new Set(permission.assetIds).size!==permission.assetIds.length)throw new Error("Authorize distinct reference asset IDs from the archive inventory.");
    const rightsEvidence=nonemptyString(permission.rightsEvidence,"Redistribution permission").trim();
    if(new TextEncoder().encode(rightsEvidence).length>4096)throw new Error("Keep redistribution evidence within 4,096 UTF-8 bytes.");
    result.referencePermission={inventorySha256:permission.inventorySha256,assetIds:[...permission.assetIds] as string[],rightsEvidence};
  }
  if(Object.hasOwn(value,"includeBackground"))result.includeBackground=boolean(value.includeBackground,"includeBackground");
  if(Object.hasOwn(value,"range")){
    const range=exactObject(value.range,["from","to"],"Speech export range");
    if(typeof range.from!=="number"||!Number.isFinite(range.from)||range.from<0||typeof range.to!=="number"||!Number.isFinite(range.to)||range.to<=range.from||range.to>604800)throw new Error("Choose a nonnegative speech range start and a later end within seven days.");
    if(result.format==="archive")throw new Error("Clear the range before exporting a portable project archive.");
    result.range={from:range.from,to:range.to};
  }
  return result;
}

function parseRenderRequest(input: unknown, production: boolean): Omit<SpeechProductionRequest, "output"> {
  const value = exactObject(input, production ? [...renderFields, "output"] : renderFields, "Speech render request");
  const takes = positiveInteger(value.takes, "takes");
  if (takes > 20) throw new Error("Choose 1 to 20 speech takes.");
  const budgetLimit = nullableNumber(value.budgetLimit, "budgetLimit");
  if (budgetLimit !== null && budgetLimit < 0) throw new Error("Speech budget must be nonnegative.");
  return {
    projectId: nonemptyString(value.projectId, "projectId"),
    revisionId: nonemptyString(value.revisionId, "revisionId"),
    profileId: nonemptyString(value.profileId, "profileId"),
    owner: nonemptyString(value.owner, "owner"),
    takes,
    reuseCache: boolean(value.reuseCache, "reuseCache"),
    cloudConsent: boolean(value.cloudConsent, "cloudConsent"),
    budgetLimit,
  };
}

async function prepareSpeechRender(request: Omit<SpeechProductionRequest, "output">, runtime: SpeechRuntime, signal?: AbortSignal): Promise<SpeechRenderInput> {
  signal?.throwIfAborted();
  const [project, profiles, settings] = await Promise.all([
    runtime.execute("getProject", { id: request.projectId }),
    runtime.execute("listProfiles", {}),
    runtime.execute("settings", {}),
  ]);
  signal?.throwIfAborted();
  if (project.id !== request.projectId || project.revisionId !== request.revisionId) throw new Error("The speech project changed. Select its current revision before rendering.");
  const profile = profiles.find(value => value.id === request.profileId);
  if (!profile) throw new Error("Choose an existing speech profile.");
  const connection = settings.connections.find(value => value.backend === profile.backend);
  if (!connection?.configured) throw new Error("Configure the selected speech backend on the owning device.");
  const cast = project.cast.length ? project.cast : speechProfileCast(profile);
  validateSpeechCastStructure({...project,cast});
  const compiled = compileSpeechScript(project.source, {
    backend:profile.backend,
    cast: speechCastBindings(cast,id=>id),
    ...(connection.maxTextBytes === null ? {} : { maxUtf8Bytes: connection.maxTextBytes }),
    ...(connection.maxSpeakers === null ? {} : { maxSpeakers: connection.maxSpeakers }),
  });
  const errors = compiled.diagnostics.filter(value => value.severity === "error");
  if (errors.length) throw new Error(`Fix speech script diagnostics before rendering (${errors.map(value => value.code).join(", ")}).`);
  if (!compiled.segments.length) throw new Error("Add spoken text before rendering.");
  return {
    ...request, priority: 0,expectedProfile:profile,
    segments: compiled.segments.map(speechRenderSegment),
  };
}

function validateJob(job: SpeechJob, render: SpeechRenderInput): void {
  if (job.owner !== render.owner || job.projectId !== render.projectId || job.revisionId !== render.revisionId) throw new Error("The speech runtime returned a job outside the submitted owner, project, or revision.");
  const total = render.segments.length * render.takes;
  if (job.totalSegments !== total || !Number.isSafeInteger(job.completedSegments) || job.completedSegments < 0 || job.completedSegments > total) throw new Error(`Speech job ${job.id} has inconsistent production progress.`);
}

export async function submitSpeechProject(request: Omit<SpeechProductionRequest, "output">, runtime = nativeSpeechRuntime): Promise<SpeechJob> {
  const render = await prepareSpeechRender(parseRenderRequest(request, false), runtime);
  const job = await runtime.execute("render", render);
  validateJob(job, render);
  return job;
}

export async function produceSpeechProject(request: SpeechProductionRequest, options: { signal?: AbortSignal; onProgress?: (job: SpeechJob) => void; runtime?: SpeechRuntime } = {}): Promise<{ job: SpeechJob; export: { path: string; sha256: string; bytes: number } }> {
  const runtime = options.runtime ?? nativeSpeechRuntime;
  const { signal } = options;
  signal?.throwIfAborted();
  const snapshot = { ...parseRenderRequest(request, true), output: parseSpeechExportOptions(request.output) };
  const { output, ...renderRequest } = snapshot;
  const render = await prepareSpeechRender(renderRequest, runtime, signal);
  signal?.throwIfAborted();
  let job = await runtime.execute("render", render);
  validateJob(job, render);
  let cancellation: Promise<{ error: unknown } | null> | undefined;
  const cancel = (): void => {
    if (cancellation || (job.state !== "queued" && job.state !== "running")) return;
    cancellation = Promise.resolve().then(() => runtime.execute("cancel", { jobId: job.id, owner: snapshot.owner })).then(() => null, error => ({ error }));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      options.onProgress?.(structuredClone(job));
      signal?.throwIfAborted();
      if (job.state === "completed") break;
      if (["failed", "cancelled", "uncertain", "interrupted"].includes(job.state)) throw new Error(`Speech job ${job.id} is ${job.state}. Inspect Jobs before retrying.`);
      await delay(200, undefined, signal ? { signal } : {});
      signal?.throwIfAborted();
      const jobs = await runtime.execute("listJobs", { owner: snapshot.owner, projectId: snapshot.projectId,id:job.id,limit:1 });
      signal?.throwIfAborted();
      const latest = jobs.find(value => value.id === job.id);
      if (!latest) throw new Error(`Speech job ${job.id} is unavailable. Inspect Jobs before retrying.`);
      validateJob(latest, render);
      job = latest;
    }
    const takes = await completedSpeechTakes(runtime,job,signal);
    signal?.throwIfAborted();
    const byId = new Map(takes.map(take => [take.id, take]));
    const bySegment = new Map(render.segments.map(segment => [segment.id, [] as string[]]));
    for (const id of job.takeIds) {
      const take = byId.get(id);
      if (!take || take.projectId !== snapshot.projectId || take.revisionId !== snapshot.revisionId) throw new Error(`Speech job ${job.id} is missing a completed take for its submitted revision.`);
      const selected = bySegment.get(take.segmentId);
      if (!selected) throw new Error(`Speech job ${job.id} contains an unexpected production segment.`);
      selected.push(id);
    }
    const takeIds = render.segments.map(segment => {
      const selected = bySegment.get(segment.id)!;
      if (selected.length !== snapshot.takes) throw new Error(`Speech job ${job.id} has incomplete production segments.`);
      return selected[0]!;
    });
    signal?.throwIfAborted();
    const exported = await runtime.execute("export", { ...output, projectId: snapshot.projectId, revisionId: snapshot.revisionId, takeIds });
    signal?.throwIfAborted();
    return { job, export: exported };
  } catch (error) {
    if (signal?.aborted) {
      cancel();
      const failed = await cancellation;
      if (failed) throw new AggregateError([signal.reason, failed.error], `Speech job ${job.id} cancellation failed. Inspect Jobs before retrying.`);
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
