import {
  Check,
  LoaderCircle,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import type { JSX } from "react";

import type { RalphInputValue } from "../../../../core/ralph.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Textarea } from "../../components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  getDefaultRalphInputValue,
} from "../../ralph/_helpers/validate-ralph-input-field-values.helper";
import { RalphInputControl } from "../../ralph/components/ralph-input-controls";
import { TaskThinkingPanel } from "../../task-thinking-panel";
import type { ChatInterviewDialogState } from "../_helpers/chat-interview";

interface ChatInterviewDialogProps {
  state: ChatInterviewDialogState | null;
  onClose: () => void;
  onValueChange: (fieldId: string, value: RalphInputValue) => void;
  onToggleComment: (fieldId: string) => void;
  onCommentChange: (fieldId: string, comment: string) => void;
  onSkipField: (fieldId: string) => void;
  onStartNow: () => void;
  onSubmitAnswers: () => void;
}

const getLatestQuestionScope = (
  state: ChatInterviewDialogState,
): string => {
  return (
    [...(state.session?.transcript ?? [])]
      .reverse()
      .find((turn) => turn.questions.length > 0)
      ?.questionScope?.trim() || "Questions"
  );
};

const getInterviewStatusTitle = (
  state: ChatInterviewDialogState,
): string => {
  if (state.status === "starting") {
    return "Starting";
  }

  if (state.status === "loading") {
    return "Preparing questions";
  }

  return state.status === "blocked" ? "Needs attention" : "Questions";
};

const getPrimaryActionLabel = (
  state: ChatInterviewDialogState,
): string => {
  return state.session && state.session.turn >= state.session.maxTurns
    ? "Start"
    : "Continue";
};

