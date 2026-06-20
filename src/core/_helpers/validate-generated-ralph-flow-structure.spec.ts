import {
  RALPH_FLOW_SCHEMA_VERSION,
  type RalphFlow,
} from "../ralph.ts";
import { validateGeneratedRalphFlowStructure } from "./validate-generated-ralph-flow-structure.helper.ts";

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
  id: "generated-flow",
  name: "Generated flow",
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "task", type: "PROMPT", title: "Task", prompt: "Do the work." },
    { id: "end", type: "END", title: "Done" },
  ],
  edges: [
    { id: "start-to-task", from: "start", fromOutput: "SUCCESS", to: "task" },
    { id: "task-to-end", from: "task", fromOutput: "SUCCESS", to: "end" },
  ],
  ...overrides,
});

describe("validateGeneratedRalphFlowStructure", () => {
  it("returns DONE for an acyclic generated flow without quality warnings", () => {
    expect(validateGeneratedRalphFlowStructure(createFlow())).toEqual({
      decision: "DONE",
      issues: [],
      warnings: [],
    });
  });

  it("requires maxTransitions when the generated graph contains a cycle", () => {
    const result = validateGeneratedRalphFlowStructure(
      createFlow({
        edges: [
          { id: "start-to-task", from: "start", fromOutput: "SUCCESS", to: "task" },
          { id: "task-loop", from: "task", fromOutput: "SUCCESS", to: "task" },
        ],
      }),
    );

    expect(result).toEqual({
      decision: "RETRY",
      issues: [
        "The generated graph has a cycle but no settings.maxTransitions cap.",
      ],
      warnings: [],
    });
  });

  it("allows cycles when maxTransitions is configured", () => {
    const result = validateGeneratedRalphFlowStructure(
      createFlow({
        settings: { maxTransitions: 12 },
        edges: [
          { id: "start-to-task", from: "start", fromOutput: "SUCCESS", to: "task" },
          { id: "task-loop", from: "task", fromOutput: "SUCCESS", to: "task" },
        ],
      }),
    );

    expect(result.decision).toBe("DONE");
    expect(result.issues).toEqual([]);
  });

  it("warns when small flows include visual-only blocks", () => {
    const result = validateGeneratedRalphFlowStructure(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "note", type: "NOTE", title: "Context", markdown: "FYI" },
          { id: "task", type: "PROMPT", title: "Task", prompt: "Do it." },
        ],
      }),
    );

    expect(result.warnings).toContain(
      "Small generated flows should usually omit NOTE and GROUP blocks unless visual organization materially improves readability.",
    );
  });

  it("does not warn about visual blocks once the generated flow is larger than seven blocks", () => {
    const blocks: RalphFlow["blocks"] = [
      { id: "start", type: "START", title: "Start" },
      { id: "note", type: "NOTE", title: "Context", markdown: "FYI" },
      { id: "one", type: "PROMPT", title: "One", prompt: "1" },
      { id: "two", type: "PROMPT", title: "Two", prompt: "2" },
      { id: "three", type: "PROMPT", title: "Three", prompt: "3" },
      { id: "four", type: "PROMPT", title: "Four", prompt: "4" },
      { id: "five", type: "PROMPT", title: "Five", prompt: "5" },
      { id: "end", type: "END", title: "Done" },
    ];

    expect(validateGeneratedRalphFlowStructure(createFlow({ blocks })).warnings).toEqual([]);
  });

  it("warns when generated flows reuse schema-example block ids", () => {
    const result = validateGeneratedRalphFlowStructure(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "main-task", type: "PROMPT", title: "Task", prompt: "Do it." },
          { id: "review-result", type: "VALIDATOR", title: "Review", prompt: "Check it." },
        ],
      }),
    );

    expect(result.warnings).toContain(
      "Generated flow appears to reuse schema-example block id(s): main-task, review-result. Use request-specific kebab-case ids instead.",
    );
  });
});
