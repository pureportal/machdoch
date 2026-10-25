import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  workerRepositorySchema,
  type WorkerRepositoryRequest,
} from "../../../lib/cloud-repository-contract";
import {
  githubRepositorySchema,
  maximumRepositoryTransferBytes,
} from "@machdoch/fleet-protocol/cloud-repository";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { SettingsCipher } from "../../settings-crypto";
import { CloudRepositories } from "./repositories";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let actor: CloudActor;
let worker: { id: string; token: string };
let request: WorkerRepositoryRequest;
let profileId: string;
const advertisement = "application/x-git-upload-pack-advertisement";
const resultType = "application/x-git-upload-pack-result";
const signal = () => new AbortController().signal;
beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 30000);
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  actor = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES ($1,'Organization')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [actor.organizationId, actor.userId],
  );
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 3)),
  });
  const team = await runtime.planning.createTeam(actor, randomUUID(), {
    name: "Team",
    key: "TM",
    visibility: "organization",
    estimateScale: defaultEstimateScale,
  });
  const project = await runtime.projects.create(actor, randomUUID(), {
    teamId: team.id,
    name: "Project",
    description: "",
  });
  const provider = await runtime.aiProviders.create(actor, randomUUID(), {
    name: "Provider",
    provider: "openai",
    region: null,
    models: ["fixture"],
    apiKey: "fixture-key",
    maxOutputTokens: 256,
    dailyTokenBudget: 100000,
    maxConcurrentRequests: 1,
  });
  profileId = (
    await runtime.execution.profiles.create(actor, randomUUID(), {
      projectId: project.id,
      name: "Cloud",
      target: "cloud",
      repository: "https://github.com/owner/repository",
      baseCommit: "a".repeat(40),
      providerId: provider.id,
      model: "fixture",
      maxDurationSeconds: 600,
      maxTokens: 10000,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    })
  ).id;
  const issue = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      projectId: project.id,
      title: "Fetch repository",
      acceptanceCriteria: "Pinned commit",
    }),
  );
  await runtime.execution.runs.create(actor, randomUUID(), {
    profileId,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  worker = await runtime.execution.workers.register(actor, profileId, "Runner");
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  request = {
    runId: claim!.runId,
    attemptId: claim!.attemptId,
    epoch: claim!.epoch,
    id: randomUUID(),
    operation: "advertise",
    body: "",
  };
});

it("binds a preparing attempt to read-only GitHub operations with no ambient credentials or redirects", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response("0000", { headers: { "Content-Type": advertisement } }),
  );
  const service = new CloudRepositories(database, transport);
  expect(workerRepositorySchema.safeParse(request).success).toBe(true);
  expect(
    await (await service.transfer(worker.token, request, signal())).text(),
  ).toBe("0000");
  expect(transport.mock.calls[0]![0]).toBe(
    "https://github.com/owner/repository.git/info/refs?service=git-upload-pack",
  );
  expect(transport.mock.calls[0]![1]).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { "Git-Protocol": "version=2", Accept: advertisement },
  });
  expect(
    new Headers(transport.mock.calls[0]![1]?.headers).has("authorization"),
  ).toBe(false);
  expect(
    (
      await database.engine.query(
        "SELECT state,charged_bytes FROM cloud_repository_transfers",
      )
    ).rows[0],
  ).toEqual({ state: "complete", charged_bytes: 4 });
  await expect(
    service.transfer(worker.token, request, signal()),
  ).rejects.toMatchObject({ code: "transfer_used" });
  transport.mockResolvedValueOnce(
    new Response(Buffer.from([0, 1, 2, 255]), {
      headers: { "Content-Type": resultType },
    }),
  );
  const fetchRequest = {
    ...request,
    id: randomUUID(),
    operation: "fetch" as const,
    body: gzipSync("0000").toString("base64"),
    encoding: "gzip" as const,
  };
  expect(
    Buffer.from(
      await (
        await service.transfer(worker.token, fetchRequest, signal())
      ).arrayBuffer(),
    ),
  ).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(transport.mock.calls[1]![0]).toBe(
    "https://github.com/owner/repository.git/git-upload-pack",
  );
  expect(transport.mock.calls[1]![1]?.body).toEqual(gzipSync("0000"));
  expect(
    new Headers(transport.mock.calls[1]![1]?.headers).get("content-encoding"),
  ).toBe("gzip");
});

it("rejects caller-supplied URLs, push operations, invalid base64 and traversal repository paths", () => {
  for (const patch of [
    { url: "http://169.254.169.254" },
    { operation: "push" },
    { body: "??" },
    { body: "YQ==" },
  ])
    expect(
      workerRepositorySchema.safeParse({ ...request, ...patch }).success,
    ).toBe(false);
  for (const url of [
    "https://github.com/../repository",
    "https://github.com/owner/..",
    "https://github.com/owner/repo?next=1",
    "https://github.com.evil.test/owner/repo",
  ])
    expect(githubRepositorySchema.safeParse(url).success).toBe(false);
});