export const ChatInterviewDialog = ({
  state,
  onClose,
  onValueChange,
  onToggleComment,
  onCommentChange,
  onSkipField,
  onStartNow,
  onSubmitAnswers,
}: ChatInterviewDialogProps): JSX.Element => {
  const busy = state?.status === "loading" || state?.status === "starting";

  return (
    <Dialog
      open={Boolean(state)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        confirmOnInteractOutside={{
          title: "Close interview?",
          description: "Current answers will be discarded.",
          cancelLabel: "Keep open",
          confirmLabel: "Close",
        }}
        className="h-[min(720px,calc(100vh-28px))] w-[min(760px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-700/80 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-w-none"
      >
        <DialogHeader className="border-b border-slate-800 bg-slate-950 px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-400/10">
                <Sparkles className="h-4 w-4 text-cyan-200" />
              </div>
              <DialogTitle className="min-w-0 truncate text-base font-semibold text-white">
                Task Interview
              </DialogTitle>
              <DialogDescription className="sr-only">
                Answer task interview questions before starting the chat task.
              </DialogDescription>
            </div>
            {state ? (
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                <Badge
                  variant="outline"
                  className="border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
                >
                  {state.context.mode}
                </Badge>
              </div>
            ) : null}
          </div>
        </DialogHeader>

        {state ? (
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-slate-950">
            <ScrollArea className="min-h-0 bg-slate-950" type="always">
              <div className="grid gap-4 p-5">
                {state.thinking ? (
                  <TaskThinkingPanel thinking={state.thinking} />
                ) : null}

                {state.status === "loading" && !state.thinking ? (
                  <div className="grid min-h-80 place-items-center">
                    <div className="grid justify-items-center gap-4">
                      <LoaderCircle className="h-7 w-7 animate-spin text-cyan-300" />
                      <div className="text-sm font-semibold text-slate-100">
                        {getInterviewStatusTitle(state)}
                      </div>
                    </div>
                  </div>
                ) : null}

                {state.status === "starting" && !state.thinking ? (
                  <div className="grid min-h-80 place-items-center">
                    <div className="grid justify-items-center gap-4">
                      <LoaderCircle className="h-7 w-7 animate-spin text-emerald-300" />
                      <div className="text-sm font-semibold text-emerald-50">
                        {getInterviewStatusTitle(state)}
                      </div>
                    </div>
                  </div>
                ) : null}

                {state.status === "blocked" ? (
                  <div className="rounded-md border border-amber-400/25 bg-amber-400/10 p-4">
                    <div className="mb-1 text-sm font-semibold text-amber-100">
                      {getInterviewStatusTitle(state)}
                    </div>
                    <p className="text-sm leading-6 text-amber-100/80">
                      {state.error ?? state.summary}
                    </p>
                  </div>
                ) : null}

                {state.status === "ready" ? (
                  <div className="grid gap-3">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <h2 className="text-base font-semibold text-white">
                        {getLatestQuestionScope(state)}
                      </h2>
                    </div>
                    {state.fields.map((field) => {
                      const error = state.validationErrors[field.id];
                      const skipped = state.skippedFieldIds.includes(field.id);
                      const answerComment = state.answerComments[field.id] ?? "";
                      const commentOpen =
                        state.expandedCommentFieldIds.includes(field.id);
                      const hasComment = answerComment.trim().length > 0;

                      return (
                        <div
                          key={field.id}
                          className={cn(
                            "grid gap-3 rounded-lg border border-slate-700/70 bg-slate-900/70 p-4 text-sm text-slate-100 shadow-sm shadow-black/15",
                            skipped && "border-slate-800 bg-slate-900/35",
                          )}
                        >
                          <span className="flex min-w-0 items-start justify-between gap-3">
                            <span className="min-w-0 font-semibold leading-5 text-slate-50">
                              {field.label}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {skipped ? (
                                <span className="text-xs font-medium text-slate-500">
                                  Skipped
                                </span>
                              ) : null}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => onToggleComment(field.id)}
                                    aria-label={`${commentOpen ? "Hide" : "Add"} comment for ${field.label}`}
                                    className={cn(
                                      "h-7 w-7 rounded-md hover:bg-slate-800 hover:text-slate-100",
                                      hasComment || commentOpen
                                        ? "text-cyan-200"
                                        : "text-slate-500",
                                    )}
                                  >
                                    <MessageSquare className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {commentOpen ? "Hide comment" : "Add comment"}
                                </TooltipContent>
                              </Tooltip>
                            </span>
                          </span>
                          {field.help ? (
                            <p className="rounded-md border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium leading-5 text-cyan-50">
                              {field.help}
                            </p>
                          ) : null}
                          <RalphInputControl
                            field={field}
                            value={
                              state.values[field.id] ??
                              getDefaultRalphInputValue(field)
                            }
                            onChange={(value) => onValueChange(field.id, value)}
                          />
                          {commentOpen ? (
                            <Textarea
                              value={answerComment}
                              aria-label={`Comment for ${field.label}`}
                              placeholder="Add extra context for this answer"
                              onChange={(event) =>
                                onCommentChange(field.id, event.target.value)
                              }
                              className="min-h-20 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          ) : null}
                          <span className="flex min-w-0 items-start justify-between gap-3">
                            {error ? (
                              <span className="min-w-0 text-xs leading-5 text-rose-200">
                                {error}
                              </span>
                            ) : (
                              <span />
                            )}
                            {field.skippable ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => onSkipField(field.id)}
                                className={cn(
                                  "shrink-0 hover:bg-slate-800 hover:text-slate-100",
                                  skipped ? "text-slate-200" : "text-slate-400",
                                )}
                              >
                                {skipped ? "Skipped" : "Skip"}
                              </Button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ScrollArea>

            <DialogFooter className="justify-end border-t border-slate-800 bg-slate-950 px-5 py-3 sm:flex-row">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onClose}
                  className="text-slate-400 hover:bg-slate-900 hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onStartNow}
                  className="border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/15"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Start now
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || state.status !== "ready"}
                  onClick={onSubmitAnswers}
                  className="bg-cyan-600 text-white hover:bg-cyan-500"
                >
                  {state.status === "loading" ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {getPrimaryActionLabel(state)}
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
