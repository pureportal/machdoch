"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { holderCan } from "@/lib/cloud-permissions";
import type {
  CloudCycle,
  CloudIssueSummary,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { IssueBoard } from "./issue-board";
import { IssueBulkBar } from "./issue-bulk-bar";
import { IssueDisplayMenu } from "./issue-display-menu";
import { IssueRows } from "./issue-rows";
import { useIssueGroups } from "./use-issue-groups";
import { useIssueList } from "./use-issue-list";
import { useIssueSelection } from "./use-issue-selection";

export function CycleIssueView({
  cycle,
  issues: initial,
  workspace,
}: {
  cycle: CloudCycle;
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const { issues, apply } = useIssueList(initial, workspace, search.toString());
  const writable = holderCan(workspace.actor, "issues.edit");
  const { options, groups } = useIssueGroups(
    issues,
    workspace,
    cycle.teamId,
    search,
  );
  const { selected, selectedIssues, toggle, clear } = useIssueSelection(
    issues,
    groups,
  );
  const setDisplay = (name: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    const encoded = next.toString();
    router.push(`/cloud/cycles/${cycle.id}${encoded ? `?${encoded}` : ""}`, {
      scroll: false,
    });
  };
  return (
    <section className="cloud-cycle-issues" aria-label="Cycle issues">
      <div className="cloud-project-issues-toolbar">
        <h2>
          Issues<span className="cloud-count">{issues.length}</span>
        </h2>
        <IssueDisplayMenu
          search={new URLSearchParams(search)}
          setFilter={setDisplay}
          layout
        />
        {cycle.status !== "closed" && (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/cloud/cycles/${cycle.id}/plan`}>
              Plan issues
              <ArrowUpRight />
            </Link>
          </Button>
        )}
      </div>
      {!issues.length ? (
        <div className="cloud-empty">
          <p>No issues in this cycle.</p>
        </div>
      ) : options.board ? (
        <IssueBoard
          groups={groups}
          issues={issues}
          workspace={workspace}
          writable={writable}
          apply={apply}
          density={options.density}
        />
      ) : (
        <IssueRows
          groups={groups}
          workspace={workspace}
          writable={writable}
          apply={apply}
          selected={selected}
          onToggle={toggle}
          density={options.density}
          showEmpty={options.emptyGroups}
          omit={["cycle"]}
        />
      )}
      {selectedIssues.length > 0 && (
        <IssueBulkBar
          issues={selectedIssues}
          workspace={workspace}
          apply={apply}
          onClear={clear}
        />
      )}
    </section>
  );
}
