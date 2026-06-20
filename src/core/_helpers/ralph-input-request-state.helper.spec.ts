import {
  applyInputValuesToContext,
  createInputRequest,
  createRunCheckpoint,
  getMatchingInputResponse,
  getPendingInputForBlock,
  isExpiredInputRequest,
  isRalphInputFieldType,
  normalizeGeneratedInputFieldId,
  restoreRalphNumberMap,
  restoreRalphRepeatedFailureMap,
  restoreRalphResultMap,
} from "./ralph-input-request-state.helper.ts";
import type {
  RalphBlockExecutionResult,
  RalphFlowBlock,
  RalphInputBlock,
  RalphInputField,
  RalphInputRequest,
  RalphRunCheckpoint,
  RalphRunOptions,
} from "../ralph.ts";

const createInputBlock = (): RalphInputBlock => ({
  id: "input",
  type: "INPUT",
  title: "Collect Input",
  position: { x: 0, y: 0 },
  fields: [],
});

const createPendingInput = (overrides: Partial<RalphInputRequest> = {}): RalphInputRequest => ({
  id: "request-1",
  runId: "run-1",
  blockId: "input",
  blockType: "INPUT",
  title: "Collect Input",
  createdAt: "2026-06-20T10:00:00.000Z",
  fields: [],
  ...overrides,
});

