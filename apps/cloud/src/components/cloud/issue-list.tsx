"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, CircleDot, Search } from "lucide-react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import {
  issueScopes,
  parseIssueScope,
  type IssueScope,
} from "@/lib/issue-scopes";
import {
  issueFilterKeys,
  meFilterValue,
  noneFilterValue,
} from "@/lib/issue-filter-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest } from "./api-client";
import { IssueBoard } from "./issue-board";
import { IssueBulkBar } from "./issue-bulk-bar";
import {
  IssueFilterButton,
  IssueFilterChips,
  useIssueFilterState,
} from "./issue-filters";
import { IssueDisplayMenu } from "./issue-display-menu";
import { filterFieldDefinitions } from "./issue-filter-fields";
import { CreateIssue } from "./issue-form";
import { parseIssueSort } from "@/lib/issue-scopes";
import { groupIssues, parseGrouping } from "./issue-grouping";
import { IssueRows } from "./issue-rows";
import { issueNavigationKey } from "./issue-header";
import { useAgentPageEntity } from "./agent/agent-shell";
import { SaveViewDialog } from "./save-view-dialog";
import { useToast } from "./toast";
import { useIssueList } from "./use-issue-list";
import { useIssueSelection } from "./use-issue-selection";

const pageSize = 200;
const filterParameters = [...issueFilterKeys, "teamId", "query", "archived"];

