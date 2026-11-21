"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Paperclip, Trash2 } from "lucide-react";
import {
  formatBytes,
  type CloudAttachment,
} from "@/lib/cloud-attachment-contract";
import { ConfirmButton } from "@/components/confirm-button";
import { cloudRequest } from "./api-client";
import { uploadAttachment } from "./attachment-upload";
import { attachmentsChangedEvent } from "./events";
import { useToast } from "./toast";

const refreshMs = 15_000;

function Preview({ attachment }: { attachment: CloudAttachment }) {
  if (attachment.kind === "image")
    return (
      <a href={attachment.url} target="_blank" rel="noopener">
        <img src={attachment.url} alt={attachment.name} loading="lazy" />
      </a>
    );
  if (attachment.kind === "video")
    return <video src={attachment.url} controls preload="metadata" />;
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener"
      className="cloud-attachment-file"
    >
      <FileText size={18} aria-hidden="true" />
    </a>
  );
}

export function IssueAttachments({
  issueId,
  writable,
}: {
  issueId: string;
  writable: boolean;
}) {
  const toast = useToast();
  const [attachments, setAttachments] = useState<CloudAttachment[]>([]);
  const [uploads, setUploads] = useState<
    Record<string, { loaded: number; total: number }>
  >({});
  const pendingUploads = Object.values(uploads);
  const uploading = pendingUploads.length;
  const uploadTotal = pendingUploads.reduce((sum, entry) => sum + entry.total, 0);
  const uploadLoaded = pendingUploads.reduce(
    (sum, entry) => sum + entry.loaded,
    0,
  );
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<{ attachments: CloudAttachment[] }>(
        `issues/${issueId}/attachments`,
        { signal },
      )
        .then((result) => setAttachments(result.attachments))
        .catch((reason: Error) => {
          if (!signal?.aborted) toast(reason.message, "error");
        }),
    [issueId, toast],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    const refresh = () => {
      if (!document.hidden) void load(abort.signal);
    };
    const timer = setInterval(refresh, refreshMs);
    window.addEventListener(attachmentsChangedEvent, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener(attachmentsChangedEvent, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  const upload = (files: File[]) => {
    if (!files.length) return;
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((current) => ({
        ...current,
        [key]: { loaded: 0, total: file.size },
      }));
      void uploadAttachment(file, issueId, (loaded, total) =>
        setUploads((current) =>
          current[key] ? { ...current, [key]: { loaded, total } } : current,
        ),
      )
        .catch((reason: Error) => toast(reason.message, "error"))
        .finally(() =>
          setUploads((current) => {
            const { [key]: _finished, ...rest } = current;
            return rest;
          }),
        );
    }
  };
  const dropHandlers = writable
    ? {
        onDragOver: (event: React.DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragLeave: (event: React.DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          setDragging(false);
          upload([...event.dataTransfer.files]);
        },
      }
    : {};
  const input = (
    <input
      ref={picker}
      type="file"
      multiple
      hidden
      onChange={(event) => {
        upload([...(event.target.files ?? [])]);
        event.target.value = "";
      }}
    />
  );
  if (!attachments.length && !uploading)
    return writable ? (
      <button
        type="button"
        className="cloud-inline-add"
        data-dragging={dragging || undefined}
        onClick={() => picker.current?.click()}
        {...dropHandlers}
      >
        <Paperclip size={13} aria-hidden="true" />
        Attach files
        {input}
      </button>
    ) : null;
  return (
    <section
      className="cloud-issue-attachments"
      aria-label="Attachments"
      data-dragging={dragging || undefined}
      {...dropHandlers}
    >
      <header>
        <h2>Attachments</h2>
        {writable && (
          <button
            type="button"
            className="cloud-icon-button"
            aria-label="Attach files"
            aria-busy={uploading > 0}
            onClick={() => picker.current?.click()}
          >
            <Paperclip size={14} />
          </button>
        )}
        {input}
      </header>
      <ul>
        {attachments.map((attachment) => (
          <li key={attachment.id} data-kind={attachment.kind}>
            <Preview attachment={attachment} />
            <div className="cloud-attachment-meta">
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener"
                title={attachment.name}
              >
                {attachment.name}
              </a>
              <span>{formatBytes(attachment.byteLength)}</span>
            </div>
            {writable && (
              <ConfirmButton
                trigger={
                  <button
                    type="button"
                    className="cloud-icon-button"
                    aria-label={`Delete ${attachment.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                }
                title="Delete attachment"
                description={`${attachment.name} is removed from this issue. Links to it stop working.`}
                actionLabel="Delete"
                onConfirm={async () => {
                  await cloudRequest(`attachments/${attachment.id}`, {
                    method: "DELETE",
                  });
                  setAttachments((current) =>
                    current.filter((entry) => entry.id !== attachment.id),
                  );
                }}
              />
            )}
          </li>
        ))}
        {uploading > 0 && (
          <li className="cloud-attachment-uploading" role="status">
            Uploading {uploading} {uploading === 1 ? "file" : "files"}…
            <progress
              aria-label="Upload progress"
              value={uploadLoaded}
              max={uploadTotal || 1}
            />
          </li>
        )}
      </ul>
    </section>
  );
}
