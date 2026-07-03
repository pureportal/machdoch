import { Check, CornerDownRight } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import type { ChatInputNeededPlaceholder } from "../_helpers/chat-input-needed-placeholders";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";

export interface ChatInputNeededDialogRequest {
  placeholder: ChatInputNeededPlaceholder;
  currentIndex: number;
  totalCount: number;
}

interface ChatInputNeededDialogProps {
  request: ChatInputNeededDialogRequest | null;
  onCancel: () => void;
  onSubmitValue: (value: string) => void;
}

const getInitialPlaceholderValue = (
  placeholder: ChatInputNeededPlaceholder | null | undefined,
): string => {
  if (!placeholder) {
    return "";
  }

  if (placeholder.defaultValue) {
    return placeholder.defaultValue;
  }

  if (!placeholder.optional && placeholder.options?.[0]) {
    return placeholder.options[0];
  }

  return "";
};

export const ChatInputNeededDialog = ({
  request,
  onCancel,
  onSubmitValue,
}: ChatInputNeededDialogProps): JSX.Element => {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const inputId = useId();
  const normalizedValue = value.trim();
  const isLastRequest =
    request !== null && request.currentIndex >= request.totalCount - 1;
  const canSubmit = request?.placeholder.optional || Boolean(normalizedValue);

  useEffect(() => {
    setValue(getInitialPlaceholderValue(request?.placeholder));
  }, [request?.currentIndex, request?.placeholder]);

  const submitValue = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!request || !canSubmit) {
      return;
    }

    onSubmitValue(normalizedValue);
  };

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-28px))] max-w-none rounded-xl border-slate-700/80 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-white">
                Input Needed
              </DialogTitle>
              <DialogDescription className="sr-only">
                Enter the missing value before submitting the chat message.
              </DialogDescription>
            </div>
            {request ? (
              <span className="shrink-0 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold text-cyan-100">
                {request.currentIndex + 1} / {request.totalCount}
              </span>
            ) : null}
          </div>
        </DialogHeader>

        {request ? (
          <form onSubmit={submitValue} className="grid gap-4 p-5">
            <div className="grid gap-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <label
                  htmlFor={inputId}
                  className="min-w-0 truncate text-sm font-semibold text-slate-50"
                >
                  {request.placeholder.key}
                </label>
                {request.placeholder.occurrenceCount > 1 ? (
                  <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                    {request.placeholder.occurrenceCount} uses
                  </span>
                ) : null}
                {request.placeholder.optional ? (
                  <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                    optional
                  </span>
                ) : null}
              </div>
              {request.placeholder.options ? (
                <select
                  id={inputId}
                  ref={(node) => {
                    inputRef.current = node;
                  }}
                  aria-label={`Value for ${request.placeholder.key}`}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-cyan-500/70 focus-visible:ring-1 focus-visible:ring-cyan-500/40"
                >
                  {request.placeholder.optional ? (
                    <option value="">No value</option>
                  ) : null}
                  {request.placeholder.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <Textarea
                  id={inputId}
                  ref={(node) => {
                    inputRef.current = node;
                  }}
                  aria-label={`Value for ${request.placeholder.key}`}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={`Enter ${request.placeholder.key}`}
                  className="min-h-28 resize-y border-slate-700 bg-slate-900 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:ring-cyan-500/40"
                />
              )}
            </div>

            <DialogFooter className="sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                className="text-slate-400 hover:bg-slate-900 hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!canSubmit}
                className="bg-cyan-600 text-white hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500"
              >
                {isLastRequest ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <CornerDownRight className="h-3.5 w-3.5" />
                )}
                {isLastRequest ? "Start" : "Next"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
