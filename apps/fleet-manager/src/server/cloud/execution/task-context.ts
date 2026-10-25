import {
  sharedAgentTask,
  sharedAgentMaximumTaskBytes,
  type TaskPromptManifest,
} from "@machdoch/fleet-protocol/cloud-task-context";
import { CloudError } from "../access";
export function taskContextLimit(manifest: TaskPromptManifest): number {
  if (
    Buffer.byteLength(sharedAgentTask(manifest), "utf8") >
    sharedAgentMaximumTaskBytes
  )
    throw new CloudError(
      422,
      "task_instructions_limit",
      "The task instructions and checks exceed the runtime input limit. Shorten them before starting a task.",
    );
  return 48 * 1024;
}
