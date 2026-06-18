import type {
  RalphBlockExecutionResult,
  RalphRunRecord,
  RalphRunResult,
} from "../ralph.ts";
import { createExecutionResult, createFlow } from "../__test__/ralph-test-helpers.ts";
import { MAX_RALPH_RESULT_CHARS } from "./parse-ralph-decision.helper.ts";
import {
  capRalphRunRecordValue,
  createRalphRunRecord,
  createRalphRunRecordBlock,
  createRalphRunSummaryFromRecord,
  isRalphRunRecord,
} from "./create-ralph-run-record.helper.ts";

const SCHEMA_VERSION = 1;
const TRUNCATION_MARKER = `\n[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]`;

const createBlockResult = (
  overrides: Partial<RalphBlockExecutionResult> = {},
): RalphBlockExecutionResult => ({
  blockId: "fix",
  output: "SUCCESS",
  status: "completed",
  attempt: 1,
  summary: "Fixed issue.",
  ...overrides,
});

const createRunResult = (
  overrides: Partial<RalphRunResult> = {},
): RalphRunResult => ({
  runId: "run-1",
  startedAt: "2026-06-18T10:00:00.000Z",
  finishedAt: "2026-06-18T10:01:00.000Z",
  flow: "flow-1",
  status: "completed",
  summary: "Run completed.",
  events: [
    {
      type: "end",
      blockId: "end",
      status: "completed",
      summary: "Done.",
    },
  ],
  blockResults: [createBlockResult()],
  missingVariables: [],
  unknownVariables: [],
  validation: {
    valid: true,
    errors: [],
    warnings: [],
    errorIssues: [],
    warningIssues: [],
    variables: [],
  },
  ...overrides,
});

const createRecord = (
  overrides: Partial<RalphRunRecord> = {},
): RalphRunRecord => ({
  schemaVersion: SCHEMA_VERSION,
  id: "run-1",
  createdAt: "2026-06-18T10:00:00.000Z",
  flowId: "flow-1",
  flowName: "Flow",
  flowRevisionId: null,
  status: "completed",
  summary: "Run completed.",
  variableValues: {},
  events: [],
  blockResults: [],
  validation: {
    valid: true,
    errors: [],
    warnings: [],
  },
  ...overrides,
});

describe("createRalphRunRecord", () => {
  it("creates a run record with flow metadata, validation summary, log paths, and capped values", () => {
    const longText = "x".repeat(MAX_RALPH_RESULT_CHARS + 1);
    const flow = createFlow({
      id: "flow-1",
      name: "Flow",
      createdAt: "2026-06-18T09:00:00.000Z",
      updatedAt: "2026-06-18T09:30:00.000Z",
    });
    const runResult = createRunResult({
      summary: longText,
      blockResults: [
        createBlockResult({
          summary: longText,
          markdown: longText,
          error: longText,
          data: { value: longText },
          result: createExecutionResult({
            task: longText,
            status: "executed",
          }),
        }),
      ],
      validation: {
        valid: false,
        errors: ["Missing edge"],
        warnings: ["Unused note"],
        errorIssues: [{ code: "missing-edge", message: "Missing edge" }],
        warningIssues: [{ code: "unused-note", message: "Unused note" }],
        variables: [],
      },
    });

    const record = createRalphRunRecord(
      SCHEMA_VERSION,
      "run-1",
      "2026-06-18T10:00:00.000Z",
      flow,
      runResult,
      { scope: longText },
      {
        id: "run-1",
        directory: "/runs/run-1",
        recordPath: "/runs/run-1/run.json",
        simpleJsonlPath: "/runs/run-1/simple.jsonl",
        simpleMarkdownPath: "/runs/run-1/simple.md",
        traceJsonlPath: "/runs/run-1/trace.jsonl",
      },
    );

    expect(record).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      id: "run-1",
      createdAt: "2026-06-18T10:00:00.000Z",
      finishedAt: "2026-06-18T10:01:00.000Z",
      flowId: "flow-1",
      flowName: "Flow",
      flowRevisionId: "2026-06-18T09:30:00.000Z",
      status: "completed",
      validation: {
        valid: false,
        errors: ["Missing edge"],
        warnings: ["Unused note"],
      },
      logPaths: {
        simpleJsonlPath: "/runs/run-1/simple.jsonl",
        simpleMarkdownPath: "/runs/run-1/simple.md",
        traceJsonlPath: "/runs/run-1/trace.jsonl",
      },
    });
    expect(record.summary).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.variableValues.scope).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.blockResults[0]).toMatchObject({
      blockId: "fix",
      executionStatus: "executed",
    });
    expect(record.blockResults[0]?.summary).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.blockResults[0]?.markdown).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.blockResults[0]?.error).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.blockResults[0]?.task).toHaveLength(
      MAX_RALPH_RESULT_CHARS + TRUNCATION_MARKER.length,
    );
    expect(record.blockResults[0]?.data).toEqual({
      value: `${longText.slice(0, MAX_RALPH_RESULT_CHARS)}${TRUNCATION_MARKER}`,
    });
  });

  it("uses createdAt as the fallback revision and omits absent optional paths", () => {
    const runResult = createRunResult();
    delete runResult.finishedAt;

    const record = createRalphRunRecord(
      SCHEMA_VERSION,
      "run-1",
      "2026-06-18T10:00:00.000Z",
      createFlow({
        id: "flow-1",
        name: "Flow",
        createdAt: "2026-06-18T09:00:00.000Z",
      }),
      runResult,
      {},
    );

    expect(record.flowRevisionId).toBe("2026-06-18T09:00:00.000Z");
    expect(record).not.toHaveProperty("finishedAt");
    expect(record).not.toHaveProperty("logPaths");
  });
});

