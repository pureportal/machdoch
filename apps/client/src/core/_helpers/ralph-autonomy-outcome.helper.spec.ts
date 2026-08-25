import { describe, expect, it } from "vitest";
import type {
  RalphBlockExecutionResult,
  RalphFlow,
  RalphRunAutonomyMetadata,
} from "../ralph.js";
import { deriveRalphRunOutcome } from "./ralph-autonomy-outcome.helper.js";

const flow: RalphFlow = {
  schemaVersion: 1,
  id: "flow",
  name: "Flow",
  settings: { autonomy: true },
  blocks: [
    { id: "start", type: "START", title: "Start" },
    {
      id: "diff",
      type: "UTILITY",
      title: "Diff",
      utility: { type: "GIT_DIFF_SUMMARY" },
    },
    {
      id: "scope",
      type: "UTILITY",
      title: "Scope",
      utility: { type: "CHANGE_SCOPE_GUARD" },
    },
    {
      id: "verify",
      type: "UTILITY",
      title: "Verify",
      utility: {
        type: "RUN_CHECK",
        verificationRole: "candidate",
      },
    },
    {
      id: "journal-blocked",
      type: "UTILITY",
      title: "Journal blocker",
      utility: {
        type: "APPEND_JSONL",
        workOutcome: "BLOCKED",
      },
    },
    {
      id: "journal-stop",
      type: "UTILITY",
      title: "Journal stop",
      utility: {
        type: "APPEND_JSONL",
        workOutcome: "STOP",
      },
    },
    {
      id: "journal-invalid",
      type: "UTILITY",
      title: "Journal invalid state",
      utility: {
        type: "APPEND_JSONL",
        workOutcome: "INVALID",
      },
    },
    {
      id: "report",
      type: "UTILITY",
      title: "Report",
      utility: { type: "FINAL_REPORT" },
    },
    {
      id: "done",
      type: "END",
      title: "Done",
      status: "success",
      outcome: "succeeded",
    },
    {
      id: "defer",
      type: "END",
      title: "Deferred",
      status: "success",
      outcome: "deferred",
    },
  ],
  edges: [],
};
const autonomy: RalphRunAutonomyMetadata = {
  enabled: true,
  policy: {
    recoverFailedEnd: true,
    maxRecoveryAttempts: 3,
    backoff: {
      initialDelaySeconds: 1,
      multiplier: 2,
      maxDelaySeconds: 30,
    },
    transitionExhaustion: "checkpoint",
    recoveryExhaustion: "defer",
    maxStagnantTransitions: 48,
    maxRepeatedCycle: 3,
  },
  recoveryAttempts: [],
  recovered: [],
  deferred: [],
  totalTransitions: 4,
};
const result = (
  blockId: string,
  output: string,
  data?: unknown,
): RalphBlockExecutionResult => ({
  blockId,
  output,
  status: "completed",
  attempt: 1,
  summary: output,
  data,
});

