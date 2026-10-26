import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Private",
    key: "PV",
    visibility: "private",
    estimateScale: [
      { label: "Small", points: 3 },
      { label: "Large", points: 8 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Private project",
    description: "",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Private issue title",
    acceptanceCriteria: "Private acceptance",
  });
  const cycle = await api("cycles", "POST", {
    teamId: team.id,
    name: "Private cycle",
    startsOn: "2026-10-01",
    endsOn: "2026-10-15",
    timezone: "UTC",
    capacity: null,
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Private profile",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 3600,
    maxTokens: 1000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const run = await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    {
      email: "viewer@example.test",
      role: "viewer",
    },
  );
  const context = await fixture.createContext();
  await acceptPasswordInvitation(fixture, context, invitation.url, {
    name: "Viewer",
    password: fixture.password,
  });
  const page = await context.newPage();
  for (const [kind, id] of [
    ["issues", issue.id],
    ["cycles", cycle.id],
    ["tasks", run.id],
  ]) {
    const apiPath = kind === "tasks" ? "runs" : kind;
    const response = await context.request.get(
      `${fixture.origin}/api/v1/${apiPath}/${id}`,
    );
    assert.equal(response.status(), 404);
    await page.goto(`${fixture.origin}/cloud/${kind}/${id}`);
    await page.getByRole("heading", { name: "404", exact: true }).waitFor();
    assert.equal(
      await page.getByText("Private issue title", { exact: true }).count(),
      0,
    );
    process.stdout.write(
      `PASS Private ${kind} return the unavailable page without exposing content\n`,
    );
    checks.push(`Private ${kind} API and rendered page isolation`);
  }
  assert.deepEqual((await cloudApi(fixture, context, "runs")).runs, []);
  assert.deepEqual(
    (await cloudApi(fixture, context, "execution-profiles")).profiles,
    [],
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  process.stderr.write(`${fixture.logs()}\n`);
  throw error;
} finally {
  await fixture.close();
}
