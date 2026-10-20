import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SpeechJob, SpeechOperations, SpeechProfile, SpeechProject, SpeechRenderInput, SpeechRuntime, SpeechSettings, SpeechTake } from "@machdoch/speech/runtime";
import { parseSpeechExportOptions, produceSpeechProject, submitSpeechProject, type SpeechProductionRequest } from "./speech.js";
import { createSpeechToolDefinitions } from "./_helpers/speech-tool-definitions.js";

type Handlers = { [K in keyof SpeechOperations]?: (input: SpeechOperations[K]["input"]) => SpeechOperations[K]["output"] | Promise<SpeechOperations[K]["output"]> };
type Tool = ReturnType<typeof createSpeechToolDefinitions>[number];
type ToolContext = Parameters<Tool["execute"]>[1];

function productionRequest(): SpeechProductionRequest {
  return {
    projectId: "project-1", revisionId: "revision-1", profileId: "profile-1", owner: "automation:run-1",
    takes: 2, reuseCache: false, cloudConsent: false, budgetLimit: 0,
    output: { outputPath: resolve(process.cwd(), "speech.wav"), format: "wav", overwrite: false, sampleRate: 48000, channels: 1, bitrate: 128, loudnessLufs: null, truePeakDb: null },
  };
}

function fixture(state: SpeechJob["state"] = "completed") {
  const project: SpeechProject = {
    id: "project-1", title: "Narration", source: "The first sentence is here.\n\nThe second sentence is here.\n\nThe third sentence is here.",
    cast: [], profileId: "profile-1", revisionId: "revision-1", parentRevisionId: null, createdAt: "", updatedAt: "",
    archived: false, location: null, timeline: [], selectedTakes: {}, bookmarks: [], variants: [],
  };
  const profile: SpeechProfile = {
    id: "profile-1", name: "Narrator", backend: "fish-cloud", model: "drama-3", voiceId: "voice-1", direction: "",
    temperature: 0.7, topP: 0.7, chunkLength: 200, minChunkLength: 0, latency: "normal", dictionaryIds: [], playbackRate: 1,
  };
  const settings: SpeechSettings = {
    cloudConsent: false, maxConcurrent: 1, pricing: null, budgetLimit: null, answerBudgetLimit: null, answerCharacterLimit: 1000, cacheRetentionDays: 30,
    modelRoot: "D:\\Models\\machdoch",
    connections: [{ backend: "fish-cloud", configured: true, healthy: true, error: null, runtimeVersion: null, model: "drama-3", nativeRevision: false, maxTextBytes: 64, maxSpeakers: 16 }],
  };
  const handlers: Handlers = {};
  let render: SpeechRenderInput | undefined;
  let job: SpeechJob | undefined;
  let takes: SpeechTake[] = [];
  const createJob = (input: SpeechRenderInput): SpeechJob => {
    render = structuredClone(input);
    takes = input.segments.flatMap(segment => Array.from({ length: input.takes }, (_, index): SpeechTake => {
      const id = `${segment.id}-take-${index}`;
      return {
        id, projectId: input.projectId, revisionId: input.revisionId, segmentId: segment.id, spokenText: segment.spokenText, chapter: segment.chapter,
        asset: { id: `asset-${id}`, sha256: "a".repeat(64), mimeType: "audio/wav", bytes: 100, duration: 1, sampleRate: 48000, channels: 1, path: `${id}.wav` },
        createdAt: "", generatedAt: "", reusedFromTakeId: null, backend: profile.backend, model: profile.model, requestHash: "request-hash", parentTakeId: null,
        favorite: false, rating: null, note: "", alignment: [],
      };
    }));
    job = {
      id: "job-1", owner: input.owner, projectId: input.projectId, revisionId: input.revisionId, state,
      completedSegments: state === "completed" ? takes.length : 0, totalSegments: takes.length,
      takeIds: state === "completed" ? takes.map(take => take.id).reverse() : [], error: null, createdAt: "", updatedAt: "",
      priority: 0, attempt: 1, parentJobId: null,
    };
    return structuredClone(job);
  };
  const execute = vi.fn(async (operation: keyof SpeechOperations, input: unknown): Promise<unknown> => {
    const handler = handlers[operation] as ((value: unknown) => unknown) | undefined;
    if (handler) return await handler(input);
    switch (operation) {
      case "getProject": return structuredClone(project);
      case "listProfiles": return [structuredClone(profile)];
      case "settings": return structuredClone(settings);
      case "render": return createJob(input as SpeechRenderInput);
      case "listJobs": return job ? [structuredClone(job)] : [];
      case "listTakes": return structuredClone(takes);
      case "cancel": return { ...job, state: "cancelled" };
      case "export": return { path: (input as SpeechOperations["export"]["input"]).outputPath, sha256: "e".repeat(64), bytes: 200 };
      default: throw new Error(`Unexpected speech operation: ${operation}`);
    }
  });
  const runtime: SpeechRuntime = { transport: "native", execute: execute as SpeechRuntime["execute"] };
  return { runtime, execute, handlers, project, profile, settings, createJob, get render() { return render!; }, get job() { return job!; }, get takes() { return takes; } };
}

