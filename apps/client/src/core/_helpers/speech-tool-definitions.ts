import type { SpeechJob, SpeechRuntime } from "@machdoch/speech/runtime";
import { completedSpeechTakes } from "@machdoch/speech/completed-takes";
import { nativeSpeechRuntime, parseSpeechExportOptions, produceSpeechProject } from "../speech.js";
import type { SpeechProductionRequest } from "../speech.js";
import { createToolErrorResult, resolveWorkspaceTarget, type AgentToolDefinition } from "./agent-tools-shared.js";
import { validateToolArguments } from "./tool-argument-validation.js";

const outputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    outputPath: { type: "string", minLength: 1 },
    format: { type: "string", enum: ["wav", "mp3", "opus", "flac", "m4b", "srt", "vtt", "txt", "json", "archive"] },
    overwrite: { type: "boolean" }, sampleRate: { type: "integer", minimum: 8000,maximum:192000 }, channels: { type: "integer", enum: [1, 2] }, bitrate: { type: "integer", minimum: 0,maximum:512000 },
    loudnessLufs: { type: ["number", "null"] }, truePeakDb: { type: ["number", "null"] },
    includeBackground:{type:"boolean"},range:{type:"object",additionalProperties:false,properties:{from:{type:"number",minimum:0},to:{type:"number",exclusiveMinimum:0,maximum:604800}},required:["from","to"]},
    referencePermission:{type:"object",additionalProperties:false,properties:{inventorySha256:{type:"string",pattern:"^[a-f0-9]{64}$"},assetIds:{type:"array",minItems:1,maxItems:10000,uniqueItems:true,items:{type:"string",pattern:"^[a-f0-9]{64}$"}},rightsEvidence:{type:"string",minLength:1,maxLength:4096}},required:["inventorySha256","assetIds","rightsEvidence"]},
  },
  required: ["outputPath", "format", "overwrite", "sampleRate", "channels", "bitrate", "loudnessLufs", "truePeakDb"],
};

const productionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    projectId: { type: "string", minLength: 1 }, revisionId: { type: "string", minLength: 1 }, profileId: { type: "string", minLength: 1 },
    takes: { type: "integer", minimum: 1, maximum: 20 }, reuseCache: { type: "boolean" }, cloudConsent: { type: "boolean" }, budgetLimit: { type: ["number", "null"], minimum: 0 },
    output: outputSchema,
  },
  required: ["projectId", "revisionId", "profileId", "takes", "reuseCache", "cloudConsent", "budgetLimit", "output"],
};

const jobsSchema = {
  type: "object", additionalProperties: false,
  properties: {
    jobId: { type: "string", minLength: 1 },
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  }, required: [],
};
const cancelSchema = { type: "object", additionalProperties: false, properties: { jobId: { type: "string", minLength: 1 } }, required: ["jobId"] };
const archiveReferencesSchema={type:"object",additionalProperties:false,properties:{jobId:{type:"string",minLength:1},projectId:{type:"string",minLength:1},revisionId:{type:"string",minLength:1}},required:["jobId","projectId","revisionId"]};
const exportSchema = {
  type: "object", additionalProperties: false,
  properties: {
    jobId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, revisionId: { type: "string", minLength: 1 },
    takeIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    output: outputSchema,
  },
  required: ["jobId", "projectId", "revisionId", "takeIds", "output"],
};

function validateArguments(schema: AgentToolDefinition["spec"]["inputSchema"], args: Record<string, unknown>): void {
  const error = validateToolArguments(schema, args);
  if (error) throw new Error(error);
}

function automationOwner(runId: string | undefined): string {
  if (!runId?.trim()) throw new Error("Choose an owning automation run.");
  return `automation:${runId}`;
}

async function ownedJob(runtime: SpeechRuntime, jobId: unknown, owner: string): Promise<SpeechJob> {
  if (typeof jobId !== "string" || !jobId.trim()) throw new Error("Choose a speech job.");
  const jobs = await runtime.execute("listJobs", { owner, id: jobId, offset: 0, limit: 1 });
  const job = jobs[0];
  if (jobs.length !== 1 || !job || job.id !== jobId || job.owner !== owner) throw new Error("The speech job is unavailable to this automation run.");
  return job;
}

