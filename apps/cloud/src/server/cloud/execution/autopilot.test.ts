import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type {
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { ReviewVerdict } from "@machdoch/fleet-protocol/cloud-delivery";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { FakeGitServer, githubApiUrl, sha } from "../git/test-git-server";
import { storeTestArtifact, verificationFixture } from "./test-artifacts";
import type { CandidatePush } from "./candidate-push";

const cipher = new SettingsCipher(randomBytes(32));
const token = `github_pat_${"o".repeat(40)}`;
const base = sha(100);
const candidate = sha(200);
const patch = `diff --git a/locales/de.json b/locales/de.json
index 1111111..2222222 100644
--- a/locales/de.json
+++ b/locales/de.json
@@ -1,3 +1,3 @@
 {
-  "greeting": "Hallo"
+  "greeting": "Guten Tag"
 }
`;
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let teamId: string;
let projectId: string;
let profileId: string;
let pushes: CandidatePush[];

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  server = new FakeGitServer();
  server.logins.set(token, "acme-bot");
  pushes = [];
  owner = { userId: randomUUID(), organizationId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [owner.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [owner.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [owner.organizationId, owner.userId],
  );
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: cipher,
    gitFetch: server.transport,
    candidatePush: async (push) => {
      pushes.push(push);
      server.branches.set(push.branch, push.candidateCommit);
    },
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Platform",
      key: "PLAT",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  await runtime.git.connections.connect(owner, randomUUID(), "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token,
    automate: false,
  });
  await runtime.git.connections.addRepository(owner, "github", "acme/app");
  projectId = (
    await runtime.projects.create(owner, randomUUID(), {
      teamId,
      name: "App",
      description: "",
    })
  ).id;
  const provider = await runtime.aiProviders.create(owner, randomUUID(), {
    name: "Provider",
    provider: "openai",
    region: null,
    models: ["fixture"],
    apiKey: "fixture-key",
    maxOutputTokens: 256,
    dailyTokenBudget: 1_000_000,
    maxConcurrentRequests: 2,
  });
  profileId = (
    await runtime.execution.profiles.create(owner, randomUUID(), {
      projectId,
      name: "App",
      target: "cloud",
      repository: "https://github.test/acme/app",
      autopilot: true,
      checkPullRequests: false,
      providerId: provider.id,
      model: "fixture",
      maxDurationSeconds: 600,
      maxTokens: 200_000,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    })
  ).id;
});

async function aiIssue(title: string) {
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId,
      projectId,
      title,
      acceptanceCriteria: "The German greeting reads Guten Tag.",
      aiAssigned: true,
    }),
  );
  return issue;
}

async function claimTask(): Promise<{ claim: WorkerClaim; worker: string }> {
  const worker = await runtime.execution.workers.register(
    owner,
    profileId,
    "Runner",
  );
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  if (!claim) throw new Error("Expected a queued task");
  await runtime.execution.leases.accept(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit: base,
    isolation: "microvm",
  });
  await runtime.execution.leases.progress(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    state: "validating",
  });
  for (const [kind, bytes, name] of [
    ["candidate", Buffer.from("bundle"), "candidate.bundle"],
    ["diff", Buffer.from(patch), "changes.patch"],
    [
      "verification",
      Buffer.from(JSON.stringify(verificationFixture(candidate))),
      "check-1.json",
    ],
  ] as const)
    await storeTestArtifact(
      runtime,
      worker.token,
      claim,
      kind,
      bytes,
      candidate,
      name,
    );
  return { claim, worker: worker.token };
}

