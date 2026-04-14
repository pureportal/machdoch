import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import {
  createTaskTimelineModel,
  type TaskTimelineMessage,
} from "./task-timeline.model";

const createMessage = (
  message: TaskTimelineMessage,
): TaskTimelineMessage => message;

describe("createTaskTimelineModel", () => {
  it("groups staged preview and execution messages for the same task", () => {
    const timeline = createTaskTimelineModel([
      createMessage({
        id: "user-1",
        taskId: "task-1",
        role: "user",
        content: "scan this workspace and explain the setup",
        createdAt: 100,
      }),
      createMessage({
        id: "agent-1",
        taskId: "task-1",
        role: "agent",
        content: "Preview ready",
        createdAt: 200,
        source: {
          kind: "preview",
          preview: createPreviewFixture(
            "scan this workspace and explain the setup",
          ),
        },
      }),
      createMessage({
        id: "agent-2",
        taskId: "task-1",
        role: "agent",
        content: "Execution ready",
        createdAt: 300,
        source: {
          kind: "execution",
          execution: createMockExecutionFixture(
            "scan this workspace and explain the setup",
            "C:/Development/machdoch",
          ),
        },
      }),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.title).toBe("scan this workspace and explain the setup");
    expect(timeline[0]?.statusLabel).toBe("Executed");
    expect(timeline[0]?.tone).toBe("success");
    expect(timeline[0]?.events.map((event) => event.label)).toEqual([
      "Request submitted",
      "Ready to run",
      "Executed",
    ]);
  });

  it("keeps preview-only tasks in an approval-needed state when no execution result exists", () => {
    const timeline = createTaskTimelineModel([
      createMessage({
        id: "user-1",
        taskId: "task-1",
        role: "user",
        content: "debug the failing task runner tests",
        createdAt: 100,
      }),
      createMessage({
        id: "agent-1",
        taskId: "task-1",
        role: "agent",
        content: "Preview ready",
        createdAt: 200,
        source: {
          kind: "preview",
          preview: createPreviewFixture("debug the failing task runner tests"),
        },
      }),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.statusLabel).toBe("Needs approval");
    expect(timeline[0]?.toolsLabel).toContain("filesystem");
    expect(timeline[0]?.events).toHaveLength(2);
  });

  it("orders tasks by the latest activity and falls back to queued status without agent sources", () => {
    const timeline = createTaskTimelineModel([
      createMessage({
        id: "user-older",
        taskId: "task-1",
        role: "user",
        content: "inspect README.md",
        createdAt: 100,
      }),
      createMessage({
        id: "user-newer",
        taskId: "task-2",
        role: "user",
        content: "summarize this project setup",
        createdAt: 200,
      }),
    ]);

    expect(timeline.map((item) => item.taskId)).toEqual(["task-2", "task-1"]);
    expect(timeline[0]?.statusLabel).toBe("Queued");
    expect(timeline[0]?.summary).toBe("summarize this project setup");
  });

  it("marks unsupported execution results as preview-only so the sidebar stays honest", () => {
    const timeline = createTaskTimelineModel([
      createMessage({
        id: "user-1",
        taskId: "task-1",
        role: "user",
        content: "install dependencies and commit the changes",
        createdAt: 100,
      }),
      createMessage({
        id: "agent-1",
        taskId: "task-1",
        role: "agent",
        content: "Execution is not available yet",
        createdAt: 200,
        source: {
          kind: "execution",
          execution: createMockExecutionFixture(
            "install dependencies and commit the changes",
            "C:/Development/machdoch",
          ),
        },
      }),
    ]);

    expect(timeline[0]?.statusLabel).toBe("Preview only");
    expect(timeline[0]?.tone).toBe("neutral");
    expect(timeline[0]?.events[1]?.label).toBe("Preview only");
  });

  it("shows cancelled execution results without treating them like failures", () => {
    const timeline = createTaskTimelineModel([
      createMessage({
        id: "user-1",
        taskId: "task-1",
        role: "user",
        content: "show README.md",
        createdAt: 100,
      }),
      createMessage({
        id: "agent-1",
        taskId: "task-1",
        role: "agent",
        content: "Execution cancelled",
        createdAt: 200,
        source: {
          kind: "execution",
          execution: {
            ...createMockExecutionFixture(
              "show README.md",
              "C:/Development/machdoch",
            ),
            status: "cancelled",
            summary: "Execution was cancelled before the task completed.",
            reason: "User cancelled the task.",
          },
        },
      }),
    ]);

    expect(timeline[0]?.statusLabel).toBe("Cancelled");
    expect(timeline[0]?.tone).toBe("neutral");
    expect(timeline[0]?.events[1]?.label).toBe("Cancelled");
  });
});
