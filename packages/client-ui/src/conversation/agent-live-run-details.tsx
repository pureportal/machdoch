import { useEffect, useState, type JSX } from "react";
import type { AgentLiveQuestion, AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { getProviderLabel } from "../common/provider-labels";
import { AgentLivePanel } from "./agent-live-panel";
import { AgentQuestionCard } from "./agent-question-card";

const useMinuteClock = (enabled: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
};

/** Writes answers as one chat message, for views that answer by sending a message. */
export const formatQuestionAnswers = (
  question: AgentLiveQuestion,
  answers: Record<string, string>,
): string => {
  const answered = question.items.filter((item) => answers[item.id]?.trim());
  if (answered.length === 1 && question.items.length === 1) return answers[answered[0]!.id]!.trim();
  return answered.map((item) => `${item.header ?? item.question}: ${answers[item.id]!.trim()}`).join("\n");
};

export interface AgentLiveRunDetailsProps {
  live: AgentLiveState;
  running: boolean;
  /** Present while this view can answer the pending question. */
  onAnswer?: (questionId: string, answers: Record<string, string>) => Promise<void>;
  /** Present while this view can stop the run's background work. */
  onStopTask?: (taskId: string) => Promise<void>;
  /** Sends text as a new chat message, used to resend unread steering. */
  onSendMessage?: (text: string) => void;
}

/** A run's pending question and live provider details, shared by every conversation view. */
export const AgentLiveRunDetails = ({
  live,
  running,
  onAnswer,
  onStopTask,
  onSendMessage,
}: AgentLiveRunDetailsProps): JSX.Element => {
  const now = useMinuteClock(running || (live.limits?.length ?? 0) > 0);
  const question = live.question;
  return (
    <div className="app-agent-live-extras flex w-full min-w-0 flex-col gap-2 lg:max-w-4xl">
      {question && (question.status !== "pending" || running) ? (
        <AgentQuestionCard
          // A new question must not inherit the previous one's selections.
          key={question.id}
          question={question}
          providerLabel={getProviderLabel(live.provider)}
          {...(onAnswer && running && question.status === "pending"
            ? { onSubmit: (answers: Record<string, string>) => onAnswer(question.id, answers) }
            : {})}
        />
      ) : null}
      <AgentLivePanel
        live={live}
        running={running}
        now={now}
        {...(onStopTask && running ? { onStopTask } : {})}
        {...(onSendMessage ? { onResendSteer: onSendMessage } : {})}
      />
    </div>
  );
};
