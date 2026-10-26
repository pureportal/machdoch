import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerJournal } from "../../../packages/cloud-client/src/worker/journal.ts";
import { readStopReceipt } from "@machdoch/cloud-client/stop-receipt";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted sandbox artifact manifest.",
);
const artifacts = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
let dropFinish = false;
let finishRequests = 0;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) => {
    if (path === "/api/v1/runner/finish") {
      finishRequests++;
      if (dropFinish && status === 200) {
        dropFinish = false;
        return true;
      }
    }
    return false;
  },
});
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const children = new Set();
const checks = [];
let worker;
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
function launch(path, mode) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "@oxc-node/core/register",
      fileURLToPath(new URL("../../cloud-runner/scripts/runner-recovery-fixture.ts", import.meta.url)),
      path,
      mode,
    ],
    {
      cwd: fileURLToPath(new URL("../../cloud-runner/", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        NODE_EXTRA_CA_CERTS: join(fixture.directory, "tls.crt"),
        MACHDOCH_CLOUD_RUNNER_TOKEN: worker.token,
      },
    },
  );
  children.add(child);
  let logs = "";
  child.stdout.on("data", (bytes) => {
    logs = (logs + bytes).slice(-8000);
  });
  child.stderr.on("data", (bytes) => {
    logs = (logs + bytes).slice(-8000);
  });
  child.finished = once(child, "exit");
  child.logs = () => logs;
  child.message = new Promise((resolveMessage, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Runner did not report readiness: ${logs}`)),
      45000,
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      resolveMessage(message);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Runner exited before reporting: ${logs}`));
    });
  });
  return child;
}
async function gone(pid) {
  await assertEventually(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}
async function configure(name) {
  const directory = join(fixture.directory, name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "configuration.json");
  await writeFile(
    path,
    JSON.stringify({ origin: fixture.origin, directory, artifacts }),
  );
  return { path, directory };
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Recovery",
    key: "REC",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Recovery",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Recovery",
    target: "cloud",
    repository: "https://github.com/octocat/Hello-World",
    baseCommit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 600,
    maxTokens: 10000,
    requiredChecks: [{ name: "unit", command: "node --test", timeoutSeconds: 60 }],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Recoverable worker",
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    projectId: project.id,
    title: "Recover an interrupted runner",
    acceptanceCriteria: "No second writer before confirmed cleanup",
  });
  const input = {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  };
  const first = await api("runs", "POST", input);
  const config = await configure("parent-crash");
  const runner = launch(config.path, "run");
  const started = await runner.message;
  assert.equal(
    started.kind,
    "running",
    JSON.stringify(started) + runner.logs(),
  );
  assert.equal(started.runId, first.id);
  assert.throws(
    () => new RunnerJournal(config.directory, fixture.origin),
    /locked/,
  );
  await page.goto(`${fixture.origin}/cloud/tasks/${first.id}`);
  await page.getByRole("status").filter({ hasText: "running" }).waitFor();
  runner.kill();
  await runner.finished;
  await assertEventually(
    async () =>
      (await readStopReceipt(started.receiptPath, started.environmentId)) !==
      null,
  );
  await gone(started.vmPid);
  await gone(started.supervisorPid);
  const beforeRecovery = (
    await fixture.database.query(
      "SELECT count(*)::integer AS count FROM cloud_run_attempts WHERE run_id=$1",
      [first.id],
    )
  ).rows[0].count;
  const recovery = launch(config.path, "recover");
  assert.deepEqual(await recovery.message, {
    kind: "recovered",
    pending: null,
  });
  assert.equal((await recovery.finished)[0], 0, recovery.logs());
  await page.getByRole("status").filter({ hasText: "failed" }).waitFor();
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::integer AS count FROM cloud_run_attempts WHERE run_id=$1",
        [first.id],
      )
    ).rows[0].count,
    beforeRecovery,
  );
  const journal = new RunnerJournal(config.directory, fixture.origin);
  assert.equal(journal.current(), null);
  journal.close();
  passed(
    "A killed runner leaves a native stop receipt and restart settles the original claim without another attempt",
  );
  await page.screenshot({
    path: join(fixture.directory, "runner-recovered.png"),
    fullPage: true,
  });

  const completed = await api("runs", "POST", input);
  const completionConfig = await configure("completion-response-loss");
  dropFinish = true;
  const completing = launch(completionConfig.path, "finish");
  assert.equal((await completing.message).kind, "running", completing.logs());
  assert.equal((await completing.finished)[0], 1);
  assert.equal(dropFinish, false);
  assert.equal((await api(`runs/${completed.id}`)).state, "failed");
  const completionJournal = new RunnerJournal(
    completionConfig.directory,
    fixture.origin,
  );
  assert.equal(completionJournal.current().phase, "reporting");
  completionJournal.close();
  const beforeCompletionRecovery = finishRequests;
  const completedRecovery = launch(completionConfig.path, "recover");
  assert.deepEqual(await completedRecovery.message, {
    kind: "recovered",
    pending: null,
  });
  assert.equal(
    (await completedRecovery.finished)[0],
    0,
    completedRecovery.logs(),
  );
  assert.equal(finishRequests, beforeCompletionRecovery);
  passed(
    "A lost completion response is reconciled from the durable server result without another completion request",
  );

  const second = await api("runs", "POST", input);
  const uncertainConfig = await configure("supervisor-crash");
  const uncertain = launch(uncertainConfig.path, "run");
  const active = await uncertain.message;
  assert.equal(
    active.kind,
    "running",
    JSON.stringify(active) + uncertain.logs(),
  );
  process.kill(active.supervisorPid);
  await gone(active.vmPid);
  uncertain.kill();
  await uncertain.finished;
  assert.equal(
    await readStopReceipt(active.receiptPath, active.environmentId),
    null,
  );
  await fixture.database.query(
    "UPDATE cloud_run_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",
    [second.id],
  );
  const refused = launch(uncertainConfig.path, "recover");
  const failure = await refused.message;
  assert.equal(failure.kind, "failed");
  assert.match(failure.message, /stop receipt is unavailable/);
  assert.equal((await refused.finished)[0], 1);
  const retained = new RunnerJournal(uncertainConfig.directory, fixture.origin);
  assert.equal(retained.current().environments.some((environment) => environment.launchRequested), true);
  retained.close();
  await page.goto(`${fixture.origin}/cloud/tasks/${second.id}`);
  await page.getByRole("status").filter({ hasText: "reconciling" }).waitFor();
  await assert.rejects(api("runs", "POST", input), /409/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "runner-unconfirmed-mobile.png"),
    fullPage: true,
  });
  passed(
    "A missing native receipt preserves the journal and issue reservation after a forced supervisor crash",
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "runner-recovery-results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        stopped: await readStopReceipt(
          started.receiptPath,
          started.environmentId,
        ),
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Runner recovery evidence: ${fixture.directory}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.finished;
  }
  await fixture.close();
}
