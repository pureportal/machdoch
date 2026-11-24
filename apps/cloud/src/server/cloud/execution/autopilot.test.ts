import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type {
  PullRequestTask,
  RunManifest,
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import { automationInputSchema } from "../../../lib/cloud-automation-contract";
import type { GitEventKind } from "../../../lib/git-events";
import { sandboxStatusContext } from "./pull-request-tasks";
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
let connectionId: string;
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
      for (const change of server.github.values())
        if (change.headRef === push.branch)
          server.update(change, {
            headSha: push.candidateCommit,
            mergeable: true,
          });
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
  ({ id: connectionId } = await runtime.git.connections.connect(
    owner,
    randomUUID(),
    "github",
    {
      revision: 0,
      apiUrl: githubApiUrl,
      token,
      automate: false,
      codeAccess: true,
    },
  ));
  await runtime.git.connections.addRepository(owner, connectionId, "acme/app");
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
      acceptanceCriteria: "- [ ] The German greeting reads Guten Tag.",
      aiAssigned: true,
    }),
  );
  return issue;
}

async function claimTask(
  commits: { base: string; candidate: string } = { base, candidate },
  checkPassed = true,
): Promise<{ claim: WorkerClaim; worker: string }> {
  const worker = await runtime.execution.workers.register(
    owner,
    profileId,
    `Runner ${randomUUID().slice(0, 8)}`,
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
    baseCommit: commits.base,
    isolation: "microvm",
  });
  await runtime.execution.leases.progress(worker.token, {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    state: "validating",
  });
  const evidence = verificationFixture(
    commits.candidate,
    checkPassed ? {} : { exitCode: 1, stdout: "1 test failed" },
  );
  for (const [kind, bytes, name] of [
    ["candidate", Buffer.from("bundle"), "candidate.bundle"],
    ["diff", Buffer.from(patch), "changes.patch"],
    ["verification", Buffer.from(JSON.stringify(evidence)), "check-1.json"],
  ] as const)
    await storeTestArtifact(
      runtime,
      worker.token,
      claim,
      kind,
      bytes,
      commits.candidate,
      name,
    );
  return { claim, worker: worker.token };
}

async function review(
  worker: string,
  claim: WorkerClaim,
  round: number,
  verdict: ReviewVerdict,
  candidateCommit = candidate,
) {
  const request = {
    requestId: randomUUID(),
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    candidateCommit,
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

function finish(
  claim: WorkerClaim,
  candidateCommit = candidate,
  checkPassed = true,
): WorkerFinish {
  const evidence = verificationFixture(
    candidateCommit,
    checkPassed ? {} : { exitCode: 1, stdout: "1 test failed" },
  );
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: "succeeded",
    stopped: true,
    summary: checkPassed
      ? "## What changed\nThe greeting now reads Guten Tag."
      : "## Verdict\nNot ready.\n\n## Problems\n- The unit test fails.",
    candidateCommit,
    tokensUsed: 300,
    checks: [
      {
        name: "unit",
        passed: checkPassed,
        candidateCommit,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(evidence))
          .digest("hex"),
      },
    ],
  };
}

async function automate(events: GitEventKind[], task: PullRequestTask) {
  return runtime.automations.service.create(
    owner,
    randomUUID(),
    automationInputSchema.parse({
      name: `${task} automation`,
      teamId,
      trigger: { kind: "git_event", events },
      actions: [
        {
          kind: "delegate",
          profileId,
          task,
          instructions:
            task === "fix" ? "Fix these problems:\n\n{{check.report}}" : "",
        },
      ],
    }),
  );
}

async function sandboxAutomations() {
  return {
    check: await automate(
      ["pull_request_opened", "pull_request_updated"],
      "check",
    ),
    fix: await automate(["sandbox_check_failed"], "fix"),
  };
}

async function sync() {
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50 && (await runtime.git.sync.tick()); round++);
}

async function dispatch() {
  for (
    let round = 0;
    round < 20 && (await runtime.automations.dispatcher.tick());
    round++
  );
}

function sandboxStatus(commit: string) {
  return server.statuses
    .get(commit)
    ?.find((status) => status.context === sandboxStatusContext);
}

