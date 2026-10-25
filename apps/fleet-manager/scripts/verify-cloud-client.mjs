import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClientCloudBindings } from "../../client/src/core/cloud/bindings.ts";
import { prepareClientWorkspace } from "../../client/src/core/cloud/managed-workspace.ts";
import { workspaceGit } from "../../client/src/core/cloud/repository.ts";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

let dropped = false;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (!dropped && path === "/api/v1/runner/workspace" && status === 200) {
      dropped = true;
      return true;
    }
    return false;
  },
});
const page = await fixture.ownerContext.newPage();
const runnerContext = await fixture.createContext();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const execute = promisify(execFile);
const config = join(fixture.directory, "client-config");
const workspace = join(fixture.directory, "source");
const cliPath = fileURLToPath(
  new URL("../../client/dist/machdoch-cli.cjs", import.meta.url),
);
const checks = [];
let worker;
let claim;
let settled = false;
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function cli(
  args,
  { root = workspace, status = 0, token = worker.token } = {},
) {
  let result;
  try {
    result = await execute(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        cliPath,
        "cloud",
        ...args,
        "--cwd",
        root,
        "--json",
      ],
      {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          PATH: process.env.PATH,
          MACHDOCH_USER_CONFIG_DIR: config,
          MACHDOCH_CLOUD_RUNNER_TOKEN: token,
          NODE_EXTRA_CA_CERTS: join(fixture.directory, "tls.crt"),
        },
      },
    );
    assert.equal(status, 0, "Expected the client command to fail");
  } catch (error) {
    assert.equal(error.code, status, error.stderr ?? error.message);
    result = error;
  }
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  return status === 0 ? JSON.parse(result.stdout) : JSON.parse(result.stderr);
}
async function runner(endpoint, body, expected = 200) {
  const response = await runnerContext.request.post(
    `${fixture.origin}/api/v1/runner/${endpoint}`,
    { headers: { Authorization: `Bearer ${worker.token}` }, data: body },
  );
  assert.equal(response.status(), expected, await response.text());
  return response.json();
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  await mkdir(workspace);
  await workspaceGit(workspace, [
    "init",
    "--initial-branch=main",
    "--template=",
  ]);
  await workspaceGit(workspace, [
    "config",
    "remote.origin.url",
    "git@github.com:example/project.git",
  ]);
  await writeFile(join(workspace, "README"), "committed source\n");
  await workspaceGit(workspace, ["add", "README"]);
  await workspaceGit(workspace, [
    "-c",
    "user.name=Verification",
    "-c",
    "user.email=verify@example.test",
    "commit",
    "-m",
    "Base",
  ]);
  const baseCommit = (
    await workspaceGit(workspace, ["rev-parse", "HEAD"])
  ).trim();
  await writeFile(join(workspace, "README"), "local work remains here\n");
  await writeFile(join(workspace, ".env"), "LOCAL_PRIVATE_FIXTURE=untouched\n");
  const sourceStatus = await workspaceGit(workspace, [
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  const team = await api("teams", "POST", {
    name: "Client team",
    key: "CLIENT",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Client project",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Client execution",
    target: "client",
    repository: "https://github.com/example/project",
    baseCommit,
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 300,
    maxTokens: 10000,
    requiredChecks: [
      { name: "README", command: "node --test", timeoutSeconds: 30 },
    ],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Development machine",
  });
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page.getByText("Not connected", { exact: true }).waitFor();
  const connect = [
    "connect",
    "--cloud-url",
    fixture.origin,
    "--name",
    "Development checkout",
  ];
  await cli(connect, { status: 1 });
  assert.equal(dropped, true);
  const pending = (await cli(["status"])).connections[0];
  assert.equal(pending.status, "linking");
  await fixture.restart();
  const linked = await cli(connect);
  assert.equal(linked.id, pending.id);
  assert.equal(linked.binding.workspaceId, pending.binding.workspaceId);
  assert.equal(linked.status, "linked");
  await page.getByRole("button", { name: "Refresh runners" }).click();
  await page
    .getByText("Workspace: Development checkout", { exact: true })
    .waitFor();
  const workers = (await api(`execution-workers?profileId=${profile.id}`))
    .workers;
  assert.equal(workers.length, 1);
  assert.equal(
    workers[0].workspaceBinding.workspaceId,
    linked.binding.workspaceId,
  );
  assert.ok(!JSON.stringify(workers).includes(JSON.stringify(workspace).slice(1, -1)));
  passed(
    "The packaged client recovers an accepted linking response across server restart and the cloud shows its workspace",
  );

  const other = join(fixture.directory, "other-checkout");
  await workspaceGit(fixture.directory, [
    "clone",
    "--no-hardlinks",
    "--",
    workspace,
    other,
  ]);
  await workspaceGit(other, [
    "config",
    "remote.origin.url",
    "https://github.com/example/project",
  ]);
  const refused = await cli(connect, { root: other, status: 1 });
  assert.match(refused.error, /already linked/);
  assert.equal(
    (await cli(["status"])).connections[0].binding.workspaceId,
    linked.binding.workspaceId,
  );
  passed("A linked runner cannot be redirected to another local checkout");

  const oldToken = worker.token;
  await page
    .getByRole("button", {
      name: "Rotate token for Development machine",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rotate token", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  worker.token = await page
    .getByLabel("Runner token", { exact: true })
    .inputValue();
  const rotated = await cli(connect);
  assert.equal(rotated.id, linked.id);
  assert.equal(rotated.binding.workspaceId, linked.binding.workspaceId);
  assert.equal(
    (
      await runnerContext.request.post(
        `${fixture.origin}/api/v1/runner/registration`,
        { headers: { Authorization: `Bearer ${oldToken}` }, data: {} },
      )
    ).status(),
    401,
  );
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  passed(
    "Token rotation preserves the client workspace identity and rejects the old credential",
  );

  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Prepare client work",
    description: "",
    acceptanceCriteria: "Preserve the local checkout",
  });
  const input = {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  };
  const run = await api("runs", "POST", input);
  claim = (await runner("claims", { claimId: randomUUID() })).claim;
  assert.equal(claim.runId, run.id);
  const bindingStore = new ClientCloudBindings(join(config, "cloud"));
  const prepared = await prepareClientWorkspace(
    join(fixture.directory, "managed"),
    await bindingStore.get(linked.id),
    claim,
  );
  assert.equal((await lstat(prepared.repositoryDirectory)).isDirectory(), true);
  assert.equal(
    await realpath(
      (
        await workspaceGit(prepared.checkoutRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    ),
    await realpath(prepared.repositoryDirectory),
  );
  await assert.rejects(
    readFile(join(prepared.repositoryDirectory, "objects/info/alternates")),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(join(prepared.workspaceRoot, "README"), "utf8"),
    "committed source\n",
  );
  await assert.rejects(readFile(join(prepared.workspaceRoot, ".env")), {
    code: "ENOENT",
  });
  assert.equal(
    await workspaceGit(workspace, ["status", "--porcelain=v1", "-z"]),
    sourceStatus,
  );
  await runner("accept", {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    environmentId: randomUUID(),
    baseCommit,
    isolation: "independent-checkout",
  });
  passed(
    "A cloud preparation claim uses the pinned commit without copying dirty files or untracked local settings",
  );

  await cli(["disconnect", linked.id]);
  assert.equal((await cli(["status"])).connections[0].status, "disconnected");
  await page.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  await page.getByRole("status").filter({ hasText: "reconciling" }).waitFor();
  await assert.rejects(api("runs", "POST", input), /active task/);
  await runner("finish", {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    outcome: "failed",
    summary:
      "Preparation stopped after client disconnection. No agent was launched.",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: null,
    tokensUsed: 0,
    checks: [],
  });
  settled = true;
  await page.getByRole("status").filter({ hasText: "failed" }).waitFor();
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page.getByText("Revoked", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(fixture.pageErrors, []);
  await page.screenshot({
    path: join(fixture.directory, "client-workspace-mobile.png"),
    fullPage: true,
  });
  passed(
    "Client disconnect fences its task until stop acknowledgment and preserves the binding in the mobile runner list",
  );
  await writeFile(
    join(fixture.directory, "client-results.json"),
    JSON.stringify(
      { checks, pageErrors: fixture.pageErrors, agentExecuted: false },
      null,
      2,
    ),
  );
  process.stdout.write(`Client integration evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "client-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  if (claim && !settled) {
    try {
      await runner("finish", {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        outcome: "failed",
        summary: "Verification preparation stopped",
        stopped: true,
        inputDigest: claim.inputDigest,
        candidateCommit: null,
        tokensUsed: 0,
        checks: [],
      });
    } catch (error) {
      process.stderr.write(`Preparation cleanup: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
  await fixture.close();
}
