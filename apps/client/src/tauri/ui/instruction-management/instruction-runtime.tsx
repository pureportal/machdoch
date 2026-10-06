import type { InstructionRuntime } from "@machdoch/client-ui/instructions";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import { runInternalDesktopTask } from "../internal-task-model";
import { cancelDesktopTask } from "../runtime";

export const instructionRuntime: InstructionRuntime = {
  runAiTask: async (workspace, prompt, taskId) => {
    const result = await runInternalDesktopTask(workspace, prompt, {
      mode: "ask",
      taskId,
    });
    return result.execution.response?.markdown ?? result.execution.summary;
  },
  cancelAiTask: async (taskId) => {
    await cancelDesktopTask(taskId);
  },
  renderMarkdown: (content, className) => (
    <MarkdownContent content={content} className={className} />
  ),
};