export function IssueList({
  workspace,
  issues: initial,
  labels,
}: {
  workspace: CloudWorkspace;
  issues: CloudIssueSummary[];
  labels: CloudLabel[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const { issues, apply, append } = useIssueList(
    initial,
    workspace,
    search.toString(),
  );
  const writable = workspace.actor.role !== "viewer";
  const board = search.get("view") === "board";
  const query = search.get("query") ?? "";
  const scope = parseIssueScope(search.get("scope"));
  const teamId = search.get("teamId");
  const team = workspace.teams.find((entry) => entry.id === teamId);
  useAgentPageEntity(
    team ? { kind: "team", id: team.id, label: team.name, title: null } : null,
  );
  const definitions = useMemo(
    () => filterFieldDefinitions(workspace, labels, teamId),
    [workspace, labels, teamId],
  );
  const filters = useIssueFilterState(
    new URLSearchParams(search),
    definitions,
    workspace.teams,
    navigate,
  );
  const singleValue = (field: "project" | "cycle") => {
    const condition = filters.conditions.find(
      (entry) => entry.field === field && !entry.negated,
    );
    const value = condition?.values.length === 1 ? condition.values[0] : null;
    return value && value !== noneFilterValue && value !== meFilterValue
      ? value
      : undefined;
  };
  const grouping = parseGrouping(search.get("group"));
  const sort = parseIssueSort(search.get("sort"));
  const reversed = search.get("order") === "reverse";
  const groups = useMemo(
    () =>
      groupIssues(
        issues,
        board && grouping === "none" ? "status" : grouping,
        workspace,
        teamId,
        sort,
        reversed,
        board,
      ),
    [issues, board, grouping, workspace, teamId, sort, reversed],
  );
  const [searchText, setSearchText] = useState(query);
  const { selected, selectedIssues, toggle, clear } = useIssueSelection(
    issues,
    groups,
  );
  const [savingView, setSavingView] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => setSearchText(query), [query]);
  useEffect(() => {
    sessionStorage.setItem(
      issueNavigationKey,
      JSON.stringify({
        ids: groups.flatMap((group) => group.issues.map((issue) => issue.id)),
        href: `${location.pathname}${location.search}`,
      }),
    );
  }, [groups]);
  useEffect(() => setExhausted(false), [search]);
  function navigate(next: URLSearchParams) {
    const encoded = next.toString();
    router.push(`/cloud/issues${encoded ? `?${encoded}` : ""}`);
  }
  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    navigate(next);
  }
  function scopeHref(entry: IssueScope) {
    const parameters = new URLSearchParams(search);
    if (entry === "all") parameters.delete("scope");
    else parameters.set("scope", entry);
    const encoded = parameters.toString();
    return `/cloud/issues${encoded ? `?${encoded}` : ""}`;
  }
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilter("query", searchText.trim());
  }
  async function loadMore() {
    setLoadingMore(true);
    const parameters = new URLSearchParams(search);
    parameters.set("offset", String(issues.length));
    try {
      const page = await cloudRequest<{ issues: CloudIssueSummary[] }>(
        `issues/page?${parameters}`,
      );
      append(page.issues);
      if (page.issues.length < pageSize) setExhausted(true);
    } catch (reason) {
      toast((reason as Error).message, "error");
    } finally {
      setLoadingMore(false);
    }
  }
  const clearable = filterParameters.some((name) => search.has(name));
  return (
    <>
      <div className="cloud-issue-toolbar">
        <nav className="cloud-scope-tabs" aria-label="Issue views">
          {(Object.keys(issueScopes) as IssueScope[]).map((entry) => (
            <Link
              key={entry}
              href={scopeHref(entry)}
              aria-current={entry === scope ? "page" : undefined}
            >
              {issueScopes[entry].label}
            </Link>
          ))}
        </nav>
        <form
          className="cloud-issue-search"
          role="search"
          onSubmit={submitSearch}
        >
          <Search size={14} aria-hidden="true" />
          <Input
            name="query"
            aria-label="Search issues"
            placeholder="Search…"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            maxLength={200}
          />
        </form>
        <div className="cloud-issue-toolbar-actions">
          <IssueFilterButton
            fields={filters.fields}
            selected={filters.selected}
            onToggle={filters.toggle}
          />
          <IssueDisplayMenu
            search={new URLSearchParams(search)}
            setFilter={setFilter}
            layout
            archived
          />
          <CreateIssue
            workspace={workspace}
            teamId={teamId ?? undefined}
            projectId={singleValue("project")}
            cycleId={singleValue("cycle")}
            compactLabel="New issue"
            shortcut
            key={search.has("new") ? "new" : "default"}
            autoOpen={search.has("new")}
          />
        </div>
      </div>
      {(filters.conditions.length > 0 ||
        (!!team && workspace.teams.length > 1)) && (
        <IssueFilterChips
          state={filters}
          definitions={definitions}
          workspace={workspace}
          onClear={() => {
            const kept = new URLSearchParams(search);
            for (const name of filterParameters) kept.delete(name);
            navigate(kept);
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="cloud-filter-button"
            onClick={() => setSavingView(true)}
          >
            <Bookmark />
            Save view
          </Button>
        </IssueFilterChips>
      )}
      {!issues.length ? (
        <div className="cloud-empty">
          <CircleDot aria-hidden="true" />
          <p>
            {clearable
              ? "No matching issues."
              : scope === "all"
                ? "No issues yet."
                : `No issues in ${issueScopes[scope].label.toLowerCase()}.`}
          </p>
          {!workspace.teams.length && writable && (
            <Link className="underline" href="/cloud/teams">
              Create a team
            </Link>
          )}
        </div>
      ) : board ? (
        <IssueBoard
          groups={groups}
          issues={issues}
          workspace={workspace}
          writable={writable}
          apply={apply}
        />
      ) : (
        <IssueRows
          groups={groups}
          workspace={workspace}
          writable={writable}
          apply={apply}
          selected={selected}
          onToggle={toggle}
        />
      )}
      {issues.length >= pageSize && !exhausted && (
        <div className="cloud-load-more">
          <Button
            variant="ghost"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      {selectedIssues.length > 0 && (
        <IssueBulkBar
          issues={selectedIssues}
          workspace={workspace}
          apply={apply}
          onClear={clear}
        />
      )}
      <SaveViewDialog
        open={savingView}
        onOpenChange={setSavingView}
        filters={Object.fromEntries(search)}
        writable={writable}
      />
    </>
  );
}
