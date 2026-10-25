import { createHash, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import {
  artifactInputSchema,
  artifactChunkBytes,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type {
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { SettingsCipher } from "../../settings-crypto";
import { storeTestArtifact, verificationFixture } from "./test-artifacts";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let actor: CloudActor;
let member: CloudActor;
let worker: { id: string; token: string };
let claim: WorkerClaim;
const commit = "a".repeat(40);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const identity = () => ({
  runId: claim.runId,
  attemptId: claim.attemptId,
  epoch: claim.epoch,
});
function inputFor(bytes: Buffer, changes: Record<string, unknown> = {}) {
  return {
    ...identity(),
    artifactId: randomUUID(),
    kind: "log" as const,
    name: "output.log",
    byteLength: bytes.length,
    sha256: sha(bytes),
    inputDigest: claim.inputDigest,
    candidateCommit: null,
    ...changes,
  };
}
const chunk = (artifactId: string, bytes: Buffer, offset = 0) => ({
  ...identity(),
  artifactId,
  offset,
  content: bytes.toString("base64"),
});
const completion = (evidenceDigest: string): WorkerFinish => ({
  ...identity(),
  outcome: "succeeded",
  summary: "Verified",
  stopped: true,
  inputDigest: claim.inputDigest,
  candidateCommit: commit,
  tokensUsed: 0,
  checks: [
    { name: "unit", passed: true, candidateCommit: commit, evidenceDigest },
  ],
});
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
  member = { organizationId: actor.organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES ($1,'Organization')",
    [actor.organizationId],
  );
  for (const [person, role] of [
    [actor, "owner"],
    [member, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [person.userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES ($1,$2,$3)",
      [person.organizationId, person.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 6)),
  });
  const team = await runtime.planning.createTeam(actor, randomUUID(), {
    name: "Team",
    key: "TM",
    visibility: "private",
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
  const profile = await runtime.execution.profiles.create(actor, randomUUID(), {
    projectId: project.id,
    name: "Cloud",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: commit,
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const issue = await runtime.planning.createIssue(
    actor,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      projectId: project.id,
      title: "Retain results",
      acceptanceCriteria: "Durable evidence",
    }),
  );
  await runtime.execution.runs.create(actor, randomUUID(), {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  worker = await runtime.execution.workers.register(
    actor,
    profile.id,
    "Runner",
  );
  claim = (await runtime.execution.leases.claim(worker.token, randomUUID()))
    .claim!;
  await runtime.execution.leases.accept(worker.token, {
    ...identity(),
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
});

it("resumes accepted chunks after response loss and returns one immutable file after restart", async () => {
  const bytes = Buffer.alloc(artifactChunkBytes + 12, 41);
  const input = inputFor(bytes);
  const initial = await runtime.execution.uploads.begin(worker.token, input);
  expect(await runtime.execution.uploads.begin(worker.token, input)).toEqual(
    initial,
  );
  await Promise.all([
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, bytes.subarray(0, artifactChunkBytes)),
    ),
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, bytes.subarray(0, artifactChunkBytes)),
    ),
  ]);
  const restarted = createCloudRuntime(database, "https://cloud.example.test");
  expect(
    (await restarted.execution.uploads.begin(worker.token, input))
      .receivedBytes,
  ).toBe(artifactChunkBytes);
  await restarted.execution.uploads.write(
    worker.token,
    chunk(
      input.artifactId,
      bytes.subarray(artifactChunkBytes),
      artifactChunkBytes,
    ),
  );
  const receipt = await restarted.execution.uploads.complete(
    worker.token,
    input,
  );
  expect(receipt).toMatchObject({
    state: "ready",
    receivedBytes: bytes.length,
  });
  const revision = (await runtime.execution.runs.get(actor, claim.runId))
    .revision;
  expect(await runtime.execution.uploads.complete(worker.token, input)).toEqual(
    receipt,
  );
  expect((await runtime.execution.runs.get(actor, claim.runId)).revision).toBe(
    revision,
  );
  const response = await runtime.execution.artifacts.download(
    actor,
    claim.runId,
    input.artifactId,
    new AbortController().signal,
  );
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("etag")).toBe(`"${sha(bytes)}"`);
  expect(
    (await runtime.execution.runs.get(actor, claim.runId)).artifacts,
  ).toHaveLength(1);
});

it("rejects conflicting metadata, changed chunks, missing offsets and tiny nonfinal chunks", async () => {
  const bytes = Buffer.alloc(artifactChunkBytes + 1, 1);
  const input = inputFor(bytes);
  await runtime.execution.uploads.begin(worker.token, input);
  await expect(
    runtime.execution.uploads.begin(worker.token, {
      ...input,
      name: "different.log",
    }),
  ).rejects.toMatchObject({ code: "artifact_conflict" });
  await expect(
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, Buffer.from("x")),
    ),
  ).rejects.toMatchObject({ code: "chunk_size" });
  await expect(
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, Buffer.from("x"), artifactChunkBytes),
    ),
  ).rejects.toMatchObject({ code: "upload_offset" });
  await runtime.execution.uploads.write(
    worker.token,
    chunk(input.artifactId, bytes.subarray(0, artifactChunkBytes)),
  );
  await expect(
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, Buffer.alloc(artifactChunkBytes, 2)),
    ),
  ).rejects.toMatchObject({ code: "chunk_conflict" });
  await expect(
    runtime.execution.uploads.complete(worker.token, input),
  ).rejects.toMatchObject({ code: "upload_incomplete" });
  await expect(
    runtime.execution.artifacts.download(
      actor,
      claim.runId,
      input.artifactId,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "artifact_unavailable" });
});

