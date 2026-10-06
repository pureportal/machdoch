import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { instructionRequestSchema } from "@machdoch/fleet-protocol/instructions";
import { createInstructionMutationArguments } from "@machdoch/fleet-protocol/instruction-command";
import type {
  InstructionLibraryRecoveryView,
  InstructionMutationInput,
  InstructionMutationResult,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";
import { createFleetOperationTransport } from "@machdoch/product-ui/fleet-operation-transport";
import { FleetInstructionRuntime } from "./cli-fleet-instructions.js";

let root: string;
let workspace: string;
let runtime: FleetInstructionRuntime;

function createRuntime(): FleetInstructionRuntime {
  return new FleetInstructionRuntime(
    async (value) => {
      if (value !== workspace)
        throw new Error("Choose a workspace listed on this device.");
      return workspace;
    },
    () => workspace,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-fleet-instructions-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  workspace = await realpath(workspace);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
  runtime = createRuntime();
});

afterEach(async () => {
  await runtime.shutdown();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function invoke<T>(args: string[], selectedWorkspace = workspace): Promise<T> {
  return createFleetOperationTransport((request) =>
    runtime.request(instructionRequestSchema.parse(request)),
  ).invoke<T>("run_instruction_command", {
    request: { workspaceRoot: selectedWorkspace, arguments: args },
  });
}

const list = () =>
  invoke<InstructionRegistryResult>(["registry", "list", "--include-content"]);
const mutate = (input: InstructionMutationInput) =>
  invoke<InstructionMutationResult>(createInstructionMutationArguments(input));

it("uses the client library for profile and workspace CRUD with assignment checks and restart persistence", async () => {
  const created = await mutate({
    operation: "profile-create",
    name: "Review",
    body: "Review the changed files.",
    tags: ["web"],
    match: { op: "tag", tag: "web" },
    expectedRevision: 0,
  });
  const id = created.profile!.id;
  expect((await list()).profiles[0]!.match).toEqual({ op: "tag", tag: "web" });
  const manual = await mutate({
    operation: "profile-edit",
    profileId: id,
    match: null,
    expectedRevision: created.library!.revision,
  });
  const configured = await mutate({
    operation: "workspace-configure",
    root: workspace,
    displayName: "Project",
    tags: ["web"],
    profileIds: [id],
    expectedRevision: manual.library!.revision,
  });
  await expect(
    mutate({
      operation: "profile-delete",
      profileId: id,
      expectedRevision: configured.library!.revision,
    }),
  ).rejects.toThrow(/assign/i);
  const edited = await mutate({
    operation: "profile-edit",
    profileId: id,
    name: "Review changes",
    body: "Check the tests.",
    expectedRevision: configured.library!.revision,
  });
  const duplicated = await mutate({
    operation: "profile-duplicate",
    profileId: id,
    expectedRevision: edited.library!.revision,
  });
  await runtime.shutdown();
  runtime = createRuntime();
  const saved = await list();
  expect(saved.profiles).toHaveLength(2);
  expect(saved.profiles.find((profile) => profile.id === id)).toMatchObject({
    body: "Check the tests.",
    enabled: true,
    global: false,
    tags: ["web"],
    manualAssignmentCount: 1,
  });
  const cleared = await mutate({
    operation: "workspace-scope-set",
    workspaceId: configured.workspace!.id,
    path: ".",
    profileIds: [],
    expectedRevision: saved.revision,
  });
  const global = await mutate({
    operation: "profile-edit",
    profileId: id,
    global: true,
    expectedRevision: cleared.library!.revision,
  });
  expect(
    (await list()).profiles.find((profile) => profile.id === id)?.global,
  ).toBe(true);
  const removed = await mutate({
    operation: "profile-delete",
    profileId: id,
    expectedRevision: global.library!.revision,
  });
  await mutate({
    operation: "profile-delete",
    profileId: duplicated.profile!.id,
    expectedRevision: removed.library!.revision,
  });
  expect((await list()).profiles).toEqual([]);
}, 90_000);

it("rejects unlisted workspaces and stale edits without changing the library", async () => {
  const created = await mutate({
    operation: "profile-create",
    name: "Review",
    body: "Original",
    expectedRevision: 0,
  });
  await expect(
    mutate({
      operation: "profile-edit",
      profileId: created.profile!.id,
      body: "Stale",
      expectedRevision: 0,
    }),
  ).rejects.toThrow(/revision|changed/i);
  await expect(
    invoke(["profiles", "list"], join(root, "outside")),
  ).rejects.toThrow(/listed/);
  await expect(
    invoke([
      "workspaces",
      "configure",
      "--name",
      "Outside",
      join(root, "outside"),
      "--expected-revision",
      "1",
    ]),
  ).rejects.toThrow(/listed/);
  expect((await list()).profiles[0]!.body).toBe("Original");
  expect(
    (
      await invoke<InstructionRegistryResult>(
        ["profiles", "list", "--include-content"],
        "",
      )
    ).profiles[0]!.body,
  ).toBe("Original");
});

it("preserves Unicode and literal option-like content across large chunked results", async () => {
  const body = `--literal\n${"🌿保持方向\n".repeat(5_000)}`;
  expect(body.length).toBeGreaterThan(32_768);
  const created = await mutate({
    operation: "profile-create",
    name: "Unicode",
    body,
    expectedRevision: 0,
  });
  const duplicate = await mutate({
    operation: "profile-duplicate",
    profileId: created.profile!.id,
    expectedRevision: created.library!.revision,
  });
  await mutate({
    operation: "profile-duplicate",
    profileId: created.profile!.id,
    expectedRevision: duplicate.library!.revision,
  });
  let chunks = 0;
  const transport = createFleetOperationTransport(async (request) => {
    const response = await runtime.request(
      instructionRequestSchema.parse(request),
    );
    if (request.kind === "read" && response.state === "complete") chunks += 1;
    return response;
  });
  const result = await transport.invoke<InstructionRegistryResult>(
    "run_instruction_command",
    {
      request: {
        workspaceRoot: workspace,
        arguments: ["profiles", "list", "--include-content"],
      },
    },
  );
  expect(chunks).toBeGreaterThan(1);
  expect(result.profiles).toHaveLength(3);
  expect(result.profiles.every((profile) => profile.body === body)).toBe(true);
}, 90_000);

it("replays one operation once and rejects reuse with another mutation", async () => {
  const request = instructionRequestSchema.parse({
    kind: "invoke",
    id: randomUUID(),
    command: "run_instruction_command",
    args: {
      request: {
        workspaceRoot: workspace,
        arguments: createInstructionMutationArguments({
          operation: "profile-create",
          name: "Once",
          body: "One file",
          expectedRevision: 0,
        }),
      },
    },
  });
  await runtime.request(request);
  await runtime.request(request);
  await runtime.shutdown();
  runtime = createRuntime();
  expect((await list()).profiles).toHaveLength(1);
  const another = instructionRequestSchema.parse({
    ...request,
    args: {
      request: { workspaceRoot: workspace, arguments: ["profiles", "list"] },
    },
  });
  await runtime.request(another);
  const failed = await runtime.request(
    instructionRequestSchema.parse({
      ...request,
      args: {
        request: {
          workspaceRoot: workspace,
          arguments: ["recovery", "status"],
        },
      },
    }),
  );
  expect(failed.state).toBe("failed");
});

it("restores and resets corrupt libraries only for the reviewed digest", async () => {
  const created = await mutate({
    operation: "profile-create",
    name: "Backup",
    body: "Backup body",
    expectedRevision: 0,
  });
  await mutate({
    operation: "profile-edit",
    profileId: created.profile!.id,
    body: "Updated body",
    expectedRevision: created.library!.revision,
  });
  const status = () =>
    invoke<InstructionLibraryRecoveryView>(["recovery", "status"]);
  const valid = await status();
  await writeFile(valid.libraryPath, "corrupt bytes");
  const registry = await list();
  expect(registry.profiles).toEqual([]);
  expect(registry.workspaces).toEqual([]);
  expect(registry.libraryError).toMatch(/invalid|parse|json/i);
  const corrupt = registry.recovery!;
  expect(corrupt.primaryValid).toBe(false);
  expect(corrupt.backupValid).toBe(true);
  await expect(
    mutate({ operation: "recovery-restore", expectedDigest: "0".repeat(64) }),
  ).rejects.toThrow(/changed|digest/i);
  await mutate({
    operation: "recovery-restore",
    expectedDigest: corrupt.backupDigest!,
  });
  expect((await status()).primaryValid).toBe(true);
  await writeFile(valid.libraryPath, "different corrupt bytes");
  const reset = await status();
  await mutate({
    operation: "recovery-reset",
    expectedDigest: reset.resetDigest!,
  });
  expect((await list()).profiles).toEqual([]);
}, 90_000);
