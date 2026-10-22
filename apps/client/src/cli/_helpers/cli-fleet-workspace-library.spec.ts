import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperationResponse } from "@machdoch/fleet-protocol/operation";
import {
  workspaceRequestSchema,
  type WorkspaceRequest,
} from "@machdoch/fleet-protocol/workspace";
import { FleetWorkspaceLibraryRuntime } from "./cli-fleet-workspace-library.js";

const runners = vi.hoisted(() => ({
  library: vi.fn<(root: string, input: unknown) => Promise<unknown>>(),
  mcp: vi.fn<(root: string, input: unknown) => Promise<unknown>>(),
  voice: vi.fn<(root: string, input: unknown) => Promise<unknown>>(),
}));

vi.mock("../../core/workspace-library/index.js", () => ({
  runWorkspaceLibraryRequest: runners.library,
}));
vi.mock("../../core/mcp/apps.js", () => ({
  runMcpAppRequest: runners.mcp,
}));
vi.mock("../../core/live-voice.js", () => ({
  runLiveVoiceRequest: runners.voice,
}));

const workspace = "/workspaces/selected";
const canonicalWorkspace = "/workspaces/canonical";
const unknownWorkspaceError = "Choose a workspace listed on this device.";
const assertWorkspace = vi.fn(async (root: string) => {
  if (root !== workspace) throw new Error(unknownWorkspaceError);
  return canonicalWorkspace;
});
const finishPending: Array<() => void> = [];
let runtime: FleetWorkspaceLibraryRuntime;

beforeEach(() => {
  assertWorkspace.mockClear();
  for (const runner of Object.values(runners)) runner.mockReset();
  runners.mcp.mockResolvedValue({ enabled: true });
  runtime = new FleetWorkspaceLibraryRuntime(assertWorkspace);
});

afterEach(async () => {
  for (const finish of finishPending.splice(0)) finish();
  await runtime.shutdown();
});

function settingsRequest(id = randomUUID()) {
  return {
    kind: "invoke",
    id,
    command: "run_mcp_app_command",
    args: { workspaceRoot: "", input: { action: "settings" } },
  } satisfies WorkspaceRequest;
}

function deferred<T>(value: T) {
  let resolve!: () => void;
  const promise = new Promise<T>((complete) => {
    resolve = () => complete(value);
  });
  finishPending.push(resolve);
  return { promise, resolve };
}

async function readReceipt(id: string, offset = 0): Promise<OperationResponse> {
  return vi.waitFor(async () => {
    const response = await runtime.request({ kind: "read", id, offset });
    expect(response.state).not.toBe("pending");
    return response;
  });
}

it.each([
  { action: "settings" },
  { action: "set-enabled", enabled: false },
  { action: "set-enabled", enabled: true },
] as const)("allows global MCP $action without a workspace", async (input) => {
  const result = {
    enabled: input.action === "settings" ? true : input.enabled,
  };
  runners.mcp.mockResolvedValue(result);
  const request = workspaceRequestSchema.parse({
    ...settingsRequest(),
    args: { workspaceRoot: "", input },
  });

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  const content = Buffer.from(JSON.stringify(result)).toString("base64");
  await expect(readReceipt(request.id)).resolves.toEqual({
    state: "complete",
    chunk: content,
    offset: 0,
    total: content.length,
  });
  expect(assertWorkspace).not.toHaveBeenCalled();
  expect(runners.mcp).toHaveBeenCalledTimes(1);
  expect(runners.mcp).toHaveBeenCalledWith("", input);
  expect(runners.library).not.toHaveBeenCalled();
  expect(runners.voice).not.toHaveBeenCalled();
});

const workspaceRequests = [
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "source", path: "src/index.ts" },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "search", query: "workspace knowledge", limit: 5 },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "index" },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "projects" },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "project", id: randomUUID() },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: {
      action: "save-project",
      project: {
        revision: 0,
        title: "Workspace knowledge",
        question: "How should workspace knowledge be indexed?",
        notes: "",
        status: "active",
        sources: [],
        findings: [],
      },
    },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "delete-project", id: randomUUID(), revision: 1 },
  },
  {
    command: "run_workspace_library_command",
    runner: "library",
    input: { action: "check-sources", id: randomUUID() },
  },
  {
    command: "run_live_voice_command",
    runner: "voice",
    input: { action: "session" },
  },
  {
    command: "run_live_voice_command",
    runner: "voice",
    input: {
      action: "process",
      text: "Focus on the active research project.",
    },
  },
  {
    command: "run_mcp_app_command",
    runner: "mcp",
    input: { action: "load", id: randomUUID() },
  },
] as const;

