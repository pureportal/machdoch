import type { TaskExecutionResult } from "../../core/types";
import { createMockExecutionFixture, createPreviewFixture } from "./preview/fixtures";
import { createTaskPanelModel } from "./task-panel";

describe("createTaskPanelModel", () => {
  it("builds a preview model with prompt, warning, note, and plan sections", () => {
    const preview = createPreviewFixture("/fix");
    const model = createTaskPanelModel({ kind: "preview", preview });

    expect(model.kind).toBe("preview");
    expect(model.title).toBe("/fix");
    expect(model.badges).toEqual(
      expect.arrayContaining([
        { label: "Preview", tone: "info" },
        { label: "machdoch", tone: "success" },
        { label: "1 warning", tone: "warning" },
      ]),
    );
    expect(model.sections.map((section) => section.id)).toEqual([
      "prompt",
      "tools",
      "instructions",
      "warnings",
      "notes",
      "plan",
    ]);
    expect(model.sections.find((section) => section.id === "prompt")?.lines).toContain(
      "arguments: none",
    );
  });

  it("builds an execution model with status, mode, tool badges, and output sections", () => {
    const execution = createMockExecutionFixture("show README.md");
    const model = createTaskPanelModel({ kind: "execution", execution });

    expect(model.kind).toBe("execution");
    expect(model.badges).toEqual(
      expect.arrayContaining([
        { label: "executed", tone: "success" },
        { label: "machdoch", tone: "success" },
        { label: "filesystem", tone: "neutral" },
      ]),
    );
    expect(model.sections[0]).toMatchObject({
      id: "execution-details",
      tone: "success",
      lines: expect.arrayContaining(["executed tools: filesystem"]),
    });
    expect(model.sections.some((section) => section.id === "output-0")).toBe(true);
  });

  it("handles blocked executions without tool output as danger details", () => {
    const execution: TaskExecutionResult = {
      ...createMockExecutionFixture("show README.md"),
      status: "blocked",
      executedTools: [],
      reason: "Denied by mode.",
    };
    const model = createTaskPanelModel({ kind: "execution", execution });

    expect(model.badges).toEqual(
      expect.arrayContaining([
        { label: "blocked", tone: "danger" },
      ]),
    );
    expect(model.sections[0]).toMatchObject({
      id: "execution-details",
      tone: "danger",
      lines: ["executed tools: none", "reason: Denied by mode."],
    });
  });
});
