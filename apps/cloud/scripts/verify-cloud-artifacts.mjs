import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";
import {
  uploadRunnerArtifact,
  verificationRecord,
} from "./cloud-artifact-fixture.mjs";

let dropped = false;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (
      !dropped &&
      path === "/api/v1/runner/artifacts/chunk" &&
      status === 200
    ) {
      dropped = true;
      return true;
    }
    return false;
  },
});
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const memberContext = await fixture.createContext();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const commit = "a".repeat(40);
const checks = [];
let worker;
let claim;
let heartbeat;
let restarting = false;
const heartbeatErrors = [];
const identity = () => ({
  runId: claim.runId,
  attemptId: claim.attemptId,
  epoch: claim.epoch,
});
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function runner(path, body, status = 200) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    { headers: { Authorization: `Bearer ${worker.token}` }, data: body },
  );
  assert.equal(response.status(), status, await response.text());
  return response.json();
}
async function restart() {
  restarting = true;
  try {
    await fixture.restart();
  } finally {
    restarting = false;
  }
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    {
      email: "member@example.test",
      role: "member",
    },
  );
  await acceptPasswordInvitation(fixture, memberContext, invitation.url, {
    name: "Member",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Private files",
    key: "FILES",
    visibility: "private",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Durable results",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Files",
    repository: "https://github.com/example/project",
    baseCommit: commit,
    target: "cloud",
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "File runner",
  });
  const run = await api("runs", "POST", {
    profileId: profile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Retain task results",
      acceptanceCriteria: "Recoverable candidate and verification evidence",
    },
  });
  claim = (await runner("claims", { claimId: randomUUID() })).claim;
  await runner("accept", {
    ...identity(),
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
  heartbeat = setInterval(() => {
    if (!restarting)
      void runner("heartbeat", identity()).catch((error) => {
        if (!restarting) heartbeatErrors.push(error.message);
      });
  }, 15000);
  const bytes = Buffer.from(
    "<script>window.artifactScriptExecuted=true</script>\n" +
      "a".repeat(140000),
  );
  const id = randomUUID();
  await assert.rejects(
    uploadRunnerArtifact(runner, claim, "log", "output.html", bytes, null, id),
  );
  assert.equal(dropped, true);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT received_bytes FROM cloud_run_artifacts WHERE id=$1",
        [id],
      )
    ).rows[0].received_bytes,
    32768,
  );
  await page.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  assert.equal(
    await page.getByRole("heading", { name: "Files", exact: true }).count(),
    0,
  );
  await restart();
  await uploadRunnerArtifact(
    runner,
    claim,
    "log",
    "output.html",
    bytes,
    null,
    id,
  );
  await page
    .getByRole("button", { name: "Preview output.html", exact: true })
    .waitFor();
  assert.equal((await api(`runs/${run.id}`)).artifacts.length, 1);
  passed(
    "A lost chunk response resumes after restart without duplicating or exposing a partial file",
  );

  await page
    .getByRole("button", { name: "Preview output.html", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("Preview shortened. Download the full file.", { exact: true })
    .waitFor();
  assert.ok((await dialog.locator("pre").textContent()).startsWith("<script>"));
  assert.equal(
    await page.evaluate(() => window.artifactScriptExecuted),
    undefined,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "artifact-preview-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("button", { name: "Preview output.html", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  const downloadPending = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download output.html", exact: true })
    .click();
  const download = await downloadPending;
  assert.equal(download.suggestedFilename(), "output.html");
  const file = join(fixture.directory, "downloaded-output.html");
  await download.saveAs(file);
  assert.deepEqual(await readFile(file), bytes);
  passed(
    "Text previews escape executable content, fit mobile screens, restore focus and download exact bytes",
  );

  await uploadRunnerArtifact(
    runner,
    claim,
    "diff",
    "earlier.patch",
    Buffer.from("Earlier diff"),
    "b".repeat(40),
  );
  await page
    .getByRole("button", { name: "Preview earlier.patch", exact: true })
    .click();
  await dialog.locator("pre").filter({ hasText: "Earlier diff" }).waitFor();
  await uploadRunnerArtifact(
    runner,
    claim,
    "diff",
    "current.patch",
    Buffer.from("Current diff"),
    commit,
  );
  await page.getByText("Earlier candidates", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("heading", { name: "Files", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  passed(
    "Preview focus recovers when a newer candidate moves the original file into history",
  );

  const privateFile = `${fixture.origin}/api/v1/runs/${run.id}/artifacts/${id}`;
  assert.equal((await memberContext.request.get(privateFile)).status(), 404);
  assert.equal(
    (await memberContext.request.get(privateFile + "/preview")).status(),
    404,
  );
  assert.equal((await runnerContext.request.get(privateFile)).status(), 401);
  assert.equal(
    (await fixture.ownerContext.request.get(privateFile)).headers()[
      "content-type"
    ],
    "application/octet-stream",
  );
  passed(
    "Task file downloads and previews enforce organization membership and private-team access",
  );

  await runner("progress", { ...identity(), state: "validating" });
  const evidence = Buffer.from(JSON.stringify(verificationRecord(commit)));
  const finish = {
    ...identity(),
    outcome: "succeeded",
    summary: "Candidate and check evidence saved",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: commit,
    tokensUsed: 0,
    checks: [
      {
        name: "unit",
        passed: true,
        candidateCommit: commit,
        evidenceDigest: createHash("sha256").update(evidence).digest("hex"),
      },
    ],
  };
  assert.equal(
    (await runner("finish", finish, 409)).code,
    "candidate_artifact_required",
  );
  await uploadRunnerArtifact(
    runner,
    claim,
    "candidate",
    "candidate.bundle",
    Buffer.from("controlled candidate fixture"),
    commit,
  );
  assert.equal(
    (await runner("finish", finish, 409)).code,
    "stored_evidence_required",
  );
  await uploadRunnerArtifact(
    runner,
    claim,
    "verification",
    "unit.json",
    evidence,
    commit,
  );
  assert.equal((await runner("finish", finish)).state, "succeeded");
  clearInterval(heartbeat);
  await restart();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
  await page
    .getByRole("link", { name: "Download candidate.bundle", exact: true })
    .waitFor();
  assert.equal((await api(`runs/${run.id}`)).artifacts.length, 5);
  assert.deepEqual(
    await (await fixture.ownerContext.request.get(privateFile)).body(),
    bytes,
  );
  assert.deepEqual(heartbeatErrors, []);
  assert.deepEqual(fixture.pageErrors, []);
  await page.screenshot({
    path: join(fixture.directory, "task-files-mobile.png"),
    fullPage: true,
  });
  passed(
    "Successful completion requires stored candidate and check evidence that remains available after restart",
  );
  await writeFile(
    join(fixture.directory, "artifact-results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Artifact evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "artifact-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  await fixture.close();
}
