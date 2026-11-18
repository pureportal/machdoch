import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  RunActivityStatus,
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import type {
  ArtifactInput,
  VerificationEvidence,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import {
  RunnerConnection,
  isTransientRunnerError,
} from "@machdoch/cloud-client";
import { uploadArtifact } from "./artifact-uploader.ts";
import { runAgent, authorize, type TaskUsage } from "./agent-loop.ts";
import { TaskEnvironments } from "./task-environments.ts";
import { reviewCandidate } from "./review.ts";
import { maximumReviewRounds } from "@machdoch/fleet-protocol/cloud-delivery";
import {
  artifactDescriptorSchema,
  guest,
  exportBytes,
  shell,
  requireShell,
  type ActiveEnvironment,
} from "./guest-operations.ts";

function boundedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return new TextDecoder("utf8").decode(bytes.subarray(0, 120 * 1024), {
    stream: bytes.length > 120 * 1024,
  });
}
async function storeBytes(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  kind: ArtifactInput["kind"],
  name: string,
  bytes: Buffer,
  candidateCommit: string,
) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await uploadArtifact(
    (operation, input) =>
      connection.command(`artifacts/${operation}`, input, environment.signal),
    { runId: claim.runId, attemptId: claim.attemptId, epoch: claim.epoch },
    {
      artifactId: randomUUID(),
      kind,
      name,
      byteLength: bytes.length,
      sha256,
      inputDigest: claim.inputDigest,
      candidateCommit,
    },
    async (offset, length) => bytes.subarray(offset, offset + length),
  );
  return sha256;
}
async function collect(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  name: string,
  kind: ArtifactInput["kind"],
  candidateCommit: string,
): Promise<Buffer> {
  const descriptor = await guest(
    environment,
    "describe_artifact",
    { path: name },
    artifactDescriptorSchema,
  );
  const bytes = await exportBytes(environment, name, descriptor.byteLength);
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256)
    throw new Error("Candidate artifact changed during export");
  await storeBytes(
    connection,
    claim,
    environment,
    kind,
    name,
    bytes,
    candidateCommit,
  );
  return bytes;
}
async function reportActivity(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environment: ActiveEnvironment,
  title: string,
  status: RunActivityStatus,
  detail = "",
): Promise<void> {
  try {
    await connection.command(
      "activity",
      {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        entries: [{ title, status, detail: detail.slice(0, 2000) }],
      },
      environment.signal,
    );
  } catch (error) {
    if (!isTransientRunnerError(error)) throw error;
  }
}

async function runChecks(
  connection: RunnerConnection,
  claim: WorkerClaim,
  validator: ActiveEnvironment,
  candidateCommit: string,
): Promise<{
  receipts: WorkerFinish["checks"];
  failed: VerificationEvidence[];
}> {
  const receipts: WorkerFinish["checks"] = [];
  const failed: VerificationEvidence[] = [];
  for (const check of claim.manifest.profile.requiredChecks) {
    await authorize(connection, claim, validator, "validating");
    const started = performance.now();
    const result = await shell(
      validator,
      check.command,
      check.timeoutSeconds * 1000,
      claim.manifest.profile.workspacePath,
    );
    const stdout = boundedText(result.stdout),
      stderr = boundedText(result.stderr);
    const record: VerificationEvidence = {
      ...result,
      stdout,
      stderr,
      truncated:
        result.truncated ||
        stdout !== result.stdout ||
        stderr !== result.stderr,
      name: check.name,
      command: check.command,
      candidateCommit,
      durationMs: Math.round(performance.now() - started),
    };
    const evidenceDigest = await storeBytes(
      connection,
      claim,
      validator,
      "verification",
      `check-${receipts.length + 1}.json`,
      Buffer.from(JSON.stringify(record)),
      candidateCommit,
    );
    const passed =
      record.exitCode === 0 && record.signal === null && !record.timedOut;
    await reportActivity(
      connection,
      claim,
      validator,
      `Check ${check.name} ${passed ? "passed" : "failed"}`,
      passed ? "passed" : "failed",
      check.command,
    );
    receipts.push({
      name: check.name,
      passed,
      candidateCommit,
      evidenceDigest,
    });
    if (!passed) failed.push(record);
  }
  await requireShell(
    validator,
    'git -c core.fsmonitor=false diff --no-ext-diff --no-textconv --exit-code HEAD -- && test -z "$(git -c core.fsmonitor=false diff --cached --name-only)"',
  );
  return { receipts, failed };
}

export async function executePullRequestCheck(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environments: TaskEnvironments,
  initial: ActiveEnvironment,
  usage: TaskUsage,
): Promise<WorkerFinish> {
  const agentResult = await runAgent(connection, claim, initial, usage);
  await environments.close(initial.sandbox.environmentId);
  const head = environments.baseCommit;
  const validator = await environments.launch(claim, "validation");
  await authorize(connection, claim, validator, "validating");
  await reportActivity(
    connection,
    claim,
    validator,
    "Validating in a fresh VM",
    "started",
  );
  const { receipts } = await runChecks(connection, claim, validator, head);
  await reportActivity(
    connection,
    claim,
    validator,
    "Review round 1 started",
    "started",
  );
  await reviewCandidate(connection, claim, validator, usage, head, 1);
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: agentResult.status === "executed" ? "succeeded" : "failed",
    stopped: true,
    summary: agentResult.summary.slice(0, 20000),
    candidateCommit: head,
    tokensUsed: usage.tokens,
    checks: receipts,
  };
}

