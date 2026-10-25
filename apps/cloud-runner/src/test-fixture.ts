import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WorkerClaim,
  WorkerFinish,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { StopReceipt } from "@machdoch/cloud-client/stop-receipt";

export function stateDirectory(): string {
  const root = fileURLToPath(
    new URL("../../../.tmp/cloud-runner-state-tests/", import.meta.url),
  );
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "case-"));
}
export function claimFixture(): WorkerClaim {
  const projectId = randomUUID();
  const providerId = randomUUID();
  return {
    runId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
    inputDigest: "a".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 90000).toISOString(),
    deadlineAt: new Date(Date.now() + 3600000).toISOString(),
    manifest: {
      contextLimitBytes: 32768,
      subject: {
        kind: "project",
        id: projectId,
        revision: 1,
        purpose: "test",
        objective: "Verify recovery",
        acceptanceCriteria: "No duplicate execution",
      },
      title: "Verify recovery",
      objective: "Verify recovery",
      acceptanceCriteria: "No duplicate execution",
      actorId: randomUUID(),
      profile: {
        id: randomUUID(),
        revision: 1,
        enabled: true,
        teamId: randomUUID(),
        projectId,
        name: "Runner",
        target: "cloud",
        repository: "https://github.com/example/project",
        baseCommit: "b".repeat(40),
        providerId,
        model: "fixture",
        maxDurationSeconds: 3600,
        maxTokens: 10000,
        requiredChecks: [
          { name: "unit", command: "node --test", timeoutSeconds: 60 },
        ],
      },
      provider: {
        id: providerId,
        name: "Provider",
        provider: "openai",
        inferenceRevision: 1,
        maxOutputTokens: 512,
      },
    },
  };
}
export function finishFixture(claim: WorkerClaim): WorkerFinish {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
    outcome: "failed",
    summary: "Runner stopped",
    stopped: true,
    candidateCommit: null,
    tokensUsed: 0,
    checks: [],
  };
}
export function grantFixture(claim: WorkerClaim) {
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    epoch: claim.epoch,
    inputDigest: claim.inputDigest,
  };
}
export function stopFixture(environmentId: string): StopReceipt {
  return {
    version: 1,
    environmentId,
    supervisorPid: 123,
    childPid: 124,
    exitCode: 1,
    reason: "parent_closed",
    processTreeStopped: true,
  };
}