async function pullRequestRuns(purpose: PullRequestTask) {
  return (
    await database.engine.query<{ id: string; manifest: RunManifest }>(
      `SELECT id,manifest FROM cloud_runs WHERE organization_id=$1 AND manifest->'subject'->>'purpose'=$2 ORDER BY created_at`,
      [owner.organizationId, purpose],
    )
  ).rows;
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
  expect(await runtime.planning.getIssue(owner, issue.id)).toMatchObject({
    state: "complete",
    acceptanceCriteria: "- [x] The German greeting reads Guten Tag.",
  });
  expect((await runtime.planning.history(owner, issue.id))[0]).toMatchObject({
    actor: "Machdoch AI",
    automated: true,
  });
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

it("checks pull requests in a sandbox when an automation asks for it", async () => {
  const head = sha(70);
  const automations = await sandboxAutomations();
  await sync();
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
  await sync();
  expect(await runtime.autopilot.autopilot.tick()).toBe(0);
  await dispatch();
  const [checkRun] = await runtime.automations.service.runs(owner, {
    automationId: automations.check.id,
  });
  expect(checkRun).toMatchObject({ state: "succeeded", error: null });
  expect(sandboxStatus(head)).toMatchObject({
    state: "pending",
    description: "Checking in a sandbox",
  });
  const worker = await runtime.execution.workers.register(
    owner,
    profileId,
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
    problems: 2,
  });
  const review = server.callsTo("/repos/acme/app/pulls/7/reviews", "POST")[0]!;
  expect(review.body).toMatchObject({ event: "COMMENT" });
  expect(JSON.stringify(review.body)).toContain("2 problems found");
  expect(JSON.stringify(review.body)).toContain("Login is disabled");
  expect(sandboxStatus(head)).toMatchObject({
    state: "failure",
    description: "2 problems found",
  });
  expect(
    (await runtime.execution.runs.changes(owner, claim.runId)).files.map(
      (file) => file.path,
    ),
  ).toEqual(["src/login.tsx"]);

  await dispatch();
  const [fixRun] = await runtime.automations.service.runs(owner, {
    automationId: automations.fix.id,
  });
  expect(fixRun).toMatchObject({
    state: "succeeded",
    trigger: "sandbox_check_failed",
  });
  expect(fixRun!.steps[0]!.detail).toBe("AI task started on #7");
  const [fix] = await pullRequestRuns("fix");
  expect(fix!.manifest.subject).toMatchObject({
    kind: "pull_request",
    purpose: "fix",
    headSha: head,
  });
  expect(fix!.manifest.objective).toContain("Fix these problems:");
  expect(fix!.manifest.objective).toContain("Login is disabled");
  expect(fix!.manifest.objective).toContain("❌ unit");
}, 60_000);