it.each(workspaceRequests)(
  "passes the canonical workspace to $command $input.action",
  async ({ command, runner, input }) => {
    const result = { handled: true };
    runners[runner].mockResolvedValue(result);
    const request = workspaceRequestSchema.parse({
      kind: "invoke",
      id: randomUUID(),
      command,
      args: { workspaceRoot: workspace, input },
    });

    await expect(runtime.request(request)).resolves.toEqual({
      state: "pending",
    });
    const content = Buffer.from(JSON.stringify(result)).toString("base64");
    await expect(readReceipt(request.id)).resolves.toEqual({
      state: "complete",
      chunk: content,
      offset: 0,
      total: content.length,
    });
    expect(assertWorkspace).toHaveBeenCalledTimes(1);
    expect(assertWorkspace).toHaveBeenCalledWith(workspace);
    expect(runners[runner]).toHaveBeenCalledWith(canonicalWorkspace, input);
    for (const [name, service] of Object.entries(runners))
      expect(service).toHaveBeenCalledTimes(name === runner ? 1 : 0);
  },
);

it.each(workspaceRequests)(
  "rejects an unknown workspace before running $command $input.action",
  async ({ command, input }) => {
    const unknownWorkspace = "/workspaces/unknown";
    const request = workspaceRequestSchema.parse({
      kind: "invoke",
      id: randomUUID(),
      command,
      args: { workspaceRoot: unknownWorkspace, input },
    });

    await expect(runtime.request(request)).resolves.toEqual({
      state: "pending",
    });
    await expect(readReceipt(request.id)).resolves.toEqual({
      state: "failed",
      error: unknownWorkspaceError,
    });
    expect(assertWorkspace).toHaveBeenCalledTimes(1);
    expect(assertWorkspace).toHaveBeenCalledWith(unknownWorkspace);
    for (const runner of Object.values(runners))
      expect(runner).not.toHaveBeenCalled();
  },
);

it("rejects MCP app loading without a workspace before running the service", async () => {
  const request = workspaceRequestSchema.parse({
    kind: "invoke",
    id: randomUUID(),
    command: "run_mcp_app_command",
    args: { workspaceRoot: "", input: { action: "load", id: randomUUID() } },
  });

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(readReceipt(request.id)).resolves.toEqual({
    state: "failed",
    error: unknownWorkspaceError,
  });
  expect(assertWorkspace).toHaveBeenCalledTimes(1);
  expect(assertWorkspace).toHaveBeenCalledWith("");
  for (const runner of Object.values(runners))
    expect(runner).not.toHaveBeenCalled();
});

it("fails protocol-valid commands that require a native client", async () => {
  const request = workspaceRequestSchema.parse({
    kind: "invoke",
    id: randomUUID(),
    command: "get_runtime_snapshot",
    args: { workspaceRoot: workspace },
  });

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(readReceipt(request.id)).resolves.toEqual({
    state: "failed",
    error:
      "This host supports knowledge and research. Other workspace tools require a native client.",
  });
  expect(assertWorkspace).not.toHaveBeenCalled();
  for (const runner of Object.values(runners))
    expect(runner).not.toHaveBeenCalled();
});

it("validates UUIDs and strict command arguments before dispatch", () => {
  const request = settingsRequest();
  const invalidRequests = [
    { ...request, id: "invalid-operation-id" },
    { ...request, extra: true },
    { ...request, args: { ...request.args, extra: true } },
    {
      ...request,
      args: { ...request.args, input: { action: "settings", extra: true } },
    },
  ] as const;

  for (const invalid of invalidRequests)
    expect(() => runtime.request(invalid)).toThrow();
  expect(assertWorkspace).not.toHaveBeenCalled();
  for (const runner of Object.values(runners))
    expect(runner).not.toHaveBeenCalled();
});