it("verifies the full digest and permits explicit abandonment before a replacement upload", async () => {
  const bytes = Buffer.from("changed");
  const input = inputFor(bytes, { sha256: sha(Buffer.from("original")) });
  await runtime.execution.uploads.begin(worker.token, input);
  await runtime.execution.uploads.write(
    worker.token,
    chunk(input.artifactId, bytes),
  );
  await expect(
    runtime.execution.uploads.complete(worker.token, input),
  ).rejects.toMatchObject({ code: "artifact_digest" });
  expect(
    (await runtime.execution.uploads.abandon(worker.token, input)).state,
  ).toBe("abandoned");
  expect(
    (await database.engine.query("SELECT * FROM cloud_artifact_chunks")).rows,
  ).toHaveLength(0);
  await expect(
    runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, bytes),
    ),
  ).rejects.toMatchObject({ code: "upload_closed" });
  const replacement = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    bytes,
    null,
    "replacement.log",
  );
  await expect(
    runtime.execution.uploads.abandon(worker.token, replacement),
  ).rejects.toMatchObject({ code: "artifact_immutable" });
});

it("requires stored candidate and matching successful check evidence before success", async () => {
  await runtime.execution.leases.progress(worker.token, {
    ...identity(),
    state: "validating",
  });
  const good = Buffer.from(JSON.stringify(verificationFixture(commit)));
  await expect(
    runtime.execution.leases.finish(worker.token, completion(sha(good))),
  ).rejects.toMatchObject({ code: "candidate_artifact_required" });
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "candidate",
    Buffer.from("controlled bundle fixture"),
    commit,
    "candidate.bundle",
  );
  await expect(
    runtime.execution.leases.finish(worker.token, completion(sha(good))),
  ).rejects.toMatchObject({ code: "stored_evidence_required" });
  const substituted = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    Buffer.from(
      JSON.stringify(verificationFixture(commit, { command: "true" })),
    ),
    commit,
    "substituted.json",
  );
  await expect(
    runtime.execution.leases.finish(
      worker.token,
      completion(substituted.sha256),
    ),
  ).rejects.toMatchObject({ code: "stored_evidence_required" });
  const bad = Buffer.from(
    JSON.stringify(verificationFixture(commit, { exitCode: 1 })),
  );
  const failed = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    bad,
    commit,
    "failed.json",
  );
  await expect(
    runtime.execution.leases.finish(worker.token, completion(failed.sha256)),
  ).rejects.toMatchObject({ code: "stored_evidence_required" });
  const passed = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    good,
    commit,
    "passed.json",
  );
  expect(
    await runtime.execution.leases.finish(
      worker.token,
      completion(passed.sha256),
    ),
  ).toMatchObject({ state: "succeeded", accepted: true });
  expect(
    (await runtime.execution.runs.get(actor, claim.runId)).artifacts,
  ).toHaveLength(4);
  expect(
    (
      await runtime.execution.artifacts.preview(
        actor,
        claim.runId,
        passed.artifactId,
      )
    ).text,
  ).toBe(good.toString());
});

