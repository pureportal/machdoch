import { describe, expect, it } from "vitest";
import type { RalphFlow, RalphRunResult } from "../../core/ralph.js";
import {
  createInterruptedRalphRunResult,
  summarizeRun,
} from "./cli-ralph-commands.js";

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
    blockType: "ASK_USER",
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

describe("createInterruptedRalphRunResult", () => {
  it("creates a persisted crashed run shape for unexpected CLI interruptions", () => {
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "flow-1",
      name: "Refactor Flow",
      blocks: [{ id: "start", type: "START", title: "Start" }],
      edges: [],
    };
    const result = createInterruptedRalphRunResult(
      flow,
      createRunResult().validation,
      {
        runId: "run-1",
        startedAt: "2026-06-29T21:22:53.000Z",
        reason: "Execution stopped after exceeding the safety timeout.",
      },
    );

    expect(result).toMatchObject({
      runId: "run-1",
      startedAt: "2026-06-29T21:22:53.000Z",
      flow: "flow-1",
      status: "crashed",
      summary: expect.stringContaining("safety timeout"),
      events: [
        {
          type: "crash",
          blockId: "run",
          output: "ERROR",
          reason: expect.stringContaining("safety timeout"),
        },
      ],
      blockResults: [],
    });
    expect(result.finishedAt).toEqual(expect.any(String));
  });
});
