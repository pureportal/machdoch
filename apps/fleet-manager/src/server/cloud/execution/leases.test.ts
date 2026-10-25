import { createHash, randomUUID } from "node:crypto";
import { storeTestArtifact, verificationFixture } from "./test-artifacts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  issueUpdateSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type {
  RunInput,
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase, testStatusReference } from "../test-database";
import { SettingsCipher } from "../../settings-crypto";
import type { ProviderUpdate } from "@machdoch/fleet-protocol/cloud-providers";
import { executionProfileInputSchema } from "@machdoch/fleet-protocol/cloud-execution";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let input: RunInput;
let projectId: string;
let profileId: string;
let providerId: string;
let teamId: string;
let worker: { id: string; token: string };
const commit = "a".repeat(40);

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 7)),
  });
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "member", "viewer"]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, userId, role],
    );
    actors.push({ userId, organizationId });
  }
  [owner, member, viewer] = actors as [CloudActor, CloudActor, CloudActor];
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  projectId = (
    await runtime.projects.create(owner, randomUUID(), {
      teamId,
      name: "Project",
      description: "",
    })
  ).id;
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Execution provider",
      provider: "openai",
      region: null,
      models: ["test-model"],
      apiKey: "fixture-credential",
      maxOutputTokens: 512,
      dailyTokenBudget: 100000,
      maxConcurrentRequests: 4,
    })
  ).id;
  profileId = (
    await runtime.execution.profiles.create(owner, randomUUID(), {
      projectId,
      name: "Cloud",
      target: "cloud",
      repository: "https://github.com/example/project",
      baseCommit: commit,
      providerId,
      model: "test-model",
      maxDurationSeconds: 3600,
      maxTokens: 10000,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    })
  ).id;
  const issue = await runtime.planning.createIssue(
    member,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      projectId,
      title: "Implement reconnect",
      description: "Handle reconnect",
      acceptanceCriteria: "No duplicate commands",
    }),
  );
  input = { profileId, subject: { kind: "issue", id: issue.id, revision: 1 } };
  worker = await runtime.execution.workers.register(owner, profileId, "Worker");
});