it.each(["invalid", "candidate"])(
  "rejects %s verification records",
  async (kind) => {
    const bytes = Buffer.from(
      JSON.stringify(
        kind === "invalid"
          ? { passed: true }
          : verificationFixture("b".repeat(40)),
      ),
    );
    const input = {
      ...inputFor(bytes),
      kind: "verification" as const,
      candidateCommit: commit,
    };
    await runtime.execution.uploads.begin(worker.token, input);
    await runtime.execution.uploads.write(
      worker.token,
      chunk(input.artifactId, bytes),
    );
    await expect(
      runtime.execution.uploads.complete(worker.token, input),
    ).rejects.toMatchObject({
      code: kind === "invalid" ? "invalid_evidence" : "candidate_mismatch",
    });
  },
);

it("keeps task files private across teams, runs, and organizations", async () => {
  const input = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    Buffer.from("private"),
    null,
    "private.log",
  );
  await expect(
    runtime.execution.artifacts.preview(member, claim.runId, input.artifactId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.execution.artifacts.download(
      { ...actor, organizationId: randomUUID() },
      claim.runId,
      input.artifactId,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.execution.artifacts.preview(actor, randomUUID(), input.artifactId),
  ).rejects.toMatchObject({ status: 404 });
});

it.each(["cancel", "lease", "worker"])(
  "fences uploads and ready-file replays after %s revocation",
  async (cause) => {
    const input = await storeTestArtifact(
      runtime,
      worker.token,
      claim,
      "log",
      Buffer.from("retained"),
      null,
      "retained.log",
    );
    if (cause === "cancel") {
      const run = await runtime.execution.runs.get(actor, claim.runId);
      await runtime.execution.runs.cancel(
        actor,
        randomUUID(),
        run.id,
        run.revision,
      );
    }
    if (cause === "lease")
      await database.engine.exec(
        "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second'",
      );
    if (cause === "worker")
      await database.engine.exec(
        "UPDATE cloud_execution_workers SET enabled=false",
      );
    await expect(
      runtime.execution.uploads.complete(worker.token, input),
    ).rejects.toMatchObject({ code: "attempt_stopped" });
    await expect(
      runtime.execution.uploads.begin(worker.token, input),
    ).rejects.toMatchObject({ code: "attempt_stopped" });
    expect(
      (
        await runtime.execution.artifacts.preview(
          actor,
          claim.runId,
          input.artifactId,
        )
      ).text,
    ).toBe("retained");
  },
);

it("reserves declared storage before accepting bytes and releases only abandoned uploads", async () => {
  const inputs = [];
  for (let index = 0; index < 4; index++) {
    const input = inputFor(Buffer.from("reserved"), {
      byteLength: 64 * 1024 * 1024,
    });
    await runtime.execution.uploads.begin(worker.token, input);
    inputs.push(input);
  }
  await expect(
    runtime.execution.uploads.begin(
      worker.token,
      inputFor(Buffer.from("extra")),
    ),
  ).rejects.toMatchObject({ code: "artifact_capacity" });
  await runtime.execution.uploads.abandon(worker.token, inputs[0]!);
  expect(
    (
      await runtime.execution.uploads.begin(
        worker.token,
        inputFor(Buffer.from("next")),
      )
    ).state,
  ).toBe("uploading");
});

it("expires partial uploads without removing completed files", async () => {
  const finished = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    Buffer.from("saved"),
    null,
    "saved.log",
  );
  const bytes = Buffer.alloc(artifactChunkBytes + 1, 1);
  const pending = inputFor(bytes);
  await runtime.execution.uploads.begin(worker.token, pending);
  await runtime.execution.uploads.write(
    worker.token,
    chunk(pending.artifactId, bytes.subarray(0, artifactChunkBytes)),
  );
  await database.engine.exec(
    "UPDATE cloud_run_artifacts SET expires_at=clock_timestamp()-interval '1 second'",
  );
  await runtime.execution.uploads.begin(
    worker.token,
    inputFor(Buffer.from("next")),
  );
  expect(
    (await runtime.execution.uploads.begin(worker.token, pending)).state,
  ).toBe("abandoned");
  expect(
    (
      await runtime.execution.artifacts.preview(
        actor,
        claim.runId,
        finished.artifactId,
      )
    ).text,
  ).toBe("saved");
});

