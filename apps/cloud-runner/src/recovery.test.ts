import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RunnerJournal } from "../../../packages/cloud-client/src/worker/journal.ts";
import { RunnerConnection } from "@machdoch/cloud-client";
import { recoverRunner } from "../../../packages/cloud-client/src/worker/recovery.ts";
import {
  claimFixture,
  grantFixture,
  finishFixture,
  stateDirectory,
  stopFixture,
} from "./test-fixture.ts";

const origin = "https://cloud.example.test";
const token = "mch_cloud_worker_" + "a".repeat(43);
await test("recovers a lost claim response without issuing another claim", async () => {
  const journal = new RunnerJournal(stateDirectory(), origin);
  const claim = claimFixture();
  const workerId = randomUUID();
  journal.plan();
  journal.transition("claiming");
  const calls: string[] = [];
  const connection = new RunnerConnection(
    origin,
    token,
    async (url, options) => {
      const endpoint = String(url).split("/").at(-1)!;
      calls.push(endpoint);
      if (endpoint === "recovery")
        return Response.json({
          workerId,
          enabled: false,
          recovery: {
            grant: grantFixture(claim),
            state: "reconciling",
            attemptState: "suspect",
            reason: "Lease expired",
            tokensUsed: 23,
          },
        });
      const finish = JSON.parse(String(options?.body));
      assert.equal(finish.outcome, "failed");
      assert.equal(finish.tokensUsed, 23);
      assert.equal(finish.attemptId, claim.attemptId);
      assert.equal(finish.summary, "Lease expired");
      return Response.json({ accepted: true, state: "failed" });
    },
  );
  try {
    await recoverRunner(journal, connection, "Local protocol failure");
    assert.equal(journal.current(), null);
    assert.deepEqual(calls, ["recovery", "finish"]);
  } finally {
    journal.close();
  }
});

await test("preserves a local failure when a claim response could not be accepted", async () => {
  const journal = new RunnerJournal(stateDirectory(), origin);
  const claim = claimFixture();
  journal.plan();
  journal.transition("claiming");
  const connection = new RunnerConnection(
    origin,
    token,
    async (url, options) => {
      if (String(url).endsWith("/recovery"))
        return Response.json({
          workerId: randomUUID(),
          enabled: true,
          recovery: {
            grant: grantFixture(claim),
            state: "preparing",
            attemptState: "preparing",
            reason: null,
            tokensUsed: 0,
          },
        });
      const finish = JSON.parse(String(options?.body));
      assert.equal(finish.summary, "Claim response was rejected");
      assert.equal(finish.outcome, "failed");
      return Response.json({ accepted: true, state: "failed" });
    },
  );
  try {
    await recoverRunner(journal, connection, "Claim response was rejected");
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});

await test("retains a started attempt when the native stop receipt is missing", async () => {
  const journal = new RunnerJournal(stateDirectory(), origin);
  const claim = claimFixture();
  journal.plan();
  journal.transition("claimed", { claim });
  journal.transition("starting");
  const connection = new RunnerConnection(origin, token, async (url) => {
    assert.ok(String(url).endsWith("/recovery"));
    return Response.json({
      workerId: randomUUID(),
      enabled: true,
      recovery: {
        grant: grantFixture(claim),
        state: "reconciling",
        attemptState: "suspect",
        reason: "Lease expired",
        tokensUsed: 0,
      },
    });
  });
  try {
    await assert.rejects(
      recoverRunner(journal, connection),
      /stop receipt is unavailable/,
    );
    assert.equal(journal.current()?.phase, "starting");
  } finally {
    journal.close();
  }
});

await test("replays the same completion after a lost response and honors server cancellation", async () => {
  const journal = new RunnerJournal(stateDirectory(), origin);
  const claim = claimFixture();
  const plan = journal.plan();
  journal.transition("claimed", { claim });
  journal.transition("starting");
  journal.transition("stopping", {
    finish: {
      ...finishFixture(claim),
      outcome: "succeeded",
      summary: "Verified",
      candidateCommit: "b".repeat(40),
    },
  });
  await writeFile(
    join(journal.directory, plan.environments[0]!.id + ".stopped.json"),
    JSON.stringify(stopFixture(plan.environments[0]!.id)),
  );
  const workerId = randomUUID();
  const finishes: unknown[] = [];
  let lost = false;
  const connection = new RunnerConnection(
    origin,
    token,
    async (url, options) => {
      if (String(url).endsWith("/recovery"))
        return Response.json({
          workerId,
          enabled: true,
          recovery: {
            grant: grantFixture(claim),
            state: "cancel_requested",
            attemptState: "stopping",
            reason: "Canceled",
            tokensUsed: 10,
          },
        });
      const finish = JSON.parse(String(options?.body));
      finishes.push(finish);
      if (!lost) {
        lost = true;
        throw new Error("Response lost");
      }
      return finish.outcome === "succeeded"
        ? Response.json({
            accepted: false,
            state: "cancel_requested",
            requiredOutcome: "canceled",
          })
        : Response.json({ accepted: true, state: "canceled" });
    },
  );
  try {
    await assert.rejects(recoverRunner(journal, connection), /Response lost/);
    assert.equal(journal.current()?.phase, "reporting");
    await recoverRunner(journal, connection);
    assert.deepEqual(finishes[0], finishes[1]);
    assert.equal((finishes[2] as { outcome: string }).outcome, "canceled");
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});

await test("does not dispatch another completion when the server already recorded stopping", async () => {
  const journal = new RunnerJournal(stateDirectory(), origin);
  const claim = claimFixture();
  const plan = journal.plan();
  journal.transition("claimed", { claim });
  journal.transition("starting");
  journal.transition("reporting", {
    finish: finishFixture(claim),
  });
  journal.recordStop(stopFixture(plan.environments[0]!.id));
  const connection = new RunnerConnection(origin, token, async (url) => {
    assert.ok(String(url).endsWith("/recovery"));
    return Response.json({
      workerId: randomUUID(),
      enabled: false,
      recovery: {
        grant: grantFixture(claim),
        state: "failed",
        attemptState: "stopped",
        reason: "Stopped",
        tokensUsed: 0,
      },
    });
  });
  try {
    await recoverRunner(journal, connection);
    assert.equal(journal.current(), null);
  } finally {
    journal.close();
  }
});
