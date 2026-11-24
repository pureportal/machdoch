import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Regex,
  Replace,
  WholeWord,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type {
  WorkspaceTextReplaceResult,
  WorkspaceTextSearch,
  WorkspaceTextSearchOptions,
} from "@machdoch/fleet-protocol/workspace-contract";
import {
  replaceWorkspaceText,
  searchWorkspaceText,
} from "./workspace-tools-runtime";

const SEARCH_DELAY_MS = 250;

const Toggle = ({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}): JSX.Element => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={pressed}
    title={label}
    className={cn(
      "grid size-6 place-items-center rounded",
      pressed
        ? "bg-sky-500/20 text-sky-200"
        : "text-slate-500 hover:text-slate-300",
    )}
    onClick={onToggle}
  >
    {children}
  </button>
);

const highlighted = (
  preview: string,
  column: number,
  length: number,
): JSX.Element => (
  <>
    {preview.slice(0, column - 1)}
    <mark className="rounded-sm bg-amber-400/25 text-amber-100">
      {preview.slice(column - 1, column - 1 + length)}
    </mark>
    {preview.slice(column - 1 + length)}
  </>
);

export const WorkspaceTextSearchView = ({
  workspaceRoot,
  onOpenMatch,
}: {
  workspaceRoot: string;
  onOpenMatch: (path: string, line: number) => void;
}): JSX.Element => {
  const [options, setOptions] = useState<WorkspaceTextSearchOptions>({
    query: "",
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    include: "",
    exclude: "",
  });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [result, setResult] = useState<WorkspaceTextSearch | null>(null);
  const [preview, setPreview] = useState<WorkspaceTextReplaceResult | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    setPreview(null);
    if (!options.query) {
      setResult(null);
      setError(null);
      return;
    }
    const request = ++requestRef.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchWorkspaceText(workspaceRoot, options)
        .then((next) => {
          if (request !== requestRef.current) return;
          setResult(next);
          setError(null);
        })
        .catch((failure: unknown) => {
          if (request !== requestRef.current) return;
          setResult(null);
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [options, workspaceRoot]);

  const targets = (): { path: string; revision: string }[] =>
    (result?.files ?? []).map((file) => ({
      path: file.path,
      revision: file.revision,
    }));

  const runReplace = async (apply: boolean): Promise<void> => {
    if (!result?.files.length) return;
    if (apply) {
      const total =
        preview?.files.reduce((sum, file) => sum + file.replacements, 0) ?? 0;
      if (
        !window.confirm(
          `Replace ${total} matches in ${preview?.files.length ?? 0} files?`,
        )
      )
        return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await replaceWorkspaceText(
        workspaceRoot,
        options,
        replacement,
        apply,
        targets(),
      );
      setPreview(next);
      if (apply) {
        const stale = next.files.filter(
          (file) => file.status === "changed" || file.status === "unreadable",
        );
        if (stale.length)
          setError(
            `${stale.length} files changed before they could be updated. Search again to retry them.`,
          );
        setOptions((current) => ({ ...current }));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  const update = (change: Partial<WorkspaceTextSearchOptions>): void =>
    setOptions((current) => ({ ...current, ...change }));

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-slate-800/80 p-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={showReplace ? "Hide replace" : "Show replace"}
            aria-expanded={showReplace}
            className="grid size-6 place-items-center text-slate-500 hover:text-slate-300"
            onClick={() => setShowReplace((current) => !current)}
          >
            {showReplace ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
          <Input
            autoFocus
            value={options.query}
            aria-label="Search"
            placeholder="Search"
            className="h-7 min-w-0 flex-1 border-slate-800 bg-slate-950 px-2 text-xs"
            onChange={(event) => update({ query: event.target.value })}
          />
          <Toggle
            label="Match case"
            pressed={options.caseSensitive}
            onToggle={() => update({ caseSensitive: !options.caseSensitive })}
          >
            <CaseSensitive className="size-3.5" />
          </Toggle>
          <Toggle
            label="Whole word"
            pressed={options.wholeWord}
            onToggle={() => update({ wholeWord: !options.wholeWord })}
          >
            <WholeWord className="size-3.5" />
          </Toggle>
          <Toggle
            label="Regular expression"
            pressed={options.regex}
            onToggle={() => update({ regex: !options.regex })}
          >
            <Regex className="size-3.5" />
          </Toggle>
        </div>
        {showReplace ? (
          <div className="flex items-center gap-1 pl-7">
            <Input
              value={replacement}
              aria-label="Replace"
              placeholder="Replace"
              className="h-7 min-w-0 flex-1 border-slate-800 bg-slate-950 px-2 text-xs"
              onChange={(event) => {
                setReplacement(event.target.value);
                setPreview(null);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={!result?.files.length || loading}
              onClick={() => void runReplace(false)}
            >
              Preview
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Replace all"
              tooltip="Replace all"
              disabled={!preview || preview.applied || loading}
              onClick={() => void runReplace(true)}
            >
              <Replace className="size-3.5" />
            </Button>
          </div>
        ) : null}
        <button
          type="button"
          className="self-start pl-7 text-[11px] text-slate-500 hover:text-slate-300"
          onClick={() => setShowFilters((current) => !current)}
        >
          {showFilters ? "Hide filters" : "Filters"}
        </button>
        {showFilters ? (
          <div className="flex flex-col gap-1 pl-7">
            <Input
              value={options.include ?? ""}
              aria-label="Files to include"
              placeholder="Include, e.g. src/**/*.ts"
              className="h-7 border-slate-800 bg-slate-950 px-2 text-xs"
              onChange={(event) => update({ include: event.target.value })}
            />
            <Input
              value={options.exclude ?? ""}
              aria-label="Files to exclude"
              placeholder="Exclude"
              className="h-7 border-slate-800 bg-slate-950 px-2 text-xs"
              onChange={(event) => update({ exclude: event.target.value })}
            />
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="shrink-0 px-3 py-2 text-red-300">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {loading && !result ? (
          <LoaderCircle className="mx-auto my-4 size-4 animate-spin text-slate-500" />
        ) : null}
        {result ? (
          <p className="px-3 pb-1 text-[11px] text-slate-500">
            {result.totalMatches} results in {result.files.length} files
            {result.limitReached ? " · limit reached" : ""}
          </p>
        ) : null}
        {preview
          ? preview.files.map((file) => (
              <section key={file.path} className="px-2 pb-2">
                <p className="truncate px-1 py-1 font-medium text-slate-300">
                  {file.path}{" "}
                  <span className="text-slate-500">· {file.replacements}</span>
                  {file.status !== "preview" ? (
                    <span className="ml-1 text-slate-500">· {file.status}</span>
                  ) : null}
                </p>
                {file.lines.map((line) => (
                  <button
                    key={line.line}
                    type="button"
                    className="block w-full rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-slate-900"
                    onClick={() => onOpenMatch(file.path, line.line)}
                  >
                    <span className="block truncate text-red-300/90 line-through decoration-red-400/50">
                      {line.before}
                    </span>
                    <span className="block truncate text-emerald-300">
                      {line.after}
                    </span>
                  </button>
                ))}
              </section>
            ))
          : result?.files.map((file) => {
              const isCollapsed = collapsed.has(file.path);
              return (
                <section key={file.path}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    className="flex w-full items-center gap-1 px-2 py-1 text-left text-slate-300 hover:bg-slate-900"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(file.path)) next.delete(file.path);
                        else next.add(file.path);
                        return next;
                      })
                    }
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3 shrink-0" />
                    ) : (
                      <ChevronDown className="size-3 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span className="text-[10px] text-slate-500">
                      {file.matches.length}
                    </span>
                  </button>
                  {isCollapsed
                    ? null
                    : file.matches.map((match) => (
                        <button
                          key={`${match.line}:${match.column}`}
                          type="button"
                          className="flex w-full gap-2 py-0.5 pl-7 pr-2 text-left font-mono text-[11px] text-slate-400 hover:bg-slate-900"
                          onClick={() => onOpenMatch(file.path, match.line)}
                        >
                          <span className="w-8 shrink-0 text-right text-slate-600">
                            {match.line}
                          </span>
                          <span className="min-w-0 truncate">
                            {highlighted(
                              match.preview,
                              match.previewColumn,
                              match.length,
                            )}
                          </span>
                        </button>
                      ))}
                </section>
              );
            })}
      </div>
    </div>
  );
};
