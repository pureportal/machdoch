import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Regex,
  WholeWord,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { SearchAddon } from "@xterm/addon-search";

const DECORATIONS = {
  matchBackground: "#0c4a6e",
  activeMatchBackground: "#0369a1",
  matchOverviewRuler: "#38bdf8",
  activeMatchColorOverviewRuler: "#7dd3fc",
} as const;

export const WorkspaceTerminalSearch = ({
  search,
  onClose,
}: {
  search: SearchAddon | null;
  onClose: () => void;
}): JSX.Element => {
  const [term, setTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (!search) return;
    const subscription = search.onDidChangeResults(
      ({ resultIndex, resultCount }) =>
        setResult({ index: resultIndex, count: resultCount }),
    );
    return () => {
      subscription.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const find = (direction: "next" | "previous", value = term): void => {
    if (!search) return;
    if (!value) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    const options = {
      caseSensitive,
      regex,
      wholeWord,
      decorations: DECORATIONS,
    };
    if (direction === "next")
      search.findNext(value, { ...options, incremental: true });
    else search.findPrevious(value, options);
  };

  useEffect(() => {
    find("next");
  }, [caseSensitive, regex, wholeWord]);

  const toggle = (
    label: string,
    Icon: typeof Regex,
    checked: boolean,
    set: (value: boolean) => void,
  ): JSX.Element => (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      aria-pressed={checked}
      tooltip={label}
      className={cn("size-6", checked && "bg-slate-800 text-sky-300")}
      onClick={() => set(!checked)}
    >
      <Icon className="size-3.5" />
    </Button>
  );

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-slate-800/80 bg-slate-950 px-2 py-1">
      <input
        ref={inputRef}
        value={term}
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        className="h-6 min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 text-xs text-slate-200 outline-none focus:border-sky-500"
        onChange={(event) => {
          setTerm(event.target.value);
          find("next", event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            find(event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span
        className="min-w-12 text-center text-[11px] text-slate-500"
        aria-live="polite"
      >
        {term && result
          ? result.count === 0
            ? "0"
            : `${result.index + 1}/${result.count}`
          : ""}
      </span>
      {toggle("Match case", CaseSensitive, caseSensitive, setCaseSensitive)}
      {toggle("Whole word", WholeWord, wholeWord, setWholeWord)}
      {toggle("Regular expression", Regex, regex, setRegex)}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label="Previous match"
        tooltip="Previous match"
        onClick={() => find("previous")}
      >
        <ArrowUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label="Next match"
        tooltip="Next match"
        onClick={() => find("next")}
      >
        <ArrowDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label="Close find"
        tooltip="Close find"
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
};
