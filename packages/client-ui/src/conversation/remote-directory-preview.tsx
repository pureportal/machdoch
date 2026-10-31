import { useEffect, useState } from "react";
import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { WorkspaceDirectoryPage } from "@machdoch/fleet-protocol/workspace-contract";
import type { ChatSessionContextAttachment } from "../composer/model";
import { normalizeLocalPath } from "./workspace-markdown-links";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";

const parentFolder = (path: string): string | null => {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return null;
  const parent = path.slice(0, separator);
  return !parent || /^[A-Za-z]:$/u.test(parent) ? `${parent}/` : parent;
};

export function RemoteDirectoryPreview({
  folder,
  transport,
  onOpenFile,
  onClose,
}: {
  folder: Extract<ChatSessionContextAttachment, { source: "path" }>;
  transport: FleetOperationTransport;
  onOpenFile: (attachment: ChatSessionContextAttachment) => void;
  onClose: () => void;
}): React.ReactElement {
  const [request, setRequest] = useState({
    path: normalizeLocalPath(folder.path),
    offset: 0,
    revision: 0,
  });
  const [directory, setDirectory] = useState<WorkspaceDirectoryPage | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const parent = parentFolder(request.path.replace(/\/+$/u, ""));

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void transport
      .invoke<WorkspaceDirectoryPage>("list_context_attachment_directory", {
        path: request.path,
        offset: request.offset,
      })
      .then((result) => {
        if (current)
          setDirectory((previous) =>
            request.offset && previous
              ? { ...result, entries: [...previous.entries, ...result.entries] }
              : result,
          );
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [transport, request]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{folder.name}</DialogTitle>
        </DialogHeader>
        <div
          aria-busy={loading}
          className="max-h-[60dvh] overflow-auto space-y-1"
        >
          <Button
            variant="outline"
            disabled={loading || parent === null}
            onClick={() =>
              setRequest({ path: parent!, offset: 0, revision: 0 })
            }
          >
            Up
          </Button>
          {directory?.entries.map((entry) => {
            const isFolder =
              entry.kind === "directory" ||
              (entry.kind === "symlink" && entry.targetKind === "directory");
            const path = `${request.path.replace(/\/+$/u, "")}/${entry.path}`;
            return (
              <Button
                key={entry.path}
                variant="ghost"
                disabled={loading}
                className="flex w-full justify-start truncate"
                onClick={() => {
                  if (isFolder) setRequest({ path, offset: 0, revision: 0 });
                  else {
                    onClose();
                    onOpenFile({
                      id: path,
                      source: "path",
                      name: entry.name,
                      path,
                      kind: "file",
                    });
                  }
                }}
              >
                {entry.name}
                {isFolder ? "/" : ""}
              </Button>
            );
          })}
          {directory?.nextOffset !== null &&
          directory?.nextOffset !== undefined ? (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() =>
                setRequest((current) => ({
                  ...current,
                  offset: directory.nextOffset!,
                }))
              }
            >
              More files
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="m-product-inline-error">
              {error}
              <Button
                variant="outline"
                onClick={() =>
                  setRequest((current) => ({
                    ...current,
                    revision: current.revision + 1,
                  }))
                }
              >
                Retry
              </Button>
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
