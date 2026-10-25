import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
const commit = "a".repeat(40);
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function runner(token, path, body) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    { headers: { Authorization: `Bearer ${token}` }, data: body },
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function changeProvider(id, changes) {
  const provider = (await api("ai-providers?view=manage")).providers.find(
    (entry) => entry.id === id,
  );
  const {
    id: _,
    provider: __,
    inferenceRevision: ___,
    ...configuration
  } = provider;
  return api(`ai-providers/${id}`, "PATCH", { ...configuration, ...changes });
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Provider team",
    key: "PT",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Provider project",
    description: "",
  });
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("link", { name: "AI providers", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "New profile", exact: true })
      .count(),
    0,
  );
  const first = await executionProviderFixture(fixture, fixture.ownerContext, {
    name: "First provider",
    models: ["first-model"],
  });
  const second = await executionProviderFixture(fixture, fixture.ownerContext, {
    name: "Second provider",
    models: ["second-model"],
  });
  await page.reload();
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Bound execution");
  await form
    .getByLabel("Repository URL", { exact: true })
    .fill("https://github.com/example/project");
  await form.getByLabel("Base commit (SHA)", { exact: true }).fill(commit);
  assert.equal(
    await form.getByLabel("Model", { exact: true }).isDisabled(),
    true,
  );
  await form.getByLabel("Provider", { exact: true }).selectOption(first.id);
  await form.getByLabel("Model", { exact: true }).selectOption("first-model");
  await form.getByLabel("Provider", { exact: true }).selectOption(second.id);
  assert.equal(
    await form.getByLabel("Model", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await form
      .getByLabel("Model", { exact: true })
      .locator('option[value="first-model"]')
      .count(),
    0,
  );
  await form.getByLabel("Model", { exact: true }).selectOption("second-model");
  await form.getByLabel("Check name 1", { exact: true }).fill("unit");
  await form.getByLabel("Check command 1", { exact: true }).fill("node --test");
  await form.getByRole("button", { name: "Save profile", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  const profile = (await api("execution-profiles")).profiles[0];
  assert.equal(profile.providerId, second.id);
  assert.equal(profile.model, "second-model");
  passed(
    "Execution profiles require a stored provider and an explicitly selected allowed model",
  );
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Provider-bound task",
    acceptanceCriteria: "Validated outcome",
  });
  const input = {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  };
  const queued = await api("runs", "POST", input);
  await page.goto(`${fixture.origin}/cloud/providers`);
  await page
    .locator("section.cloud-card")
    .filter({
      has: page.getByRole("heading", { name: "Second provider", exact: true }),
    })
    .getByRole("button", { name: "Edit provider", exact: true })
    .click();
  assert.equal(
    await form
      .getByText("Active AI work using this provider will stop.", {
        exact: true,
      })
      .count(),
    0,
  );
  await form.getByLabel("Status", { exact: true }).selectOption("false");
  await form
    .getByText("Active AI work using this provider will stop.", { exact: true })
    .waitFor();
  await form
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await form.waitFor({ state: "hidden" });
  await page.goto(`${fixture.origin}/cloud/tasks/${queued.id}`);
  await page.getByRole("status").filter({ hasText: "failed" }).waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "AI provider access changed" })
    .waitFor();
  await page.screenshot({
    path: join(fixture.directory, "provider-task-stopped.png"),
    fullPage: true,
  });
  passed(
    "Disabling a provider explains the consequence and displays the queued task's stop reason",
  );
  await changeProvider(second.id, { enabled: true });
  const worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Provider worker",
  });
  const active = await api("runs", "POST", input);
  const claim = (
    await runner(worker.token, "claims", { claimId: randomUUID() })
  ).claim;
  assert.equal(claim.runId, active.id);
  assert.equal(claim.manifest.provider.inferenceRevision, 3);
  const identity = {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
  };
  await runner(worker.token, "accept", {
    ...identity,
    environmentId: randomUUID(),
    baseCommit: commit,
    isolation: "microvm",
  });
  await changeProvider(second.id, {
    name: "Renamed provider",
    dailyTokenBudget: 200000,
  });
  assert.equal(
    (await runner(worker.token, "heartbeat", identity)).instruction,
    "continue",
  );
  assert.equal(
    (await api(`runs/${active.id}`)).manifest.provider.name,
    "Second provider",
  );
  passed(
    "Cosmetic provider updates preserve the running grant and its recorded provider identity",
  );
  await Promise.all([
    changeProvider(second.id, { apiKey: "replacement-verification-key" }),
    runner(worker.token, "heartbeat", identity),
  ]);
  assert.equal(
    (await runner(worker.token, "heartbeat", identity)).instruction,
    "stop",
  );
  const stopped = await runner(worker.token, "finish", {
    ...identity,
    outcome: "failed",
    summary: "Worker stopped",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: null,
    tokensUsed: 0,
    checks: [],
  });
  assert.equal(stopped.accepted, true);
  assert.equal(
    (await api(`runs/${active.id}`)).reason,
    "AI provider access changed",
  );
  await fixture.restart();
  await page.goto(`${fixture.origin}/cloud/tasks/${active.id}`);
  await page
    .getByRole("alert")
    .filter({ hasText: "AI provider access changed" })
    .waitFor();
  passed(
    "Credential rotation fences running work during concurrent heartbeats and retains the cause after restart",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "provider-task-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "execution-provider-results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Execution provider evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "provider-task-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.message : "Verification failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  await fixture.close();
}
