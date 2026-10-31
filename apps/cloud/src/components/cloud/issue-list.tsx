"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bookmark, CircleDot, Columns3, LayoutList, Search } from "lucide-react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import {
  issueScopes,
  parseIssueScope,
  type IssueScope,
} from "@/lib/issue-scopes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest } from "./api-client";
import { IssueBoard } from "./issue-board";
import { IssueBulkBar } from "./issue-bulk-bar";
import { IssueDisplayMenu, IssueFilters } from "./issue-filters";
import { CreateIssue } from "./issue-form";
import { groupIssues, parseGrouping } from "./issue-grouping";
import { IssueRows } from "./issue-rows";
import { SaveViewDialog } from "./save-view-dialog";
import { useToast } from "./toast";
import { useIssueList } from "./use-issue-list";
import { useIssueSelection } from "./use-issue-selection";

const pageSize = 200;
const filterParameters = [
  "teamId",
  "projectId",
  "cycleId",
  "labelId",
  "statusId",
  "assigneeId",
  "priority",
  "estimate",
  "query",
  "archived",
];

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
  const grouping = parseGrouping(search.get("group"));
  const sort = search.get("sort");
  const groups = useMemo(
    () =>
      groupIssues(
        issues,
        board && grouping === "none" ? "status" : grouping,
        workspace,
        teamId,
        sort,
        board,
      ),
    [issues, board, grouping, workspace, teamId, sort],
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
  useEffect(() => setExhausted(false), [search]);
  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === "teamId") {
      next.delete("projectId");
      next.delete("cycleId");
      next.delete("labelId");
      next.delete("statusId");
    }
    const encoded = next.toString();
    router.push(`/cloud/issues${encoded ? `?${encoded}` : ""}`);
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
      <header className="cloud-page-header">
        <div className="cloud-page-heading">
          <h1>{issueScopes[scope].label === "All issues" ? "Issues" : issueScopes[scope].label}</h1>
        </div>
        <CreateIssue
          workspace={workspace}
          teamId={teamId ?? undefined}
          projectId={search.get("projectId") ?? undefined}
          cycleId={search.get("cycleId") ?? undefined}
          shortcut
          key={search.has("new") ? "new" : "default"}
          autoOpen={search.has("new")}
        />
      </header>
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
            placeholder="Search issues…"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            maxLength={200}
          />
        </form>
      </div>
      <IssueFilters
        workspace={workspace}
        labels={labels}
        search={new URLSearchParams(search)}
        setFilter={setFilter}
        clearable={clearable}
        onClear={() => {
          const kept = new URLSearchParams(search);
          for (const name of filterParameters) kept.delete(name);
          const encoded = kept.toString();
          router.push(`/cloud/issues${encoded ? `?${encoded}` : ""}`);
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
        <IssueDisplayMenu
          search={new URLSearchParams(search)}
          setFilter={setFilter}
        />
        <div className="cloud-view-toggle" role="group" aria-label="Issue view">
          <Button
            variant="outline"
            aria-label="List view"
            aria-pressed={!board}
            onClick={() => setFilter("view", "")}
          >
            <LayoutList />
          </Button>
          <Button
            variant="outline"
            aria-label="Board view"
            aria-pressed={board}
            onClick={() => setFilter("view", "board")}
          >
            <Columns3 />
          </Button>
        </div>
      </IssueFilters>
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