async function claimed(): Promise<WorkerClaim> {
  await runtime.execution.runs.create(member, randomUUID(), input);
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  expect(claim).not.toBeNull();
  return claim!;
}
async function accepted(): Promise<WorkerClaim> {
  const claim = await claimed();
  await runtime.execution.leases.accept(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
  return claim;
}

async function clientWorker(target: "client" | "client-linux" = "client") {
  const profile = (await runtime.execution.profiles.list(owner)).find(
    (entry) => entry.id === profileId,
  )!;
  const { id: _, projectId: __, teamId: ___, ...definition } = profile;
  await runtime.execution.profiles.update(owner, randomUUID(), profileId, {
    ...definition,
    target,
  });
  worker = await runtime.execution.workers.register(owner, profileId, "Client");
  return {
    workspaceId: randomUUID(),
    name: "Local checkout",
    repository: profile.repository,
  };
}

it("requires an immutable matching client workspace before claiming a task", async () => {
  const binding = await clientWorker();
  const run = await runtime.execution.runs.create(member, randomUUID(), input);
  expect(
    (await runtime.execution.leases.available(worker.token)).available,
  ).toBe(false);
  await expect(
    runtime.execution.leases.claim(worker.token, randomUUID()),
  ).rejects.toMatchObject({ code: "workspace_binding_required" });
  await expect(
    runtime.execution.clientWorkspaces.bind(worker.token, {
      ...binding,
      repository: "https://github.com/other/project",
    }),
  ).rejects.toMatchObject({ code: "repository_mismatch" });
  const registration = await runtime.execution.clientWorkspaces.bind(
    worker.token,
    binding,
  );
  expect(registration.profile.id).toBe(profileId);
  expect(registration.workspaceBinding).toEqual(binding);
  expect(JSON.stringify(registration)).not.toContain("fixture-credential");
  expect(
    await runtime.execution.clientWorkspaces.bind(worker.token, binding),
  ).toEqual(registration);
  await expect(
    runtime.execution.clientWorkspaces.bind(worker.token, {
      ...binding,
      workspaceId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "workspace_already_linked" });
  expect(
    (await runtime.execution.leases.available(worker.token)).available,
  ).toBe(true);
  expect(
    (await runtime.execution.leases.claim(worker.token, randomUUID())).claim
      ?.runId,
  ).toBe(run.id);
});

it("requires a linked workspace and microVM acceptance for explicit Linux client execution", async () => {
  const binding = await clientWorker("client-linux");
  await runtime.execution.runs.create(member, randomUUID(), input);
  await expect(
    runtime.execution.leases.claim(worker.token, randomUUID()),
  ).rejects.toMatchObject({ code: "workspace_binding_required" });
  await runtime.execution.clientWorkspaces.bind(worker.token, binding);
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  expect(claim?.manifest.profile.target).toBe("client-linux");
  const acceptance = {
    runId: claim!.runId,
    attemptId: claim!.attemptId,
    epoch: claim!.epoch,
    environmentId: randomUUID(),
    baseCommit: commit,
  };
  await expect(
    runtime.execution.leases.accept(worker.token, {
      ...acceptance,
      isolation: "independent-checkout",
    }),
  ).rejects.toMatchObject({ code: "environment_mismatch" });
  expect(
    await runtime.execution.leases.accept(worker.token, {
      ...acceptance,
      isolation: "microvm",
    }),
  ).toMatchObject({ instruction: "continue" });
});

it("disconnecting a client retains its issue reservation until its own stop receipt arrives", async () => {
  const binding = await clientWorker();
  await runtime.execution.clientWorkspaces.bind(worker.token, binding);
  const claim = await claimed();
  await runtime.execution.clientWorkspaces.disconnect(worker.token);
  const fenced = await runtime.execution.runs.get(owner, claim.runId);
  await runtime.execution.clientWorkspaces.disconnect(worker.token);
  expect((await runtime.execution.runs.get(owner, claim.runId)).revision).toBe(
    fenced.revision,
  );
  await expect(
    runtime.execution.clientWorkspaces.registration(worker.token),
  ).rejects.toMatchObject({ code: "runner_revoked" });
  expect((await runtime.execution.runs.get(owner, claim.runId)).state).toBe(
    "reconciling",
  );
  await expect(
    runtime.execution.runs.create(member, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  const completion = await runtime.execution.leases.finish(worker.token, {
    ...result(claim, "failed"),
    candidateCommit: null,
    checks: [],
    tokensUsed: 0,
  });
  expect(completion).toEqual({ accepted: true, state: "failed" });
  expect(
    await runtime.execution.clientWorkspaces.disconnect(worker.token),
  ).toEqual({ disabled: true });
  const events = await database.engine.query<{
    kind: string;
    actor_id: string | null;
  }>(
    "SELECT kind,actor_id FROM cloud_outbox WHERE worker_id=$1 ORDER BY occurred_at",
    [worker.id],
  );
  expect(events.rows).toEqual([
    { kind: "runner.workspace_linked", actor_id: null },
    { kind: "runner.disconnected", actor_id: null },
  ]);
});

it("cloud-only and revoked runners cannot bind a client workspace", async () => {
  const binding = {
    workspaceId: randomUUID(),
    name: "Workspace",
    repository: "https://github.com/example/project",
  };
  await expect(
    runtime.execution.clientWorkspaces.bind(worker.token, binding),
  ).rejects.toMatchObject({ code: "client_profile_required" });
  await runtime.execution.workers.revoke(owner, randomUUID(), worker.id);
  await expect(
    runtime.execution.clientWorkspaces.bind(worker.token, binding),
  ).rejects.toMatchObject({ code: "runner_revoked" });
});
function result(
  claim: WorkerClaim,
  outcome: WorkerFinish["outcome"] = "succeeded",
): WorkerFinish {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    outcome,
    summary: "Verification outcome",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: commit,
    tokensUsed: 50,
    checks: [
      {
        name: "unit",
        passed: true,
        candidateCommit: commit,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(verificationFixture(commit)))
          .digest("hex"),
      },
    ],
  };
}

async function updateProvider(patch: Partial<ProviderUpdate>) {
  const current = (await runtime.aiProviders.list(owner, true)).providers.find(
    (provider) => provider.id === providerId,
  )!;
  await runtime.aiProviders.update(owner, randomUUID(), providerId, {
    revision: current.revision,
    name: current.name,
    models: current.models,
    region: current.region,
    enabled: current.enabled,
    maxOutputTokens: current.maxOutputTokens,
    dailyTokenBudget: current.dailyTokenBudget,
    maxConcurrentRequests: current.maxConcurrentRequests,
    ...patch,
  });
}

it("binds profiles to tenant-owned providers and allowed models", async () => {
  const profile = (await runtime.execution.profiles.list(owner))[0]!;
  const definition = executionProfileInputSchema.strip().parse(profile);
  await expect(
    runtime.execution.profiles.create(owner, randomUUID(), {
      ...definition,
      name: "Missing",
      providerId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.execution.profiles.create(owner, randomUUID(), {
      ...definition,
      name: "Unknown model",
      model: "unconfigured",
    }),
  ).rejects.toMatchObject({ code: "model_unavailable" });
  const otherOrganization = randomUUID(),
    otherProvider = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Other')",
    [otherOrganization],
  );
  await database.engine.query(
    `INSERT INTO cloud_ai_providers(organization_id,id,name,provider,models,max_output_tokens,daily_token_budget,max_concurrent_requests,secret)
    VALUES($1,$2,'Other','openai','["test-model"]',512,100000,1,$3)`,
    [otherOrganization, otherProvider, new Uint8Array([1])],
  );
  await expect(
    runtime.execution.profiles.create(owner, randomUUID(), {
      ...definition,
      name: "Other tenant",
      providerId: otherProvider,
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it("freezes provider identity and permits cosmetic changes without fencing work", async () => {
  const claim = await accepted();
  expect(claim.manifest.provider).toMatchObject({
    id: providerId,
    name: "Execution provider",
    provider: "openai",
    inferenceRevision: 1,
    maxOutputTokens: 512,
  });
  expect(JSON.stringify(claim)).not.toContain("fixture-credential");
  await updateProvider({
    name: "Renamed provider",
    dailyTokenBudget: 200000,
    models: ["test-model", "another-model"],
  });
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("continue");
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).manifest.provider
      .name,
  ).toBe("Execution provider");
});

it("credential changes fence a running task until its worker proves it stopped", async () => {
  const claim = await accepted();
  await updateProvider({ apiKey: "replacement-fixture-credential" });
  const task = await runtime.execution.runs.get(owner, claim.runId);
  expect(task.state).toBe("reconciling");
  expect(task.reason).toBe("AI provider access changed");
  expect(task.epoch).toBeGreaterThan(claim.epoch);
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  expect(
    await runtime.execution.leases.finish(worker.token, result(claim)),
  ).toMatchObject({ accepted: false, requiredOutcome: "failed" });
  expect(
    await runtime.execution.leases.finish(
      worker.token,
      result(claim, "failed"),
    ),
  ).toMatchObject({ accepted: true, state: "failed" });
});

it("disabling a provider fails queued tasks and prevents admission until explicitly restored", async () => {
  const key = randomUUID();
  const run = await runtime.execution.runs.create(owner, key, input);
  await updateProvider({ enabled: false });
  const failed = await runtime.execution.runs.get(owner, run.id);
  expect(failed.state).toBe("failed");
  expect(failed.reason).toBe("AI provider access changed");
  expect(await runtime.execution.runs.create(owner, key, input)).toEqual(run);
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ status: 404 });
  await updateProvider({ enabled: true });
  const next = await runtime.execution.runs.create(owner, randomUUID(), input);
  expect(
    (await runtime.execution.runs.get(owner, next.id)).manifest.provider
      .inferenceRevision,
  ).toBe(3);
});

it("removing a model cancels its queued authorization and rejects a new run", async () => {
  const run = await runtime.execution.runs.create(owner, randomUUID(), input);
  await updateProvider({ models: ["replacement-model"] });
  expect((await runtime.execution.runs.get(owner, run.id)).state).toBe(
    "failed",
  );
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "model_unavailable" });
});

it("reserves an issue once, freezes the inputs and persists a retried claim without another attempt", async () => {
  const key = randomUUID();
  const run = await runtime.execution.runs.create(member, key, input);
  expect(await runtime.execution.runs.create(member, key, input)).toEqual(run);
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  await expect(
    runtime.execution.runs.create(viewer, randomUUID(), input),
  ).rejects.toMatchObject({ status: 403 });
  const issue = await runtime.planning.getIssue(member, input.subject.id);
  await runtime.planning.updateIssue(member, randomUUID(), issue.id, {
    ...issueUpdateSchema.strip().parse(issue),
    description: "Changed after admission",
  });
  const claimId = randomUUID();
  const first = await runtime.execution.leases.claim(worker.token, claimId);
  const second = await createCloudRuntime(
    database,
    runtime.origin,
  ).execution.leases.claim(worker.token, claimId);
  expect(second).toEqual(first);
  expect(first.claim?.manifest.objective).not.toContain(
    "Changed after admission",
  );
  expect(
    (await runtime.execution.runs.get(owner, run.id)).attempts,
  ).toHaveLength(1);
  expect(
    (await runtime.execution.leases.claim(worker.token, randomUUID())).claim,
  ).toBeNull();
});

it("requires the declared environment, accepted grant and candidate-bound verification before success", async () => {
  const claim = await claimed();
  await expect(
    runtime.execution.leases.progress(worker.token, {
      ...claim,
      state: "validating",
    }),
  ).rejects.toMatchObject({ code: "invalid_transition" });
  const acceptance = {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm" as const,
  };
  await expect(
    runtime.execution.leases.accept(worker.token, {
      ...acceptance,
      isolation: "independent-checkout",
    }),
  ).rejects.toMatchObject({ code: "environment_mismatch" });
  await runtime.execution.leases.accept(worker.token, acceptance);
  await runtime.execution.leases.accept(worker.token, acceptance);
  await expect(
    runtime.execution.leases.finish(worker.token, result(claim)),
  ).rejects.toMatchObject({ code: "validation_required" });
  await runtime.execution.leases.progress(worker.token, {
    ...claim,
    state: "validating",
  });
  await expect(
    runtime.execution.leases.finish(worker.token, {
      ...result(claim),
      checks: [],
    }),
  ).rejects.toMatchObject({ code: "evidence_required" });
  await expect(
    runtime.execution.leases.finish(worker.token, {
      ...result(claim),
      candidateCommit: "c".repeat(40),
    }),
  ).rejects.toMatchObject({ code: "evidence_required" });
  await expect(
    runtime.execution.leases.finish(worker.token, {
      ...result(claim),
      tokensUsed: 10001,
    }),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "candidate",
    Buffer.from("controlled candidate fixture"),
    commit,
    "candidate.bundle",
  );
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    Buffer.from(JSON.stringify(verificationFixture(commit))),
    commit,
    "unit.json",
  );
  expect(
    await runtime.execution.leases.finish(worker.token, result(claim)),
  ).toEqual({ accepted: true, state: "succeeded" });
  expect(
    await runtime.execution.leases.finish(worker.token, result(claim)),
  ).toEqual({ accepted: true, state: "succeeded" });
  await expect(
    runtime.execution.leases.finish(worker.token, {
      ...result(claim),
      summary: "Different",
    }),
  ).rejects.toMatchObject({ code: "result_conflict" });
  expect((await runtime.planning.getIssue(owner, input.subject.id)).state).toBe(
    "backlog",
  );
});

it("fences cancellation immediately and holds the issue until the supervisor confirms stopping", async () => {
  const claim = await accepted();
  const run = await runtime.execution.runs.get(owner, claim.runId);
  await runtime.execution.runs.cancel(
    owner,
    randomUUID(),
    run.id,
    run.revision,
  );
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  expect(
    await runtime.execution.leases.finish(worker.token, result(claim)),
  ).toEqual({
    accepted: false,
    state: "cancel_requested",
    requiredOutcome: "canceled",
  });
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  expect(
    await runtime.execution.leases.finish(
      worker.token,
      result(claim, "canceled"),
    ),
  ).toEqual({ accepted: true, state: "canceled" });
  expect(
    await runtime.execution.runs.create(owner, randomUUID(), input),
  ).toHaveProperty("id");
});

it("does not let an expired lease revive, release the issue or take a second runner slot", async () => {
  const claim = await accepted();
  await database.engine.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [claim.attemptId],
  );
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  const run = await runtime.execution.runs.get(owner, claim.runId);
  expect(run).toMatchObject({ state: "reconciling", epoch: claim.epoch + 1 });
  expect(
    (await runtime.execution.leases.claim(worker.token, randomUUID())).claim,
  ).toBeNull();
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  expect(
    await runtime.execution.leases.finish(
      worker.token,
      result(claim, "failed"),
    ),
  ).toEqual({ accepted: true, state: "failed" });
});

