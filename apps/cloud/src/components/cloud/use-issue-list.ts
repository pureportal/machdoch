"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { cloudRequest } from "./api-client";
import { applyIssueChanges } from "./issue-properties";
import { mergeRefreshedIssues } from "./merge-refreshed-issues";
import { useToast } from "./toast";

const liveRefreshMs = 30_000;
const maximumChangesPerRequest = 100;

export function useIssueList(
  initial: CloudIssueSummary[],
  workspace: CloudWorkspace,
  listKey = "",
) {
  const router = useRouter();
  const toast = useToast();
  const [issues, setIssues] = useState(initial);
  const pending = useRef(0);
  const appended = useRef(new Set<string>());
  const currentListKey = useRef(listKey);
  useEffect(() => {
    if (currentListKey.current !== listKey) {
      currentListKey.current = listKey;
      appended.current = new Set();
    }
    if (pending.current === 0)
      setIssues((current) =>
        mergeRefreshedIssues(initial, current, appended.current),
      );
  }, [initial, listKey]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && pending.current === 0)
        startTransition(() => router.refresh());
    };
    const timer = setInterval(refresh, liveRefreshMs);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);
  const apply = useCallback(
    (targets: CloudIssueSummary[], changes: IssueChangeSet) => {
      const ids = new Set(targets.map((issue) => issue.id));
      const previous = new Map(targets.map((issue) => [issue.id, issue]));
      setIssues((current) =>
        current
          .map((issue) =>
            ids.has(issue.id)
              ? applyIssueChanges(issue, changes, workspace)
              : issue,
          )
          .filter(
            (issue) =>
              changes.archived === undefined ||
              !ids.has(issue.id) ||
              issue.archived === changes.archived,
          ),
      );
      pending.current += 1;
      void (async () => {
        try {
          for (
            let start = 0;
            start < targets.length;
            start += maximumChangesPerRequest
          )
            await cloudRequest("issues/changes", {
              method: "POST",
              key: crypto.randomUUID(),
              body: {
                issues: targets
                  .slice(start, start + maximumChangesPerRequest)
                  .map(({ id }) => ({ id })),
                changes,
              },
            });
          if (targets.length > 1)
            toast(`${targets.length} issues updated`);
        } catch (reason) {
          setIssues((current) =>
            current.map((issue) => previous.get(issue.id) ?? issue),
          );
          toast((reason as Error).message, "error");
        } finally {
          pending.current -= 1;
          startTransition(() => router.refresh());
        }
      })();
    },
    [router, toast, workspace],
  );
  const append = useCallback((more: CloudIssueSummary[]) => {
    for (const issue of more) appended.current.add(issue.id);
    setIssues((current) => {
      const known = new Set(current.map((issue) => issue.id));
      return [...current, ...more.filter((issue) => !known.has(issue.id))];
    });
  }, []);
  return { issues, apply, append };
}
