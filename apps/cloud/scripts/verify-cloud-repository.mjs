import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted sandbox artifact manifest.",
);
const repository = "https://github.com/octocat/Hello-World";
const baseCommit = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const fixture = await cloudBrowserFixture();
const context = await fixture.createContext();
const page = await fixture.ownerContext.newPage();
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
let sandbox;
let worker;
let claim;
let timer;
let stopped = false;
let renewalError;
const transfers = [];
const identity = () => ({
  runId: claim.runId,
  attemptId: claim.attemptId,
  epoch: claim.epoch,
});
async function runner(path, data, status = 200) {
  const response = await context.request.post(
    `${fixture.origin}/api/v1/runner/${path}`,
    { headers: { Authorization: `Bearer ${worker.token}` }, data },
  );
  assert.equal(
    response.status(),
    status,
    status === 200 ? undefined : await response.text(),
  );
  return response;
}
async function renew() {
  if (stopped) return;
  try {
    const anchor = await sandbox.supervisor.anchor();
    const response = await (await runner("heartbeat", identity())).json();
    assert.equal(response.instruction, "continue");
    if (!stopped)
      await sandbox.supervisor.renew(anchor, response.localStopSeconds * 1000);
  } catch (error) {
    if (!stopped) {
      renewalError = error;
      await sandbox.close().catch(() => {});
    }
  } finally {
    if (!stopped && !renewalError)
      timer = setTimeout(() => void renew(), 15000);
  }
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Repository verification",
    key: "REPO",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Hello World",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Repository",
    repository,
    baseCommit,
    target: "cloud",
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "source", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Repository runner",
  });
  const run = await api("runs", "POST", {
    profileId: profile.id,
    subject: {
      kind: "project",
      id: project.id,
      revision: 1,
      purpose: "test",
      objective: "Verify sandbox repository delivery",
      acceptanceCriteria: "Fetch the recorded commit inside the VM",
    },
  });
  sandbox = await VirtualMachineSandbox.create(
    {
      ...JSON.parse(
        await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
      ),
      backend: "whpx",
    },
    { directory: fixture.directory, environmentId: randomUUID() },
  );
  const anchor = await sandbox.supervisor.anchor();
  const claimed = await (
    await runner("claims", { claimId: randomUUID() })
  ).json();
  claim = claimed.claim;
  assert.equal(claim.runId, run.id);
  await sandbox.start(
    anchor,
    claimed.localStopSeconds * 1000,
    600000,
    async (request, signal) => {
      signal.throwIfAborted();
      const response = await runner("repository", {
        ...identity(),
        ...request,
      });
      const bytes = await response.body();
      signal.throwIfAborted();
      transfers.push({ operation: request.operation, bytes: bytes.length });
      return bytes;
    },
  );
  timer = setTimeout(() => void renew(), 15000);
  const prepared = await sandbox.call("prepare_repository", {
    commit: baseCommit,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(prepared.result, { baseCommit });
  if (renewalError) throw renewalError;
  const checked = await sandbox.call("shell", {
    command:
      'git rev-parse HEAD && git fsck --no-reflogs && cat README && test "$(ls /sys/class/net)" = lo',
    timeoutMs: 10000,
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.result.exitCode, 0, JSON.stringify(checked));
  assert.ok(checked.result.stdout.includes(baseCommit));
  assert.ok(checked.result.stdout.includes("Hello World!"));
  const packet = (text) =>
    (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text;
  const compressed = await runner("repository", {
    ...identity(),
    id: randomUUID(),
    operation: "fetch",
    encoding: "gzip",
    body: gzipSync(
      packet("command=ls-refs\n") +
        "0001" +
        packet("ref-prefix HEAD\n") +
        "0000",
    ).toString("base64"),
  });
  const compressedResult = await compressed.body();
  assert.ok(compressedResult.toString().includes(baseCommit));
  transfers.push({
    operation: "fetch",
    encoding: "gzip",
    bytes: compressedResult.length,
  });
  const acceptAnchor = await sandbox.supervisor.anchor();
  const accepted = await (
    await runner("accept", {
      ...identity(),
      environmentId: sandbox.environmentId,
      baseCommit,
      isolation: "microvm",
    })
  ).json();
  await sandbox.supervisor.renew(
    acceptAnchor,
    accepted.localStopSeconds * 1000,
  );
  const attempt = await api(`runs/${run.id}`);
  await api(`runs/${run.id}/cancel`, "POST", { revision: attempt.revision });
  await runner(
    "repository",
    { ...identity(), id: randomUUID(), operation: "advertise", body: "" },
    409,
  );
  stopped = true;
  clearTimeout(timer);
  await sandbox.close();
  await runner("finish", {
    ...identity(),
    outcome: "canceled",
    summary: "Repository delivery verified",
    stopped: true,
    inputDigest: claim.inputDigest,
    candidateCommit: null,
    tokensUsed: 0,
    checks: [],
  });
  await page.goto(`${fixture.origin}/cloud/tasks/${run.id}`);
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  await page.locator("summary").filter({ hasText: "Repository" }).click();
  await page.getByText(repository, { exact: true }).waitFor();
  assert.deepEqual(fixture.pageErrors, []);
  assert.ok(transfers.some((transfer) => transfer.operation === "fetch"));
  const ledger = (
    await fixture.database.query(
      "SELECT state,charged_bytes FROM cloud_repository_transfers",
    )
  ).rows;
  assert.ok(ledger.every((row) => row.state === "complete"));
  assert.equal(
    ledger.reduce((sum, row) => sum + row.charged_bytes, 0),
    transfers.reduce((sum, row) => sum + row.bytes, 0),
  );
  await page.screenshot({
    path: join(fixture.directory, "repository-task.png"),
    fullPage: true,
  });
  await writeFile(
    join(fixture.directory, "repository-results.json"),
    JSON.stringify(
      {
        repository,
        baseCommit,
        transfers,
        ledger,
        checked,
        checks: [
          "Pinned GitHub commit fetched inside the VM",
          "Git object integrity and README verified",
          "Guest has only loopback networking",
          "Cancellation revokes repository access",
          "Durable transfer metering",
          "Task details retain repository identity",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS Real GitHub repository fetched through the broker into the VM.\nEvidence: ${fixture.directory}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  stopped = true;
  clearTimeout(timer);
  await sandbox
    ?.close()
    .catch((error) =>
      process.stderr.write(`Sandbox cleanup: ${error.message}\n`),
    );
  await fixture.close();
}