it("settles deadlines from database time and allows project tasks without inventing an issue", async () => {
  const run = await runtime.execution.runs.create(owner, randomUUID(), input);
  await database.engine.query(
    "UPDATE cloud_runs SET deadline_at=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  expect((await runtime.execution.runs.get(owner, run.id)).state).toBe(
    "timed_out",
  );
  const project = await runtime.execution.runs.create(owner, randomUUID(), {
    profileId,
    subject: {
      kind: "project",
      id: projectId,
      revision: 1,
      purpose: "research",
      objective: "Review reconnect risks",
      acceptanceCriteria: "Report evidence",
    },
  });
  expect(
    (await runtime.execution.runs.get(owner, project.id)).issueId,
  ).toBeNull();
});

it("revalidates the initiator, profile and runner instead of trusting a previous grant", async () => {
  const claim = await accepted();
  await runtime.administration.updateMember(
    owner,
    randomUUID(),
    member.userId,
    { revision: 1, active: false, role: "member" },
  );
  expect(
    (
      await runtime.execution.leases.progress(worker.token, {
        ...claim,
        state: "validating",
      })
    ).instruction,
  ).toBe("stop");
  expect((await runtime.execution.runs.get(owner, claim.runId)).state).toBe(
    "reconciling",
  );
  await runtime.execution.workers.revoke(owner, randomUUID(), worker.id);
  await expect(
    runtime.execution.leases.claim(worker.token, randomUUID()),
  ).rejects.toMatchObject({ code: "runner_revoked" });
  expect(
    (
      await runtime.execution.leases.finish(
        worker.token,
        result(claim, "failed"),
      )
    ).state,
  ).toBe("failed");
  const profiles = await runtime.execution.profiles.list(owner);
  await runtime.execution.profiles.update(owner, randomUUID(), profileId, {
    ...profiles[0]!,
    enabled: false,
  });
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "profile_disabled" });
});