export function createSpeechToolDefinitions(runtime: SpeechRuntime = nativeSpeechRuntime): AgentToolDefinition[] {
  return [{
    spec: {
      name: "speech_produce_project",
      description: "Render an exact Text to Speech project revision and export it through the shared native speech queue. Uses the selected profile and explicit cloud consent and budget; returns durable job and asset evidence.",
      inputSchema: productionSchema,
    },
    backingTool: "workflows", riskLevel: "high", effect: "external-side-effect",
    execute: async (args, context) => {
      try {
        validateArguments(productionSchema, args);
        const owner = automationOwner(context.runId);
        context.signal?.throwIfAborted();
        const request = structuredClone(args) as unknown as Omit<SpeechProductionRequest, "owner">;
        const output = await resolveWorkspaceTarget(context.workspaceRoot, request.output.outputPath);
        if (!output.insideWorkspace) throw new Error("Choose a speech export location inside the active workspace.");
        const result = await produceSpeechProject({ ...request, output: { ...request.output, outputPath: output.resolvedPath }, owner }, { runtime, ...(context.signal ? { signal: context.signal } : {}) });
        return {
          toolResult: { callId: "", name: "speech_produce_project", output: JSON.stringify(result), isError: false },
          sections: [{ title: "Speech export", lines: [`Job: ${result.job.id}`, `SHA-256: ${result.export.sha256}`, `Bytes: ${result.export.bytes}`] }],
          traceLines: [`Speech job ${result.job.id} completed.`],
        };
      } catch (error) {
        return createToolErrorResult("", "speech_produce_project", error instanceof Error ? error.message : "Speech production failed.");
      }
    },
  }, {
    spec: { name: "speech_list_jobs", description: "Inspect a bounded page of speech jobs owned by this automation run, or one explicit job ID. Returns hasMore for subsequent pages.", inputSchema: jobsSchema },
    backingTool: "workflows", riskLevel: "low", effect: "read",
    execute: async (args, context) => {
      try {
        validateArguments(jobsSchema, args);
        const owner = automationOwner(context.runId);
        context.signal?.throwIfAborted();
        const offset = (args.offset as number | undefined) ?? 0;
        const limit = (args.limit as number | undefined) ?? 50;
        const jobId = args.jobId as string | undefined;
        const jobs = await runtime.execute("listJobs", { owner, offset, limit: limit + 1, ...(jobId ? { id: jobId } : {}) });
        context.signal?.throwIfAborted();
        if (jobs.length > limit + 1 || new Set(jobs.map(job => job.id)).size !== jobs.length || jobs.some(job => job.owner !== owner || jobId && job.id !== jobId)) throw new Error("The speech runtime returned an invalid job page for this automation run.");
        return { toolResult: { callId: "", name: "speech_list_jobs", output: JSON.stringify({ jobs: jobs.slice(0, limit), offset, limit, hasMore: jobs.length > limit }), isError: false }, sections: [], traceLines: ["Read speech job states."] };
      } catch (error) { return createToolErrorResult("", "speech_list_jobs", error instanceof Error ? error.message : "Speech jobs are unavailable."); }
    },
  }, {
    spec: { name: "speech_cancel_job", description: "Cancel a speech job owned by this automation run through the shared native queue.", inputSchema: cancelSchema },
    backingTool: "workflows", riskLevel: "medium", effect: "external-side-effect",
    execute: async (args, context) => {
      try {
        validateArguments(cancelSchema, args);
        const owner = automationOwner(context.runId);
        context.signal?.throwIfAborted();
        const job = await ownedJob(runtime, args.jobId, owner);
        context.signal?.throwIfAborted();
        const cancelled = await runtime.execute("cancel", { jobId: job.id, owner });
        if (cancelled.id !== job.id || cancelled.owner !== owner || cancelled.projectId !== job.projectId || cancelled.revisionId !== job.revisionId) throw new Error("The speech runtime returned a cancellation outside the requested job scope.");
        return { toolResult: { callId: "", name: "speech_cancel_job", output: JSON.stringify(cancelled), isError: false }, sections: [], traceLines: [`Speech job ${job.id} is ${cancelled.state}.`] };
      } catch (error) { return createToolErrorResult("", "speech_cancel_job", error instanceof Error ? error.message : "Speech cancellation failed."); }
    },
  }, {
    spec: { name: "speech_archive_references", description: "Inspect reference recordings bundled with a project revision belonging to this run's job. This read does not authorize redistribution; supply the user's separate permission evidence when exporting an archive.",inputSchema:archiveReferencesSchema},
    backingTool:"workflows",riskLevel:"low",effect:"read",
    execute:async(args,context)=>{
      try{
        validateArguments(archiveReferencesSchema,args);const owner=automationOwner(context.runId);context.signal?.throwIfAborted();
        const job=await ownedJob(runtime,args.jobId,owner);
        if(!job.projectId||job.projectId!==args.projectId||job.revisionId!==args.revisionId)throw new Error("The speech job does not match the requested archive project and revision.");
        context.signal?.throwIfAborted();const inventory=await runtime.execute("archiveReferences",{projectId:job.projectId,revisionId:job.revisionId});
        if(inventory.projectId!==job.projectId||inventory.revisionId!==job.revisionId)throw new Error("The archive inventory differs from the requested project revision.");
        return {toolResult:{callId:"",name:"speech_archive_references",output:JSON.stringify(inventory),isError:false},sections:[],traceLines:["Read archive reference inventory."]};
      }catch(error){return createToolErrorResult("","speech_archive_references",error instanceof Error?error.message:"Archive reference inspection failed.");}
    },
  }, {
    spec: { name: "speech_export_job", description: "Export explicitly ordered takes from a completed speech job owned by this automation run. Requires the exact project and revision; reuses existing audio. Archives containing reference recordings also require the user's separate redistribution evidence for the reviewed inventory.", inputSchema: exportSchema },
    backingTool: "workflows", riskLevel: "high", effect: "external-side-effect",
    execute: async (args, context) => {
      try {
        validateArguments(exportSchema, args);
        const owner = automationOwner(context.runId);
        context.signal?.throwIfAborted();
        const jobId = args.jobId;
        const projectId = args.projectId;
        const revisionId = args.revisionId;
        const takeIds = structuredClone(args.takeIds) as string[];
        const options = parseSpeechExportOptions(args.output);
        if (typeof projectId !== "string" || !projectId.trim() || typeof revisionId !== "string" || !revisionId.trim()) throw new Error("Choose an exact speech project and revision.");
        if (!takeIds.length || new Set(takeIds).size !== takeIds.length) throw new Error("Choose distinct speech takes in export order.");
        const output = await resolveWorkspaceTarget(context.workspaceRoot, options.outputPath);
        if (!output.insideWorkspace) throw new Error("Choose a speech export location inside the active workspace.");
        context.signal?.throwIfAborted();
        const job = await ownedJob(runtime, jobId, owner);
        if (job.projectId !== projectId || job.revisionId !== revisionId) throw new Error("The speech job does not match the requested project and revision.");
        if (job.state !== "completed" || job.completedSegments !== job.totalSegments) throw new Error("Complete the speech job before exporting.");
        const takes = await completedSpeechTakes(runtime, job, context.signal);
        context.signal?.throwIfAborted();
        if (takeIds.some(id => !job.takeIds.includes(id) || !takes.some(take => take.id === id && take.projectId === projectId && take.revisionId === revisionId))) throw new Error("Choose completed takes from this speech job and revision.");
        const exported = await runtime.execute("export", { ...options, outputPath: output.resolvedPath, projectId, revisionId, takeIds });
        return { toolResult: { callId: "", name: "speech_export_job", output: JSON.stringify({ jobId: job.id, export: exported }), isError: false }, sections: [], traceLines: [`Exported speech job ${job.id}.`] };
      } catch (error) { return createToolErrorResult("", "speech_export_job", error instanceof Error ? error.message : "Speech export failed."); }
    },
  }];
}
