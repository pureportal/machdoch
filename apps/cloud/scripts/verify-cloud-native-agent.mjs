import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workspaceGit } from "../../client/src/core/cloud/repository.ts";
import { cloudApi, cloudBrowserFixture } from "./cloud-browser-fixture.mjs";

const agent = process.env.CLOUD_NATIVE_AGENT ?? "claude-cli";
const fixture = await cloudBrowserFixture();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const execute = promisify(execFile);
const config = join(fixture.directory, "client-config");
const workspace = join(fixture.directory, "source");
const cliEntry = fileURLToPath(
  new URL("../../client/src/cli/main.ts", import.meta.url),
);
const checks = [];
let worker;
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function cli(args, timeout = 60000) {
  const result = await execute(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "@oxc-node/core/register",
      cliEntry,
      "cloud",
      ...args,
      "--cwd",
      workspace,
      "--json",
    ],
    {
      cwd: fixture.directory,
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        MACHDOCH_USER_CONFIG_DIR: config,
        MACHDOCH_CLOUD_RUNNER_TOKEN: worker.token,
        NODE_EXTRA_CA_CERTS: join(fixture.directory, "tls.crt"),
      },
    },
  );
  assert.ok(!result.stdout.includes(worker.token));
  assert.ok(!result.stderr.includes(worker.token));
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
    "https://github.com/example/native-agent",
  ]);
  await writeFile(
    join(workspace, "math.mjs"),
    "export function add(left, right) {\n  return left - right;\n}\n",
  );
  await writeFile(
    join(workspace, "math.test.mjs"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "./math.mjs";\n\ntest("adds numbers", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  );
  await workspaceGit(workspace, ["add", "."]);
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
  await writeFile(
    join(workspace, "local-notes.txt"),
    "uncommitted local work\n",
  );
  const sourceStatus = await workspaceGit(workspace, [
    "status",
    "--porcelain=v1",
  ]);
  const team = await api("teams", "POST", {
    name: "Product",
    key: "PRD",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Calculator",
    description: "",
  });
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Local agent",
    target: "client",
    repository: "https://github.com/example/native-agent",
    baseCommit,
    agent,
    ...(process.env.CLOUD_NATIVE_MODEL
      ? { model: process.env.CLOUD_NATIVE_MODEL }
      : {}),
    maxDurationSeconds: 1200,
    maxTokens: 5000000,
    requiredChecks: [
      { name: "tests", command: "node --test", timeoutSeconds: 120 },
    ],
  });
  const profiles = (await api(`execution-profiles?projectId=${project.id}`))
    .profiles;
  assert.equal(profiles[0].agent, agent);
  assert.equal(profiles[0].providerId, undefined);
  passed(
    "A linked client profile selects a local agent without a cloud model provider",
  );
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Development machine",
  });
  const [linked] = await cli([
    "connect",
    "--cloud-url",
    fixture.origin,
    "--name",
    "Calculator checkout",
  ]);
  assert.equal(linked.status, "linked");
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Fix addition",
    description: "add() in math.mjs subtracts instead of adding.",
    acceptanceCriteria: "add(2, 3) returns 5 and node --test passes.",
  });
  const run = await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  const queued = await api(`runs/${run.id}`);
  assert.equal(queued.manifest.provider, null);
  const started = Date.now();
  const results = await cli(["run", linked.id, "--once"], 1500000);
  assert.deepEqual(
    results.map(({ runId, state }) => ({ runId, state })),
    [{ runId: run.id, state: "succeeded" }],
  );
  const detail = await api(`runs/${run.id}`);
  assert.equal(detail.state, "succeeded");
  const branch = /Branch: (machdoch\/[^\s]+)/.exec(detail.summary)?.[1];
  assert.ok(branch, detail.summary);
  assert.deepEqual(
    [...new Set(detail.artifacts.map((artifact) => artifact.kind))].sort(),
    ["candidate", "diff", "verification"],
  );
  assert.equal(
    (await workspaceGit(workspace, ["rev-parse", branch])).trim(),
    detail.candidateCommit,
  );
  assert.match(
    await workspaceGit(workspace, ["show", `${branch}:math.mjs`]),
    /left \+ right/,
  );
  assert.equal(
    await workspaceGit(workspace, ["status", "--porcelain=v1"]),
    sourceStatus,
  );
  assert.equal(
    (await workspaceGit(workspace, ["rev-parse", "HEAD"])).trim(),
    baseCommit,
  );
  assert.equal(
    await readFile(join(workspace, "math.mjs"), "utf8"),
    "export function add(left, right) {\n  return left - right;\n}\n",
  );
  passed(
    `The ${agent} agent completed the issue in an isolated checkout, passed independent checks and added ${branch} without touching local work (${Math.round((Date.now() - started) / 1000)}s)`,
  );
  const page = await fixture.ownerContext.newPage();
  await page.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  await page
    .getByText(agent === "claude-cli" ? "Claude Code" : "Codex CLI", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    path: join(fixture.directory, "native-agent-task.png"),
    fullPage: true,
  });
  assert.deepEqual(fixture.pageErrors, []);
  passed("The task view shows the client agent, checks and result");
  await writeFile(
    join(fixture.directory, "native-agent-results.json"),
    JSON.stringify({ checks, summary: detail.summary, branch }, null, 2),
  );
  process.stdout.write(`Native agent evidence: ${fixture.directory}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  await fixture.close();
}
