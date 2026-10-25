import { readFile } from "node:fs/promises";
import { RunnerJournal } from "../../../packages/cloud-client/src/worker/journal.ts";
import { RunnerConnection } from "@machdoch/cloud-client";
import { recoverRunner } from "../../../packages/cloud-client/src/worker/recovery.ts";
import { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import type { SandboxConfiguration } from "../../../packages/cloud-client/src/worker/sandbox/configuration.ts";
import { workerLeaseReceiptSchema } from "@machdoch/fleet-protocol/cloud-execution";

const configuration = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  origin: string;
  directory: string;
  artifacts: SandboxConfiguration;
};
const connection = new RunnerConnection(
  configuration.origin,
  process.env.MACHDOCH_CLOUD_RUNNER_TOKEN!,
);
const journal = new RunnerJournal(
  configuration.directory,
  configuration.origin,
);
let sandbox: VirtualMachineSandbox | undefined;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
try {
  if (process.argv[3] === "recover") {
    await recoverRunner(journal, connection);
    process.send?.({ kind: "recovered", pending: journal.current() });
  } else {
    const job = journal.plan();
    const worker = await connection.recover(job.claimId);
    journal.bindWorker(worker.workerId);
    sandbox = await VirtualMachineSandbox.create(
      { ...configuration.artifacts, backend: "whpx" },
      {
        directory: configuration.directory,
        environmentId: job.environments[0]!.id,
      },
    );
    journal.transition("claiming");
    const anchor = await sandbox.supervisor.anchor();
    const response = await connection.claim(job.claimId);
    const claim = response.claim;
    if (!claim) throw new Error("No verification task was queued");
    journal.transition("claimed", { claim });
    journal.transition("starting");
    const vmPid = await sandbox.start(
      anchor,
      response.localStopSeconds * 1000,
      claim.manifest.profile.maxDurationSeconds * 1000,
      (request, signal) => connection.repository(claim, request, signal),
    );
    const prepared = await sandbox.call("prepare_repository", {
      commit: claim.manifest.profile.baseCommit,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const acceptAnchor = await sandbox.supervisor.anchor();
    const accepted = workerLeaseReceiptSchema.parse(
      await connection.command("accept", {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        environmentId: job.environments[0]!.id,
        baseCommit: claim.manifest.profile.baseCommit,
        isolation: "microvm",
      }),
    );
    if (accepted.instruction !== "continue")
      throw new Error("Verification claim was stopped");
    await sandbox.supervisor.renew(
      acceptAnchor,
      accepted.localStopSeconds * 1000,
    );
    journal.transition("running");
    process.send?.({
      kind: "running",
      claimId: job.claimId,
      runId: claim.runId,
      environmentId: job.environments[0]!.id,
      supervisorPid: sandbox.supervisor.processId,
      vmPid,
      receiptPath: sandbox.receiptPath,
    });
    if (process.argv[3] === "finish") {
      const finish = {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        inputDigest: claim.inputDigest,
        outcome: "failed" as const,
        stopped: true as const,
        summary: "Verification stopped",
        candidateCommit: null,
        tokensUsed: 0,
        checks: [],
      };
      journal.transition("stopping", { finish });
      const stopReceipt = await sandbox.close();
      journal.recordStop(stopReceipt);
      journal.transition("reporting");
      const completion = await connection.finish(finish);
      if (!completion.accepted)
        throw new Error("Stop receipt was not accepted");
      journal.clear();
    } else
      await new Promise<never>((_resolve, reject) => {
        const renew = async () => {
          try {
            const anchor = await sandbox!.supervisor.anchor();
            const receipt = await connection.heartbeat(claim);
            if (receipt.instruction !== "continue")
              throw new Error("Runner authority ended");
            await sandbox!.supervisor.renew(
              anchor,
              receipt.localStopSeconds * 1000,
            );
            heartbeat = setTimeout(() => void renew(), 15000);
          } catch (error) {
            reject(error);
          }
        };
        sandbox!.supervisor.signal.addEventListener(
          "abort",
          () => reject(sandbox!.supervisor.signal.reason),
          { once: true },
        );
        heartbeat = setTimeout(() => void renew(), 15000);
      });
  }
} catch (error) {
  process.send?.({
    kind: "failed",
    message:
      error instanceof Error ? error.message : "Runner verification failed",
  });
  process.exitCode = 1;
} finally {
  clearTimeout(heartbeat);
  await sandbox
    ?.close()
    .catch((error) =>
      process.stderr.write(`Environment cleanup: ${error.message}\n`),
    );
  journal.close();
  process.disconnect?.();
}