describe("createRalphRunRecordBlock", () => {
  it("omits undefined, empty, and unavailable optional fields", () => {
    const block = createRalphRunRecordBlock(
      createBlockResult({
        data: undefined,
        error: "",
        markdown: "",
        result: createExecutionResult({ task: "", status: "blocked" }),
      }),
    );

    expect(block).toEqual({
      blockId: "fix",
      output: "SUCCESS",
      status: "completed",
      attempt: 1,
      executionStatus: "blocked",
      summary: "Fixed issue.",
    });
  });
});

describe("capRalphRunRecordValue", () => {
  it.each([
    [null, null],
    [undefined, undefined],
    [true, true],
    [42, 42],
    [Symbol("unsupported"), undefined],
  ] as const)("normalizes scalar value %#", (input, expected) => {
    expect(capRalphRunRecordValue(input)).toBe(expected);
  });

  it("caps arrays, object entries, and nested data at the run-record boundaries", () => {
    const largeArray = Array.from({ length: 105 }, (_, index) => index);
    const largeObject = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [`key-${index}`, index]),
    );

    expect(capRalphRunRecordValue(largeArray)).toHaveLength(100);
    expect(Object.keys(capRalphRunRecordValue(largeObject) as object)).toHaveLength(
      100,
    );
    expect(
      capRalphRunRecordValue({
        first: { second: { third: { fourth: { fifth: "hidden" } } } },
      }),
    ).toEqual({
      first: { second: { third: { fourth: "[Ralph data truncated]" } } },
    });
  });
});

describe("isRalphRunRecord", () => {
  it("accepts the minimal valid run record shape", () => {
    expect(isRalphRunRecord(createRecord(), SCHEMA_VERSION)).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    createRecord({ schemaVersion: 2 as RalphRunRecord["schemaVersion"] }),
    { ...createRecord(), id: 123 },
    { ...createRecord(), events: {} },
    { ...createRecord(), blockResults: {} },
  ])("rejects invalid record value %#", (value) => {
    expect(isRalphRunRecord(value, SCHEMA_VERSION)).toBe(false);
  });
});

describe("createRalphRunSummaryFromRecord", () => {
  it("projects list summaries from records", () => {
    const summary = createRalphRunSummaryFromRecord(
      createRecord({
        finishedAt: "2026-06-18T10:01:00.000Z",
        events: [
          {
            type: "end",
            blockId: "end",
            status: "completed",
            summary: "Done.",
          },
        ],
        blockResults: [createBlockResult()],
        logPaths: {
          simpleJsonlPath: "/runs/run-1/simple.jsonl",
          simpleMarkdownPath: "/runs/run-1/simple.md",
          traceJsonlPath: "/runs/run-1/trace.jsonl",
        },
      }),
      "/runs/run-1/run.json",
    );

    expect(summary).toEqual({
      id: "run-1",
      path: "/runs/run-1/run.json",
      createdAt: "2026-06-18T10:00:00.000Z",
      finishedAt: "2026-06-18T10:01:00.000Z",
      flowId: "flow-1",
      flowName: "Flow",
      status: "completed",
      summary: "Run completed.",
      simpleLogPath: "/runs/run-1/simple.md",
      traceLogPath: "/runs/run-1/trace.jsonl",
      blockCount: 1,
      eventCount: 1,
    });
  });

  it("omits optional summary paths when logs are absent", () => {
    const summary = createRalphRunSummaryFromRecord(
      createRecord(),
      "/runs/run-1/run.json",
    );

    expect(summary).not.toHaveProperty("simpleLogPath");
    expect(summary).not.toHaveProperty("traceLogPath");
  });
});