it("fixes what the sandbox check finds on its own pull request before merging", async () => {
  await sandboxAutomations();
  const fixed = sha(300);
  const issue = await aiIssue("Use a formal German greeting");
  expect(await runtime.autopilot.autopilot.tick()).toBe(1);
  const change = await claimTask();
  await review(change.worker, change.claim, 1, {
    decision: "approve",
    summary: "Only the German value changed.",
    findings: [],
  });
  await runtime.execution.leases.finish(change.worker, finish(change.claim));
  await deliver();
  const pullRequest = server.github.get(1)!;
  expect(pullRequest).toMatchObject({ state: "open", headSha: candidate });
  server.pullFiles.set(1, [
    {
      filename: "locales/de.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: `@@ -2,1 +2,1 @@\n-  "greeting": "Hallo"\n+  "greeting": "Guten Tag"`,
    },
  ]);
  expect(
    (await runtime.execution.runs.get(owner, change.claim.runId)).delivery,
  ).toMatchObject({
    state: "merging",
    autoMerge: true,
    pullRequestNumber: 1,
    reason: "Waiting for automations.",
  });

  await dispatch();
  expect(sandboxStatus(candidate)).toMatchObject({ state: "pending" });
  await deliver();
  expect(
    (await runtime.execution.runs.get(owner, change.claim.runId)).delivery,
  ).toMatchObject({
    state: "merging",
    reason: "Waiting for repository checks.",
  });
  const check = await claimTask({ base: candidate, candidate }, false);
  expect(check.claim.manifest.subject).toMatchObject({
    kind: "pull_request",
    purpose: "check",
    headSha: candidate,
  });
  await review(check.worker, check.claim, 1, {
    decision: "request_changes",
    summary: "The unit test fails.",
    findings: [
      {
        severity: "blocking",
        file: "locales/de.json",
        line: 2,
        title: "Broken JSON",
        detail: "Add the missing comma.",
      },
    ],
  });
  await runtime.execution.leases.finish(
    check.worker,
    finish(check.claim, candidate, false),
  );
  await deliver();
  expect(
    (await runtime.execution.runs.get(owner, check.claim.runId)).delivery,
  ).toMatchObject({ kind: "check", state: "reported", problems: 2 });
  expect(sandboxStatus(candidate)).toMatchObject({ state: "failure" });
  expect(
    (await runtime.execution.runs.get(owner, change.claim.runId)).delivery,
  ).toMatchObject({ state: "merging", reason: "Waiting for automations." });
  expect(pullRequest.state).toBe("open");

  await dispatch();
  await deliver();
  expect(
    (await runtime.execution.runs.get(owner, change.claim.runId)).delivery,
  ).toMatchObject({ state: "merging", reason: "Waiting for the fix task." });
  const fix = await claimTask({ base: candidate, candidate: fixed });
  expect(fix.claim.manifest.subject).toMatchObject({
    kind: "pull_request",
    purpose: "fix",
    headSha: candidate,
  });
  expect(fix.claim.manifest.objective).toContain("Broken JSON");
  expect(fix.claim.manifest.objective).toContain("❌ unit");
  await review(
    fix.worker,
    fix.claim,
    1,
    { decision: "approve", summary: "The comma is back.", findings: [] },
    fixed,
  );
  await runtime.execution.leases.finish(fix.worker, finish(fix.claim, fixed));
  await deliver();
  expect(pushes.at(-1)).toMatchObject({
    branch: pullRequest.headRef,
    baseCommit: candidate,
    candidateCommit: fixed,
  });
  expect(pullRequest).toMatchObject({ state: "open", headSha: fixed });
  expect(
    server.callsTo("/repos/acme/app/issues/1/comments", "POST"),
  ).toHaveLength(1);
  expect(
    (await runtime.execution.runs.get(owner, change.claim.runId)).delivery,
  ).toMatchObject({
    state: "closed",
    reason: "A newer task replaced this change.",
  });
  expect(
    (await runtime.execution.runs.get(owner, fix.claim.runId)).delivery,
  ).toMatchObject({
    state: "merging",
    pullRequestNumber: 1,
    reason: "Waiting for automations.",
  });
  expect((await runtime.planning.getIssue(owner, issue.id)).state).toBe(
    "review",
  );

  await dispatch();
  expect(sandboxStatus(fixed)).toMatchObject({ state: "pending" });
  const recheck = await claimTask({ base: fixed, candidate: fixed });
  expect(recheck.claim.manifest.subject).toMatchObject({
    purpose: "check",
    headSha: fixed,
  });
  await review(
    recheck.worker,
    recheck.claim,
    1,
    { decision: "approve", summary: "Clean.", findings: [] },
    fixed,
  );
  await runtime.execution.leases.finish(
    recheck.worker,
    finish(recheck.claim, fixed),
  );
  await deliver();
  expect(sandboxStatus(fixed)).toMatchObject({
    state: "success",
    description: "No problems found",
  });
  await dispatch();
  await deliver();
  expect(pullRequest.state).toBe("merged");
  expect(server.branches.has(pullRequest.headRef)).toBe(false);
  expect(
    (await runtime.execution.runs.get(owner, fix.claim.runId)).delivery,
  ).toMatchObject({ state: "merged" });
  expect(await runtime.planning.getIssue(owner, issue.id)).toMatchObject({
    state: "complete",
    acceptanceCriteria: "- [x] The German greeting reads Guten Tag.",
  });
  expect(await runtime.autopilot.autopilot.tick()).toBe(0);
}, 60_000);