it("retains ownership through unknown external outcomes, then reconciles without reviving cancellation", async () => {
  const claim = await accepted();
  await runtime.execution.leases.progress(worker.token, {
    ...claim,
    state: "validating",
  });
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "candidate",
    Buffer.from("controlled candidate fixture"),
    commit,
    "candidate.bundle",
  );
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    Buffer.from(JSON.stringify(verificationFixture(commit))),
    commit,
    "unit.json",
  );
  const effectId = randomUUID();
  const resource = "https://github.com/example/project#branch/test";
  expect(
    (
      await runtime.execution.effects.reserve(
        worker.token,
        claim,
        effectId,
        resource,
        "d".repeat(64),
      )
    ).action,
  ).toBe("dispatch");
  expect(
    (
      await runtime.execution.effects.reserve(
        worker.token,
        claim,
        effectId,
        resource,
        "d".repeat(64),
      )
    ).action,
  ).toBe("reconcile");
  await expect(
    runtime.execution.effects.reserve(
      worker.token,
      claim,
      effectId,
      resource,
      "e".repeat(64),
    ),
  ).rejects.toMatchObject({ code: "effect_conflict" });
  await runtime.execution.effects.resolve(
    owner.organizationId,
    effectId,
    "unknown",
    { request: "ambiguous" },
  );
  expect(
    (await runtime.execution.leases.finish(worker.token, result(claim))).state,
  ).toBe("reconciling");
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), input),
  ).rejects.toMatchObject({ code: "run_active" });
  const run = await runtime.execution.runs.get(owner, claim.runId);
  await runtime.execution.runs.cancel(
    owner,
    randomUUID(),
    run.id,
    run.revision,
  );
  await runtime.execution.effects.resolve(
    owner.organizationId,
    effectId,
    "succeeded",
    { pullRequest: 42, repository: "example/project" },
  );
  await runtime.execution.effects.resolve(
    owner.organizationId,
    effectId,
    "succeeded",
    { repository: "example/project", pullRequest: 42 },
  );
  expect((await runtime.execution.runs.get(owner, run.id)).state).toBe(
    "canceled",
  );
  await expect(
    runtime.execution.effects.resolve(
      owner.organizationId,
      effectId,
      "failed",
      {},
    ),
  ).rejects.toMatchObject({ code: "receipt_conflict" });
});

