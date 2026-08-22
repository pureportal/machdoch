import type { RalphRunRecord } from "../../../../core/ralph.js";
import type { RalphRunDetailResult } from "../../runtime.js";
import { createRalphRunResultFromDetail } from "./create-ralph-run-result-from-detail.helper.js";

const createDetail = (
  overrides: Partial<RalphRunDetailResult> = {},
): RalphRunDetailResult => ({
  path: "C:\\runs\\run-1\\run.json",
  effectiveStatus: "running",
  record: {
    schemaVersion: 1,
    id: "run-1",
    createdAt: "2026-08-04T00:00:00.000Z",
    flowId: "flow-1",
    flowName: "Flow 1",
    status: "running",
    summary: "Run is active.",
    variableValues: {},
    events: [],
    blockResults: [],
    validation: { valid: true, errors: [], warnings: [] },
  } satisfies RalphRunRecord,
  ...overrides,
});

describe("createRalphRunResultFromDetail", () => {
  it("makes an abandoned retained run recoverable without changing its record", () => {
    const detail = createDetail({ effectiveStatus: "abandoned" });

    expect(createRalphRunResultFromDetail(detail)).toMatchObject({
      status: "crashed",
      summary: "Run stopped before terminal state was persisted.",
    });
    expect(detail.record.status).toBe("running");
    expect(detail.record.summary).toBe("Run is active.");
  });

  it("preserves authoritative outcome, progress, and persistence failures", () => {
    const outcome = {
      status: "blocked" as const,
      verified: false,
      retryable: true,
      reason: "Validation is unavailable.",
      evidence: [],
      limitations: [],
    };
    const progress = {
      consecutiveNoProgress: 1,
      meaningfulTransitions: 2,
      channelFingerprints: {},
      recent: [],
    };
    const record: RalphRunRecord = {
      ...createDetail().record,
      status: "blocked",
      outcome,
      progress,
      blockResults: [
        {
          blockId: "persist",
          output: "ERROR",
          status: "error",
          attempt: 1,
          summary: "Could not persist output.",
          failure: { kind: "persistence", retryable: false },
        },
      ],
    };

    expect(
      createRalphRunResultFromDetail(
        createDetail({ record, effectiveStatus: "blocked" }),
      ),
    ).toMatchObject({
      outcome,
      progress,
      blockResults: [{ failure: { kind: "persistence", retryable: false } }],
    });
  });
});
