import { Plus, X } from "lucide-react";
import {
  useEffect,
  useId,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  MAX_INSTRUCTION_TAG_LENGTH,
  MAX_INSTRUCTION_TAGS,
  instructionTagKey,
  normalizeInstructionTag,
} from "../../../core/instruction-system/tag-rules.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../components/ui/submit-shortcut";
import { ControlTooltip } from "../components/ui/tooltip";

export const TagEditor = ({
  value,
  disabled = false,
  onChange,
  onPendingChange,
}: {
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
  onPendingChange?: (pending: boolean) => void;
}): JSX.Element => {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  useEffect(() => {
    setDraft("");
    setError(null);
    onPendingChange?.(false);
  }, [onPendingChange, value]);

  const add = (): void => {
    let candidates: string[];
    try {
      candidates = draft
        .split(",")
        .filter((tag) => tag.trim().length > 0)
        .map(normalizeInstructionTag);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
      return;
    }
    if (candidates.length === 0) {
      setDraft("");
      setError(null);
      onPendingChange?.(false);
      return;
    }
    const existing = new Set(value.map(instructionTagKey));
    const additions = candidates.filter((tag) => {
      const key = instructionTagKey(tag);
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
    if (value.length + additions.length > MAX_INSTRUCTION_TAGS) {
      setError(`Add at most ${MAX_INSTRUCTION_TAGS} tags.`);
      return;
    }
    onChange([...value, ...additions]);
    setDraft("");
    setError(null);
    onPendingChange?.(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (
      event.key === "," ||
      (event.key === "Enter" && !event.ctrlKey && !event.metaKey)
    ) {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="space-y-2">
      <SubmitShortcut asChild>
        <div className="flex gap-2">
        <Input
          value={draft}
          maxLength={
            MAX_INSTRUCTION_TAGS * (MAX_INSTRUCTION_TAG_LENGTH + 1) * 2
          }
          disabled={disabled}
          aria-label="Add tag"
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          placeholder="Add tag"
          onKeyDown={onKeyDown}
          onBlur={add}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            setError(null);
            onPendingChange?.(nextDraft.trim().length > 0);
          }}
          className="h-9 border-slate-800 bg-slate-950"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={
            disabled || !draft.trim() || value.length >= MAX_INSTRUCTION_TAGS
          }
          aria-label="Add tag"
          onClick={add}
          {...SUBMIT_SHORTCUT_ACTION_PROPS}
        >
          <Plus className="size-4" />
        </Button>
        </div>
      </SubmitShortcut>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={instructionTagKey(tag)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-300"
            >
              {tag}
              <ControlTooltip content={`Remove ${tag}`}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${tag}`}
                  onClick={() =>
                    onChange(value.filter((candidate) => candidate !== tag))
                  }
                  className="rounded-sm text-slate-500 outline-none hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              </ControlTooltip>
            </span>
          ))}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
};
