import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  routeDesktopTaskProgress,
  type DesktopTaskProgressRoute,
} from "./use-desktop-task-progress";

const streamingProgress: TaskExecutionProgress = {
  task: "Enhance the request",
  mode: "ask",
  state: "executing",
  message: "Enhancing prompt",
  executedTools: [],
  outputSections: [],
  cancellable: true,
  assistantText: "<machdoch_enhanced_prompt>Improved request",
};

const terminalProgress: TaskExecutionProgress = {
  ...streamingProgress,
  state: "completed",
  message: "Prompt enhanced",
  cancellable: false,
  assistantText:
    "<machdoch_enhanced_prompt>Improved request</machdoch_enhanced_prompt>",
};

describe("desktop task progress routing", () => {
  it("keeps owned streaming and terminal progress out of fallback handling", () => {
    const taskId = "prompt-enhancement-task";
    const routes = new Map<string, DesktopTaskProgressRoute>([[taskId, {}]]);

    expect(
      routeDesktopTaskProgress(routes, taskId, streamingProgress, 100),
    ).toBe(true);
    expect(
      routeDesktopTaskProgress(routes, taskId, terminalProgress, 200),
    ).toBe(true);

    routes.delete(taskId);

    expect(
      routeDesktopTaskProgress(routes, taskId, terminalProgress, 300),
    ).toBe(false);
  });

  it("continues to forward progress for routes with callbacks", () => {
    const onProgress = vi.fn();
    const routes = new Map<string, DesktopTaskProgressRoute>([
      ["interview-task", { onProgress }],
    ]);

    expect(
      routeDesktopTaskProgress(
        routes,
        "interview-task",
        streamingProgress,
        400,
      ),
    ).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(streamingProgress, 400);
    expect(
      routeDesktopTaskProgress(routes, "unowned-task", streamingProgress, 500),
    ).toBe(false);
  });
});
