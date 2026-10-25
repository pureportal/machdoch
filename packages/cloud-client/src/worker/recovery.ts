import { join } from "node:path";
import type {
  WorkerGrantIdentity,
  WorkerFinish,
  RunState,
} from "@machdoch/fleet-protocol/cloud-execution";
import { RunnerConnection } from "@machdoch/cloud-client";
import { RunnerJournal } from "./journal.ts";
import { readStopReceipt } from "@machdoch/cloud-client/stop-receipt";

function interrupted(
  claim: WorkerGrantIdentity,
  tokensUsed: number,
  reason: string | null,
): WorkerFinish {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: "failed",
    stopped: true,
    summary:
      reason ??
      "The runner stopped before completing this task. Start a new task to continue.",
    candidateCommit: null,
    tokensUsed,
    checks: [],
  };
}

export async function recoverRunner(
  journal: RunnerJournal,
  connection: RunnerConnection,
  interruptionReason?: string,
): Promise<{ runId: string; state: RunState } | null> {
  const job = journal.current();
  if (!job) return null;
  const response = await connection.recover(job.claimId);
  journal.bindWorker(response.workerId);
  const recovered = response.recovery;
  if (!recovered) {
    if (
      job.grant ||
      job.environments.some((environment) => environment.launchRequested)
    )
      throw new Error(
        "The cloud no longer has this journaled claim. Preserve the runner state for reconciliation.",
      );
    journal.clear();
    return null;
  }
  if (
    job.grant &&
    (job.grant.runId !== recovered.grant.runId ||
      job.grant.attemptId !== recovered.grant.attemptId ||
      job.grant.inputDigest !== recovered.grant.inputDigest ||
      job.grant.epoch !== recovered.grant.epoch)
  )
    throw new Error(
      "Recovered task identity does not match the runner journal",
    );
  for (const environment of job.environments) {
    const receipt =
      environment.stopReceipt ??
      (await readStopReceipt(
        join(journal.directory, environment.id + ".stopped.json"),
        environment.id,
      ));
    if (environment.launchRequested && !receipt)
      throw new Error(
        "The environment's stop receipt is unavailable. Preserve the runner state and reconcile the environment before claiming another task.",
      );
    if (receipt) journal.recordStop(receipt);
  }
  let finish =
    job.finish ??
    interrupted(
      recovered.grant,
      recovered.tokensUsed,
      recovered.reason ?? (interruptionReason?.trim().slice(0, 20000) || null),
    );
  journal.transition("reporting", {
    grant: recovered.grant,
    finish,
  });
  let state = recovered.state;
  if (recovered.attemptState !== "stopped") {
    let result = await connection.finish(finish);
    if (!result.accepted) {
      finish = {
        ...finish,
        outcome: result.requiredOutcome,
        summary:
          recovered.reason ??
          "Execution authority ended before the task could complete.",
      };
      journal.transition("reporting", { finish });
      result = await connection.finish(finish);
    }
    if (!result.accepted)
      throw new Error("The cloud did not accept the runner's stop receipt");
    state = result.state;
  }
  journal.clear();
  return { runId: recovered.grant.runId, state };
}