it("keeps private tasks, profiles and worker claims isolated", async () => {
  const claim = await accepted();
  await runtime.administration.updateTeam(owner, randomUUID(), teamId, {
    revision: 1,
    name: "Private",
    visibility: "private",
    memberIds: [],
  });
  expect(await runtime.execution.runs.list(viewer)).toEqual([]);
  expect(await runtime.execution.profiles.list(viewer)).toEqual([]);
  await expect(
    runtime.execution.runs.get(viewer, claim.runId),
  ).rejects.toMatchObject({ status: 404 });
  const otherWorker = await runtime.execution.workers.register(
    owner,
    profileId,
    "Other",
  );
  await expect(
    runtime.execution.leases.heartbeat(otherWorker.token, claim),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.execution.leases.claim("not-a-token", randomUUID()),
  ).rejects.toMatchObject({ status: 401 });
});

it("rotates credentials without losing a pending cancellation or allowing the old token to continue", async () => {
  const claim = await accepted();
  const run = await runtime.execution.runs.get(owner, claim.runId);
  await runtime.execution.runs.cancel(
    owner,
    randomUUID(),
    run.id,
    run.revision,
  );
  const rotated = await runtime.execution.workers.rotate(owner, worker.id);
  await expect(
    runtime.execution.leases.heartbeat(worker.token, claim),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (await runtime.execution.leases.heartbeat(rotated.token, claim))
      .instruction,
  ).toBe("stop");
  expect(
    (
      await runtime.execution.leases.finish(
        rotated.token,
        result(claim, "failed"),
      )
    ).state,
  ).toBe("canceled");
  await runtime.execution.runs.create(owner, randomUUID(), input);
  expect(
    (await runtime.execution.leases.claim(rotated.token, randomUUID())).claim,
  ).not.toBeNull();
});

