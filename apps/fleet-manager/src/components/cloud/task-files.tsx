"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ArtifactPreview,
  TaskArtifact,
} from "@machdoch/fleet-protocol/cloud-artifacts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cloudRequest } from "./api-client";

export function TaskFiles({
  runId,
  files,
  candidateCommit,
}: {
  runId: string;
  files: TaskArtifact[];
  candidateCommit: string | null;
}) {
  const [selected, setSelected] = useState<TaskArtifact | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    setPreview(null);
    setError("");
    if (!selected) return;
    const controller = new AbortController();
    void cloudRequest<ArtifactPreview>(
      `runs/${runId}/artifacts/${selected.id}/preview`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "The file could not be loaded. Close the preview and try again.",
          );
      });
    return () => controller.abort();
  }, [runId, selected]);
  if (!files.length) return null;
  const download = (file: TaskArtifact) =>
    `/api/v1/runs/${runId}/artifacts/${file.id}`;
  const selectedCommit =
    candidateCommit ??
    files.findLast((file) => file.candidateCommit !== null)?.candidateCommit ??
    null;
  const currentFiles = files.filter(
    (file) =>
      file.candidateCommit === null || file.candidateCommit === selectedCommit,
  );
  const previousCommits = [
    ...new Set(
      files.flatMap((file) =>
        file.candidateCommit && file.candidateCommit !== selectedCommit
          ? [file.candidateCommit]
          : [],
      ),
    ),
  ];
  const rows = (items: TaskArtifact[]) => (
    <ul className="grid gap-3">
      {items.map((file) => (
        <li
          key={file.id}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border pb-3 last:border-0 last:pb-0"
        >
          <div className="min-w-0 flex-1">
            <span className="break-words">{file.name}</span>
            <span className="ml-3 text-sm text-muted-foreground">
              {Math.ceil(file.byteLength / 1024).toLocaleString()} KiB
            </span>
          </div>
          <div className="flex gap-2">
            {file.kind !== "candidate" && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Preview ${file.name}`}
                onClick={(event) => {
                  returnFocus.current = event.currentTarget;
                  setSelected(file);
                }}
              >
                Preview
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <a
                href={download(file)}
                download
                aria-label={`Download ${file.name}`}
              >
                Download
              </a>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="cloud-card">
      <h2 ref={heading} tabIndex={-1}>
        Files
      </h2>
      {rows(currentFiles)}
      {previousCommits.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Earlier candidates
          </summary>
          <div className="mt-4 grid gap-4">
            {previousCommits.map((commit) => (
              <div key={commit}>
                <h3 className="mb-3 font-mono text-xs">
                  Commit {commit.slice(0, 12)}
                </h3>
                {rows(files.filter((file) => file.candidateCommit === commit))}
              </div>
            ))}
          </div>
        </details>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="max-w-4xl"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            } else if (heading.current) {
              event.preventDefault();
              heading.current.focus();
            }
          }}
        >
          <DialogTitle>{selected?.name}</DialogTitle>
          {error ? (
            <p role="alert" className="cloud-error">
              {error}
            </p>
          ) : preview ? (
            <>
              <pre
                className="max-h-[60dvh] min-w-0 overflow-auto rounded border border-border p-3 text-xs"
                tabIndex={0}
              >
                {preview.text}
              </pre>
              {preview.truncated && (
                <p className="text-sm text-muted-foreground">
                  Preview shortened. Download the full file.
                </p>
              )}
              {selected && (
                <Button variant="outline" asChild>
                  <a href={download(selected)} download>
                    Download file
                  </a>
                </Button>
              )}
            </>
          ) : (
            <p role="status">Loading file…</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
