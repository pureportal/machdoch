import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  uploadRunnerArtifact,
  verificationRecord,
} from "./cloud-artifact-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const commit = "a".repeat(40);
const checks = [];
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function runner(token, path, body, status = 200) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    { headers: { Authorization: `Bearer ${token}` }, data: body },
  );
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
function identity(claim) {
  return { runId: claim.runId, attemptId: claim.attemptId, epoch: claim.epoch };
}
function finish(claim, outcome = "succeeded") {
  return {
    ...identity(claim),
    outcome,
    summary: "Controlled protocol fixture finished",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: commit,
    tokensUsed: 60,
    checks: [
      {
        name: "unit",
        passed: true,
        candidateCommit: commit,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(verificationRecord(commit)))
          .digest("hex"),
      },
    ],
  };
}
async function accept(token, claim) {
  await runner(token, "accept", {
    ...identity(claim),
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
}
async function duplicate(body) {
  const csrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  const response = await fixture.ownerContext.request.post(
    `${fixture.origin}/api/v1/runs`,
    {
      headers: {
        Origin: fixture.origin,
        "x-machdoch-cloud-csrf": csrf,
        "Idempotency-Key": randomUUID(),
      },
      data: body,
    },
  );
  assert.equal(response.status(), 409);
  assert.equal((await response.json()).code, "run_active");
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
    { name: "Protocol fixture", models: ["fixture-model"] },
  );
  const team = await api("teams", "POST", {
    name: "Execution team",
    key: "EX",
    visibility: "organization",
    estimateScale: [
      { label: "Small", points: 3 },
      { label: "Large", points: 8 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Execution project",
    description: "",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Recover interrupted work",
    acceptanceCriteria: "Accepted commands must not be duplicated",
  });
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Cloud worker");
  await form
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project");
  await form.getByLabel("Base commit (SHA)", { exact: true }).fill(commit);
  await form.getByLabel("Provider", { exact: true }).selectOption(provider.id);
  await form.getByLabel("Model", { exact: true }).selectOption("fixture-model");
  await form.getByLabel("Check name 1", { exact: true }).fill("unit");
  await form.getByLabel("Check command 1", { exact: true }).fill("node --test");
  await form.getByRole("button", { name: "Save profile", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const profile = (await api("execution-profiles")).profiles[0];
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page
    .getByRole("button", { name: "Enroll runner", exact: true })
    .click();
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("First worker");
  await form.getByRole("button", { name: "Create token", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const first = {
    token: await page.getByLabel("Runner token", { exact: true }).inputValue(),
  };
  const second = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Second worker",
  });
  passed("Execution profile and scoped runner enrollment through the UI");

  await page.goto(`${fixture.origin}/cloud/issues/${issue.id}`);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await form
    .getByLabel("Execution profile", { exact: true })
    .selectOption(profile.id);
  await form.getByRole("button", { name: "Queue task", exact: true }).click();
  await page.waitForURL(/\/cloud\/tasks\/[a-f0-9-]+$/);
  await page.getByRole("status").filter({ hasText: "queued" }).waitFor();
  const request = {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  };
  await Promise.all(Array.from({ length: 6 }, () => duplicate(request)));
  const claimId = randomUUID();
  const claims = await Promise.all([
    runner(first.token, "claims", { claimId }),
    runner(second.token, "claims", { claimId: randomUUID() }),
  ]);
  assert.equal(claims.filter((response) => response.claim).length, 1);
  const winner = claims[0].claim ? first : second;
  const claim = claims.find((response) => response.claim).claim;
  assert.equal((await api(`runs/${claim.runId}`)).attempts.length, 1);
  await fixture.restart();
  if (winner === first)
    assert.deepEqual(
      (await runner(first.token, "claims", { claimId })).claim,
      claim,
    );
  await page.reload();
  await page.getByRole("status").filter({ hasText: "preparing" }).waitFor();
  passed(
    "Concurrent workers get one claim and persisted ownership survives restart",
  );

  await accept(winner.token, claim);
  await runner(winner.token, "progress", {
    ...identity(claim),
    state: "validating",
  });
  await runner(winner.token, "finish", { ...finish(claim), checks: [] }, 409);
  assert.equal((await api(`runs/${claim.runId}`)).state, "validating");
  const sendArtifact = (path, body) => runner(winner.token, path, body);
  await uploadRunnerArtifact(
    sendArtifact,
    claim,
    "candidate",
    "candidate.bundle",
    Buffer.from("controlled candidate fixture"),
    commit,
  );
  await uploadRunnerArtifact(
    sendArtifact,
    claim,
    "verification",
    "unit.json",
    Buffer.from(JSON.stringify(verificationRecord(commit))),
    commit,
  );
  await runner(winner.token, "finish", finish(claim));
  await runner(winner.token, "finish", finish(claim));
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  assert.equal((await api(`issues/${issue.id}`)).state, "backlog");
  passed(
    "Candidate evidence gates completion and a successful task does not close the issue",
  );

  const next = await api("runs", "POST", request);
  const nextClaim = (
    await runner(first.token, "claims", { claimId: randomUUID() })
  ).claim;
  assert.equal(nextClaim.runId, next.id);
  await accept(first.token, nextClaim);
  await page.goto(`${fixture.origin}/cloud/tasks/${next.id}`);
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await form.getByRole("button", { name: "Cancel task", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  assert.equal(
    (await runner(first.token, "heartbeat", identity(nextClaim))).instruction,
    "stop",
  );
  assert.deepEqual(await runner(first.token, "finish", finish(nextClaim)), {
    accepted: false,
    state: "cancel_requested",
    requiredOutcome: "canceled",
  });
  await duplicate(request);
  assert.equal(
    (await runner(first.token, "finish", finish(nextClaim, "canceled"))).state,
    "canceled",
  );
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  passed(
    "Cancellation fences late success and retains the reservation until the runner stops",
  );

  const expired = await api("runs", "POST", request);
  const expiredClaim = (
    await runner(first.token, "claims", { claimId: randomUUID() })
  ).claim;
  await accept(first.token, expiredClaim);
  await fixture.database.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expiredClaim.attemptId],
  );
  assert.equal(
    (await runner(first.token, "heartbeat", identity(expiredClaim)))
      .instruction,
    "stop",
  );
  await page.goto(`${fixture.origin}/cloud/tasks/${expired.id}`);
  await page.getByRole("status").filter({ hasText: "reconciling" }).waitFor();
  await duplicate(request);
  assert.equal(
    (await runner(second.token, "claims", { claimId: randomUUID() })).claim,
    null,
  );
  await runner(first.token, "finish", finish(expiredClaim, "failed"));
  const queued = await api("runs", "POST", request);
  await fixture.database.query(
    "UPDATE cloud_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [queued.id],
  );
  await page.goto(`${fixture.origin}/cloud/tasks/${queued.id}`);
  await page.getByRole("status").filter({ hasText: "timed out" }).waitFor();
  passed(
    "Lease loss cannot revive an old worker and queued deadlines use database time",
  );

  const secretRows = await fixture.database.query(
    "SELECT token_hash FROM cloud_execution_workers",
  );
  assert.ok(
    secretRows.rows.every(
      (row) =>
        row.token_hash !== first.token && row.token_hash !== second.token,
    ),
  );
  const browserRunnerCall = await fixture.ownerContext.request.post(
    `${fixture.origin}/api/v1/runner/claims`,
    {
      headers: {
        Authorization: `Bearer ${first.token}`,
        Origin: fixture.origin,
      },
      data: { claimId: randomUUID() },
    },
  );
  assert.equal(browserRunnerCall.status(), 403);
  passed(
    "Runner tokens are hashed and browser sessions cannot use the runner transport",
  );

  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page
    .getByRole("button", { name: "Rotate token for First worker", exact: true })
    .click();
  await form.getByRole("button", { name: "Rotate token", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const rotatedToken = await page
    .getByLabel("Runner token", { exact: true })
    .inputValue();
  assert.notEqual(rotatedToken, first.token);
  await runner(first.token, "claims", { claimId: randomUUID() }, 401);
  assert.equal(
    (await runner(rotatedToken, "claims", { claimId: randomUUID() })).claim,
    null,
  );
  passed(
    "Runner token rotation invalidates the old credential and activates the new one",
  );

  await page.goto(`${fixture.origin}/cloud/tasks/${queued.id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Execution details", { exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(fixture.directory, "task-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        scope:
          "Control-plane protocol fixture; no AI provider or sandbox workload executed.",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(`${fixture.logs()}\nEvidence: ${fixture.directory}\n`);
  throw error;
} finally {
  await fixture.close();
}
