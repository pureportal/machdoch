import { describe, expect, it } from "vitest";
import type { RalphRunResult } from "../../core/ralph.js";
import { summarizeRun } from "./cli-ralph-commands.js";

const createRunResult = (
  overrides: Partial<RalphRunResult> = {},
): RalphRunResult => ({
  runId: "run-1",
  flow: "flow-1",
  status: "waiting-for-input",
  summary: "Waiting for input.",
  missingVariables: [],
  unknownVariables: [],
  events: [],
  blockResults: [],
  validation: {
    valid: true,
    errors: [],
    warnings: [],
    errorIssues: [],
    warningIssues: [],
    variables: [],
  },
  pendingInput: {
    id: "request-1",
    runId: "run-1",
    blockId: "input",
    blockType: "INPUT",
    title: "Configure Template",
    fields: [],
    createdAt: "2026-06-26T00:00:00.000Z",
  },
  ...overrides,
});

describe("summarizeRun", () => {
  it("preserves the run id so desktop input requests can resume", () => {
    expect(summarizeRun(createRunResult())).toMatchObject({
      runId: "run-1",
      flow: "flow-1",
      status: "waiting-for-input",
      pendingInput: expect.objectContaining({
        id: "request-1",
      }),
    });
  });
});
