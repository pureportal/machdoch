import type { JSX } from "react";
import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { AgentLiveRunDetails } from "@machdoch/client-ui/conversation/agent-live-run-details";
import type { TaskThinkingTrace } from "../../task-thinking.model";
import {
  sendAgentControl,
  useAgentControlEndpoint,
} from "../../agent-control-client";

/** Live provider details for one desktop run, wired to its local control endpoint. */
export const AgentLiveRunExtras = ({
  trace,
  live,
  taskId,
  onSendMessage,
}: {
  trace: TaskThinkingTrace;
  live: AgentLiveState;
  taskId: string | undefined;
  onSendMessage?: (text: string) => void;
}): JSX.Element => {
  const running = trace.status === "running";
  const endpoint = useAgentControlEndpoint(running ? taskId : undefined);
  const capabilities = new Set(endpoint?.capabilities ?? []);
  return (
    <AgentLiveRunDetails
      live={live}
      running={running}
      {...(taskId && capabilities.has("answer")
        ? {
            onAnswer: (questionId: string, answers: Record<string, string>) =>
              sendAgentControl(taskId, { type: "answer", questionId, answers }),
          }
        : {})}
      {...(taskId && capabilities.has("stop-task")
        ? {
            onStopTask: (backgroundTaskId: string) =>
              sendAgentControl(taskId, { type: "stop-task", taskId: backgroundTaskId }),
          }
        : {})}
      {...(onSendMessage ? { onSendMessage } : {})}
    />
  );
};