it("fences both queued and executing tasks when the execution profile changes", async () => {
  const claim = await accepted();
  const queued = await runtime.execution.runs.create(owner, randomUUID(), {
    profileId,
    subject: {
      kind: "project",
      id: projectId,
      revision: 1,
      purpose: "test",
      objective: "Run checks",
      acceptanceCriteria: "All checks pass",
    },
  });
  const profile = (await runtime.execution.profiles.list(owner))[0]!;
  await updateProvider({ models: ["test-model", "new-model"] });
  await runtime.execution.profiles.update(owner, randomUUID(), profileId, {
    ...profile,
    model: "new-model",
  });
  expect((await runtime.execution.runs.get(owner, queued.id)).state).toBe(
    "failed",
  );
  expect((await runtime.execution.runs.get(owner, claim.runId)).state).toBe(
    "reconciling",
  );
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  await runtime.execution.leases.finish(worker.token, result(claim, "failed"));
  const rotated = await runtime.execution.workers.rotate(owner, worker.id);
  await runtime.execution.runs.create(owner, randomUUID(), input);
  expect(
    (await runtime.execution.leases.claim(rotated.token, randomUUID())).claim
      ?.manifest.profile.model,
  ).toBe("new-model");
});

it("retains a deadline outcome when a late worker reports failure", async () => {
  const claim = await accepted();
  await database.engine.query(
    "UPDATE cloud_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claim.runId],
  );
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  expect(
    (
      await runtime.execution.leases.finish(
        worker.token,
        result(claim, "failed"),
      )
    ).state,
  ).toBe("timed_out");
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).attempts[0]?.state,
  ).toBe("stopped");
});

it("bounds a runner's local watchdog by the remaining lease and task deadline", async () => {
  await runtime.execution.runs.create(owner, randomUUID(), input);
  const claimId = randomUUID();
  const claim = (await runtime.execution.leases.claim(worker.token, claimId))
    .claim!;
  await database.engine.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()+interval '4 seconds' WHERE id=$1",
    [claim.attemptId],
  );
  const replay = await runtime.execution.leases.claim(worker.token, claimId);
  expect(replay.claim?.attemptId).toBe(claim.attemptId);
  expect(replay.localStopSeconds).toBeLessThanOrEqual(4);
  await database.engine.query(
    "UPDATE cloud_runs SET deadline_at=clock_timestamp()+interval '8 seconds' WHERE id=$1",
    [claim.runId],
  );
  const renewed = await runtime.execution.leases.heartbeat(worker.token, claim);
  expect(renewed.instruction).toBe("continue");
  expect(renewed.localStopSeconds).toBeGreaterThan(0);
  expect(renewed.localStopSeconds).toBeLessThanOrEqual(8);
});

it("recovers a lost claim after lease expiry without renewing execution authority", async () => {
  await runtime.execution.runs.create(owner, randomUUID(), input);
  const claimId = randomUUID();
  const claim = (await runtime.execution.leases.claim(worker.token, claimId))
    .claim!;
  await database.engine.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claim.attemptId],
  );
  expect(
    (await runtime.execution.leases.claim(worker.token, claimId)).claim,
  ).toBeNull();
  const recovery = await runtime.execution.leases.recover(
    worker.token,
    claimId,
  );
  expect(recovery.workerId).toBe(worker.id);
  expect(recovery.recovery?.grant).toMatchObject({
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
  });
  expect(recovery.recovery?.state).toBe("reconciling");
  expect(recovery.recovery?.attemptState).toBe("suspect");
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("stop");
  await runtime.execution.leases.finish(worker.token, result(claim, "failed"));
  expect(
    (await runtime.execution.leases.recover(worker.token, claimId)).recovery,
  ).toMatchObject({ attemptState: "stopped", state: "failed" });
});

it("limits recovery to the enrolled worker while allowing revoked workers to report stopping", async () => {
  await runtime.execution.runs.create(owner, randomUUID(), input);
  const claimId = randomUUID();
  const claim = (await runtime.execution.leases.claim(worker.token, claimId))
    .claim!;
  const other = await runtime.execution.workers.register(
    owner,
    profileId,
    "Other runner",
  );
  expect(
    (await runtime.execution.leases.recover(other.token, claimId)).recovery,
  ).toBeNull();
  await runtime.execution.workers.revoke(owner, randomUUID(), worker.id);
  const recovery = await runtime.execution.leases.recover(
    worker.token,
    claimId,
  );
  expect(recovery.enabled).toBe(false);
  expect(recovery.recovery?.grant.attemptId).toBe(claim.attemptId);
  expect(JSON.stringify(recovery)).not.toContain(claim.manifest.objective);
  expect(JSON.stringify(recovery)).not.toContain(
    claim.manifest.profile.repository,
  );
  expect(
    (
      await runtime.execution.leases.finish(
        worker.token,
        result(claim, "failed"),
      )
    ).accepted,
  ).toBe(true);
});