function renderRequest() {
  const { output: _output, ...request } = productionRequest();
  return request;
}

function toolContext(): ToolContext {
  return { workspaceRoot: process.cwd(), runId: "run-1", memory: {} as ToolContext["memory"] };
}

function findTool(runtime: SpeechRuntime, name: string): Tool {
  return createSpeechToolDefinitions(runtime).find(tool => tool.spec.name === name)!;
}

describe("speech automation JSON boundaries", () => {
  it("preserves separately supplied archive permission without deriving it from cloning metadata",()=>{
    const referencePermission={inventorySha256:"a".repeat(64),assetIds:["b".repeat(64)],rightsEvidence:"Owner permits this recording in the archive."};
    const parsed=parseSpeechExportOptions({...productionRequest().output,format:"archive",referencePermission});expect(parsed.referencePermission).toEqual(referencePermission);referencePermission.assetIds[0]="c".repeat(64);expect(parsed.referencePermission!.assetIds).toEqual(["b".repeat(64)]);
    expect(parseSpeechExportOptions({...productionRequest().output,format:"archive"}).referencePermission).toBeUndefined();
  });
  it.each(["audio-format","wrong-hash","duplicate-assets","empty-evidence","oversized-utf8","extra-field"])("rejects %s archive permission at the JSON boundary",failure=>{
    const referencePermission:Record<string,unknown>={inventorySha256:"a".repeat(64),assetIds:["b".repeat(64)],rightsEvidence:"Owner permits this archive."};
    if(failure==="wrong-hash")referencePermission.inventorySha256="unreviewed";
    if(failure==="duplicate-assets")referencePermission.assetIds=["b".repeat(64),"b".repeat(64)];
    if(failure==="empty-evidence")referencePermission.rightsEvidence=" ";
    if(failure==="oversized-utf8")referencePermission.rightsEvidence="界".repeat(1366);
    if(failure==="extra-field")referencePermission.cloningPermission=true;
    expect(()=>parseSpeechExportOptions({...productionRequest().output,format:failure==="audio-format"?"wav":"archive",referencePermission})).toThrow();
  });
  it("preserves explicit background and range choices and rejects malformed range or normalization",()=>{
    const output=productionRequest().output;
    expect(parseSpeechExportOptions({...output,includeBackground:true,range:{from:0.25,to:3}})).toMatchObject({includeBackground:true,range:{from:0.25,to:3}});
    for(const range of [{from:1,to:1},{from:-1,to:2},{from:0,to:Infinity},{from:0,to:2,unknown:true}])expect(()=>parseSpeechExportOptions({...output,range})).toThrow();
    expect(()=>parseSpeechExportOptions({...output,format:"archive",range:{from:0,to:2}})).toThrow(/archive/);
    expect(()=>parseSpeechExportOptions({...output,loudnessLufs:-16})).toThrow(/both/);
  });
  const invalidRenderValues: Array<[string, unknown]> = [
    ["projectId", ""], ["revisionId", "  "], ["profileId", 3], ["owner", null],
    ["takes", 0], ["takes", 21], ["takes", 1.5], ["takes", "2"],
    ["reuseCache", "false"], ["cloudConsent", 1], ["budgetLimit", -1], ["budgetLimit", Infinity], ["budgetLimit", undefined],
  ];

  it.each(invalidRenderValues)("rejects invalid %s before runtime calls (%s)", async (field, value) => {
    const test = fixture();
    await expect(submitSpeechProject({ ...renderRequest(), [field]: value } as Parameters<typeof submitSpeechProject>[0], test.runtime)).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each(Object.keys(renderRequest()))("requires the explicit %s field", async field => {
    const test = fixture();
    const request = { ...renderRequest() } as Record<string, unknown>;
    delete request[field];
    await expect(submitSpeechProject(request as unknown as Parameters<typeof submitSpeechProject>[0], test.runtime)).rejects.toThrow(/exactly/);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each([null, [], "request", { ...renderRequest(), priority: 100 }])("rejects nonobjects and extra render fields", async request => {
    const test = fixture();
    await expect(submitSpeechProject(request as Parameters<typeof submitSpeechProject>[0], test.runtime)).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["format", "aac"], ["outputPath", " "], ["overwrite", "false"], ["sampleRate", 0], ["sampleRate", 1.5],
    ["sampleRate", Number.MAX_SAFE_INTEGER + 1], ["channels", 3], ["channels", "1"], ["bitrate", -1],
    ["loudnessLufs", NaN], ["truePeakDb", Infinity], ["truePeakDb", "0"],
    ["takeIds", ["injected"]], ["projectId", "other-project"],
  ])("rejects invalid export option %s before rendering", async (field, value) => {
    const test = fixture();
    const request = productionRequest();
    Object.assign(request.output, { [field as string]: value });
    await expect(produceSpeechProject(request, { runtime: test.runtime })).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each(Object.keys(productionRequest().output))("requires explicit export option %s", field => {
    const output = { ...productionRequest().output } as Record<string, unknown>;
    delete output[field];
    expect(() => parseSpeechExportOptions(output)).toThrow(/exactly/);
  });

  it("rejects extra production fields and preserves finite normalization choices", async () => {
    const test = fixture();
    await expect(produceSpeechProject({ ...productionRequest(), retry: true } as SpeechProductionRequest, { runtime: test.runtime })).rejects.toThrow(/exactly/);
    expect(test.execute).not.toHaveBeenCalled();
    expect(parseSpeechExportOptions({ ...productionRequest().output, loudnessLufs: -16, truePeakDb: -1 })).toMatchObject({ loudnessLufs: -16, truePeakDb: -1, overwrite: false });
  });
});

describe("speech production snapshots and exports", () => {
  it("uses default profile references and the exact reviewed profile in canonical automation requests",async()=>{
    const test=fixture();delete test.profile.voiceId;test.profile.referenceAssetIds=["a".repeat(64),"b".repeat(64)];test.settings.cloudConsent=true;
    await submitSpeechProject({...renderRequest(),takes:1,cloudConsent:true,budgetLimit:null},test.runtime);
    expect(test.render.expectedProfile).toEqual(test.profile);expect(test.render.segments.length).toBeGreaterThan(0);for(const segment of test.render.segments){expect(segment.voiceIds).toEqual([]);expect(segment.referenceAssetIds).toEqual(test.profile.referenceAssetIds);}
  });
  it("exports exactly one take per compiled segment in source order", async () => {
    const test = fixture();
    const result = await produceSpeechProject(productionRequest(), { runtime: test.runtime });
    expect(test.render.segments.length).toBeGreaterThan(1);
    expect(test.render).toMatchObject({ owner: "automation:run-1", revisionId: "revision-1", takes: 2, reuseCache: false, cloudConsent: false, budgetLimit: 0 });
    const exported = test.execute.mock.calls.find(([operation]) => operation === "export")![1] as SpeechOperations["export"]["input"];
    expect(exported.takeIds.map(id => test.takes.find(take => take.id === id)!.segmentId)).toEqual(test.render.segments.map(segment => segment.id));
    expect(new Set(exported.takeIds).size).toBe(test.render.segments.length);
    expect(exported.overwrite).toBe(false);
    expect(result.export).toMatchObject({ sha256: "e".repeat(64), bytes: 200 });
    expect(test.execute.mock.calls.filter(([operation]) => operation === "render")).toHaveLength(1);
  });

  it("detaches caller inputs and keeps arriving takes on the submitted revision", async () => {
    const test = fixture();
    const request = productionRequest();
    const expectedPath = request.output.outputPath;
    const project = Promise.withResolvers<SpeechProject>();
    test.handlers.getProject = () => project.promise;
    test.handlers.render = input => {
      test.project.revisionId = "revision-2";
      test.project.source = "Changed after submission.";
      return test.createJob(input);
    };
    const pending = produceSpeechProject(request, { runtime: test.runtime });
    request.owner = "automation:other-run";
    request.revisionId = "revision-2";
    request.takes = 20;
    request.output.outputPath = resolve(process.cwd(), "changed.wav");
    project.resolve(structuredClone(test.project));
    const result = await pending;
    expect(test.render).toMatchObject({ owner: "automation:run-1", revisionId: "revision-1", takes: 2 });
    expect(result.job.revisionId).toBe("revision-1");
    expect(result.export.path).toBe(expectedPath);
    expect(test.execute.mock.calls.filter(([operation]) => operation === "getProject")).toHaveLength(1);
  });

  it("protects job state from progress observers", async () => {
    const test = fixture();
    await produceSpeechProject(productionRequest(), { runtime: test.runtime, onProgress: job => { job.state = "failed"; job.takeIds.length = 0; } });
    expect(test.execute).toHaveBeenCalledWith("export", expect.anything());
  });

  it.each(["project", "profile", "backend", "script"])("rejects invalid %s preflight without synthesis", async failure => {
    const test = fixture();
    if (failure === "project") test.project.revisionId = "other-revision";
    if (failure === "profile") test.profile.id = "other-profile";
    if (failure === "backend") test.settings.connections[0]!.configured = false;
    if (failure === "script") test.project.source = "<whisper>Unclosed delivery";
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime })).rejects.toThrow();
    expect(test.execute.mock.calls.some(([operation]) => operation === "render" || operation === "export")).toBe(false);
  });

  it.each(["owner", "projectId", "revisionId"])("rejects a returned job with the wrong %s", async field => {
    const test = fixture();
    test.handlers.render = input => ({ ...test.createJob(input), [field]: "other" });
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime })).rejects.toThrow(/outside/);
    expect(test.execute).not.toHaveBeenCalledWith("listTakes", expect.anything());
  });

  it.each(["missing", "duplicate", "revision", "project", "unknown-segment", "uneven", "progress"])("rejects %s completed-take evidence before export", async failure => {
    const test = fixture();
    test.handlers.listTakes = () => {
      const takes = structuredClone(test.takes);
      if (failure === "missing") takes.pop();
      if (failure === "duplicate") test.job.takeIds[0] = test.job.takeIds[1]!;
      if (failure === "revision") takes[0]!.revisionId = "other-revision";
      if (failure === "project") takes[0]!.projectId = "other-project";
      if (failure === "unknown-segment") takes[0]!.segmentId = "unknown-segment";
      if (failure === "uneven") takes[takes.length - 1]!.segmentId = takes[0]!.segmentId;
      if (failure === "progress") test.job.completedSegments = 0;
      return takes;
    };
    if (failure === "duplicate" || failure === "progress") {
      test.handlers.render = input => {
        const job = test.createJob(input);
        if (failure === "duplicate") job.takeIds[0] = job.takeIds[1]!;
        else job.completedSegments = 0;
        return job;
      };
    }
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime })).rejects.toThrow();
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it.each(["failed", "cancelled", "uncertain", "interrupted"] as const)("does not retry a %s job", async state => {
    const test = fixture(state);
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime })).rejects.toThrow(state);
    expect(test.execute.mock.calls.filter(([operation]) => operation === "render")).toHaveLength(1);
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it("propagates provider failure without another generation", async () => {
    const test = fixture();
    test.handlers.render = () => { throw new Error("Insufficient credit"); };
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime })).rejects.toThrow("Insufficient credit");
    expect(test.execute.mock.calls.filter(([operation]) => operation === "render")).toHaveLength(1);
  });
});

