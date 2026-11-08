import { Check, GitBranch, LoaderCircle, Plus } from "lucide-react";
import { useState, type JSX } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@machdoch/media-studio/tauri/ui/components/ui/command.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { isValidGitBranchName } from "./branch-name";
import { SESSION_GIT_BRANCH_TONE } from "./session-git-branch-details";

export const SessionGitBranchPicker = ({
  branchName,
  suggestions,
  loading,
  onSelect,
}: {
  branchName: string | null;
  suggestions: readonly string[];
  loading: boolean;
  onSelect: (branchName: string) => void;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const draft = query.trim();
  const draftValid = isValidGitBranchName(draft);
  const canUseDraft =
    draftValid && draft !== branchName && !suggestions.includes(draft);

  return (
    <Command className="bg-transparent dark:bg-transparent">
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        aria-label="Branch name"
        placeholder="Branch name"
      />
      <CommandList className="max-h-72">
        {draft && !draftValid ? (
          <p
            role="alert"
            className={cn("px-3 py-2 text-xs", SESSION_GIT_BRANCH_TONE.danger)}
          >
            Not a valid branch name.
          </p>
        ) : (
          <CommandEmpty className="py-4 text-xs">
            {loading ? (
              <LoaderCircle
                aria-label="Loading branches"
                className={cn(
                  "mx-auto size-4 animate-spin",
                  SESSION_GIT_BRANCH_TONE.faint,
                )}
              />
            ) : (
              "No branches"
            )}
          </CommandEmpty>
        )}
        {canUseDraft ? (
          <CommandGroup>
            <CommandItem
              value={`use:${draft}`}
              keywords={[draft]}
              onSelect={() => onSelect(draft)}
            >
              <Plus className={cn("size-3.5", SESSION_GIT_BRANCH_TONE.info)} />
              <span className="min-w-0 flex-1 truncate">
                Use <strong>{draft}</strong>
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}
        {suggestions.length > 0 ? (
          <CommandGroup>
            {suggestions.map((suggestion) => (
              <CommandItem
                key={suggestion}
                value={`branch:${suggestion}`}
                keywords={[suggestion]}
                onSelect={() => onSelect(suggestion)}
              >
                <GitBranch
                  className={cn("size-3.5", SESSION_GIT_BRANCH_TONE.faint)}
                />
                <span className="min-w-0 flex-1 truncate">{suggestion}</span>
                {suggestion === branchName ? (
                  <Check
                    className={cn("size-3.5", SESSION_GIT_BRANCH_TONE.info)}
                  />
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
};