export async function executeTask(
  connection: RunnerConnection,
  claim: WorkerClaim,
  environments: TaskEnvironments,
  initial: ActiveEnvironment,
  usage: TaskUsage,
  repairAttempts: number,
): Promise<WorkerFinish> {
  let agent = initial;
  let previousTree: string | null = null;
  let correction = environments.merge
    ? JSON.stringify({ conflictedFiles: environments.merge.conflicts })
    : "";
  let repairs = 0;
  let reviewRound = 0;
  while (true) {
    const agentResult = await runAgent(
      connection,
      claim,
      agent,
      usage,
      correction,
    );
    const summary = agentResult.summary;
    await authorize(connection, claim, agent, "validating");
    const candidate = await guest(
      agent,
      "snapshot_candidate",
      {
        baseCommit: environments.baseCommit,
        ...(environments.merge
          ? { mergeParent: environments.merge.parent }
          : {}),
      },
      z.strictObject({
        candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
        tree: z.string().regex(/^[a-f0-9]{40}$/),
      }),
    );
    if (candidate.tree === previousTree)
      throw new Error(
        reviewRound
          ? "The review requested changes and the agent did not change the candidate"
          : "Verification failed and the agent did not change the candidate",
      );
    previousTree = candidate.tree;
    const bundle = await collect(
      connection,
      claim,
      agent,
      "candidate.bundle",
      "candidate",
      candidate.candidateCommit,
    );
    await collect(
      connection,
      claim,
      agent,
      "changes.patch",
      "diff",
      candidate.candidateCommit,
    );
    await reportActivity(
      connection,
      claim,
      agent,
      "Candidate captured",
      "passed",
      candidate.candidateCommit,
    );
    await environments.close(agent.sandbox.environmentId);
    if (agentResult.status !== "executed")
      return {
        runId: claim.runId,
        attemptId: claim.attemptId,
        epoch: claim.epoch,
        inputDigest: claim.inputDigest,
        outcome: "failed",
        summary,
        stopped: true,
        candidateCommit: candidate.candidateCommit,
        tokensUsed: usage.tokens,
        checks: [],
      };
    const validator = await environments.launch(claim, "validation", {
      bytes: bundle,
      candidateCommit: candidate.candidateCommit,
    });
    await reportActivity(
      connection,
      claim,
      validator,
      "Validating in a fresh VM",
      "started",
    );
    const { receipts, failed } = await runChecks(
      connection,
      claim,
      validator,
      candidate.candidateCommit,
    );
    const finished = (outcome: "failed" | "succeeded", text: string) => ({
      runId: claim.runId,
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      inputDigest: claim.inputDigest,
      outcome,
      stopped: true as const,
      summary: text,
      candidateCommit: candidate.candidateCommit,
      tokensUsed: usage.tokens,
      checks: receipts,
    });
    if (failed.length) {
      if (repairs >= repairAttempts)
        return finished(
          "failed",
          `Verification failed: ${failed.map((check) => check.name).join(", ")}.`,
        );
      repairs++;
      correction = JSON.stringify({
        instruction:
          "Repair the candidate using these failed verification results. The runner executes these commands independently. Do not change the verification commands.",
        failed: failed.map(({ name, command, exitCode, stderr, stdout }) => ({
          name,
          command,
          exitCode,
          stderr: stderr.slice(-3000),
          stdout: stdout.slice(-3000),
        })),
      });
    } else {
      reviewRound++;
      await authorize(connection, claim, validator, "validating");
      await reportActivity(
        connection,
        claim,
        validator,
        `Review round ${reviewRound} started`,
        "started",
      );
      const review = await reviewCandidate(
        connection,
        claim,
        validator,
        usage,
        candidate.candidateCommit,
        reviewRound,
      );
      if (review.decision === "approve" || reviewRound >= maximumReviewRounds)
        return finished(
          "succeeded",
          `${summary.slice(0, 15000)}\n\nChecks passed: ${receipts.map((check) => check.name).join(", ") || "none configured"}.`,
        );
      correction = JSON.stringify({
        instruction:
          "An independent reviewer requested changes. Fix every blocking finding in the current candidate, keep the existing tests meaningful, and do not change the verification commands.",
        review: review.summary,
        findings: review.findings.filter(
          (finding) => finding.severity === "blocking",
        ),
      });
    }
    await environments.close(validator.sandbox.environmentId);
    agent = await environments.launch(claim, "agent", {
      bytes: bundle,
      candidateCommit: candidate.candidateCommit,
    });
  }
}
