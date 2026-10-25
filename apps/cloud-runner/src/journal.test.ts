import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RunnerJournal, runnerJobSchema } from "../../../packages/cloud-client/src/worker/journal.ts";
import {
  stateDirectory,
  claimFixture,
  finishFixture,
  stopFixture,
} from "./test-fixture.ts";

await test("an exclusive journal blocks another process and survives a forced owner crash", async () => {
  const directory = stateDirectory();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "@oxc-node/core/register",
      fileURLToPath(
        new URL("../scripts/journal-process-fixture.ts", import.meta.url),
      ),
      directory,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  const guard = setTimeout(() => child.kill(), 8000);
  try {
    const [message] = await once(child, "message");
    const job = runnerJobSchema.parse(message);
    assert.throws(
      () => new RunnerJournal(directory, "https://cloud.example.test"),
      /locked/,
    );
    child.kill();
    await exited;
    const restored = new RunnerJournal(directory, "https://cloud.example.test");
    try {
      assert.deepEqual(restored.current(), job);
    } finally {
      restored.close();
    }
  } finally {
    clearTimeout(guard);
    child.kill();
    await exited;
  }
});

await test("pins cloud and worker identity without storing a credential", () => {
  const directory = stateDirectory();
  const workerId = randomUUID();
  const journal = new RunnerJournal(directory, "https://cloud.example.test");
  journal.bindWorker(workerId);
  journal.close();
  assert.throws(
    () => new RunnerJournal(directory, "https://other.example.test"),
    /another cloud/,
  );
  const restored = new RunnerJournal(directory, "https://cloud.example.test");
  try {
    restored.bindWorker(workerId);
    assert.throws(
      () => restored.bindWorker(randomUUID()),
      /another enrolled runner/,
    );
  } finally {
    restored.close();
  }
});

await test("never clears a launch intent without a native stop receipt", () => {
  const journal = new RunnerJournal(
    stateDirectory(),
    "https://cloud.example.test",
  );
  try {
    const plan = journal.plan();
    const claim = claimFixture();
    journal.transition("claimed", { claim });
    journal.transition("starting");
    journal.transition("reporting", { finish: finishFixture(claim) });
    assert.throws(() => journal.clear(), /native stop receipt/);
    assert.throws(() => journal.transition("claimed"), /cannot move back/);
    assert.throws(
      () => journal.recordStop(stopFixture(randomUUID())),
      /another environment/,
    );
    journal.recordStop(stopFixture(plan.environments[0]!.id));
    assert.throws(
      () =>
        journal.recordStop({
          ...stopFixture(plan.environments[0]!.id),
          reason: "completed",
        }),
      /cannot be replaced/,
    );
    journal.clear();
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});

await test("rejects replacement grants and cross-task completions", () => {
  const journal = new RunnerJournal(
    stateDirectory(),
    "https://cloud.example.test",
  );
  try {
    journal.plan();
    const claim = claimFixture();
    journal.transition("claimed", { claim });
    assert.throws(
      () => journal.transition("claimed", { claim: claimFixture() }),
      /cannot be replaced/,
    );
    assert.throws(
      () =>
        journal.transition("claimed", {
          claim: {
            ...claim,
            manifest: { ...claim.manifest, objective: "Changed objective" },
          },
        }),
      /cannot be replaced/,
    );
    assert.throws(
      () =>
        journal.transition("reporting", {
          finish: finishFixture(claimFixture()),
        }),
      /another task grant/,
    );
    assert.throws(() => journal.plan(), /Recover the current task/);
  } finally {
    journal.close();
  }
});

await test("requires stop receipts for every launched verification environment", () => {
  const journal = new RunnerJournal(
    stateDirectory(),
    "https://cloud.example.test",
  );
  try {
    const plan = journal.plan();
    const claim = claimFixture();
    journal.transition("claimed", { claim });
    journal.transition("starting");
    journal.transition("running");
    assert.throws(
      () => journal.addEnvironment("validation"),
      /Stop the active/,
    );
    journal.recordStop(stopFixture(plan.environments[0]!.id));
    const validator = journal.addEnvironment("validation");
    const prepared = journal.addEnvironment("agent");
    journal.requestLaunch(validator.id);
    assert.throws(() => journal.requestLaunch(prepared.id), /Stop the active/);
    journal.transition("reporting", { finish: finishFixture(claim) });
    assert.throws(() => journal.clear(), /native stop receipt/);
    const receipt = stopFixture(validator.id);
    journal.recordStop(receipt);
    journal.recordStop(
      Object.fromEntries(Object.entries(receipt).reverse()) as typeof receipt,
    );
    journal.clear();
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});