it("reads chunked receipts by offset and releases completed results", async () => {
  const result = { text: "🌿保持方向\n".repeat(20_000) };
  const content = Buffer.from(JSON.stringify(result)).toString("base64");
  runners.mcp.mockResolvedValue(result);
  const request = settingsRequest();

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  let offset = 0;
  let received = "";
  let chunks = 0;
  while (offset < content.length) {
    const response = await readReceipt(request.id, offset);
    expect(response.state).toBe("complete");
    if (response.state !== "complete")
      throw new Error("Expected a completed operation receipt.");
    expect(response.offset).toBe(offset);
    expect(response.total).toBe(content.length);
    expect(response.chunk.length).toBeGreaterThan(0);
    expect(response.chunk.length).toBeLessThanOrEqual(262_144);
    received += response.chunk;
    offset += response.chunk.length;
    chunks += 1;
  }
  expect(chunks).toBeGreaterThan(1);
  expect(received).toBe(content);
  expect(JSON.parse(Buffer.from(received, "base64").toString("utf8"))).toEqual(
    result,
  );
  await expect(readReceipt(request.id, content.length)).resolves.toEqual({
    state: "complete",
    chunk: "",
    offset: content.length,
    total: content.length,
  });
  await expect(readReceipt(request.id, content.length + 1)).resolves.toEqual({
    state: "failed",
    error: "Invalid response offset.",
  });
  await expect(
    runtime.request({ kind: "release", id: request.id }),
  ).resolves.toEqual({ state: "complete", chunk: "", offset: 0, total: 0 });
  await expect(readReceipt(request.id)).resolves.toEqual({
    state: "failed",
    error: "Operation expired. Refresh and check Runs before retrying.",
  });
  expect(runners.mcp).toHaveBeenCalledTimes(1);
});

it("deduplicates running and completed invocations and rejects changed arguments", async () => {
  const pending = deferred({ enabled: true });
  runners.mcp.mockReturnValue(pending.promise);
  const request = settingsRequest();

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(
    runtime.request({ kind: "read", id: request.id, offset: 0 }),
  ).resolves.toEqual({ state: "pending" });
  await expect(
    runtime.request({ kind: "release", id: request.id }),
  ).resolves.toEqual({
    state: "failed",
    error: "Operation is still running.",
  });
  const changed = workspaceRequestSchema.parse({
    ...request,
    args: {
      workspaceRoot: "",
      input: { action: "set-enabled", enabled: false },
    },
  });
  await expect(runtime.request(changed)).resolves.toEqual({
    state: "failed",
    error: "Operation ID was reused with different arguments.",
  });
  expect(runners.mcp).toHaveBeenCalledTimes(1);
  expect(runners.mcp).toHaveBeenCalledWith("", { action: "settings" });

  pending.resolve();
  const completed = await readReceipt(request.id);
  expect(completed.state).toBe("complete");
  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(readReceipt(request.id)).resolves.toEqual(completed);
  expect(runners.mcp).toHaveBeenCalledTimes(1);
});

it("retains service errors as failed receipts until release", async () => {
  runners.mcp.mockRejectedValue(new Error("MCP settings are unavailable."));
  const request = settingsRequest();

  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  const failure = {
    state: "failed",
    error: "MCP settings are unavailable.",
  };
  await expect(readReceipt(request.id)).resolves.toEqual(failure);
  await expect(runtime.request(request)).resolves.toEqual({ state: "pending" });
  await expect(readReceipt(request.id)).resolves.toEqual(failure);
  expect(runners.mcp).toHaveBeenCalledTimes(1);
  await expect(
    runtime.request({ kind: "release", id: request.id }),
  ).resolves.toEqual({ state: "complete", chunk: "", offset: 0, total: 0 });
});

it("waits for every in-flight operation during shutdown and rejects new requests", async () => {
  const first = deferred({ enabled: true });
  const second = deferred({ enabled: false });
  runners.mcp
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  await runtime.request(settingsRequest());
  await runtime.request(settingsRequest());
  await vi.waitFor(() => expect(runners.mcp).toHaveBeenCalledTimes(2));
  const stopped = vi.fn();
  const shutdown = runtime.shutdown().then(stopped);
  const stopping = { state: "failed", error: "Fleet service is stopping." };
  await expect(runtime.request(settingsRequest())).resolves.toEqual(stopping);
  expect(stopped).not.toHaveBeenCalled();

  first.resolve();
  await first.promise;
  await expect(runtime.request(settingsRequest())).resolves.toEqual(stopping);
  expect(stopped).not.toHaveBeenCalled();

  second.resolve();
  await shutdown;
  expect(stopped).toHaveBeenCalledTimes(1);
  await expect(runtime.request(settingsRequest())).resolves.toEqual(stopping);
  expect(runners.mcp).toHaveBeenCalledTimes(2);
});
