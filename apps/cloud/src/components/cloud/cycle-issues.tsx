import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import type { CycleDetail } from "@/lib/cloud-cycle-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export function CycleIssues({ detail }: { detail: CycleDetail }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const { issues, cycle, statusNames } = detail;
  const carried = new Set(detail.carriedIssueIds);
  const search = query.trim().toLowerCase();
  const filtered = issues.filter(
    (issue) =>
      (!status || statusNames[issue.id] === status) &&
      `${issue.identifier} ${issue.title}`.toLowerCase().includes(search),
  );
  return (
    <section className="cloud-cycle-issues" aria-label="Cycle issues">
      <header>
        <h2>
          Issues<span className="cloud-count">{issues.length}</span>
        </h2>
        {cycle.status !== "closed" && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/cloud/cycles/${cycle.id}/plan`}>
              Plan issues
              <ArrowUpRight />
            </Link>
          </Button>
        )}
      </header>
      {issues.length > 0 && (
        <div className="cloud-toolbar">
          <div className="cloud-issue-search">
            <Search size={15} aria-hidden="true" />
            <Input
              type="search"
              aria-label="Search cycle issues"
              placeholder="Search issues…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter issue status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {[...new Set(issues.map((issue) => statusNames[issue.id]))].map(
              (name) => (
                <option key={name}>{name}</option>
              ),
            )}
          </Select>
        </div>
      )}
      {!filtered.length ? (
        <div className="cloud-empty">
          <p>
            {issues.length ? "No matching issues." : "No issues in this cycle."}
          </p>
          {(query || status) && (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setStatus("");
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <ul className="cloud-cycle-issue-list">
          {filtered.map((issue) => (
            <li key={issue.id}>
              <Link href={`/cloud/issues/${issue.id}`}>
                <span className="cloud-issue-key">{issue.identifier}</span>
                <span className="cloud-issue-title">{issue.title}</span>
              </Link>
              <span className="cloud-state" data-state={issue.state}>
                {statusNames[issue.id]}
              </span>
              <span className="cloud-cycle-issue-points">
                {issue.estimatePoints === null
                  ? "Unestimated"
                  : `${issue.estimatePoints} pts`}
              </span>
              {cycle.status === "closed" && carried.has(issue.id) && (
                <span className="cloud-cycle-carried">
                  Carried over
                  <ArrowUpRight size={12} aria-hidden="true" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
