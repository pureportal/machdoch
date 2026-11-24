import { useEffect, useState, type JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { CloudIssueReference } from "./workspace-cloud-issues";
import { issueKeyFromBranch } from "./workspace-git-branch-search";
import { getCloudIssueDirectory } from "./workspace-tools-runtime";

const MAX_BRANCH_LOOKUPS = 40;
const SEARCH_DELAY_MS = 250;

const STATE_CLASSES: Record<string, string> = {
  active: "text-sky-300",
  review: "text-violet-300",
  blocked: "text-red-300",
  complete: "text-emerald-300",
  canceled: "text-slate-500",
};

export const useBranchIssues = (
  workspaceRoot: string,
  branchNames: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, CloudIssueReference> => {
  const keys = enabled
    ? [
        ...new Set(
          branchNames.flatMap((name) => issueKeyFromBranch(name) ?? []),
        ),
      ]
        .slice(0, MAX_BRANCH_LOOKUPS)
        .join("\n")
    : "";
  const [issues, setIssues] = useState<
    ReadonlyMap<string, CloudIssueReference>
  >(() => new Map());
  useEffect(() => {
    if (!keys) return;
    let active = true;
    let reported = false;
    const directory = getCloudIssueDirectory(workspaceRoot);
    for (const key of keys.split("\n")) {
      directory
        .lookup(key)
        .then((issue) => {
          if (!active || !issue) return;
          setIssues((current) => new Map(current).set(key, issue));
        })
        .catch((error: unknown) => {
          if (reported) return;
          reported = true;
          console.error("Loading machdoch.cloud issues failed", error);
        });
    }
    return () => {
      active = false;
    };
  }, [keys, workspaceRoot]);
  return issues;
};

export const useIssueSearch = (
  workspaceRoot: string,
  query: string,
  enabled: boolean,
): CloudIssueReference[] => {
  const trimmed = query.trim();
  const [result, setResult] = useState<{
    query: string;
    issues: CloudIssueReference[];
  } | null>(null);
  useEffect(() => {
    if (!enabled || !trimmed) return;
    let active = true;
    const timer = window.setTimeout(() => {
      getCloudIssueDirectory(workspaceRoot)
        .search(trimmed)
        .then((issues) => {
          if (active) setResult(issues ? { query: trimmed, issues } : null);
        })
        .catch((error: unknown) =>
          console.error("Searching machdoch.cloud issues failed", error),
        );
    }, SEARCH_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, trimmed, workspaceRoot]);
  return enabled && result?.query === trimmed ? result.issues : [];
};

export const BranchIssue = ({
  issueKey,
  issue,
}: {
  issueKey: string;
  issue?: CloudIssueReference;
}): JSX.Element => (
  <>
    {issue ? (
      <span className="min-w-0 max-w-[45%] truncate text-[11px] text-slate-500">
        {issue.title}
      </span>
    ) : null}
    <span className="shrink-0 rounded border border-slate-700 px-1 text-[10px] text-slate-400">
      {issueKey}
      {issue ? (
        <span className={cn(STATE_CLASSES[issue.state])}>
          {" "}
          · {issue.statusName}
        </span>
      ) : null}
    </span>
  </>
);
