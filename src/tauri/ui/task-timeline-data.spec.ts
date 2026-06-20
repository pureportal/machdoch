import { createMockExecutionFixture, createPreviewFixture } from "./preview/fixtures";
import { createTaskTimelineModel, type TaskTimelineMessage } from "./task-timeline-data";

describe("createTaskTimelineModel", () => {
  it("groups messages by task id, orders events chronologically, and sorts newest task first", () => {
    const messages: TaskTimelineMessage[] = [
      {
        id: "task-1-agent",
        taskId: "task-1",
        role: "agent",
        content: "done",
        createdAt: 20,
        source: {
          kind: "execution",
          execution: createMockExecutionFixture("show README.md"),
        },
      },
      {
        id: "task-2-user",
        taskId: "task-2",
        role: "user",
        content: "preview the second task",
        createdAt: 30,
      },
      {
        id: "task-1-user",
        taskId: "task-1",
        role: "user",
        content: "show README.md",
        createdAt: 10,
      },
    ];

    const model = createTaskTimelineModel(messages);

    expect(model.map((item) => item.taskId)).toEqual(["task-2", "task-1"]);
    expect(model[1]?.events.map((event) => event.id)).toEqual([
      "task-1-user",
      "task-1-agent",
    ]);
    expect(model[1]).toMatchObject({
      title: "show README.md",
      statusLabel: "Executed",
      tone: "success",
      modeLabel: "machdoch",
      toolsLabel: "filesystem",
    });
  });

  it("uses preview sources for task title, status, mode, and tools when no execution exists", () => {
    const preview = createPreviewFixture("scan workspace", { mode: "ask" });
    const model = createTaskTimelineModel([
      {
        id: "user",
        taskId: "task-preview",
        role: "user",
        content: "scan workspace",
      },
      {
        id: "preview",
        taskId: "task-preview",
        role: "agent",
        content: "preview",
        source: { kind: "preview", preview },
      },
    ]);

    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({
      title: "scan workspace",
      summary: preview.summary,
      statusLabel: "Ready to run",
      tone: "info",
      modeLabel: "ask",
      toolsLabel: "filesystem",
    });
  });

  it("falls back to message ids, trimmed content, and queued status for source-less messages", () => {
    const model = createTaskTimelineModel([
      {
        id: "empty-agent",
        role: "agent",
        content: "   ",
      },
      {
        id: "user",
        role: "user",
        content: "  draft task  ",
      },
    ]);

    expect(model).toEqual([
      expect.objectContaining({
        id: "user",
        taskId: "user",
        title: "draft task",
        summary: "draft task",
        statusLabel: "Queued",
        tone: "neutral",
      }),
      expect.objectContaining({
        id: "empty-agent",
        taskId: "empty-agent",
        title: "Untitled task",
        summary: "Awaiting task details.",
        statusLabel: "Queued",
        tone: "neutral",
      }),
    ]);
  });
});