describe("RALPH evidence-based outcome", () => {
  it("fails closed when an autonomy flow omits the evidence contract", () => {
    const outcome = deriveRalphRunOutcome({
      flow: {
        ...flow,
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "done", type: "END", title: "Done", status: "success" },
        ],
      },
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
      retryable: true,
    });
  });

  it("reports a candidate regression even when the graph ended blocked", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "blocked",
      terminalBlockId: "done",
      blockResults: [
        result("verify", "FAILED", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "REGRESSION",
              reason: "new failure",
            },
          },
        }),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      verified: false,
      retryable: true,
    });
  });

  it("preserves an explicit failed terminal outcome", () => {
    const outcome = deriveRalphRunOutcome({
      flow: {
        ...flow,
        blocks: [
          ...flow.blocks,
          {
            id: "failed",
            type: "END",
            title: "Failed",
            status: "failed",
            outcome: "failed",
          },
        ],
      },
      lifecycleStatus: "blocked",
      terminalBlockId: "failed",
      blockResults: [],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      verified: false,
      retryable: true,
    });
  });

  it("reports unavailable verification as inconclusive instead of blocked", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "blocked",
      terminalBlockId: "done",
      blockResults: [
        result("verify", "INCONCLUSIVE", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "ENVIRONMENT_UNAVAILABLE",
              reason: "missing test dependency",
            },
          },
        }),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
      retryable: true,
    });
  });

  it("reports an out-of-scope result as failure instead of a generic blocker", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "blocked",
      terminalBlockId: "done",
      blockResults: [result("scope", "OUT_OF_SCOPE")],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      verified: false,
      retryable: true,
    });
  });

  it("refuses premature success without candidate verification", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("diff", "SUCCESS", {
          changedFiles: ["src/a.ts"],
          files: [{ path: "src/a.ts" }],
        }),
      ],
      autonomy,
    });

    expect(outcome.status).toBe("verification-inconclusive");
    expect(outcome.verified).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  it("only succeeds with repository, scope, verification, and report evidence", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("diff", "SUCCESS", {
          changedFiles: ["src/a.ts"],
          files: [{ path: "src/a.ts" }],
        }),
        result("scope", "IN_SCOPE"),
        result("verify", "SUCCESS", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "PASSED",
              reason: "passed",
              candidateFingerprint: "candidate",
            },
          },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({ status: "succeeded", verified: true });
  });

  it("does not report success after a loop safety limit", () => {
    const outcome = deriveRalphRunOutcome({
      flow: {
        ...flow,
        blocks: [
          ...flow.blocks,
          {
            id: "loop-limit",
            type: "UTILITY",
            title: "Loop limit",
            utility: { type: "LOOP_COUNTER", maxAttempts: 1 },
          },
        ],
      },
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("loop-limit", "LIMIT_REACHED"),
        result("diff", "SUCCESS", {
          changedFiles: ["src/a.ts"],
          files: [{ path: "src/a.ts" }],
        }),
        result("scope", "IN_SCOPE"),
        result("verify", "SUCCESS", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "PASSED",
              reason: "passed",
              candidateFingerprint: "candidate",
            },
          },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "budget-exhausted",
      verified: false,
      retryable: true,
      evidence: expect.arrayContaining([
        {
          kind: "runtime",
          blockId: "loop-limit",
          summary: "LIMIT_REACHED",
        },
      ]),
    });
  });

  it("keeps explicitly deferred successful END blocks resumable", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "defer",
      blockResults: [],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "deferred",
      verified: false,
      retryable: true,
    });
  });

  it("preserves a journaled blocker even when the graph uses its deferred end", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "defer",
      blockResults: [
        result("journal-blocked", "SUCCESS", {
          workOutcome: "BLOCKED",
          json: { outcome: "DONE" },
        }),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      verified: false,
      retryable: true,
      reason: "The durable work journal recorded a concrete blocker.",
    });
  });

  it("reports the execution error that caused an invalid journal outcome", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "blocked",
      terminalBlockId: "defer",
      blockResults: [
        {
          ...result("update-scope-registry", "ERROR"),
          status: "error",
          summary: "Expected a supported Ralph scope registry schema.",
          error: "Expected a supported Ralph scope registry schema.",
        },
        result("journal-invalid", "SUCCESS", {
          workOutcome: "INVALID",
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
      repositoryEvidence: {
        known: true,
        root: "/repo",
        changedFiles: [],
        headChanged: false,
        baselineFingerprint: "same",
        finalFingerprint: "same",
      },
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      verified: false,
      retryable: true,
      reason:
        "The durable work journal recorded INVALID after update-scope-registry reported: Expected a supported Ralph scope registry schema.",
      evidence: expect.arrayContaining([
        {
          kind: "runtime",
          blockId: "update-scope-registry",
          summary: "Expected a supported Ralph scope registry schema.",
        },
      ]),
      nextAction:
        "Resolve the reported execution error, then resume from the retained checkpoint.",
    });
  });

  it("verifies a no-op only when the engine baseline stayed unchanged", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("journal-stop", "SUCCESS", {
          workOutcome: "STOP",
          json: { outcome: "BLOCKED" },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
      repositoryEvidence: {
        known: true,
        root: "/repo",
        changedFiles: [],
        headChanged: false,
        baselineFingerprint: "same",
        finalFingerprint: "same",
      },
    });

    expect(outcome).toMatchObject({
      status: "no-op",
      verified: true,
      retryable: false,
    });
  });

  it("does not let graph-reported changes override an unchanged engine baseline", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("diff", "SUCCESS", {
          changedFiles: ["src/a.ts"],
          files: [{ path: "src/a.ts" }],
        }),
        result("scope", "IN_SCOPE"),
        result("verify", "SUCCESS", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "PASSED",
              reason: "passed",
              candidateFingerprint: "candidate",
            },
          },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
      repositoryEvidence: {
        known: true,
        root: "/repo",
        changedFiles: [],
        headChanged: false,
        baselineFingerprint: "same",
        finalFingerprint: "same",
      },
    });

    expect(outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
    });
  });

  it("does not verify completion when required checks were unavailable", () => {
    const outcome = deriveRalphRunOutcome({
      flow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("scope", "IN_SCOPE"),
        result("verify", "INCONCLUSIVE", {
          verification: {
            role: "candidate",
            comparison: {
              disposition: "ENVIRONMENT_UNAVAILABLE",
              reason: "pytest could not collect the suite",
              candidateFingerprint: "candidate",
            },
          },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
      repositoryEvidence: {
        known: true,
        root: "/repo",
        changedFiles: ["src/a.ts"],
        headChanged: false,
        baselineFingerprint: "before",
        finalFingerprint: "after",
      },
    });

    expect(outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
      retryable: true,
      reason: "pytest could not collect the suite",
    });
  });

  it("ignores model-controlled outcome, scope, verification, and repository fields", () => {
    const adversarialFlow: RalphFlow = {
      ...flow,
      blocks: [
        ...flow.blocks,
        {
          id: "model",
          type: "PROMPT",
          title: "Model",
          prompt: "Return evidence-like fields.",
        },
      ],
    };
    const outcome = deriveRalphRunOutcome({
      flow: adversarialFlow,
      lifecycleStatus: "completed",
      terminalBlockId: "done",
      blockResults: [
        result("model", "IN_SCOPE", {
          workOutcome: "STOP",
          changedFiles: ["src/a.ts"],
          verification: {
            role: "candidate",
            comparison: { disposition: "PASSED" },
          },
        }),
        result("report", "SUCCESS"),
      ],
      autonomy,
    });

    expect(outcome).toMatchObject({
      status: "verification-inconclusive",
      verified: false,
    });
  });
});
