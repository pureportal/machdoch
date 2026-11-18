import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { ReviewVerdict } from "@machdoch/fleet-protocol/cloud-delivery";
import type { WorkerClaim } from "@machdoch/fleet-protocol/cloud-execution";
import { createTestCloudDatabase } from "../src/server/cloud/test-database.ts";
import { FleetDatabase } from "../src/server/database.ts";
import { initializeInstallation } from "../src/server/cloud/installation-storage.ts";
import { cloudCredentialsCipher } from "../src/server/cloud/credential-storage.ts";
import {
  createCloudRuntime,
  getCloudRuntime,
  initializeCloudRuntime,
} from "../src/server/cloud/runtime.ts";
import {
  storeTestArtifact,
  verificationFixture,
} from "../src/server/cloud/execution/test-artifacts.ts";
import { startGitFixture } from "./cloud-git-fixture.mjs";
import { completeSecondFactor } from "./cloud-two-factor-fixture.mjs";
import { assertEventually, cloudApi } from "./cloud-browser-fixture.mjs";

const port = Number(process.env.PORT ?? 4321);
const origin = `http://localhost:${port}`;
const output = resolve(
  import.meta.dirname,
  "../../../.tmp/cloud-autopilot-verification",
);
const base = "1".repeat(40);
const patches = {
  merged: `diff --git a/locales/de.json b/locales/de.json
index 1111111..2222222 100644
--- a/locales/de.json
+++ b/locales/de.json
@@ -1,5 +1,5 @@
 {
-  "greeting": "Hallo",
+  "greeting": "Guten Tag",
   "farewell": "Tschüss",
   "reconnect": "Verbindung wird wiederhergestellt"
 }
diff --git a/src/session/reconnect.ts b/src/session/reconnect.ts
index 3333333..4444444 100644
--- a/src/session/reconnect.ts
+++ b/src/session/reconnect.ts
@@ -12,7 +12,10 @@ export function reconnect(socket: Socket) {
   const delays = [500, 1000, 2000];
-  return retry(socket, delays);
+  return retry(socket, delays, {
+    keepPending: true,
+    restoreWorkspace: true,
+  });
 }
diff --git a/src/session/reconnect.test.ts b/src/session/reconnect.test.ts
index 5555555..6666666 100644
--- a/src/session/reconnect.test.ts
+++ b/src/session/reconnect.test.ts
@@ -20,3 +20,8 @@ describe("reconnect", () => {
   it("retries with backoff", async () => {});
+
+  it("keeps pending edits", async () => {
+    await reconnect(socket);
+    expect(pending()).toHaveLength(2);
+  });
 });
`,
  sensitive: `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 7777777..8888888 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -40,3 +40,3 @@ export const sessionPolicy = {
-  idleMinutes: 30,
+  idleMinutes: 60,
 };
`,
};

const database = await createTestCloudDatabase();
await new FleetDatabase(database).initialize();
const installation = await initializeInstallation(database);
await initializeCloudRuntime(async () =>
  createCloudRuntime(database, installation.origin ?? "", {
    credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
  }),
);
const git = await startGitFixture();
Object.assign(process.env, {
  PORT: String(port),
  MACHDOCH_CLOUD_LISTEN_ADDRESS: "127.0.0.1",
});
process.argv = [process.argv[0]!, "src/server.ts", "dev"];
await import("../src/server.ts");

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const ownerContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const fixture = {
  origin,
  ownerContext,
  database: {
    query: (text: string, values?: unknown[]) =>
      database.engine.query(text, values),
  },
};
const api = (path: string, method = "GET", data?: unknown) =>
  cloudApi(fixture, ownerContext, path, method, data);
const checks: string[] = [];

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  assert.ok(overflow <= 1, `${name}: the page overflows by ${overflow}px`);
  await page.screenshot({
    path: resolve(output, `${name}.png`),
    fullPage: true,
  });
  checks.push(name);
}