async function review(
  worker: string,
  claim: WorkerClaim,
  round: number,
  verdict: ReviewVerdict,
) {
  const request = {
    requestId: randomUUID(),
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    candidateCommit: candidate,
    round,
  };
  await runtime.execution.reviews.submit(worker, request);
  const call = (
    await database.engine.query<{ system_prompt: string; user_prompt: string }>(
      "SELECT system_prompt,user_prompt FROM cloud_inference_calls WHERE id=$1 AND purpose='review'",
      [request.requestId],
    )
  ).rows[0]!;
  expect(call.system_prompt).toContain("independent code reviewer");
  expect(call.user_prompt).toContain("Guten Tag");
  await database.engine.query(
    "UPDATE cloud_inference_calls SET state='complete',response=$2,actual_tokens=120 WHERE id=$1",
    [
      request.requestId,
      JSON.stringify({ text: JSON.stringify(verdict), toolCalls: [] }),
    ],
  );
  return runtime.execution.reviews.result(worker, request);
}

function finish(claim: WorkerClaim): WorkerFinish {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: "succeeded",
    stopped: true,
    summary: "## What changed\nThe greeting now reads Guten Tag.",
    candidateCommit: candidate,
    tokensUsed: 300,
    checks: [
      {
        name: "unit",
        passed: true,
        candidateCommit: candidate,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(verificationFixture(candidate)))
          .digest("hex"),
      },
    ],
  };
}

async function deliver() {
  for (let round = 0; round < 10; round++) {
    await database.engine.query(
      "UPDATE cloud_run_deliveries SET next_attempt_at=clock_timestamp()",
    );
    if (!(await runtime.autopilot.deliveries.tick())) return;
  }
}

it("takes an issue assigned to AI through review, pull request and merge", async () => {
  const issue = await aiIssue("Use a formal German greeting");
  expect(await runtime.autopilot.autopilot.tick()).toBe(1);
  expect((await runtime.planning.getIssue(owner, issue.id)).state).toBe(
    "active",
  );
  const { claim, worker } = await claimTask();
  expect(claim.baseCommit).toBeNull();
  expect(claim.manifest.branch).toBe("main");

  const first = await review(worker, claim, 1, {
    decision: "request_changes",
    summary: "The English text changed too.",
    findings: [
      {
        severity: "blocking",
        file: "locales/de.json",
        line: 2,
        title: "Keep the key",
        detail: "Only change the value.",
      },
    ],
  });
  expect(first.review).toMatchObject({
    decision: "request_changes",
    gatesPassed: true,
  });
  const second = await review(worker, claim, 2, {
    decision: "approve",
    summary: "Only the German value changed.",
    findings: [],
  });
  expect(second.review?.decision).toBe("approve");
  await expect(
    review(worker, claim, 2, {
      decision: "approve",
      summary: "Again",
      findings: [],
    }),
  ).rejects.toMatchObject({ code: "review_rounds" });

  await runtime.execution.leases.finish(worker, finish(claim));
  const run = await runtime.execution.runs.get(owner, claim.runId);
  expect(run).toMatchObject({ state: "succeeded", baseCommit: base });
  expect(run.reviews.map((entry) => entry.decision)).toEqual([
    "request_changes",
    "approve",
  ]);
  expect(run.changes).toEqual([
    expect.objectContaining({
      path: "locales/de.json",
      additions: 1,
      deletions: 1,
    }),
  ]);

  await deliver();
  expect(pushes).toEqual([
    expect.objectContaining({
      baseCommit: base,
      candidateCommit: candidate,
      remote: "https://github.test/acme/app.git",
    }),
  ]);
  const pullRequest = server.github.get(1)!;
  expect(pullRequest).toMatchObject({ state: "merged", baseRef: "main" });
  expect(pullRequest.title).toBe("PLAT-1 Use a formal German greeting");
  expect(pullRequest.body).toContain("Closes PLAT-1");
  expect(pullRequest.body).toContain("approved in round 2");
  expect(server.branches.has(pullRequest.headRef)).toBe(false);
  const delivered = await runtime.execution.runs.get(owner, claim.runId);
  expect(delivered.delivery).toMatchObject({
    state: "merged",
    autoMerge: true,
    pullRequestNumber: 1,
  });
  expect((await runtime.planning.getIssue(owner, issue.id)).state).toBe(
    "complete",
  );
  const diff = await runtime.execution.runs.changes(owner, claim.runId);
  expect(diff.files[0]!.hunks[0]!.lines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "addition", newLine: 2 }),
    ]),
  );
}, 60_000);