it("retains local capacity until a downloaded response is consumed or canceled", async () => {
  const service = new CloudRepositories(
    database,
    async () =>
      new Response("0000", { headers: { "Content-Type": advertisement } }),
  );
  const responses: Response[] = [];
  for (let index = 0; index < 8; index++)
    responses.push(
      await service.transfer(
        worker.token,
        { ...request, id: randomUUID() },
        signal(),
      ),
    );
  await expect(
    service.transfer(worker.token, { ...request, id: randomUUID() }, signal()),
  ).rejects.toMatchObject({ code: "repository_busy" });
  await responses.shift()!.text();
  responses.push(
    await service.transfer(
      worker.token,
      { ...request, id: randomUUID() },
      signal(),
    ),
  );
  await Promise.all(responses.map((response) => response.body!.cancel()));
  expect(
    await (
      await service.transfer(
        worker.token,
        { ...request, id: randomUUID() },
        signal(),
      )
    ).text(),
  ).toBe("0000");
});

it("denies other runners and expired claims before opening a connection", async () => {
  const transport = vi.fn<typeof fetch>();
  const service = new CloudRepositories(database, transport);
  const foreign = await runtime.execution.workers.register(
    actor,
    profileId,
    "Foreign",
  );
  await expect(
    service.transfer(foreign.token, request, signal()),
  ).rejects.toMatchObject({ code: "attempt_unavailable" });
  await database.engine.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second'",
  );
  await expect(
    service.transfer(worker.token, request, signal()),
  ).rejects.toMatchObject({ code: "attempt_stopped" });
  expect(transport).not.toHaveBeenCalled();
});

it("withholds fetched bytes if cancellation arrives during the network request", async () => {
  let release!: (response: Response) => void;
  const transport = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const service = new CloudRepositories(database, transport);
  const transfer = service.transfer(worker.token, request, signal());
  const rejected = expect(transfer).rejects.toMatchObject({
    code: "attempt_stopped",
  });
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  await expect(
    service.transfer(worker.token, { ...request, id: randomUUID() }, signal()),
  ).rejects.toMatchObject({ code: "repository_busy" });
  const run = await runtime.execution.runs.get(actor, request.runId);
  await runtime.execution.runs.cancel(
    actor,
    randomUUID(),
    run.id,
    run.revision,
  );
  release(new Response("0000", { headers: { "Content-Type": advertisement } }));
  await rejected;
  expect(
    (
      await database.engine.query(
        "SELECT state,charged_bytes FROM cloud_repository_transfers",
      )
    ).rows[0],
  ).toEqual({ state: "failed", charged_bytes: maximumRepositoryTransferBytes });
});

it.each(["redirect", "html", "declared-size", "stream-size"])(
  "rejects %s responses and retains transfer reservations",
  async (kind) => {
    let canceled = false;
    const transport = vi.fn<typeof fetch>(async () => {
      if (kind === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1" },
        });
      if (kind === "html")
        return new Response("sign in", {
          headers: { "Content-Type": "text/html" },
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(Buffer.alloc(1024 * 1024));
          },
          cancel() {
            canceled = true;
          },
        }),
        {
          headers: {
            "Content-Type": advertisement,
            ...(kind === "declared-size"
              ? { "Content-Length": String(maximumRepositoryTransferBytes + 1) }
              : {}),
          },
        },
      );
    });
    const service = new CloudRepositories(database, transport);
    await expect(
      service.transfer(worker.token, request, signal()),
    ).rejects.toMatchObject({
      code: kind.endsWith("size")
        ? "repository_too_large"
        : "repository_unavailable",
    });
    if (kind.endsWith("size")) expect(canceled).toBe(true);
    expect(
      (
        await database.engine.query(
          "SELECT state,charged_bytes FROM cloud_repository_transfers",
        )
      ).rows[0],
    ).toEqual({
      state: "failed",
      charged_bytes: maximumRepositoryTransferBytes,
    });
  },
);

it("bounds repeated failures and reaps expired transfers without refunding unknown bytes", async () => {
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("Unavailable");
  });
  const service = new CloudRepositories(database, transport);
  await database.engine.query(
    "INSERT INTO cloud_repository_transfers VALUES ($1,$2,$3,$4,$5,'pending',$6,clock_timestamp()-interval '1 second')",
    [
      actor.organizationId,
      randomUUID(),
      request.runId,
      request.attemptId,
      request.epoch,
      maximumRepositoryTransferBytes * 7,
    ],
  );
  await expect(
    service.transfer(worker.token, request, signal()),
  ).rejects.toMatchObject({ code: "repository_unavailable" });
  await expect(
    service.transfer(worker.token, { ...request, id: randomUUID() }, signal()),
  ).rejects.toMatchObject({ code: "repository_limit" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    (
      await database.engine.query<{ state: string }>(
        "SELECT state FROM cloud_repository_transfers",
      )
    ).rows.every((row) => row.state === "failed"),
  ).toBe(true);
});
