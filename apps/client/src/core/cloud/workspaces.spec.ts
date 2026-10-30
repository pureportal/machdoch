import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ClientCloudBindings } from "./bindings.js";
import { canonicalRepository, within, workspaceGit } from "./repository.js";
import { prepareClientWorkspace } from "./managed-workspace.js";
import type {
  WorkerClaim,
  WorkerRegistration,
} from "@machdoch/fleet-protocol/cloud-execution";
import { parseCliArgs } from "../../cli/_helpers/cli-args.js";
import { executeCloudWorkspaceRequest } from "./desktop.js";
import { repositoryDirectorySchema } from "@machdoch/fleet-protocol/cloud-execution";

const roots: string[] = [];
const testRoot = resolve("../../.tmp/cloud-client-tests");
const repository = "https://github.com/example/project";
const token = "mch_cloud_worker_" + "a".repeat(43);
async function setup() {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "case-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await workspaceGit(source, ["init", "--initial-branch=main", "--template="]);
  await workspaceGit(source, [
    "config",
    "remote.origin.url",
    "git@github.com:example/project.git",
  ]);
  await writeFile(join(source, "README"), "committed source\n");
  await workspaceGit(source, ["add", "README"]);
  await workspaceGit(source, [
    "-c",
    "user.name=Verification",
    "-c",
    "user.email=verify@example.test",
    "commit",
    "-m",
    "Base",
  ]);
  const commit = (await workspaceGit(source, ["rev-parse", "HEAD"])).trim();
  const registration: WorkerRegistration = {
    workerId: randomUUID(),
    organizationId: randomUUID(),
    projectName: "Project",
    workspaceBinding: null,
    profile: {
      id: randomUUID(),
      teamId: randomUUID(),
      projectId: randomUUID(),
      revision: 1,
      enabled: true,
      name: "Client",
      target: "client",
      repository,
      baseCommit: commit,
      agent: "codex-cli",
      maxDurationSeconds: 300,
      maxTokens: 10000,
      requiredChecks: [
        { name: "check", command: "node --test", timeoutSeconds: 30 },
      ],
    },
  };
  let loseResponse = false;
  let disconnected = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/registration")) return Response.json(registration);
      if (url.endsWith("/availability"))
        return Response.json({
          workerId: registration.workerId,
          enabled: true,
          available: false,
        });
      if (url.endsWith("/workspace")) {
        registration.workspaceBinding = JSON.parse(String(options.body));
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError("Response lost");
        }
        return Response.json(registration);
      }
      if (url.endsWith("/disconnect")) {
        disconnected = true;
        return Response.json({ disabled: true });
      }
      throw new Error("Unexpected connection request");
    }),
  );
  const bindings = new ClientCloudBindings(join(root, "settings"));
  const connect = () =>
    bindings.connect(
      "https://cloud.example.test",
      token,
      source,
      "Client checkout",
    );
  const claim = (): WorkerClaim => ({
    runId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
    inputDigest: "b".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
    deadlineAt: new Date(Date.now() + 300000).toISOString(),
    manifest: {
      contextLimitBytes: 40000,
      title: "Task",
      objective: "Change README",
      acceptanceCriteria: "Checks pass",
      actorId: randomUUID(),
      subject: { kind: "issue", id: randomUUID(), revision: 1 },
      profile: registration.profile,
      provider: null,
    },
  });
  return {
    root,
    source,
    registration,
    bindings,
    connect,
    claim,
    loseResponse: () => {
      loseResponse = true;
    },
    disconnected: () => disconnected,
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    const canonical = await realpath(root);
    if (!canonical.startsWith((await realpath(testRoot)) + sep))
      throw new Error("Refusing to clean an unrelated test directory");
    await rm(canonical, { recursive: true, force: true });
  }
});

