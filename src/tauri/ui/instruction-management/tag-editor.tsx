import { Plus, X } from "lucide-react";
import { useState, type JSX, type KeyboardEvent } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export const TagEditor = ({
  value,
  disabled = false,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}): JSX.Element => {
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const candidates = draft
      .split(",")
      .map((tag) => tag.trim().replace(/\s+/gu, " "))
      .filter(Boolean);
    if (candidates.length === 0) return;
    const existing = new Set(value.map((tag) => tag.toLocaleLowerCase()));
    onChange([
      ...value,
      ...candidates.filter((tag) => {
        const key = tag.toLocaleLowerCase();
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      }),
    ]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={draft}
          disabled={disabled}
          aria-label="Add tag"
          placeholder="Add tag"
          onKeyDown={onKeyDown}
          onChange={(event) => setDraft(event.target.value)}
          className="h-9 border-slate-800 bg-slate-950"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={disabled || !draft.trim()}
          aria-label="Add tag"
          onClick={add}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge
              key={tag.toLocaleLowerCase()}
              variant="secondary"
              className="gap-1 pl-2"
            >
              {tag}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${tag}`}
                onClick={() =>
                  onChange(value.filter((candidate) => candidate !== tag))
                }
                className="rounded-sm text-slate-500 hover:text-slate-100 disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
};
