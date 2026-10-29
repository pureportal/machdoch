import { useId, useState, type FormEvent, type JSX } from "react";
import type { AgentLiveQuestion } from "@machdoch/fleet-protocol/task-thinking";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { AgentQuestionIcon } from "./agent-live-icons";

export interface AgentQuestionCardProps {
  question: AgentLiveQuestion;
  providerLabel: string;
  /** Missing when this device cannot answer (for example a remote viewer). */
  onSubmit?: (answers: Record<string, string>) => Promise<void>;
}

/** An agent's clarifying question, answered without leaving the chat. */
export const AgentQuestionCard = ({
  question,
  providerLabel,
  onSubmit,
}: AgentQuestionCardProps): JSX.Element => {
  const formId = useId();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = question.status === "pending";

  const answerFor = (itemId: string): string => {
    const typed = other[itemId]?.trim();
    const picked = selected[itemId] ?? [];
    return [...picked, ...(typed ? [typed] : [])].join(", ");
  };
  const complete = question.items.every((item) => answerFor(item.id).length > 0);

  const toggle = (itemId: string, label: string, multi: boolean) => {
    setSelected((current) => {
      const existing = current[itemId] ?? [];
      const next = multi
        ? existing.includes(label)
          ? existing.filter((entry) => entry !== label)
          : [...existing, label]
        : existing[0] === label
          ? []
          : [label];
      return { ...current, [itemId]: next };
    });
    if (!multi) setOther((current) => ({ ...current, [itemId]: "" }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!onSubmit || !complete || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(
        Object.fromEntries(question.items.map((item) => [item.id, answerFor(item.id)])),
      );
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The answer could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      id={formId}
      aria-label={`${providerLabel} is asking a question`}
      onSubmit={(event) => void submit(event)}
      className={cn(
        "app-agent-question w-full min-w-0 rounded-2xl border px-4 py-3 shadow-lg lg:max-w-3xl",
        pending
          ? "border-amber-400/35 bg-amber-400/[0.07] shadow-amber-950/20"
          : "border-slate-800 bg-slate-900/50 shadow-none",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border",
            pending ? "border-amber-300/40 text-amber-200" : "border-slate-700 text-slate-400",
          )}
        >
          <AgentQuestionIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-semibold text-slate-100">
            {pending ? `${providerLabel} needs your input` : question.status === "answered" ? "You answered" : "Question closed"}
          </p>
          <p className="m-0 text-[11px] text-slate-400">
            {pending ? "The run is paused until you answer." : question.status === "answered" ? "The agent continued with your answer." : "The run ended before an answer was sent."}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        {question.items.map((item) => {
          const multi = item.multiSelect === true;
          const picked = selected[item.id] ?? [];
          const answered = question.answers?.[item.id];
          return (
            <fieldset key={item.id} className="m-0 min-w-0 border-0 p-0" disabled={!pending || sending || !onSubmit}>
              <legend className="mb-1.5 text-sm text-slate-200">
                {item.header ? (
                  <span className="mr-2 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                    {item.header}
                  </span>
                ) : null}
                {item.question}
              </legend>
              {answered ? (
                <p className="m-0 text-sm text-emerald-200">{item.secret ? "••••••" : answered}</p>
              ) : (
                <>
                  {item.options.length > 0 ? (
                    <div role={multi ? "group" : "radiogroup"} className="flex flex-wrap gap-2">
                      {item.options.map((option) => {
                        const active = picked.includes(option.label);
                        return (
                          <button
                            key={option.label}
                            type="button"
                            role={multi ? "checkbox" : "radio"}
                            aria-checked={active}
                            title={option.description}
                            onClick={() => toggle(item.id, option.label, multi)}
                            className={cn(
                              "max-w-full rounded-xl border px-3 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 disabled:cursor-not-allowed disabled:opacity-60",
                              active
                                ? "border-amber-300/60 bg-amber-300/15 text-amber-50"
                                : "border-slate-700 bg-slate-950/50 text-slate-200 hover:border-slate-500",
                            )}
                          >
                            <span className="block font-medium">{option.label}</span>
                            {option.description ? (
                              <span className="block text-[10.5px] text-slate-400">{option.description}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {item.allowOther !== false ? (
                    <input
                      type={item.secret ? "password" : "text"}
                      aria-label={item.options.length > 0 ? `Other answer for: ${item.question}` : item.question}
                      placeholder={item.options.length > 0 ? "Or type your own answer" : "Type your answer"}
                      value={other[item.id] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setOther((current) => ({ ...current, [item.id]: value }));
                        if (!multi && value.trim()) setSelected((current) => ({ ...current, [item.id]: [] }));
                      }}
                      className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:border-amber-300/50 focus-visible:outline-none"
                    />
                  ) : null}
                </>
              )}
            </fieldset>
          );
        })}
      </div>

      {pending && onSubmit ? (
        <div className="mt-3 flex items-center justify-end gap-3">
          {error ? <span className="mr-auto text-[11px] text-rose-300">{error}</span> : null}
          <button
            type="submit"
            disabled={!complete || sending}
            className="rounded-full border border-amber-300/40 bg-amber-300/15 px-4 py-1.5 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-300/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send answer"}
          </button>
        </div>
      ) : pending && !onSubmit ? (
        <p className="mt-3 text-[11px] text-slate-400">Answer on the device that runs this task.</p>
      ) : null}
    </form>
  );
};