describe("ralph input request state helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes generated field ids while rejecting invalid or empty values", () => {
    expect(normalizeGeneratedInputFieldId("  123 user name!  ", "field_1")).toBe(
      "_user_name_",
    );
    expect(normalizeGeneratedInputFieldId("___", "field_1")).toBe("___");
    expect(normalizeGeneratedInputFieldId("123", "field_1")).toBe("field_1");
    expect(normalizeGeneratedInputFieldId(undefined, "field_1")).toBe("field_1");
  });

  it("recognizes supported input field types", () => {
    expect(isRalphInputFieldType("textarea")).toBe(true);
    expect(isRalphInputFieldType("images")).toBe(true);
    expect(isRalphInputFieldType("unknown")).toBe(false);
    expect(isRalphInputFieldType("")).toBe(false);
  });

  it("creates templated input requests with expiration metadata", () => {
    const block = createInputBlock();
    const fields: RalphInputField[] = [
      {
        id: "name",
        type: "text",
        label: "Name for {{subject}}",
        placeholder: "Enter {{subject}}",
        help: "Required for {{subject}}",
        defaultValue: "{{subject}}",
        options: [{ value: "a", label: "Option {{subject}}" }],
      },
    ];

    const request = createInputRequest(
      block,
      { runId: "run-1", variables: { subject: "docs" } },
      fields,
      (text, context) => text.replaceAll("{{subject}}", context.variables.subject ?? ""),
      {
        prompt: "Prompt {{subject}}",
        submitLabel: "Send",
        cancelLabel: "Stop",
        timeoutSeconds: 30,
      },
    );

    expect(request.id).toMatch(/^ralph-input-input-/u);
    expect(request).toMatchObject({
      runId: "run-1",
      blockId: "input",
      blockType: "INPUT",
      title: "Collect Input",
      prompt: "Prompt docs",
      submitLabel: "Send",
      cancelLabel: "Stop",
      createdAt: "2026-06-20T10:00:00.000Z",
      expiresAt: "2026-06-20T10:00:30.000Z",
      fields: [
        {
          id: "name",
          label: "Name for docs",
          placeholder: "Enter docs",
          help: "Required for docs",
          defaultValue: "docs",
          options: [{ value: "a", label: "Option docs" }],
        },
      ],
    });
  });

  it("omits expiration for null, zero, and negative timeout values", () => {
    const block = createInputBlock();
    const context = { runId: "run-1", variables: {} };
    const resolveTemplate = (text: string): string => text;

    expect(
      createInputRequest(block, context, [], resolveTemplate, { timeoutSeconds: null })
        .expiresAt,
    ).toBeUndefined();
    expect(
      createInputRequest(block, context, [], resolveTemplate, { timeoutSeconds: 0 })
        .expiresAt,
    ).toBeUndefined();
    expect(
      createInputRequest(block, context, [], resolveTemplate, { timeoutSeconds: -1 })
        .expiresAt,
    ).toBeUndefined();
  });

  it("applies submitted values to every variable alias declared by fields", () => {
    const context = { runId: "run-1", variables: { existing: "keep" } };
    const fields: RalphInputField[] = [
      { id: "name", type: "text", label: "Name", variableName: "USER_NAME" },
      { id: "missing", type: "text", label: "Missing", variableName: "MISSING" },
    ];

    applyInputValuesToContext(context, fields, { name: "Ada" });

    expect(context.variables).toEqual({
      existing: "keep",
      name: "Ada",
      USER_NAME: "Ada",
      missing: "",
      MISSING: "",
    });
  });

  it("matches pending input requests and ignores stale responses", () => {
    const block = createInputBlock() as RalphFlowBlock;
    const pendingInput = createPendingInput();
    const options: RalphRunOptions = {
      workspaceRoot: "C:/repo",
      checkpoint: { pendingInput } as RalphRunCheckpoint,
      inputResponse: { requestId: "request-1", values: { name: "Ada" } },
    };

    expect(getPendingInputForBlock(block, options)).toBe(pendingInput);
    expect(getMatchingInputResponse(block, options)).toEqual({
      requestId: "request-1",
      values: { name: "Ada" },
    });

    expect(
      getMatchingInputResponse(block, {
        ...options,
        inputResponse: { requestId: "other", values: {} },
      }),
    ).toBeUndefined();
    expect(
      getPendingInputForBlock({ ...block, id: "other" } as RalphFlowBlock, options),
    ).toBeUndefined();
  });

  it("detects expired requests and treats missing or future expiration as active", () => {
    expect(
      isExpiredInputRequest(
        createPendingInput({ expiresAt: "2026-06-20T09:59:59.999Z" }),
      ),
    ).toBe(true);
    expect(
      isExpiredInputRequest(
        createPendingInput({ expiresAt: "2026-06-20T10:00:00.001Z" }),
      ),
    ).toBe(false);
    expect(isExpiredInputRequest(createPendingInput())).toBe(false);
  });

  it("creates immutable checkpoint snapshots from mutable run state", () => {
    const result: RalphBlockExecutionResult = {
      blockId: "prompt",
      blockType: "PROMPT",
      output: "SUCCESS",
      summary: "Done",
    };
    const event = {
      type: "block-start",
      timestamp: "2026-06-20T10:00:00.000Z",
      blockId: "prompt",
      blockType: "PROMPT",
      title: "Prompt",
    } as const;
    const pendingInput = createPendingInput();
    const context = {
      runId: "run-1",
      variables: { A: "1" },
      resultsByBlock: new Map([["prompt", result]]),
      runLog: [],
      interviewStates: new Map(),
    };

    const checkpoint = createRunCheckpoint(
      "input",
      3,
      context,
      [result],
      [event],
      new Map([["prompt", 2]]),
      new Map([["prompt", { signature: "same", count: 2 }]]),
      pendingInput,
    );

    context.variables.A = "changed";

    expect(checkpoint).toMatchObject({
      currentBlockId: "input",
      transitions: 3,
      variables: { A: "1" },
      resultsByBlock: { prompt: result },
      blockResults: [result],
      events: [event],
      errorCounts: { prompt: 2 },
      repeatedFailures: { prompt: { signature: "same", count: 2 } },
      pendingInput,
    });
  });

  it("restores checkpoint maps while filtering invalid numeric and failure entries", () => {
    const result: RalphBlockExecutionResult = {
      blockId: "prompt",
      blockType: "PROMPT",
      output: "SUCCESS",
      summary: "Done",
    };

    expect(
      restoreRalphResultMap({ resultsByBlock: { prompt: result } } as RalphRunCheckpoint),
    ).toEqual(new Map([["prompt", result]]));
    expect(restoreRalphResultMap(undefined)).toEqual(new Map());
    expect(restoreRalphNumberMap({ ok: 1, nan: Number.NaN, infinite: Infinity })).toEqual(
      new Map([["ok", 1]]),
    );
    expect(restoreRalphNumberMap(undefined)).toEqual(new Map());
    expect(
      restoreRalphRepeatedFailureMap({
        ok: { signature: "same", count: 2 },
        missingSignature: { count: 1 } as never,
        missingCount: { signature: "same" } as never,
      }),
    ).toEqual(new Map([["ok", { signature: "same", count: 2 }]]));
    expect(restoreRalphRepeatedFailureMap(undefined)).toEqual(new Map());
  });
});