describe("speech production cancellation", () => {
  it("does no work for a pre-aborted request", async () => {
    const test = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("does not submit when cancellation arrives during preflight", async () => {
    const test = fixture();
    const controller = new AbortController();
    const project = Promise.withResolvers<SpeechProject>();
    test.handlers.getProject = () => project.promise;
    const pending = produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    project.resolve(test.project);
    await rejected;
    expect(test.execute).not.toHaveBeenCalledWith("render", expect.anything());
  });

  it("cancels once when submission returns after an abort", async () => {
    const test = fixture("queued");
    const controller = new AbortController();
    const submitted = Promise.withResolvers<SpeechJob>();
    test.handlers.render = input => { const job = test.createJob(input); void Promise.resolve().then(() => { controller.abort(); submitted.resolve(job); }); return submitted.promise; };
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.execute.mock.calls.filter(([operation]) => operation === "cancel")).toEqual([["cancel", { jobId: "job-1", owner: "automation:run-1" }]]);
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it("initiates cancellation while a job poll is still pending", async () => {
    const test = fixture("running");
    const controller = new AbortController();
    const polling = Promise.withResolvers<SpeechJob[]>();
    const started = Promise.withResolvers<void>();
    test.handlers.listJobs = () => { started.resolve(); return polling.promise; };
    const pending = produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    controller.abort();
    await vi.waitFor(() => expect(test.execute).toHaveBeenCalledWith("cancel", { jobId: "job-1", owner: "automation:run-1" }));
    polling.resolve([test.job]);
    await rejected;
    expect(test.execute.mock.calls.filter(([operation]) => operation === "cancel")).toHaveLength(1);
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it("wakes the polling delay on cancellation", async () => {
    const test = fixture("queued");
    const controller = new AbortController();
    const progress = Promise.withResolvers<void>();
    const pending = produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal, onProgress: () => progress.resolve() });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await progress.promise;
    controller.abort();
    await rejected;
    expect(test.execute).toHaveBeenCalledWith("cancel", { jobId: "job-1", owner: "automation:run-1" });
    expect(test.execute).not.toHaveBeenCalledWith("listJobs", expect.anything());
  });

  it("stops before export if aborted while loading completed takes", async () => {
    const test = fixture();
    const controller = new AbortController();
    test.handlers.listTakes = () => { controller.abort(); return test.takes; };
    await expect(produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
    expect(test.execute).not.toHaveBeenCalledWith("cancel", expect.anything());
  });

  it("reports native cancellation failure with the abort reason", async () => {
    const test = fixture("running");
    const controller = new AbortController();
    const reason = new Error("Automation stopped");
    const cancellationError = new Error("Native cancellation unavailable");
    test.handlers.cancel = () => { throw cancellationError; };
    const pending = produceSpeechProject(productionRequest(), { runtime: test.runtime, signal: controller.signal, onProgress: () => controller.abort(reason) });
    await expect(pending).rejects.toMatchObject({ name: "AggregateError", errors: [reason, cancellationError], message: expect.stringContaining("cancellation failed") });
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });
});

describe("scoped speech agent tools", () => {
  it.each(["speech_produce_project", "speech_list_jobs", "speech_cancel_job", "speech_export_job"])("requires an owning run for %s", async name => {
    const test = fixture();
    const { runId: _runId, ...context } = toolContext();
    const args = name === "speech_produce_project" ? (({ owner: _owner, ...request }) => request)(productionRequest()) : name === "speech_cancel_job" ? { jobId: "job-1" } : name === "speech_export_job" ? { jobId: "job-1", projectId: "project-1", revisionId: "revision-1", takeIds: ["take-1"], output: productionRequest().output } : {};
    const result = await findTool(test.runtime, name).execute(args, context);
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each(["speech_list_jobs", "speech_cancel_job", "speech_produce_project", "speech_export_job"])("rejects injected ownership in %s", async name => {
    const test = fixture();
    const result = await findTool(test.runtime, name).execute({ owner: "automation:other-run" }, toolContext());
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("uses the injected shared runtime for production and returns asset evidence", async () => {
    const test = fixture();
    const { owner: _owner, ...args } = productionRequest();
    const result = await findTool(test.runtime, "speech_produce_project").execute(args, toolContext());
    expect(result.toolResult.isError).toBe(false);
    expect(JSON.parse(result.toolResult.output)).toMatchObject({ job: { owner: "automation:run-1" }, export: { sha256: "e".repeat(64), bytes: 200 } });
  });

  it("rejects a production path outside the workspace before runtime calls", async () => {
    const test = fixture();
    const { owner: _owner, ...args } = productionRequest();
    args.output.outputPath = resolve(process.cwd(), "..", "outside.wav");
    const result = await findTool(test.runtime, "speech_produce_project").execute(args, toolContext());
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("keeps job listing and cancellation isolated to the current run", async () => {
    const test = fixture("running");
    await submitSpeechProject(renderRequest(), test.runtime);
    const context = toolContext();
    const listed = await findTool(test.runtime, "speech_list_jobs").execute({}, context);
    expect(listed.toolResult.isError).toBe(false);
    expect(test.execute).toHaveBeenCalledWith("listJobs", { owner: "automation:run-1", offset: 0, limit: 51 });
    const cancelled = await findTool(test.runtime, "speech_cancel_job").execute({ jobId: "job-1" }, context);
    expect(cancelled.toolResult.isError).toBe(false);
    expect(test.execute).toHaveBeenCalledWith("listJobs", { owner: "automation:run-1", id: "job-1", offset: 0, limit: 1 });
    expect(test.execute).toHaveBeenCalledWith("cancel", { jobId: "job-1", owner: "automation:run-1" });
  });

  it("pages older owned jobs with an explicit continuation and direct ID lookup", async () => {
    const test = fixture();
    await submitSpeechProject(renderRequest(), test.runtime);
    test.handlers.listJobs = input => {
      expect(input).toEqual({owner:"automation:run-1",offset:100,limit:3});
      return ["old-a","old-b","old-c"].map(id => ({...test.job,id}));
    };
    const result = await findTool(test.runtime,"speech_list_jobs").execute({offset:100,limit:2},toolContext());
    expect(result.toolResult.isError).toBe(false);
    expect(JSON.parse(result.toolResult.output)).toMatchObject({jobs:[{id:"old-a"},{id:"old-b"}],offset:100,limit:2,hasMore:true});
    test.handlers.listJobs = input => {
      expect(input).toEqual({owner:"automation:run-1",id:"old-a",offset:0,limit:51});
      return [{...test.job,id:"old-a"}];
    };
    const lookup = await findTool(test.runtime,"speech_list_jobs").execute({jobId:"old-a"},toolContext());
    expect(JSON.parse(lookup.toolResult.output)).toMatchObject({jobs:[{id:"old-a"}],hasMore:false});
  });

  it.each([{limit:0},{limit:101},{offset:-1},{offset:1.5},{jobId:""}])("rejects an invalid job page before runtime calls: %s", async args => {
    const test=fixture();
    const result=await findTool(test.runtime,"speech_list_jobs").execute(args,toolContext());
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it.each(["speech_list_jobs", "speech_cancel_job", "speech_export_job"])("does not expose or mutate foreign jobs through %s", async name => {
    const test = fixture();
    await submitSpeechProject(renderRequest(), test.runtime);
    test.job.owner = "automation:other-run";
    const args = name === "speech_list_jobs" ? {} : name === "speech_cancel_job" ? { jobId: test.job.id } : { jobId: test.job.id, projectId: "project-1", revisionId: "revision-1", takeIds: [test.takes[0]!.id], output: productionRequest().output };
    const result = await findTool(test.runtime, name).execute(args, toolContext());
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).not.toContain("automation:other-run");
    expect(test.execute).not.toHaveBeenCalledWith("cancel", expect.anything());
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it("reads an owned archive inventory without authorizing bundling or generating audio",async()=>{
    const test=fixture();await submitSpeechProject(renderRequest(),test.runtime);const inventory={projectId:"project-1",revisionId:"revision-1",inventorySha256:"a".repeat(64),references:[{assetId:"b".repeat(64),bytes:100,transcriptPreview:"Synthetic reference.",rightsEvidence:"Cloning permission only",original:true}]};test.handlers.archiveReferences=()=>inventory;test.execute.mockClear();
    const result=await findTool(test.runtime,"speech_archive_references").execute({jobId:test.job.id,projectId:"project-1",revisionId:"revision-1"},toolContext());expect(result.toolResult.isError).toBe(false);expect(JSON.parse(result.toolResult.output)).toEqual(inventory);expect(test.execute.mock.calls.map(([operation])=>operation)).toEqual(["listJobs","archiveReferences"]);
  });
  it.each(["foreign-job","wrong-revision","wrong-response","injected-owner","missing-run"])("rejects %s archive reference discovery",async failure=>{
    const test=fixture();await submitSpeechProject(renderRequest(),test.runtime);test.handlers.archiveReferences=()=>({projectId:"project-1",revisionId:failure==="wrong-response"?"other":"revision-1",inventorySha256:"a".repeat(64),references:[]});const args:Record<string,unknown>={jobId:test.job.id,projectId:"project-1",revisionId:"revision-1"};
    if(failure==="foreign-job")test.job.owner="automation:other";if(failure==="wrong-revision")args.revisionId="other";if(failure==="injected-owner")args.owner="automation:run-1";test.execute.mockClear();
    const result=await findTool(test.runtime,"speech_archive_references").execute(args,failure==="missing-run"?{...toolContext(),runId:undefined}:toolContext());expect(result.toolResult.isError).toBe(true);expect(test.execute).not.toHaveBeenCalledWith("export",expect.anything());if(failure!=="wrong-response")expect(test.execute).not.toHaveBeenCalledWith("archiveReferences",expect.anything());
  });
  it("exports explicitly ordered owned takes without rendering again", async () => {
    const test = fixture();
    await submitSpeechProject(renderRequest(), test.runtime);
    const takeIds = [test.takes.at(-1)!.id, test.takes[0]!.id];
    test.execute.mockClear();
    const result = await findTool(test.runtime, "speech_export_job").execute({ jobId: test.job.id, projectId: "project-1", revisionId: "revision-1", takeIds, output: productionRequest().output }, toolContext());
    expect(result.toolResult.isError).toBe(false);
    expect(test.execute).toHaveBeenCalledWith("export", expect.objectContaining({ projectId: "project-1", takeIds, overwrite: false }));
    expect(test.execute).not.toHaveBeenCalledWith("render", expect.anything());
  });

  it.each(["revision", "foreign-take", "duplicate-take", "unfinished", "outside-path"])("rejects %s explicit job export", async failure => {
    const test = fixture();
    await submitSpeechProject(renderRequest(), test.runtime);
    const args = { jobId: test.job.id, projectId: "project-1", revisionId: "revision-1", takeIds: [test.takes[0]!.id], output: productionRequest().output };
    if (failure === "revision") args.revisionId = "revision-2";
    if (failure === "foreign-take") args.takeIds = ["other-job-take"];
    if (failure === "duplicate-take") args.takeIds.push(args.takeIds[0]!);
    if (failure === "unfinished") test.job.state = "running";
    if (failure === "outside-path") args.output.outputPath = resolve(process.cwd(), "..", "outside.wav");
    const result = await findTool(test.runtime, "speech_export_job").execute(args, toolContext());
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });

  it("does not export when the automation signal aborts during take lookup", async () => {
    const test = fixture();
    await submitSpeechProject(renderRequest(), test.runtime);
    const controller = new AbortController();
    test.handlers.listTakes = () => { controller.abort(); return test.takes; };
    const result = await findTool(test.runtime, "speech_export_job").execute({ jobId: test.job.id, projectId: "project-1", revisionId: "revision-1", takeIds: [test.takes[0]!.id], output: productionRequest().output }, { ...toolContext(), signal: controller.signal });
    expect(result.toolResult.isError).toBe(true);
    expect(test.execute).not.toHaveBeenCalledWith("export", expect.anything());
  });
});
