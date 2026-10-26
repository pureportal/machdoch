import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { randomUUID } from "node:crypto";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const certificates = getCACertificates("default");
const previousConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
const userDirectory = join(fixture.directory, "native-user");
const workspace = join(fixture.directory, "native-workspace");
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
let manager;
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  setDefaultCACertificates([
    ...certificates,
    await readFile(join(fixture.directory, "tls.crt"), "utf8"),
  ]);
  process.env.MACHDOCH_USER_CONFIG_DIR = userDirectory;
  await mkdir(workspace, { recursive: true });
  const { McpClientManager } =
    await import("../../client/src/core/mcp/client.ts");
  const { createMcpConfigFromPreset, saveUserMcpConfig } =
    await import("../../client/src/core/mcp/config.ts");
  await saveUserMcpConfig({
    schemaVersion: 1,
    servers: [
      createMcpConfigFromPreset("machdoch-cloud", {
        enabled: true,
        transport: {
          type: "streamable-http",
          url: `${fixture.origin}/api/v1/mcp`,
        },
      }),
    ],
  });
  manager = new McpClientManager({ loadRuntimeEnvironment: async () => ({}) });
  const result = await manager.authorizeOAuth(workspace, "machdoch-cloud", {
    openAuthorizationUrl: async (url) => {
      await page.goto(url);
      await page
        .getByLabel("Email", { exact: true })
        .fill("owner@example.test");
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("heading", { name: "Connect Machdoch client" })
        .waitFor();
      assert.equal(
        await page.getByLabel("Edit planning and comments").isChecked(),
        false,
      );
      await page.getByLabel("Edit planning and comments").check();
      await page.getByLabel("Start and cancel AI tasks").check();
      await page.screenshot({
        path: join(fixture.directory, "mcp-consent-desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page
        .getByRole("heading", { name: "Authorization received" })
        .waitFor();
    },
  });
  assert.equal(result.status, "authorized");
  assert.equal(result.stateVerified, true);
  passed(
    "Native Machdoch OAuth discovery, login, consent, PKCE, issuer, and loopback callback",
  );
  const discovery = await manager.discoverServerById(
    workspace,
    "machdoch-cloud",
  );
  assert.equal(discovery.discovery.tools.length, 39);
  const call = async (name, args = {}) => {
    const result = await manager.callTool(
      workspace,
      "machdoch-cloud",
      name,
      args,
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const data = await call("get_workspace");
  assert.equal(data.organization.name, "Cloud verification");
  const recurrence = await call("preview_recurrence", {
    recurrence: {
      kind: "cron",
      expression: "30 2 * * *",
      timezone: "Europe/Berlin",
      start: "2026-01-01T00:00:00Z",
      fold: "both",
    },
    after: "2026-10-24T22:00:00Z",
    count: 2,
  });
  assert.deepEqual(
    recurrence.occurrences.map((value) => new Date(value.at).toISOString()),
    ["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"],
  );
  passed(
    "Native MCP recurrence preview uses pinned timezone rules and resolves both DST folds without creating a task",
  );
  const team = await api("teams", "POST", {
    name: "MCP team",
    key: "MCP",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const workflow = await call("get_team_workflow", { teamId: team.id });
  assert.equal(workflow.statuses.length, 7);
  const readyStatus = workflow.statuses.find(
    (entry) => entry.category === "ready",
  );
  const command = {
    commandId: randomUUID(),
    issue: {
      teamId: team.id,
      title: "Native MCP issue",
      status: { id: readyStatus.id, revision: readyStatus.revision },
    },
  };
  const schedule = await api("schedules", "POST", {
    name: "MCP schedule",
    teamId: team.id,
    action: {
      kind: "create-issue",
      issue: { teamId: team.id, title: "Recurring review" },
    },
    recurrence: {
      kind: "cron",
      expression: "0 9 * * MON",
      timezone: "Europe/Berlin",
      start: "2026-01-01T00:00:00Z",
    },
    missed: "skip",
    catchUpLimit: 1,
    lookbackHours: 24,
  });
  assert.equal(
    (await call("list_schedules", { teamId: team.id }))[0].id,
    schedule.id,
  );
  assert.equal(
    (await call("get_schedule", { id: schedule.id })).enabled,
    false,
  );
  assert.deepEqual(await call("schedule_history", { id: schedule.id }), []);
  assert.deepEqual(
    await call("list_schedules", { teamId: team.id, offset: 1 }),
    [],
  );
  await api(`schedules/${schedule.id}/archive`, "POST", {
    revision: 1,
    archived: true,
  });
  assert.deepEqual(await call("list_schedules", { teamId: team.id }), []);
  assert.equal(
    (await call("list_schedules", { teamId: team.id, archived: true }))[0].id,
    schedule.id,
  );
  await fixture.database.query(
    "INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome) SELECT $1,$2,1,1000+n,1000+n,'skipped' FROM generate_series(1,3) n",
    [data.organization.id, schedule.id],
  );
  const earlier = await call("schedule_history", {
    id: schedule.id,
    beforeAt: 1002,
    beforeRevision: 1,
  });
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].at, 1001);
  await api(`schedules/${schedule.id}/archive`, "POST", {
    revision: 2,
    archived: false,
  });
  passed(
    "Native MCP reads active and archived schedules and cursor-paged occurrence history",
  );
  const issue = await call("create_issue", command);
  assert.deepEqual(await call("create_issue", command), issue);
  await page.goto(`${fixture.origin}/cloud/issues/${issue.id}`);
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Native MCP issue",
  );
  passed(
    "Native tool discovery and duplicate-safe issue creation appear in the cloud UI",
  );
  const childCommand = {
    commandId: randomUUID(),
    parentId: issue.id,
    child: {
      parentRevision: 1,
      issue: { teamId: team.id, title: "MCP sub-issue" },
    },
  };
  const child = await call("create_sub_issue", childCommand);
  assert.deepEqual(await call("create_sub_issue", childCommand), child);
  assert.equal(
    (await call("get_issue_relations", { id: child.id }))[0].kind,
    "parent",
  );
  const relationCommand = {
    commandId: randomUUID(),
    id: issue.id,
    relation: {
      kind: "blocks",
      targetId: child.id,
      sourceRevision: 1,
      targetRevision: 1,
    },
  };
  const relation = await call("add_issue_relation", relationCommand);
  assert.deepEqual(await call("add_issue_relation", relationCommand), relation);
  await call("remove_issue_relation", {
    commandId: randomUUID(),
    id: child.id,
    relationId: relation.id,
  });
  assert.deepEqual(await call("add_issue_relation", relationCommand), relation);
  assert.equal((await call("get_issue_relations", { id: issue.id })).length, 1);
  passed(
    "Native MCP creates sub-issues atomically and links/removes dependencies without resurrecting a removed link on retry",
  );
  const label = await call("create_label", {
    commandId: randomUUID(),
    teamId: team.id,
    label: { name: "MCP label", color: "purple" },
  });
  const labelCommand = {
    commandId: randomUUID(),
    id: issue.id,
    labels: { revision: 1, labelIds: [label.id] },
  };
  await call("set_issue_labels", labelCommand);
  await call("set_issue_labels", labelCommand);
  assert.equal((await call("get_issue_labels", { id: issue.id })).revision, 2);
  assert.equal(
    (await call("list_issues", { labelId: label.id }))[0].id,
    issue.id,
  );
  passed(
    "Native MCP labels support idempotent assignment and filtered issue lookup",
  );
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "MCP project",
    description: "",
  });
  const projectUpdate = {
    commandId: randomUUID(),
    id: project.id,
    project: {
      revision: 1,
      name: "Updated MCP project",
      description: "Updated through the native client",
    },
  };
  await call("update_project", projectUpdate);
  await call("update_project", projectUpdate);
  assert.equal((await call("get_project", { id: project.id })).revision, 2);
  passed("Native MCP project edits are revision checked and duplicate safe");
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "MCP tasks",
    target: "cloud",
    repository: "https://github.com/example/project",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 300,
    maxTokens: 1000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const run = await call("start_run", {
    commandId: randomUUID(),
    run: {
      profileId: profile.id,
      subject: {
        kind: "project",
        id: project.id,
        revision: 2,
        purpose: "test",
        objective: "Run tests",
        acceptanceCriteria: "Tests pass",
      },
    },
  });
  const status = await call("get_run", { id: run.id });
  assert.equal(status.contextChanged, false);
  await call("update_project", {
    commandId: randomUUID(),
    id: project.id,
    project: {
      revision: 2,
      name: "Updated MCP project",
      description: "Revised planning",
    },
  });
  assert.equal((await call("get_run", { id: run.id })).contextChanged, true);
  await page.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  await page
    .getByRole("status")
    .filter({ hasText: "Planning has changed" })
    .waitFor();
  await page.getByRole("link", { name: "Open project", exact: true }).click();
  await page.locator(`#planning-${project.id}`).waitFor();
  assert.ok(page.url().endsWith(`/cloud/projects#planning-${project.id}`));
  passed(
    "Changed project context is visible in the native task response and links to the current project in the browser",
  );
  await call("cancel_run", {
    commandId: randomUUID(),
    id: run.id,
    revision: status.revision,
  });
  assert.equal((await call("get_run", { id: run.id })).state, "canceled");
  passed("Execution scope uses durable task admission and cancellation");
  await manager.closeAll();
  await fixture.restart();
  assert.equal(
    (await call("get_issue", { id: issue.id })).title,
    "Native MCP issue",
  );
  await fixture.database.query(
    "UPDATE cloud_oauth_tokens SET expires_at=now()-interval '1 second' WHERE kind='access'",
  );
  await manager.closeAll();
  const secondWorkspace = join(fixture.directory, "second-workspace");
  await mkdir(secondWorkspace, { recursive: true });
  const concurrent = await Promise.all([
    call("get_issue", { id: issue.id }),
    manager.callTool(secondWorkspace, "machdoch-cloud", "get_issue", {
      id: issue.id,
    }),
  ]);
  assert.equal(concurrent[0].title, "Native MCP issue");
  assert.notEqual(concurrent[1].isError, true);
  const rotated = await fixture.database.query(
    "SELECT count(*)::int AS count FROM cloud_oauth_tokens WHERE kind='refresh' AND consumed_at IS NOT NULL",
  );
  assert.equal(rotated.rows[0].count, 1);
  passed(
    "Cloud restart preserves the native connection; simultaneous workspaces share one rotated refresh",
  );
  await page.goto(`${fixture.origin}/cloud/connections`);
  await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "mcp-connections-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByText("No connected apps.", { exact: true }).waitFor();
  const stored = JSON.parse(
    await readFile(join(userDirectory, "mcp.json"), "utf8"),
  );
  const access = stored.servers.find((server) => server.id === "machdoch-cloud")
    .auth.accessToken;
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/v1/mcp`, {
        headers: { Authorization: `Bearer ${access}` },
      })
    ).status,
    401,
  );
  passed("Mobile connected-app controls revoke access immediately");
  await manager.closeAll();
  await assert.rejects(
    manager.authorizeOAuth(workspace, "machdoch-cloud", {
      openAuthorizationUrl: async (url) => {
        await page.goto(url);
        await page
          .getByRole("heading", { name: "Connect Machdoch client" })
          .waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("heading", { name: "Authorization failed", exact: true })
          .waitFor();
      },
    }),
    /access_denied/,
  );
  assert.equal((await api("connections")).connections.length, 0);
  passed(
    "Declining mobile consent returns a verified denial without granting access",
  );
  const pending = await manager.beginOAuth(workspace, "machdoch-cloud");
  assert.equal(pending.status, "authorization-required");
  await page.goto(pending.authorizationUrl);
  await page
    .getByRole("heading", { name: "Connect Machdoch client" })
    .waitFor();
  await fixture.database.query("DELETE FROM cloud_sessions");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Connect Machdoch client" })
    .waitFor();
  await fixture.database.query(
    "UPDATE cloud_oauth_requests SET expires_at=now()-interval '1 second' WHERE decided_at IS NULL",
  );
  await page.reload();
  await page
    .getByRole("alert")
    .filter({ hasText: "connection request expired" })
    .waitFor();
  passed(
    "Expired sessions return to consent after sign-in; expired requests require a new connection",
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "mcp-result.json"),
    JSON.stringify({ checks }, null, 2),
  );
  process.stdout.write(`MCP browser evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "mcp-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `MCP verification failed: ${error instanceof Error ? error.message : "Unknown failure"}\n`,
  );
  process.exitCode = 1;
} finally {
  await manager?.closeAll();
  await rm(join(userDirectory, "mcp.json"), { force: true });
  if (previousConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = previousConfig;
  setDefaultCACertificates(certificates);
  await fixture.close();
}