it("treats a competing lock candidate as a lock but other files as unowned storage", async () => {
  const fixture = await setup();
  const link = await fixture.connect();
  const connection = await fixture.bindings.get(link.id);
  const storage = join(fixture.root, "managed");
  const directory = join(storage, fixture.registration.workerId);
  await mkdir(join(directory, "repository.machdoch.lock.candidate.1.a.b"), {
    recursive: true,
  });
  await expect(
    prepareClientWorkspace(storage, connection, fixture.claim()),
  ).resolves.toMatchObject({ baseCommit: fixture.registration.profile.baseCommit });

  const unowned = join(fixture.root, "unowned");
  const unownedDirectory = join(unowned, fixture.registration.workerId);
  await mkdir(unownedDirectory, { recursive: true });
  await writeFile(join(unownedDirectory, "leftover"), "unknown\n");
  await expect(
    prepareClientWorkspace(unowned, connection, fixture.claim()),
  ).rejects.toThrow("without an ownership record");
});

it("keeps dirty source files, branches and Git metadata separate from concurrent task checkouts", async () => {
  const fixture = await setup();
  await writeFile(join(fixture.source, "README"), "local unsaved work\n");
  await writeFile(
    join(fixture.source, ".env"),
    "PRIVATE_LOCAL_VALUE=untouched\n",
  );
  const before = await workspaceGit(fixture.source, [
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  const refs = await workspaceGit(fixture.source, ["show-ref"]);
  const sourceWorktrees = await workspaceGit(fixture.source, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const link = await fixture.connect();
  expect(JSON.stringify(link)).not.toContain(token);
  const connection = await fixture.bindings.get(link.id);
  const storage = join(fixture.root, "managed-" + "deep-storage-".repeat(5));
  const [first, second] = await Promise.all([
    prepareClientWorkspace(storage, connection, fixture.claim()),
    prepareClientWorkspace(storage, connection, fixture.claim()),
  ]);
  expect(first.branch).not.toBe(second.branch);
  expect(first.checkoutRoot).not.toBe(second.checkoutRoot);
  expect(first.repositoryDirectory).not.toBe(second.repositoryDirectory);
  expect((await lstat(first.repositoryDirectory)).isDirectory()).toBe(true);
  expect(
    await realpath(
      (
        await workspaceGit(first.checkoutRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    ),
  ).toBe(await realpath(first.repositoryDirectory));
  await workspaceGit(first.checkoutRoot, [
    "config",
    "cloud.verification",
    "first-attempt-only",
  ]);
  expect(
    await readFile(join(second.repositoryDirectory, "config"), "utf8"),
  ).not.toContain("first-attempt-only");
  await workspaceGit(first.checkoutRoot, ["worktree", "prune", "--expire=now"]);
  expect(
    (await workspaceGit(second.checkoutRoot, ["rev-parse", "HEAD"])).trim(),
  ).toBe(second.baseCommit);
  expect(await readFile(join(first.workspaceRoot, "README"), "utf8")).toBe(
    "committed source\n",
  );
  await expect(
    readFile(join(first.workspaceRoot, ".env")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(first.workspaceRoot, "README"), "first task changes\n");
  expect(await readFile(join(second.workspaceRoot, "README"), "utf8")).toBe(
    "committed source\n",
  );
  expect(
    await workspaceGit(fixture.source, ["status", "--porcelain=v1", "-z"]),
  ).toBe(before);
  expect(await workspaceGit(fixture.source, ["show-ref"])).toBe(refs);
  expect(
    await workspaceGit(fixture.source, ["worktree", "list", "--porcelain"]),
  ).toBe(sourceWorktrees);
  expect(await readFile(join(fixture.source, "README"), "utf8")).toBe(
    "local unsaved work\n",
  );
  await expect(
    readFile(join(first.repositoryDirectory, "objects/info/alternates")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(second.repositoryDirectory, "objects/info/alternates")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers a lost linking response without replacing the workspace identity or exposing the token", async () => {
  const fixture = await setup();
  fixture.loseResponse();
  await expect(fixture.connect()).rejects.toThrow("Response lost");
  const pending = (await fixture.bindings.list())[0]!;
  expect(pending.status).toBe("linking");
  const restored = new ClientCloudBindings(fixture.bindings.directory);
  const linked = await restored.connect(
    "https://cloud.example.test",
    token,
    fixture.source,
    "Client checkout",
  );
  expect(linked.id).toBe(pending.id);
  expect(linked.binding.workspaceId).toBe(pending.binding.workspaceId);
  expect(linked.status).toBe("linked");
  expect(JSON.stringify(await restored.list())).not.toContain(token);
  await restored.disconnect(linked.id);
  expect(fixture.disconnected()).toBe(true);
  expect((await restored.list())[0]?.status).toBe("disconnected");
});

it("resumes prepared work without resetting edits and rejects another grant or source identity", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  const connection = await fixture.bindings.get(linked.id);
  const claim = fixture.claim();
  const storage = join(fixture.root, "managed");
  const prepared = await prepareClientWorkspace(storage, connection, claim);
  await writeFile(join(prepared.workspaceRoot, "README"), "preserved work\n");
  expect(await prepareClientWorkspace(storage, connection, claim)).toEqual(
    prepared,
  );
  expect(await readFile(join(prepared.workspaceRoot, "README"), "utf8")).toBe(
    "preserved work\n",
  );
  await expect(
    prepareClientWorkspace(storage, connection, {
      ...claim,
      inputDigest: "c".repeat(64),
    }),
  ).rejects.toThrow("another task grant");
  await workspaceGit(fixture.source, [
    "config",
    "remote.origin.url",
    "https://github.com/another/project",
  ]);
  await expect(
    prepareClientWorkspace(storage, connection, fixture.claim()),
  ).rejects.toThrow("does not match");
});

it("refuses storage inside the source or through a junction before writing into the checkout", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  const connection = await fixture.bindings.get(linked.id);
  const destination = join(fixture.source, "managed");
  await expect(
    prepareClientWorkspace(destination, connection, fixture.claim()),
  ).rejects.toThrow("separate from the source");
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const junction = join(fixture.root, "alias");
  await symlink(fixture.source, junction, "junction");
  await expect(
    prepareClientWorkspace(
      join(junction, "managed"),
      connection,
      fixture.claim(),
    ),
  ).rejects.toThrow("separate from the source");
});

it("recovers a complete checkout after an interrupted acknowledgment but refuses partial preparation", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  const connection = await fixture.bindings.get(linked.id);
  const claim = fixture.claim();
  const storage = join(fixture.root, "managed");
  const prepared = await prepareClientWorkspace(storage, connection, claim);
  const recordPath = join(prepared.directory, "preparation.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(
    recordPath,
    JSON.stringify({ ...record, phase: "preparing" }),
  );
  await rm(join(prepared.workspaceRoot, "README"));
  await expect(
    prepareClientWorkspace(storage, connection, claim),
  ).rejects.toThrow("preparation is incomplete");
  expect(JSON.parse(await readFile(recordPath, "utf8")).phase).toBe(
    "preparing",
  );
  await writeFile(join(prepared.workspaceRoot, "README"), "committed source\n");
  expect(await prepareClientWorkspace(storage, connection, claim)).toEqual(
    prepared,
  );
  expect(JSON.parse(await readFile(recordPath, "utf8")).phase).toBe("ready");
});

it("validates repository URLs and exposes a focused CLI without execution overrides", () => {
  expect(within(resolve("owned"), resolve("owned/..cache"))).toBe(true);
  expect(within(resolve("owned"), resolve("owned/../private"))).toBe(false);
  expect(within(resolve("owned"), resolve("."))).toBe(false);
  expect(canonicalRepository("ssh://git@github.com/Example/Project.git")).toBe(
    repository,
  );
  expect(() =>
    canonicalRepository("https://secret@github.com/example/project"),
  ).toThrow("credentials");
  expect(
    parseCliArgs([
      "cloud",
      "connect",
      "--cloud-url",
      "https://cloud.example.test",
      "--json",
    ]).cloud?.action,
  ).toBe("connect");
  expect(() =>
    parseCliArgs([
      "cloud",
      "connect",
      "--cloud-url",
      "https://cloud.example.test",
      "--provider",
      "openai",
    ]),
  ).toThrow("not supported");
  expect(
    parseCliArgs([
      "cloud",
      "run",
      "connection",
      "--cloud-runtime",
      "runtime.json",
      "--once",
    ]).cloud,
  ).toEqual({
    action: "run",
    id: "connection",
    runtime: "runtime.json",
    once: true,
  });
  expect(parseCliArgs(["cloud", "run", "connection"]).cloud).toEqual({
    action: "run",
    id: "connection",
    once: false,
  });
  expect(() => parseCliArgs(["cloud", "status", "--once"])).toThrow(
    "require machdoch cloud run",
  );
  for (const path of [
    "/root",
    "C:/source",
    "../source",
    "a/../b",
    "a//b",
    ".",
    "a\\b",
    "a\u0000b",
  ])
    expect(repositoryDirectorySchema.safeParse(path).success).toBe(false);
  expect(repositoryDirectorySchema.parse("apps/worker")).toBe("apps/worker");
});

it("links an explicit Linux client only to the configured repository directory", async () => {
  const fixture = await setup();
  const selected = join(fixture.source, "apps", "worker");
  await mkdir(selected, { recursive: true });
  await writeFile(join(selected, "README"), "worker source");
  await workspaceGit(fixture.source, ["add", "apps"]);
  await workspaceGit(fixture.source, [
    "-c",
    "user.name=Verification",
    "-c",
    "user.email=verify@example.test",
    "commit",
    "-m",
    "Worker",
  ]);
  fixture.registration.profile.baseCommit = (
    await workspaceGit(fixture.source, ["rev-parse", "HEAD"])
  ).trim();
  const { agent: _, ...profile } = fixture.registration.profile as Extract<
    WorkerRegistration["profile"],
    { target: "client" }
  >;
  fixture.registration.profile = {
    ...profile,
    target: "client-linux",
    providerId: randomUUID(),
    model: "fixture",
    workspacePath: "apps/worker",
  };
  await expect(fixture.connect()).rejects.toThrow("directory configured");
  expect(await fixture.bindings.list()).toEqual([]);
  const linked = await fixture.bindings.connect(
    "https://cloud.example.test",
    token,
    selected,
    "Worker",
  );
  expect(linked.subdirectory.replaceAll("\\", "/")).toBe("apps/worker");
  expect(linked.registration.profile.target).toBe("client-linux");
});

it("a delayed reconnection cannot overwrite a newer confirmed credential", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  const transport = vi.mocked(globalThis.fetch);
  const implementation = transport.getMockImplementation()!;
  let releaseHeld!: () => void;
  let notifyRequested!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    notifyRequested = resolve;
  });
  const oldToken = "mch_cloud_worker_" + "b".repeat(43);
  const newToken = "mch_cloud_worker_" + "c".repeat(43);
  transport.mockImplementation(async (input, options) => {
    if (
      String(input).endsWith("/workspace") &&
      new Headers(options?.headers).get("authorization") ===
        `Bearer ${oldToken}`
    ) {
      notifyRequested();
      await held;
    }
    return implementation(input, options);
  });
  const oldConnection = fixture.bindings.connect(
    "https://cloud.example.test",
    oldToken,
    fixture.source,
    "Client checkout",
  );
  await requested;
  await fixture.bindings.connect(
    "https://cloud.example.test",
    newToken,
    fixture.source,
    "Client checkout",
  );
  const rejected = expect(oldConnection).rejects.toThrow("connection changed");
  releaseHeld();
  await rejected;
  expect((await fixture.bindings.get(linked.id)).token).toBe(newToken);
});

it("desktop responses expose connection summaries and classify revoked credentials without disclosing them", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  const reply = await executeCloudWorkspaceRequest(
    { action: "list", refresh: true },
    fixture.bindings,
  );
  expect(reply.ok).toBe(true);
  if (!reply.ok) throw new Error(reply.error);
  expect(reply.connections[0]).toMatchObject({
    id: linked.id,
    workspaceName: "Client checkout",
    projectName: "Project",
    access: "available",
  });
  expect(JSON.stringify(reply)).not.toContain(token);
  expect(JSON.stringify(reply)).not.toContain("registration");
  vi.mocked(fetch).mockResolvedValue(
    Response.json(
      { error: token, code: "runner_authentication" },
      { status: 401 },
    ),
  );
  const expired = await executeCloudWorkspaceRequest(
    { action: "list", refresh: true },
    fixture.bindings,
  );
  expect(expired.ok && expired.connections[0]?.access).toBe(
    "credentials_required",
  );
  const rejected = await executeCloudWorkspaceRequest(
    { action: "reconnect", id: linked.id },
    fixture.bindings,
  );
  expect(rejected.ok).toBe(false);
  expect(JSON.stringify(rejected)).not.toContain(token);
});

it("reconnect cannot turn another runner's token into an unintended new connection", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  fixture.registration.workerId = randomUUID();
  fixture.registration.workspaceBinding = null;
  const result = await executeCloudWorkspaceRequest(
    {
      action: "reconnect",
      id: linked.id,
      token: "mch_cloud_worker_" + "b".repeat(43),
    },
    fixture.bindings,
  );
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining("another runner"),
  });
  expect(await fixture.bindings.list()).toHaveLength(1);
  expect((await fixture.bindings.get(linked.id)).token).toBe(token);
});

