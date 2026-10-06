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

export function RemoteDirectoryPreview({
  folder,
  workspace,
  transport,
  onOpenFile,
  onClose,
}: {
  folder: Extract<ChatSessionContextAttachment, { source: "path" }>;
  workspace: string | undefined;
  transport: FleetOperationTransport;
  onOpenFile: (attachment: ChatSessionContextAttachment) => void;
  onClose: () => void;
}): React.ReactElement {
  const root = workspace ? normalizeLocalPath(workspace).replace(/\/+$/u, "") : undefined;
  const path = normalizeLocalPath(folder.path).replace(/\/+$/u, "");
  const caseInsensitive = root ? /^(?:[A-Za-z]:|\/\/)/u.test(root) : false;
  const comparisonRoot = caseInsensitive ? root?.toLowerCase() : root;
  const comparisonPath = caseInsensitive ? path.toLowerCase() : path;
  const relative =
    comparisonRoot && comparisonPath === comparisonRoot
      ? ""
      : comparisonRoot && comparisonPath.startsWith(comparisonRoot + "/")
        ? path.slice(root!.length + 1)
        : null;
  const [request, setRequest] = useState({
    path: relative,
    offset: 0,
    revision: 0,
  });
  const [directory, setDirectory] = useState<WorkspaceDirectoryPage | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    if (request.path === null || !workspace) {
      setError(
        "This folder is outside the session workspace. Select its workspace to browse it.",
      );
      setLoading(false);
      return;
    }
    void transport
      .invoke<WorkspaceDirectoryPage>("list_workspace_directory", {
        workspaceRoot: workspace,
        relativePath: request.path,
        offset: request.offset,
      })
      .then((result) => {
        if (current)
          setDirectory((previous) =>
            request.offset && previous?.path === result.path
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
  }, [workspace, transport, request]);

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
            disabled={loading || !request.path}
            onClick={() =>
              setRequest({
                path: request.path!.split("/").slice(0, -1).join("/"),
                offset: 0,
                revision: 0,
              })
            }
          >
            Up
          </Button>
          {directory?.entries.map((entry) => (
            <Button
              key={entry.path}
              variant="ghost"
              disabled={loading}
              className="flex w-full justify-start truncate"
              onClick={() => {
                if (entry.kind === "directory")
                  setRequest({ path: entry.path, offset: 0, revision: 0 });
                else {
                  onClose();
                  onOpenFile({
                    id: entry.path,
                    source: "path",
                    name: entry.name,
                    path: `${root}/${entry.path}`,
                    kind: "file",
                  });
                }
              }}
            >
              {entry.name}
              {entry.kind === "directory" ? "/" : ""}
            </Button>
          ))}
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
              {request.path !== null ? (
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
              ) : null}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
