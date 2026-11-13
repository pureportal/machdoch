import type { JSX } from "react";
import type { AgentLiveQuestion, AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { getProviderLabel } from "../common/provider-labels";
import { AgentQuestionCard } from "./agent-question-card";

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
}

/** A run's question from the agent, shared by every conversation view. */
export const AgentLiveRunDetails = ({
  live,
  running,
  onAnswer,
}: AgentLiveRunDetailsProps): JSX.Element | null => {
  const question = live.question;
  if (!question || (question.status === "pending" && !running)) return null;
  return (
    <div className="app-agent-live-extras flex w-full min-w-0 flex-col gap-2 lg:max-w-4xl">
      <AgentQuestionCard
        // A new question must not inherit the previous one's selections.
        key={question.id}
        question={question}
        providerLabel={getProviderLabel(live.provider)}
        {...(onAnswer && running && question.status === "pending"
          ? { onSubmit: (answers: Record<string, string>) => onAnswer(question.id, answers) }
          : {})}
      />
    </div>
  );
};