it("reports queue availability without claiming work or bypassing worker occupancy", async () => {
  expect(await runtime.execution.leases.available(worker.token)).toMatchObject({
    workerId: worker.id,
    enabled: true,
    available: false,
  });
  await runtime.execution.runs.create(owner, randomUUID(), input);
  expect(
    (await runtime.execution.leases.available(worker.token)).available,
  ).toBe(true);
  expect(
    (await database.engine.query("SELECT id FROM cloud_run_attempts")).rows,
  ).toHaveLength(0);
  await runtime.execution.leases.claim(worker.token, randomUUID());
  expect(
    (await runtime.execution.leases.available(worker.token)).available,
  ).toBe(false);
  await runtime.execution.workers.revoke(owner, randomUUID(), worker.id);
  expect(await runtime.execution.leases.available(worker.token)).toMatchObject({
    enabled: false,
    available: false,
  });
});

it("rejects oversized task instructions before reserving execution", async () => {
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), {
      profileId,
      subject: {
        kind: "project",
        id: projectId,
        revision: 1,
        purpose: "test",
        objective: "€".repeat(20000),
        acceptanceCriteria: "€".repeat(20000),
      },
    }),
  ).rejects.toMatchObject({ code: "task_instructions_limit" });
  expect(
    (await database.engine.query("SELECT id FROM cloud_runs")).rows,
  ).toHaveLength(0);
});

it("checks prerequisites at admission and preserves the accepted snapshot across planning changes", async () => {
  const blocker = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, projectId, title: "Prerequisite" }),
  );
  const link = await runtime.relations.add(
    owner,
    randomUUID(),
    input.subject.id,
    {
      kind: "blocked_by",
      targetId: blocker.id,
      sourceRevision: 1,
      targetRevision: 1,
    },
  );
  for (const state of ["backlog", "canceled"] as const) {
    const issue = await runtime.planning.getIssue(owner, blocker.id);
    await runtime.planning.updateIssue(
      owner,
      randomUUID(),
      blocker.id,
      issueUpdateSchema.strip().parse({
        ...issue,
        status: await testStatusReference(database, owner, teamId, state),
        archived: state === "canceled",
      }),
    );
    await expect(
      runtime.execution.runs.create(member, randomUUID(), input),
    ).rejects.toMatchObject({ code: "issue_dependencies" });
  }
  const issue = await runtime.planning.getIssue(owner, blocker.id);
  await runtime.planning.updateIssue(
    owner,
    randomUUID(),
    blocker.id,
    issueUpdateSchema.strip().parse({
      ...issue,
      status: await testStatusReference(database, owner, teamId, "complete"),
    }),
  );
  const key = randomUUID();
  const run = await runtime.execution.runs.create(member, key, input);
  const initial = await runtime.execution.runs.get(owner, run.id);
  expect(initial.contextChanged).toBe(false);
  expect(initial).not.toHaveProperty("planningDigest");
  expect(JSON.stringify(initial)).not.toContain(blocker.id);
  await runtime.relations.remove(
    owner,
    randomUUID(),
    input.subject.id,
    link.id,
  );
  expect(await runtime.execution.runs.create(member, key, input)).toEqual(run);
  const changed = await runtime.execution.runs.get(member, run.id);
  expect(changed.contextChanged).toBe(true);
  expect(changed.manifest).toEqual(initial.manifest);
  expect(changed.inputDigest).toBe(initial.inputDigest);
  expect(changed.state).toBe("queued");
});

it("keeps completed dependency revisions stale after reopening and completing again", async () => {
  const blocker = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      title: "Done prerequisite",
      status: await testStatusReference(database, owner, teamId, "complete"),
    }),
  );
  await runtime.relations.add(owner, randomUUID(), input.subject.id, {
    kind: "blocked_by",
    targetId: blocker.id,
    sourceRevision: 1,
    targetRevision: 1,
  });
  const claim = await accepted();
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).contextChanged,
  ).toBe(false);
  for (const state of ["active", "complete"] as const) {
    const issue = await runtime.planning.getIssue(owner, blocker.id);
    await runtime.planning.updateIssue(
      owner,
      randomUUID(),
      blocker.id,
      issueUpdateSchema.strip().parse({
        ...issue,
        status: await testStatusReference(database, owner, teamId, state),
      }),
    );
    expect(
      (await runtime.execution.runs.get(owner, claim.runId)).contextChanged,
    ).toBe(true);
    expect(
      (await runtime.execution.leases.heartbeat(worker.token, claim))
        .instruction,
    ).toBe("continue");
  }
});

