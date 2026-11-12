"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { GitHubPullRequestFile } from "@/lib/cloud-github-contract";
import { cloudRequest } from "./api-client";

const expandedFileLimit = 3;
const statusLetters: Record<string, string> = {
  added: "A",
  removed: "D",
  renamed: "R",
  copied: "C",
};

function lineKind(line: string): "added" | "removed" | "hunk" | undefined {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return undefined;
}

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="cloud-diff-hunk cloud-file-patch">
      {patch.split("\n").map((line, index) => (
        <span key={index} data-kind={lineKind(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function PullRequestFiles({
  pullRequestId,
  url,
}: {
  pullRequestId: string;
  url: string;
}) {
  const [files, setFiles] = useState<GitHubPullRequestFile[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<{ files: GitHubPullRequestFile[] }>(
      `pull-requests/${pullRequestId}/files`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) setFiles(result.files);
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [pullRequestId]);
  if (error)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  if (!files)
    return (
      <p className="cloud-pull-request-loading" aria-busy="true">
        Loading…
      </p>
    );
  if (!files.length)
    return <p className="cloud-pull-request-loading">No changed files.</p>;
  return (
    <ul className="cloud-pull-request-files">
      {files.map((file) => (
        <li key={file.filename}>
          <details open={files.length <= expandedFileLimit}>
            <summary>
              <span className="cloud-file-status" data-status={file.status}>
                {statusLetters[file.status] ?? "M"}
              </span>
              <code title={file.filename}>
                {file.previousFilename
                  ? `${file.previousFilename} → ${file.filename}`
                  : file.filename}
              </code>
              <span className="cloud-diff-added">+{file.additions}</span>
              <span className="cloud-diff-removed">−{file.deletions}</span>
            </summary>
            {file.patch ? (
              <Patch patch={file.patch} />
            ) : (
              <a
                className="cloud-file-external"
                href={`${url}/files`}
                target="_blank"
                rel="noreferrer"
              >
                View on GitHub
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}