it("resolves merge conflicts in a sandbox that knows the base branch", async () => {
  const head = sha(80);
  const resolved = sha(81);
  await automate(["merge_conflict"], "resolve");
  await sync();
  server.branches.set("main", sha(90));
  const change = server.add(server.github, 8, {
    title: "Rename the greeting",
    headRef: "feature/greeting",
    headSha: head,
  });
  await sync();
  server.update(change, { mergeable: false });
  await sync();
  await dispatch();
  const { claim, worker } = await claimTask({
    base: head,
    candidate: resolved,
  });
  expect(claim.manifest.title).toBe(
    "Resolve conflicts in acme/app#8 Rename the greeting",
  );
  expect(claim.manifest.subject).toMatchObject({
    kind: "pull_request",
    purpose: "resolve",
    headSha: head,
    base: { ref: "main", sha: sha(90), mergeBase: sha(2) },
  });
  expect(claim.manifest.objective).toContain("Resolve every conflict");
  await review(
    worker,
    claim,
    1,
    { decision: "approve", summary: "Both sides kept.", findings: [] },
    resolved,
  );
  await runtime.execution.leases.finish(worker, finish(claim, resolved));
  await deliver();
  expect(pushes.at(-1)).toMatchObject({
    branch: "feature/greeting",
    baseCommit: head,
    mergeParent: sha(90),
    candidateCommit: resolved,
  });
  expect(change.headSha).toBe(resolved);
  const comment = server.callsTo("/repos/acme/app/issues/8/comments", "POST");
  expect(JSON.stringify(comment[0]!.body)).toContain(
    "Machdoch conflict resolution",
  );
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).delivery,
  ).toMatchObject({
    state: "merging",
    pullRequestNumber: 8,
    reason: "Waiting for automations.",
  });
  await dispatch();
  await deliver();
  expect(change.state).toBe("merged");
  expect(
    (await runtime.execution.runs.get(owner, claim.runId)).delivery,
  ).toMatchObject({ state: "merged" });
}, 60_000);

it("stops starting fix tasks after three rounds", async () => {
  const automations = await sandboxAutomations();
  await aiIssue("Use a formal German greeting");
  await runtime.autopilot.autopilot.tick();
  const change = await claimTask();
  await review(change.worker, change.claim, 1, {
    decision: "approve",
    summary: "Fine.",
    findings: [],
  });
  await runtime.execution.leases.finish(change.worker, finish(change.claim));
  await deliver();
  server.pullFiles.set(1, [
    {
      filename: "locales/de.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: `@@ -2,1 +2,1 @@\n-  "greeting": "Hallo"\n+  "greeting": "Guten Tag"`,
    },
  ]);
  let head = candidate;
  for (let round = 1; round <= 4; round++) {
    await dispatch();
    expect(sandboxStatus(head)).toMatchObject({ state: "pending" });
    const check = await claimTask({ base: head, candidate: head }, false);
    await review(
      check.worker,
      check.claim,
      1,
      { decision: "approve", summary: "Only the test fails.", findings: [] },
      head,
    );
    await runtime.execution.leases.finish(
      check.worker,
      finish(check.claim, head, false),
    );
    await deliver();
    await dispatch();
    await deliver();
    if (round === 4) break;
    const next = sha(300 + round);
    const fix = await claimTask({ base: head, candidate: next });
    await review(
      fix.worker,
      fix.claim,
      1,
      { decision: "approve", summary: "Tried.", findings: [] },
      next,
    );
    await runtime.execution.leases.finish(fix.worker, finish(fix.claim, next));
    await deliver();
    head = next;
  }
  expect(await pullRequestRuns("check")).toHaveLength(4);
  expect(await pullRequestRuns("fix")).toHaveLength(3);
  const fixRuns = await runtime.automations.service.runs(owner, {
    automationId: automations.fix.id,
  });
  expect(fixRuns).toHaveLength(4);
  expect(fixRuns[0]!.steps[0]).toMatchObject({
    state: "skipped",
    detail: "3 fix tasks already ran on #1.",
  });
  const [lastFix] = (await pullRequestRuns("fix")).slice(-1);
  expect(
    (await runtime.execution.runs.get(owner, lastFix!.id)).delivery,
  ).toMatchObject({
    state: "needs_person",
    reason: "Repository checks failed on the pull request.",
  });
  expect(server.github.get(1)!.state).toBe("open");
}, 60_000);