it("blocks new publication after planning changes but reconciles already reserved effects", async () => {
  const claim = await accepted();
  await runtime.execution.leases.progress(worker.token, {
    ...claim,
    state: "validating",
  });
  const effectId = randomUUID(),
    resource = "https://github.com/example/project#branch/context";
  expect(
    (
      await runtime.execution.effects.reserve(
        worker.token,
        claim,
        effectId,
        resource,
        "d".repeat(64),
      )
    ).action,
  ).toBe("dispatch");
  await runtime.execution.effects.resolve(
    owner.organizationId,
    effectId,
    "unknown",
    { request: "sent" },
  );
  const issue = await runtime.planning.getIssue(owner, input.subject.id);
  await runtime.planning.updateIssue(
    owner,
    randomUUID(),
    issue.id,
    issueUpdateSchema
      .strip()
      .parse({ ...issue, acceptanceCriteria: "New criterion" }),
  );
  await expect(
    runtime.execution.effects.reserve(
      worker.token,
      claim,
      randomUUID(),
      resource + "2",
      "d".repeat(64),
    ),
  ).rejects.toMatchObject({ code: "planning_changed" });
  expect(
    (
      await runtime.execution.effects.reserve(
        worker.token,
        claim,
        effectId,
        resource,
        "d".repeat(64),
      )
    ).action,
  ).toBe("reconcile");
  await runtime.execution.effects.resolve(
    owner.organizationId,
    effectId,
    "succeeded",
    { pullRequest: 17 },
  );
  expect(
    (
      await runtime.execution.effects.reserve(
        worker.token,
        claim,
        effectId,
        resource,
        "d".repeat(64),
      )
    ).action,
  ).toBe("settled");
});

it("does not forget a planning edit that was reversed while a task was running", async () => {
  const claim = await accepted();
  const other = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Related" }),
  );
  const edge = await runtime.relations.add(
    owner,
    randomUUID(),
    input.subject.id,
    {
      kind: "related",
      targetId: other.id,
      sourceRevision: 1,
      targetRevision: 1,
    },
  );
  await runtime.relations.remove(
    owner,
    randomUUID(),
    input.subject.id,
    edge.id,
  );
  expect(await runtime.relations.list(owner, input.subject.id)).toEqual([]);
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).contextChanged,
  ).toBe(true);
});

it("workflow recategorization changes planning without rewriting accepted work or bypassing dependency checks", async () => {
  const blocker = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      title: "Dependency",
      status: await testStatusReference(database, owner, teamId, "complete"),
    }),
  );
  await runtime.relations.add(owner, randomUUID(), input.subject.id, {
    kind: "blocked_by",
    targetId: blocker.id,
    sourceRevision: 1,
    targetRevision: 1,
  });
  const claim = await accepted();
  const before = await runtime.execution.runs.get(owner, claim.runId);
  const workflow = await runtime.workflows.get(owner, teamId);
  const definition = {
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: workflow.statuses.map(({ revision: _, ...status }) => ({
      ...status,
      category:
        status.category === "complete" ? ("ready" as const) : status.category,
    })),
  };
  const impact = await runtime.workflows.preview(owner, teamId, definition);
  expect(impact).toMatchObject({ changedIssues: 1, changedTasks: 1 });
  await runtime.workflows.update(owner, randomUUID(), teamId, {
    definition,
    impactDigest: impact.digest,
  });
  const after = await runtime.execution.runs.get(owner, claim.runId);
  expect(after.contextChanged).toBe(true);
  expect(after.manifest).toEqual(before.manifest);
  expect(after.inputDigest).toBe(before.inputDigest);
  expect(
    (await runtime.execution.leases.heartbeat(worker.token, claim)).instruction,
  ).toBe("continue");
  await runtime.execution.leases.progress(worker.token, {
    ...claim,
    state: "validating",
  });
  await expect(
    runtime.execution.effects.reserve(
      worker.token,
      claim,
      randomUUID(),
      "https://github.com/example/project#workflow",
      "a".repeat(64),
    ),
  ).rejects.toMatchObject({ code: "planning_changed" });
  const other = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      projectId,
      title: "Next task",
      acceptanceCriteria: "Verified",
    }),
  );
  const currentBlocker = await runtime.planning.getIssue(owner, blocker.id);
  await runtime.relations.add(owner, randomUUID(), other.id, {
    kind: "blocked_by",
    targetId: blocker.id,
    sourceRevision: 1,
    targetRevision: currentBlocker.revision,
  });
  await expect(
    runtime.execution.runs.create(owner, randomUUID(), {
      profileId,
      subject: { kind: "issue", id: other.id, revision: 1 },
    }),
  ).rejects.toMatchObject({ code: "issue_dependencies" });
});
