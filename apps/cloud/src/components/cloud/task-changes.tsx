"use client";

import { Fragment, useEffect, useState } from "react";
import { FileDiff } from "lucide-react";
import { LoadingState } from "@machdoch/product-ui";
import type { ReviewFinding } from "@machdoch/fleet-protocol/cloud-delivery";
import type { DiffFile } from "@/lib/unified-diff";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { ReviewFindingItem } from "./task-review";

const visibleLines = 400;
const statusLabels: Record<DiffFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

function DiffFileView({
  file,
  findings,
  open,
}: {
  file: DiffFile;
  findings: ReviewFinding[];
  open: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let shown = 0;
  const anchored = (line: number | null) =>
    findings.filter((finding) => line !== null && finding.line === line);
  const general = findings.filter(
    (finding) =>
      finding.line === null ||
      !file.hunks.some((hunk) =>
        hunk.lines.some((line) => line.newLine === finding.line),
      ),
  );
  return (
    <details className="cloud-diff-file" open={open}>
      <summary>
        <span className="cloud-diff-status" data-status={file.status}>
          {statusLabels[file.status]}
        </span>
        <code className="cloud-diff-path">
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </code>
        {findings.length > 0 && (
          <span className="cloud-diff-flag">
            {findings.length} {findings.length === 1 ? "note" : "notes"}
          </span>
        )}
        <span className="cloud-diff-counts">
          <span data-kind="addition">+{file.additions}</span>
          <span data-kind="deletion">−{file.deletions}</span>
        </span>
      </summary>
      {general.length > 0 && (
        <ul className="cloud-review-findings cloud-diff-notes">
          {general.map((finding, index) => (
            <ReviewFindingItem key={index} finding={finding} />
          ))}
        </ul>
      )}
      {file.binary ? (
        <p className="cloud-diff-binary">Binary file</p>
      ) : (
        <div className="cloud-diff-body" tabIndex={0}>
          <table>
            <tbody>
              {file.hunks.map((hunk, hunkIndex) => {
                if (!expanded && shown >= visibleLines) return null;
                return (
                  <Fragment key={hunkIndex}>
                    <tr className="cloud-diff-hunk">
                      <td colSpan={3}>@@ {hunk.header}</td>
                    </tr>
                    {hunk.lines.map((line, lineIndex) => {
                      if (!expanded && shown++ >= visibleLines) return null;
                      const notes = anchored(line.newLine);
                      return (
                        <Fragment key={lineIndex}>
                          <tr data-kind={line.kind}>
                            <td className="cloud-diff-number">
                              {line.oldLine ?? ""}
                            </td>
                            <td className="cloud-diff-number">
                              {line.newLine ?? ""}
                            </td>
                            <td className="cloud-diff-code">
                              <span aria-hidden="true">
                                {line.kind === "addition"
                                  ? "+"
                                  : line.kind === "deletion"
                                    ? "−"
                                    : " "}
                              </span>
                              {line.text}
                            </td>
                          </tr>
                          {notes.length > 0 && (
                            <tr className="cloud-diff-note">
                              <td colSpan={3}>
                                <ul className="cloud-review-findings">
                                  {notes.map((finding, index) => (
                                    <ReviewFindingItem
                                      key={index}
                                      finding={finding}
                                    />
                                  ))}
                                </ul>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!expanded && total > visibleLines && (
            <Button
              variant="ghost"
              size="sm"
              className="m-2"
              onClick={() => setExpanded(true)}
            >
              Show all {total.toLocaleString()} lines
            </Button>
          )}
        </div>
      )}
    </details>
  );
}

export function TaskChanges({
  runId,
  candidateCommit,
  findings,
}: {
  runId: string;
  candidateCommit: string | null;
  findings: ReviewFinding[];
}) {
  const [diff, setDiff] = useState<{
    files: DiffFile[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!candidateCommit) return;
    const controller = new AbortController();
    setDiff(null);
    setError("");
    void cloudRequest<{ files: DiffFile[]; truncated: boolean }>(
      `runs/${runId}/changes`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setDiff(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [runId, candidateCommit]);
  if (!candidateCommit)
    return (
      <div className="cloud-empty">
        <FileDiff aria-hidden="true" />
        <p>Changes appear here once the AI has a candidate.</p>
      </div>
    );
  if (error)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  if (!diff) return <LoadingState label="Loading changes…" />;
  const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="cloud-diff">
      <p className="cloud-diff-summary">
        {diff.files.length} {diff.files.length === 1 ? "file" : "files"} changed
        <span data-kind="addition">+{additions.toLocaleString()}</span>
        <span data-kind="deletion">−{deletions.toLocaleString()}</span>
        <code>{candidateCommit.slice(0, 7)}</code>
      </p>
      {diff.truncated && (
        <p className="cloud-task-notice">
          This change is too large to show completely. Download the patch from
          Files.
        </p>
      )}
      {diff.files.map((file) => (
        <DiffFileView
          key={`${file.previousPath ?? ""}${file.path}`}
          file={file}
          open={diff.files.length <= 12}
          findings={findings.filter((finding) => finding.file === file.path)}
        />
      ))}
    </div>
  );
}
