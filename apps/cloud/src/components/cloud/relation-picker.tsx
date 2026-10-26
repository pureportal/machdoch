"use client";

import { useEffect, useState } from "react";
import type { CloudIssue } from "@/lib/cloud-contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";

export function RelationPicker({
  issueId,
  selected,
  onSelect,
}: {
  issueId: string;
  selected: CloudIssue | null;
  onSelect: (issue: CloudIssue | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<CloudIssue[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void cloudRequest<{ issues: CloudIssue[] }>(
        `issues?query=${encodeURIComponent(query)}&offset=${offset}`,
        { signal: abort.signal },
      )
        .then(({ issues }) => {
          if (abort.signal.aborted) return;
          setChoices((previous) =>
            offset
              ? [
                  ...previous,
                  ...issues.filter(
                    (issue) => !previous.some((entry) => entry.id === issue.id),
                  ),
                ]
              : issues,
          );
          setMore(issues.length === 100);
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setError(reason.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, offset, retry]);
  return (
    <>
      <Input
        aria-label="Find issues"
        placeholder="Find issues…"
        value={query}
        maxLength={200}
        onChange={(event) => {
          setQuery(event.target.value);
          setOffset(0);
          setChoices([]);
          setMore(false);
          onSelect(null);
        }}
      />
      <div
        className="grid max-h-64 gap-2 overflow-auto"
        role="radiogroup"
        aria-label="Issue"
      >
        {choices
          .filter((issue) => issue.id !== issueId)
          .map((issue) => (
            <label
              key={issue.id}
              className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3"
            >
              <input
                type="radio"
                name="related-issue"
                value={issue.id}
                checked={selected?.id === issue.id}
                onChange={() => onSelect(issue)}
                className="mt-1"
              />
              <span className="min-w-0 break-words">
                <span className="text-muted-foreground">
                  {issue.identifier}
                </span>{" "}
                {issue.title}
              </span>
            </label>
          ))}
      </div>
      {loading && <p role="status">Loading issues…</p>}
      {!loading && !error && !choices.some((issue) => issue.id !== issueId) && (
        <p role="status">No issues found.</p>
      )}
      {error && (
        <div>
          <p role="alert" className="cloud-error">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRetry(retry + 1)}
          >
            Retry search
          </Button>
        </div>
      )}
      {more && !error && (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => setOffset(offset + 100)}
        >
          More issues
        </Button>
      )}
    </>
  );
}