try {
  await mkdir(output, { recursive: true });
  await assertEventually(
    async () => (await ownerContext.request.get(`${origin}/healthz`)).ok(),
    () => "The Cloud server did not start.",
    300_000,
  );
  const setup = await ownerContext.request.post(`${origin}/api/v1/auth/setup`, {
    headers: { Origin: origin },
    data: {
      organization: "Northstar Studio",
      name: "Alex Morgan",
      email: "owner@example.test",
      password: randomUUID(),
    },
  });
  assert.equal(setup.status(), 201, await setup.text());
  await completeSecondFactor(fixture, ownerContext);
  const workspace = await api("workspace");
  const owner = {
    organizationId: workspace.organization.id as string,
    userId: workspace.actor.id as string,
  };
  const team = await api("teams", "POST", {
    name: "Engineering",
    key: "ENG",
    visibility: "organization",
    estimateScale: [1, 2, 3].map((points) => ({
      label: String(points),
      points,
    })),
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Cloud workspace",
    description: "Planning, development and connected clients.",
    status: "active",
  });
  const provider = await api("ai-providers", "POST", {
    name: "Engineering AI",
    models: ["gpt-5.5", "gpt-5.5-mini"],
    provider: "openai",
    region: null,
    apiKey: "verification-provider-key",
    maxOutputTokens: 4096,
    dailyTokenBudget: 10_000_000,
    maxConcurrentRequests: 4,
  });
  await api("git/github", "PUT", {
    revision: 0,
    apiUrl: git.apiUrl,
    token: "ghp_organization_fixture_token_0000",
    automate: false,
  });
  await api("git/github/repositories", "POST", {
    fullName: "northstar/cloud-workspace",
  });
  await api("git/github/sync", "POST", {});
  const issue = async (title: string) => {
    const created = await api("issues", "POST", {
      teamId: team.id,
      projectId: project.id,
      title,
      description: "Keep pending work when the connection drops.",
      acceptanceCriteria:
        "The session reconnects. Pending changes and the selected workspace are preserved.",
    });
    return api(`issues/${created.id}`);
  };
  const reconnect = await issue(
    "Reconnect clients after an interrupted session",
  );
  const sessions = await issue("Extend idle sessions to one hour");
  const progress = await issue("Show live execution progress");
  const emptyState = await issue("Polish the empty task list");

  const page = await ownerContext.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(240_000);
  await page.goto(`${origin}/cloud/execution`);
  await page.getByRole("heading", { name: "AI setup" }).waitFor();
  await capture(page, "01-setup-empty");
  await page.getByRole("button", { name: "Set up a project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".cloud-select-trigger").first().waitFor();
  await dialog
    .locator(".cloud-select", { has: page.locator("#profile-repository") })
    .locator(".cloud-select-trigger")
    .click();
  await page
    .locator(".cloud-select-menu")
    .getByRole("option", { name: "northstar/cloud-workspace" })
    .click();
  assert.equal(
    await dialog.getByRole("combobox", { name: "Repository" }).inputValue(),
    "https://github.com/northstar/cloud-workspace",
  );
  await dialog.getByRole("switch", { name: "Autopilot" }).click();
  assert.equal(await dialog.getByText("Base commit").count(), 0);
  assert.equal(
    await dialog.getByRole("combobox", { name: "Model" }).inputValue(),
    `${provider.id}|gpt-5.5`,
  );
  await dialog.getByRole("button", { name: "Add check" }).click();
  await dialog.getByLabel("Check name 1").fill("Unit tests");
  await dialog.getByLabel("Check command 1").fill("pnpm test");
  await capture(page, "02-setup-dialog");
  await dialog.getByRole("button", { name: "Set up", exact: true }).click();
  await page
    .getByRole("heading", { name: "northstar/cloud-workspace" })
    .waitFor();
  await page.getByText("Autopilot").first().waitFor();
  await capture(page, "03-setup-card");
  const profileId = (await api(`execution-profiles?projectId=${project.id}`))
    .profiles[0].id as string;

  const runtime = await getCloudRuntime();
  const worker = await runtime.execution.workers.register(
    owner,
    profileId,
    "Cloud runner",
  );
  async function claimed(issueRecord: { id: string; revision: number }) {
    await runtime.execution.runs.create(owner, randomUUID(), {
      profileId,
      subject: {
        kind: "issue",
        id: issueRecord.id,
        revision: issueRecord.revision,
      },
    });
    const { claim } = await runtime.execution.leases.claim(
      worker.token,
      randomUUID(),
    );
    assert.ok(claim);
    const identity = {
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
    };
    await runtime.execution.leases.accept(worker.token, {
      ...identity,
      environmentId: randomUUID(),
      baseCommit: base,
      isolation: "microvm",
    });
    return { claim, identity };
  }
  async function activity(
    claim: WorkerClaim,
    entries: {
      title: string;
      status: "info" | "started" | "passed" | "failed";
      detail?: string;
    }[],
  ) {
    await runtime.execution.leases.activity(worker.token, {
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      entries: entries.map((entry) => ({ detail: "", ...entry })),
    });
  }
  async function validate(
    claim: WorkerClaim,
    candidate: string,
    patch: string,
  ) {
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
        Buffer.from(
          JSON.stringify(
            verificationFixture(candidate, {
              name: "Unit tests",
              command: "pnpm test",
              stdout: "Tests 42 passed",
            }),
          ),
        ),
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
    await activity(claim, [
      { title: "Validating in a fresh VM", status: "started" },
      {
        title: "Check Unit tests passed",
        status: "passed",
        detail: "pnpm test",
      },
    ]);
  }
  async function review(
    claim: WorkerClaim,
    candidate: string,
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
    await activity(claim, [
      { title: `Review round ${round} started`, status: "started" },
    ]);
    await runtime.execution.reviews.submit(worker.token, request);
    await database.engine.query(
      "UPDATE cloud_inference_calls SET state='complete',response=$2,actual_tokens=2400 WHERE id=$1",
      [
        request.requestId,
        JSON.stringify({ text: JSON.stringify(verdict), toolCalls: [] }),
      ],
    );
    await runtime.execution.reviews.result(worker.token, request);
  }
  async function finish(
    claim: WorkerClaim,
    candidate: string,
    summary: string,
  ) {
    await runtime.execution.leases.finish(worker.token, {
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      inputDigest: claim.inputDigest,
      outcome: "succeeded",
      stopped: true,
      summary,
      candidateCommit: candidate,
      tokensUsed: 48_000,
      checks: [
        {
          name: "Unit tests",
          passed: true,
          candidateCommit: candidate,
          evidenceDigest: createHash("sha256")
            .update(
              JSON.stringify(
                verificationFixture(candidate, {
                  name: "Unit tests",
                  command: "pnpm test",
                  stdout: "Tests 42 passed",
                }),
              ),
            )
            .digest("hex"),
        },
      ],
    });
  }
  async function deliver(
    claim: WorkerClaim,
    issueId: string,
    candidate: string,
    state: string,
    number: number,
    autoMerge: boolean,
    reason: string | null,
  ) {
    await assertEventually(
      async () =>
        (
          await database.engine.query(
            "SELECT 1 FROM cloud_git_pull_requests WHERE number=$1",
            [number],
          )
        ).rows.length > 0,
      () => "The pull requests did not sync.",
      60_000,
    );
    await database.engine.query(
      `INSERT INTO cloud_run_deliveries (organization_id,run_id,issue_id,repository,state,branch,base_branch,head_sha,pull_request_id,pull_request_number,pull_request_url,auto_merge,reason,merged_at,next_attempt_at)
      SELECT $1,$2,$3,'https://github.com/northstar/cloud-workspace',$4,$5,'main',$6,id,number,url,$7,$8,CASE WHEN $4='merged' THEN clock_timestamp() END,clock_timestamp()+interval '1 day'
      FROM cloud_git_pull_requests WHERE organization_id=$1 AND number=$9`,
      [
        owner.organizationId,
        claim.runId,
        issueId,
        state,
        `machdoch/eng-${number}-${claim.runId.slice(0, 8)}`,
        candidate,
        autoMerge,
        reason,
        number,
      ],
    );
  }

  const merged = await claimed(reconnect);
  const mergedCandidate = "a".repeat(40);
  await validate(merged.claim, mergedCandidate, patches.merged);
  await review(merged.claim, mergedCandidate, 1, {
    decision: "request_changes",
    summary:
      "Pending edits are kept, but nothing proves it. Add a test for the pending-edit path.",
    findings: [
      {
        severity: "blocking",
        file: "src/session/reconnect.ts",
        line: 13,
        title: "Cover the pending-edit path",
        detail: "Add a test showing that pending edits survive a reconnect.",
      },
    ],
  });
  await review(merged.claim, mergedCandidate, 2, {
    decision: "approve",
    summary:
      "The reconnect keeps pending edits and restores the workspace. The new test covers the pending-edit path.",
    findings: [
      {
        severity: "suggestion",
        file: "src/session/reconnect.ts",
        line: 15,
        title: "Name the options object",
        detail: "A named type would make the retry options easier to reuse.",
      },
    ],
  });
  await deliver(
    merged.claim,
    reconnect.id,
    mergedCandidate,
    "merged",
    39,
    true,
    null,
  );
  await finish(
    merged.claim,
    mergedCandidate,
    `## What changed
Reconnecting now keeps pending edits and restores the selected workspace. The German greeting reads "Guten Tag".

## Decisions
- **Reused the existing retry helper** instead of adding a new reconnect loop, so the backoff stays in one place.
- **Kept pending edits in memory** rather than writing them to disk; they only need to survive the reconnect.
- Did not change the delay steps (500 ms, 1 s, 2 s); the issue does not ask for different timing.

## Checks
- \`pnpm test\`: 42 passed`,
  );

  const waiting = await claimed(sessions);
  const waitingCandidate = "b".repeat(40);
  await validate(waiting.claim, waitingCandidate, patches.sensitive);
  await review(waiting.claim, waitingCandidate, 1, {
    decision: "approve",
    summary: "The idle timeout is now 60 minutes as requested.",
    findings: [],
  });
  await api("automations", "POST", {
    name: "Check pull requests in a sandbox",
    teamId: team.id,
    trigger: {
      kind: "git_event",
      events: ["pull_request_opened", "pull_request_updated"],
    },
    actions: [{ kind: "delegate", profileId, task: "check" }],
  });
  await deliver(
    waiting.claim,
    sessions.id,
    waitingCandidate,
    "open",
    44,
    false,
    "Sensitive areas changed: security, billing, migrations, infrastructure or secrets.",
  );
  await finish(
    waiting.claim,
    waitingCandidate,
    "## What changed\nIdle sessions now expire after 60 minutes.\n\n## Decisions\n- Changed only the policy value; the session store already reads it.",
  );

  const running = await claimed(progress);

  await page.goto(`${origin}/cloud/tasks`);
  await page.getByText("Merged · #39").waitFor();
  await page.getByText("In review · #44").waitFor();
  await capture(page, "04-task-list");

  await page.goto(`${origin}/cloud/tasks/${merged.claim.runId}`);
  await page.getByRole("heading", { name: "Merged into main" }).waitFor();
  await page.getByRole("heading", { name: "Decisions the AI made" }).waitFor();
  await page.getByText("Approved in round 2").waitFor();
  await capture(page, "05-task-merged-overview");
  await page.getByRole("tab", { name: /Changes/ }).click();
  await page.getByText("src/session/reconnect.ts").first().waitFor();
  await page.getByText("Name the options object").waitFor();
  await capture(page, "06-task-changes");
  await page.getByRole("tab", { name: /Review/ }).click();
  await page.getByRole("heading", { name: "Round 1" }).waitFor();
  await page.getByText("Cover the pending-edit path").waitFor();
  await capture(page, "07-task-review");

  await page.goto(`${origin}/cloud/tasks/${waiting.claim.runId}`);
  await page.getByRole("heading", { name: "Ready for your review" }).waitFor();
  await page
    .getByText(
      "Sensitive areas changed: security, billing, migrations, infrastructure or secrets.",
    )
    .waitFor();
  await page.getByRole("button", { name: "Merge" }).waitFor();
  await page.getByRole("tab", { name: /Review/ }).click();
  await page.getByText("Sensitive areas", { exact: true }).waitFor();
  await page.getByText("src/auth/session.ts").first().waitFor();
  await capture(page, "08-task-needs-person");

  await runtime.execution.leases.heartbeat(worker.token, running.identity);
  await page.goto(`${origin}/cloud/tasks/${running.claim.runId}`);
  await page
    .getByRole("heading", { name: "AI is working on the change" })
    .waitFor();
  await capture(page, "09-task-running");

  await page.goto(`${origin}/cloud/issues/${emptyState.id}`);
  await page.getByRole("button", { name: "Assign to AI" }).click();
  await page.getByText("Machdoch AI").first().waitFor();
  await assertEventually(
    async () => (await api(`runs?issueId=${emptyState.id}`)).runs.length === 1,
    () => "Autopilot did not start the issue assigned to AI.",
    60_000,
  );
  await page.reload();
  await page.getByText("Machdoch AI").first().waitFor();
  await capture(page, "10a-issue-assigned-to-ai");

  await page.goto(`${origin}/cloud/issues/${reconnect.id}`);
  await page.getByText("Merged · #39").first().waitFor();
  await capture(page, "10-issue");
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`${origin}/cloud/tasks/${merged.claim.runId}`);
  await page.getByRole("heading", { name: "Merged into main" }).waitFor();
  await capture(page, "11-task-mobile");

  await page.setViewportSize({ width: 1440, height: 1000 });
  const checker = await runtime.execution.workers.register(
    owner,
    profileId,
    "Pull request checker",
  );
  let check: WorkerClaim | null = null;
  await assertEventually(
    async () => {
      check = (
        await runtime.execution.leases.claim(checker.token, randomUUID())
      ).claim;
      return check !== null;
    },
    () => "No pull request check was started.",
    60_000,
  );
  const pullRequestCheck = check as unknown as WorkerClaim;
  assert.equal(
    (pullRequestCheck.manifest.subject as { purpose: string }).purpose,
    "check",
  );
  const checkHead = pullRequestCheck.baseCommit!;
  const checkIdentity = {
    runId: pullRequestCheck.runId,
    attemptId: pullRequestCheck.attemptId,
    epoch: pullRequestCheck.epoch,
  };
  await runtime.execution.leases.accept(checker.token, {
    ...checkIdentity,
    environmentId: randomUUID(),
    baseCommit: checkHead,
    isolation: "microvm",
  });
  await runtime.execution.leases.progress(checker.token, {
    ...checkIdentity,
    state: "validating",
  });
  const failedCheck = verificationFixture(checkHead, {
    name: "Unit tests",
    command: "pnpm test",
    exitCode: 1,
    stdout: "reconnect.test.ts: 1 failed",
  });
  await storeTestArtifact(
    runtime,
    checker.token,
    pullRequestCheck,
    "verification",
    Buffer.from(JSON.stringify(failedCheck)),
    checkHead,
    "check-1.json",
  );
  await runtime.execution.leases.activity(checker.token, {
    ...checkIdentity,
    entries: [
      { title: "Validating in a fresh VM", status: "started", detail: "" },
      {
        title: "Check Unit tests failed",
        status: "failed",
        detail: "pnpm test",
      },
      { title: "Review round 1 started", status: "started", detail: "" },
    ],
  });
  const checkReview = {
    requestId: randomUUID(),
    ...checkIdentity,
    candidateCommit: checkHead,
    round: 1,
  };
  await runtime.execution.reviews.submit(checker.token, checkReview);
  await database.engine.query(
    "UPDATE cloud_inference_calls SET state='complete',response=$2,actual_tokens=1800 WHERE id=$1",
    [
      checkReview.requestId,
      JSON.stringify({
        text: JSON.stringify({
          decision: "request_changes",
          summary:
            "Reconnects retry correctly, but the attempt counter never resets after a successful connection.",
          findings: [
            {
              severity: "blocking",
              file: "src/session/reconnect.ts",
              line: 15,
              title: "Attempts never reset",
              detail:
                "Reset attempts after a successful reconnect, otherwise later drops fail immediately.",
            },
          ],
        }),
        toolCalls: [],
      }),
    ],
  );
  await runtime.execution.reviews.result(checker.token, checkReview);
  await runtime.execution.leases.finish(checker.token, {
    ...checkIdentity,
    inputDigest: pullRequestCheck.inputDigest,
    outcome: "succeeded",
    stopped: true,
    summary:
      "## Verdict\nNot ready to merge: a test fails and reconnects stop working after the first drop.\n\n## Problems\n- `src/session/reconnect.ts`: `attempts` is never reset, so a second connection drop fails immediately.\n- `pnpm test` fails in `reconnect.test.ts`.\n\n## Checks\n- `pnpm install`, `pnpm build`: passed\n- `pnpm test`: 1 failed\n- Opened the app in the sandbox browser and dropped the connection twice: the reconnect banner stayed after the second drop.",
    candidateCommit: checkHead,
    tokensUsed: 9000,
    checks: [
      {
        name: "Unit tests",
        passed: false,
        candidateCommit: checkHead,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(failedCheck))
          .digest("hex"),
      },
    ],
  });
  await page.goto(`${origin}/cloud/tasks/${pullRequestCheck.runId}`);
  await page.getByRole("heading", { name: "2 problems found" }).waitFor();
  await page
    .getByRole("heading", { name: "Problems found", exact: true })
    .waitFor();
  await capture(page, "12-pull-request-check");

  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify({ passed: checks }, null, 2),
  );
  process.stdout.write(
    `Autopilot verification passed: ${checks.length} views\n`,
  );
} catch (error) {
  console.error(error);
  for (const [index, open] of ownerContext.pages().entries()) {
    await open.screenshot({
      path: resolve(output, `failure-${index}.png`),
      fullPage: true,
    });
    console.error((await open.locator("body").innerText()).slice(0, 3000));
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await git.close();
  process.exit(process.exitCode ?? 0);
}
