import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CloudRunner } from "../../../packages/cloud-client/src/worker/runner.ts";
import { RunnerConnection } from "@machdoch/cloud-client";
import { RunnerJournal } from "../../../packages/cloud-client/src/worker/journal.ts";
import { TaskEnvironments } from "../../../packages/cloud-client/src/worker/task-environments.ts";
import { claimFixture, stateDirectory } from "./test-fixture.ts";
import type { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import type { RunnerConfiguration } from "../../../packages/cloud-client/src/worker/configuration.ts";

function configuration(directory: string): RunnerConfiguration {
  const artifact = { path: process.execPath, sha256: "a".repeat(64) };
  return {
    origin: "https://cloud.example.test",
    stateDirectory: directory,
    pollIntervalMs: 1000,
    repairAttempts: 0,
    sandbox: {
      backend: "whpx",
      supervisor: artifact,
      qemu: artifact,
      kernel: artifact,
      image: artifact,
      initramfs: artifact,
    },
  };
}

await test("rejects a client worker before preparing an environment or claiming its queued task", async (context) => {
  const directory = stateDirectory();
  const journal = new RunnerJournal(directory, "https://cloud.example.test");
  const workerId = randomUUID();
  const endpoints: string[] = [];
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    "mch_cloud_worker_" + "a".repeat(43),
    async (url) => {
      const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
      endpoints.push(endpoint);
      if (endpoint === "availability")
        return Response.json({ workerId, enabled: true, available: true });
      assert.equal(endpoint, "registration");
      return Response.json({
        workerId,
        organizationId: randomUUID(),
        projectName: "Client project",
        profile: { ...claimFixture().manifest.profile, target: "client-linux" },
        workspaceBinding: null,
      });
    },
  );
  const prepare = context.mock.method(
    TaskEnvironments.prototype,
    "prepare",
    async () => {
      throw new Error("Unexpected environment preparation");
    },
  );
  try {
    await assert.rejects(
      new CloudRunner(configuration(directory), connection, journal, {
        kind: "cloud",
      }).runNext(new AbortController().signal),
      /Enroll a worker for a cloud profile/,
    );
    assert.deepEqual(endpoints, ["availability", "registration"]);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});

await test("closes prepared environments even if journaling the failed outcome throws", async (context) => {
  const claim = claimFixture();
  claim.manifest.profile.target = "client-linux";
  const directory = stateDirectory();
  const journal = new RunnerJournal(directory, "https://cloud.example.test");
  const workerId = randomUUID();
  const connection = new RunnerConnection(
    "https://cloud.example.test",
    "mch_cloud_worker_" + "a".repeat(43),
    async (url) => {
      if (String(url).endsWith("/availability"))
        return Response.json({
          workerId,
          enabled: true,
          available: true,
        });
      if (String(url).endsWith("/registration"))
        return Response.json({
          workerId,
          organizationId: randomUUID(),
          projectName: "Cloud project",
          profile: { ...claim.manifest.profile, target: "cloud" },
          workspaceBinding: null,
        });
      assert.ok(String(url).endsWith("/claims"));
      return Response.json({ claim, localStopSeconds: 60 });
    },
  );
  let closed = false;
  context.mock.method(
    TaskEnvironments.prototype,
    "prepare",
    async () =>
      ({
        supervisor: { anchor: async () => "anchor" },
      }) as unknown as VirtualMachineSandbox,
  );
  context.mock.method(TaskEnvironments.prototype, "closeAll", async () => {
    closed = true;
  });
  const transition = journal.transition.bind(journal);
  context.mock.method(
    journal,
    "transition",
    (
      phase: Parameters<RunnerJournal["transition"]>[0],
      changes?: Parameters<RunnerJournal["transition"]>[1],
    ) => {
      if (phase === "reporting") throw new Error("Journal write failed");
      return transition(phase, changes);
    },
  );
  const runner = new CloudRunner(
    configuration(directory),
    connection,
    journal,
    { kind: "cloud" },
  );
  try {
    await assert.rejects(
      runner.runNext(new AbortController().signal),
      /Journal write failed/,
    );
    assert.equal(closed, true);
  } finally {
    journal.close();
  }
});