it("leaves weakened tests and sensitive areas for a person", async () => {
  const issue = await aiIssue("Speed up the suite");
  await runtime.autopilot.autopilot.tick();
  const { claim, worker } = await claimTask();
  await database.engine.query(
    "UPDATE cloud_artifact_chunks SET bytes=$1 WHERE artifact_id=(SELECT id FROM cloud_run_artifacts WHERE run_id=$2 AND kind='diff')",
    [
      Buffer.from(`diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts
--- a/src/auth/session.test.ts
+++ b/src/auth/session.test.ts
@@ -1,1 +1,1 @@
-it("expires sessions", () => {});
+it.skip("expires sessions", () => {});
`),
      claim.runId,
    ],
  );
  const result = await review(worker, claim, 1, {
    decision: "approve",
    summary: "Looks fine.",
    findings: [],
  });
  expect(result.review).toMatchObject({
    decision: "request_changes",
    gatesPassed: false,
  });
  expect(result.review!.findings[0]!.title).toBe("Restore the tests");
  for (let round = 2; round <= 3; round++)
    await review(worker, claim, round, {
      decision: "approve",
      summary: "Looks fine.",
      findings: [],
    });
  await runtime.execution.leases.finish(worker, finish(claim));
  await deliver();
  const run = await runtime.execution.runs.get(owner, claim.runId);
  expect(run.delivery).toMatchObject({ state: "open", autoMerge: false });
  expect(run.reviews.at(-1)!.gates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "tests_intact", passed: false }),
      expect.objectContaining({ id: "protected_paths", passed: false }),
    ]),
  );
  expect(server.github.get(1)!.state).toBe("open");
  expect((await runtime.planning.getIssue(owner, issue.id)).state).toBe(
    "review",
  );

  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issue.id }],
    changes: { statusCategory: "canceled" },
  });
  await deliver();
  expect(server.github.get(1)!.state).toBe("closed");
  expect(
    server.callsTo(/\/git\/refs\/heads\/machdoch\//u, "DELETE"),
  ).toHaveLength(1);
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).delivery?.state,
  ).toBe("closed");
}, 60_000);

it("starts only issues assigned to AI and keeps one assignee", async () => {
  const manual = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, projectId, title: "Manual work" }),
  );
  const assigned = await aiIssue("Translate the greeting");
  expect(await runtime.autopilot.autopilot.tick()).toBe(1);
  expect(await runtime.execution.runs.list(owner, manual.id)).toHaveLength(0);
  expect(await runtime.execution.runs.list(owner, assigned.id)).toHaveLength(1);
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: assigned.id }],
    changes: { assigneeId: owner.userId },
  });
  expect(await runtime.planning.getIssue(owner, assigned.id)).toMatchObject({
    assigneeId: owner.userId,
    aiAssigned: false,
  });
  await expect(
    runtime.planning.createIssue(
      owner,
      randomUUID(),
      issueInputSchema.parse({
        teamId,
        title: "Without a project",
        aiAssigned: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "ai_unavailable" });
}, 60_000);