it("offers safe bounded previews and forces downloads to remain attachments", async () => {
  const bytes = Buffer.from(
    "<script>window.injected=true</script>\n".repeat(5000),
  );
  const input = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    bytes,
    null,
    "output.html",
  );
  const preview = await runtime.execution.artifacts.preview(
    actor,
    claim.runId,
    input.artifactId,
  );
  expect(preview.truncated).toBe(true);
  expect(preview.text).toContain("<script>");
  expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(128 * 1024);
  const response = await runtime.execution.artifacts.download(
    actor,
    claim.runId,
    input.artifactId,
    new AbortController().signal,
  );
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="output.html"',
  );
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it("rechecks membership between download pages", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 97);
  const input = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    bytes,
    null,
    "large.log",
  );
  const response = await runtime.execution.artifacts.download(
    actor,
    claim.runId,
    input.artifactId,
    new AbortController().signal,
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  let received = first.value!.byteLength;
  await database.engine.query(
    "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
    [actor.userId],
  );
  await expect(
    (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        received += next.value.byteLength;
      }
    })(),
  ).rejects.toThrow("interrupted");
  expect(received).toBeLessThan(bytes.length);
});

it("bounds concurrent downloads and releases canceled response slots", async () => {
  const input = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "log",
    Buffer.from("download"),
    null,
    "download.log",
  );
  const responses: Response[] = [];
  for (let index = 0; index < 8; index++)
    responses.push(
      await runtime.execution.artifacts.download(
        actor,
        claim.runId,
        input.artifactId,
        new AbortController().signal,
      ),
    );
  await expect(
    runtime.execution.artifacts.download(
      actor,
      claim.runId,
      input.artifactId,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "downloads_busy" });
  await Promise.all(responses.map((response) => response.body!.cancel()));
  expect(
    await (
      await runtime.execution.artifacts.download(
        actor,
        claim.runId,
        input.artifactId,
        new AbortController().signal,
      )
    ).text(),
  ).toBe("download");
});

it("rejects unsafe file names and mismatched task manifests", async () => {
  for (const name of [
    "../file",
    "C:file",
    'file".txt',
    "CON.txt",
    ".",
    "trailing\nheader",
  ])
    expect(
      artifactInputSchema.safeParse({
        artifactId: randomUUID(),
        kind: "log",
        name,
        byteLength: 1,
        sha256: "a".repeat(64),
        inputDigest: "b".repeat(64),
        candidateCommit: null,
      }).success,
    ).toBe(false);
  await expect(
    runtime.execution.uploads.begin(
      worker.token,
      inputFor(Buffer.from("file"), { inputDigest: "0".repeat(64) }),
    ),
  ).rejects.toMatchObject({ code: "manifest_mismatch" });
});

it("stores empty diffs without fabricated content", async () => {
  const input = await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "diff",
    Buffer.alloc(0),
    commit,
    "changes.patch",
  );
  expect(
    await runtime.execution.artifacts.preview(
      actor,
      claim.runId,
      input.artifactId,
    ),
  ).toEqual({ text: "", truncated: false });
  expect(
    await (
      await runtime.execution.artifacts.download(
        actor,
        claim.runId,
        input.artifactId,
        new AbortController().signal,
      )
    ).text(),
  ).toBe("");
});
