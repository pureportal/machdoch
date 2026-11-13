"use client";

import { useMemo } from "react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import { parseIssueSort } from "@/lib/issue-scopes";
import { parseIssueViewOptions, visibleIssues } from "@/lib/issue-view-options";
import { groupIssues, parseGrouping } from "./issue-grouping";

export function useIssueGroups(
  issues: CloudIssueSummary[],
  workspace: CloudWorkspace,
  teamId: string | null,
  search: Pick<URLSearchParams, "get">,
) {
  const view = search.get("view");
  const density = search.get("density");
  const completed = search.get("completed");
  const subIssues = search.get("subIssues");
  const empty = search.get("empty");
  const group = search.get("group");
  const sortValue = search.get("sort");
  const order = search.get("order");
  const options = useMemo(
    () =>
      parseIssueViewOptions(
        new URLSearchParams(
          Object.entries({ view, density, completed, subIssues, empty }).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
      ),
    [view, density, completed, subIssues, empty],
  );
  const groups = useMemo(() => {
    const grouping = parseGrouping(group);
    return groupIssues(
      visibleIssues(issues, options),
      options.board && grouping === "none" ? "status" : grouping,
      workspace,
      teamId,
      parseIssueSort(sortValue),
      order === "reverse",
      options.board || options.emptyGroups,
    );
  }, [issues, options, group, sortValue, order, workspace, teamId]);
  return { options, groups };
}