it("an explicit renewed credential can reconnect a disconnected workspace and finish a pending disconnect", async () => {
  const fixture = await setup();
  const linked = await fixture.connect();
  await fixture.bindings.disconnect(linked.id);
  const newToken = "mch_cloud_worker_" + "b".repeat(43);
  const reconnected = await executeCloudWorkspaceRequest(
    { action: "reconnect", id: linked.id, token: newToken },
    fixture.bindings,
  );
  expect(reconnected.ok && reconnected.connections[0]?.status).toBe("linked");
  expect((await fixture.bindings.get(linked.id)).binding.workspaceId).toBe(
    linked.binding.workspaceId,
  );
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) =>
    String(url).endsWith("/availability")
      ? Response.json({
          workerId: randomUUID(),
          enabled: true,
          available: false,
        })
      : original(url, options),
  );
  await expect(fixture.bindings.disconnect(linked.id, token)).rejects.toThrow(
    "another runner",
  );
  expect((await fixture.bindings.get(linked.id)).status).toBe("disconnecting");
  expect((await fixture.bindings.get(linked.id)).token).toBe(newToken);
  vi.mocked(fetch).mockImplementation(original);
  await fixture.bindings.disconnect(linked.id, token);
  expect((await fixture.bindings.get(linked.id)).status).toBe("disconnected");
});

it("a malformed private connection file cannot echo its contents through the desktop error reply", async () => {
  const fixture = await setup();
  await fixture.connect();
  const path = join(fixture.bindings.directory, "connections.json");
  await writeFile(path, token);
  const reply = await executeCloudWorkspaceRequest(
    { action: "list", refresh: false },
    fixture.bindings,
  );
  expect(reply).toMatchObject({
    ok: false,
    error: expect.stringContaining("unreadable"),
  });
  expect(JSON.stringify(reply)).not.toContain(token);
  expect(await readFile(path, "utf8")).toBe(token);
});
