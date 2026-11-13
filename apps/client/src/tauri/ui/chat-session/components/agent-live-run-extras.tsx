import type { JSX, ReactNode } from "react";
import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { AgentRunStatusButton } from "@machdoch/client-ui/conversation/agent-live-panel";
import { AgentLiveRunDetails } from "@machdoch/client-ui/conversation/agent-live-run-details";
import { TaskThinkingPanel } from "@machdoch/client-ui/conversation/task-thinking-panel";
import type { ChatSessionRecord } from "../../chat-session.model";
import type { TaskThinkingTrace } from "../../task-thinking.model";
import {
  sendAgentControl,
  useAgentControlEndpoint,
} from "../../agent-control-client";

const useStopTaskControl = (
  taskId: string | undefined,
  running: boolean,
): ((backgroundTaskId: string) => Promise<void>) | undefined => {
  const endpoint = useAgentControlEndpoint(running ? taskId : undefined);
  return taskId && endpoint?.capabilities.includes("stop-task")
    ? (backgroundTaskId) =>
        sendAgentControl(taskId, { type: "stop-task", taskId: backgroundTaskId })
    : undefined;
};

/** One desktop run's execution card, wired to its local control endpoint. */
export const RunExecutionPanel = ({
  trace,
  taskId,
  timeoutControls,
  onSendMessage,
}: {
  trace: TaskThinkingTrace;
  taskId: string | undefined;
  timeoutControls: ReactNode;
  onSendMessage?: ((text: string) => void) | undefined;
}): JSX.Element => {
  const stopTask = useStopTaskControl(taskId, trace.status === "running");
  return (
    <TaskThinkingPanel
      thinking={trace}
      timeoutControls={timeoutControls}
      {...(stopTask ? { onStopAgentTask: stopTask } : {})}
      {...(onSendMessage ? { onResendSteer: onSendMessage } : {})}
    />
  );
};

/** A desktop run's question from the agent, wired to its local control endpoint. */
export const AgentLiveRunExtras = ({
  trace,
  live,
  taskId,
}: {
  trace: TaskThinkingTrace;
  live: AgentLiveState;
  taskId: string | undefined;
}): JSX.Element | null => {
  const running = trace.status === "running";
  const endpoint = useAgentControlEndpoint(running ? taskId : undefined);
  return (
    <AgentLiveRunDetails
      live={live}
      running={running}
      {...(taskId && endpoint?.capabilities.includes("answer")
        ? {
            onAnswer: (questionId: string, answers: Record<string, string>) =>
              sendAgentControl(taskId, { type: "answer", questionId, answers }),
          }
        : {})}
    />
  );
};

const findRunningLiveMessage = (session: ChatSessionRecord) => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    const trace =
      message?.source?.kind === "thinking" ? message.source.thinking : null;
    if (trace?.status === "running" && trace.agentLive) {
      return { taskId: message?.taskId, live: trace.agentLive };
    }
  }
  return null;
};

/** The active run's plan progress, kept in view while the feed scrolls. */
export const SessionRunStatus = ({
  session,
  onSendMessage,
}: {
  session: ChatSessionRecord;
  onSendMessage: (text: string) => void;
}): JSX.Element | null => {
  const running = findRunningLiveMessage(session);
  const stopTask = useStopTaskControl(running?.taskId, running !== null);
  return running ? (
    <AgentRunStatusButton
      live={running.live}
      running
      onStopTask={stopTask}
      onResendSteer={onSendMessage}
    />
  ) : null;
};