it("checks new pull requests in a sandbox and comments the verdict", async () => {
  const head = sha(70);
  server.add(server.github, 7, {
    title: "Add login form",
    headRef: "feature/login",
    headSha: head,
  });
  server.pullFiles.set(7, [
    {
      filename: "src/login.tsx",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch:
        "@@ -1,1 +1,1 @@\n-<button>Login</button>\n+<button disabled>Login</button>",
    },
  ]);
  await runtime.git.connections.requestSync(owner, "github");
  for (let round = 0; round < 50 && (await runtime.git.sync.tick()); round++);
  const [profile] = await runtime.execution.profiles.list(owner);
  if (!profile || profile.target === "client") throw new Error("Profile");
  const {
    id: _,
    teamId: __,
    projectId: ___,
    revision,
    ...definition
  } = profile;
  await runtime.execution.profiles.update(owner, randomUUID(), profile.id, {
    ...definition,
    revision,
    checkPullRequests: true,
  });

  expect(await runtime.autopilot.autopilot.tick()).toBe(1);
  expect(await runtime.autopilot.autopilot.tick()).toBe(0);
  const worker = await runtime.execution.workers.register(
    owner,
    profile.id,
    "Runner",
  );
  const { claim } = await runtime.execution.leases.claim(
    worker.token,
    randomUUID(),
  );
  if (!claim) throw new Error("Expected a pull request check");
  expect(claim.manifest.subject).toMatchObject({
    kind: "pull_request",
    purpose: "check",
    headSha: head,
  });
  expect(claim.manifest.title).toBe("Check acme/app#7 Add login form");
  expect(claim.baseCommit).toBe(head);
  const identity = {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
  };
  await runtime.execution.leases.accept(worker.token, {
    ...identity,
    environmentId: randomUUID(),
    baseCommit: head,
    isolation: "microvm",
  });
  await runtime.execution.leases.progress(worker.token, {
    ...identity,
    state: "validating",
  });
  const failing = verificationFixture(head, {
    exitCode: 1,
    stdout: "1 test failed",
  });
  await storeTestArtifact(
    runtime,
    worker.token,
    claim,
    "verification",
    Buffer.from(JSON.stringify(failing)),
    head,
    "check-1.json",
  );
  const request = {
    requestId: randomUUID(),
    ...identity,
    candidateCommit: head,
    round: 1,
  };
  await runtime.execution.reviews.submit(worker.token, request);
  const prompt = (
    await database.engine.query<{ user_prompt: string; system_prompt: string }>(
      "SELECT user_prompt,system_prompt FROM cloud_inference_calls WHERE id=$1",
      [request.requestId],
    )
  ).rows[0]!;
  expect(prompt.system_prompt).toContain("Someone opened the pull request");
  expect(prompt.user_prompt).toContain("<button disabled>Login</button>");
  await database.engine.query(
    "UPDATE cloud_inference_calls SET state='complete',response=$2,actual_tokens=50 WHERE id=$1",
    [
      request.requestId,
      JSON.stringify({
        text: JSON.stringify({
          decision: "request_changes",
          summary: "The login button can no longer be clicked.",
          findings: [
            {
              severity: "blocking",
              file: "src/login.tsx",
              line: 1,
              title: "Login is disabled",
              detail: "Remove the disabled attribute.",
            },
          ],
        }),
        toolCalls: [],
      }),
    ],
  );
  await runtime.execution.reviews.result(worker.token, request);
  await runtime.execution.leases.finish(worker.token, {
    ...identity,
    inputDigest: claim.inputDigest,
    outcome: "succeeded",
    stopped: true,
    summary: "## Verdict\nNot ready.\n\n## Problems\n- Login is disabled.",
    candidateCommit: head,
    tokensUsed: 100,
    checks: [
      {
        name: "unit",
        passed: false,
        candidateCommit: head,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(failing))
          .digest("hex"),
      },
    ],
  });
  await deliver();
  const run = await runtime.execution.runs.get(owner, claim.runId);
  expect(run.delivery).toMatchObject({
    kind: "check",
    state: "reported",
    pullRequestNumber: 7,
    reason: "2 problems found.",
  });
  const review = server.callsTo("/repos/acme/app/pulls/7/reviews", "POST")[0]!;
  expect(review.body).toMatchObject({ event: "COMMENT" });
  expect(JSON.stringify(review.body)).toContain("2 problems found");
  expect(JSON.stringify(review.body)).toContain("Login is disabled");
  expect(
    (await runtime.execution.runs.changes(owner, claim.runId)).files.map(
      (file) => file.path,
    ),
  ).toEqual(["src/login.tsx"]);
  expect(await runtime.autopilot.autopilot.tick()).toBe(0);
}, 60_000);
