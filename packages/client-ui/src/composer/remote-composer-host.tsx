import { useEffect, useRef, useState } from "react";
import "./remote-attachments.css";
import type {
  FleetOperationTransport,
  RemoteComposerProps,
} from "@machdoch/product-ui";
import { useRemoteFilePreview } from "../file-preview/use-remote-file-preview";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import type { WorkspaceDirectoryPage } from "@machdoch/fleet-protocol/workspace-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { RemoteComposer } from "./remote-composer";
import { useRemoteComposerHistory } from "./use-remote-composer-history";
import { RemoteContextPackPicker } from "../context-packs/remote-picker";
import type {
  AttachmentSelectionKind,
  ChatSessionContextAttachment,
} from "./model";

interface Selection {
  kind: AttachmentSelectionKind;
  sessionId: string;
  workspace: string | null;
  messageId?: string;
}

export interface RemoteComposerHostProps extends RemoteComposerProps {
  workspaceTransport: FleetOperationTransport;
  ralphTransport: FleetOperationTransport;
  mediaTransport: FleetMediaTransport;
}

export function RemoteComposerHost(
  source: RemoteComposerHostProps,
): React.ReactElement {
  const history = useRemoteComposerHistory(source);
  const props = {
    ...source,
    composer: history.composer,
    onCommand: history.execute,
  };
  const { session, workspaceTransport, mediaTransport, onCommand } = props;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [directory, setDirectory] = useState<WorkspaceDirectoryPage | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filePreview = useRemoteFilePreview({
    sessionId: session.id,
    workspace: session.workspace,
    workspaceTransport,
    mediaTransport,
  });
  const requestVersion = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestVersion.current++;
    setSelection(null);
    setDirectory(null);
    setSelected([]);
    setError(null);
    setBusy(false);
  }, [session.id, session.workspace]);

  const report = (reason: unknown): void =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const attach = async (target: Selection, paths: string[]): Promise<void> => {
    if (!paths.length) return;
    const succeeded = await onCommand({
      kind: "add-context-attachments",
      sessionId: target.sessionId,
      paths,
      ...(target.messageId ? { messageId: target.messageId } : {}),
    });
    if (!succeeded)
      throw new Error("The attachments could not be added. Try again.");
  };
  const upload = async (files: File[], messageId?: string): Promise<void> => {
    if (!files.length) return;
    const version = ++requestVersion.current;
    const target: Selection = {
      sessionId: session.id,
      workspace: session.workspace ?? null,
      kind: "files",
      ...(messageId ? { messageId } : {}),
    };
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        const transferPath = await mediaTransport.upload(file, file.name);
        try {
          const imported = await workspaceTransport.invoke<{ path: string }>(
            "import_context_attachment",
            { path: transferPath, name: file.name },
          );
          await attach(target, [imported.path]);
        } finally {
          await mediaTransport.release(transferPath);
        }
      }
      if (version === requestVersion.current) setSelection(null);
    } catch (reason) {
      if (version === requestVersion.current) report(reason);
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };
  const browse = async (
    target: Selection,
    relativePath = ".",
    offset = 0,
  ): Promise<void> => {
    if (!target.workspace) {
      setError("Choose a workspace before browsing device files.");
      return;
    }
    const version = ++requestVersion.current;
    setBusy(true);
    setError(null);
    try {
      const page = await workspaceTransport.invoke<WorkspaceDirectoryPage>(
        "list_workspace_directory",
        {
          workspaceRoot: target.workspace,
          relativePath: relativePath || ".",
          offset,
        },
      );
      if (version === requestVersion.current)
        setDirectory((current) =>
          offset && current?.path === page.path
            ? { ...page, entries: [...current.entries, ...page.entries] }
            : page,
        );
    } catch (reason) {
      if (version === requestVersion.current) report(reason);
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };
  const select = async (
    kind: AttachmentSelectionKind,
    messageId?: string,
  ): Promise<void> => {
    const target: Selection = {
      kind,
      sessionId: session.id,
      workspace: session.workspace ?? null,
      ...(messageId ? { messageId } : {}),
    };
    setSelection(target);
    setDirectory(null);
    setSelected([]);
    setError(null);
    if (kind === "folders") await browse(target);
  };
  const open = (attachment: ChatSessionContextAttachment): void => {
    if (
      attachment.source === "path" &&
      /^(?:https?:|mailto:|ftp:)/iu.test(attachment.path)
    ) {
      window.open(attachment.path, "_blank", "noopener,noreferrer");
      return;
    }
    if (attachment.source === "path" && attachment.kind === "directory") {
      const target: Selection = {
        kind: "folders",
        sessionId: session.id,
        workspace: session.workspace ?? null,
      };
      setSelection(target);
      const workspace = target.workspace?.replace(/[\\/]+$/u, "");
      const relative =
        workspace &&
        attachment.path
          .replaceAll("\\", "/")
          .toLowerCase()
          .startsWith(`${workspace.replaceAll("\\", "/").toLowerCase()}/`)
          ? attachment.path.slice(workspace.length + 1).replaceAll("\\", "/")
          : ".";
      void browse(target, relative);
      return;
    }
    filePreview.open(attachment);
  };
  const selectedPaths = selected.map(
    (relative) => `${selection?.workspace?.replace(/[\\/]$/u, "")}/${relative}`,
  );

  return (
    <>
      <RemoteComposer
        {...props}
        onHistoryKeyDown={history.handleKeyDown}
        pending={props.pending || busy}
        attachments={{ select, upload, open }}
        renderContextPackPicker={(activeDraft) => (
          <RemoteContextPackPicker
            key={session.id}
            {...props}
            activeDraft={activeDraft}
            pending={props.pending || busy}
          />
        )}
      />
      {error && !selection ? (
        <p role="alert" className="m-product-inline-error">
          {error}
        </p>
      ) : null}
      <Dialog
        open={selection !== null}
        onOpenChange={(opened) => {
          if (!opened && !busy) {
            requestVersion.current++;
            setSelection(null);
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="m-attachment-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {selection?.kind === "folders"
                ? "Attach folders"
                : selection?.kind === "images"
                  ? "Attach images"
                  : "Attach files"}
            </DialogTitle>
          </DialogHeader>
          {selection?.kind !== "folders" ? (
            <div className="flex flex-wrap gap-2">
              <input
                ref={uploadInput}
                type="file"
                multiple
                accept={selection?.kind === "images" ? "image/*" : undefined}
                aria-label="Upload attachments"
                className="hidden"
                disabled={busy}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void upload(files, selection?.messageId);
                }}
              />
              <Button
                disabled={busy}
                onClick={() => uploadInput.current?.click()}
              >
                Upload files
              </Button>
              <Button
                variant="outline"
                disabled={busy || !selection?.workspace}
                onClick={() => {
                  if (selection) void browse(selection);
                }}
              >
                Browse device
              </Button>
            </div>
          ) : null}
          {directory && selection ? (
            <div className="m-attachment-directory min-h-0 overflow-auto space-y-1">
              <div className="flex gap-2 items-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !directory.path || directory.path === "."}
                  onClick={() =>
                    void browse(
                      selection,
                      directory.path.split(/[\\/]/u).slice(0, -1).join("/"),
                    )
                  }
                >
                  Up
                </Button>
                <span className="truncate text-sm">
                  {directory.path && directory.path !== "."
                    ? directory.path
                    : selection.workspace}
                </span>
              </div>
              {selection.kind === "folders" &&
              (!directory.path || directory.path === ".") ? (
                <label className="m-attachment-file">
                  <input
                    type="checkbox"
                    checked={selected.includes("")}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, ""]
                          : current.filter((path) => path !== ""),
                      )
                    }
                  />
                  <span>{selection.workspace}</span>
                </label>
              ) : null}
              {directory.entries.map((entry) => {
                const selectable =
                  selection.kind === "folders"
                    ? entry.kind === "directory"
                    : entry.kind === "file" &&
                      (selection.kind !== "images" ||
                        /\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|avif)$/iu.test(
                          entry.name,
                        ));
                const checkbox = selectable ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.name}`}
                    checked={selected.includes(entry.path)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, entry.path]
                          : current.filter((path) => path !== entry.path),
                      )
                    }
                  />
                ) : null;
                const FileRow = selectable ? "label" : "div";
                return (
                  <div key={entry.path} className="m-attachment-entry">
                    {entry.kind === "directory" ? (
                      <>
                        {checkbox ? (
                          <label className="m-attachment-directory-select">
                            {checkbox}
                          </label>
                        ) : null}
                        <Button
                          variant="ghost"
                          className="m-attachment-folder justify-start min-w-0"
                          disabled={busy}
                          onClick={() => void browse(selection, entry.path)}
                        >
                          <span>{entry.name}/</span>
                        </Button>
                      </>
                    ) : (
                      <FileRow className="m-attachment-file">
                        {checkbox}
                        <span>{entry.name}</span>
                      </FileRow>
                    )}
                  </div>
                );
              })}
              {directory.nextOffset !== null ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void browse(
                      selection,
                      directory.path,
                      directory.nextOffset ?? 0,
                    )
                  }
                >
                  More files
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="m-product-inline-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="m-attachment-dialog-footer">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !selected.length}
              onClick={() => {
                if (!selection) return;
                const version = ++requestVersion.current;
                setBusy(true);
                setError(null);
                void attach(selection, selectedPaths)
                  .then(() => {
                    if (version === requestVersion.current) setSelection(null);
                  })
                  .catch((reason: unknown) => {
                    if (version === requestVersion.current) report(reason);
                  })
                  .finally(() => {
                    if (version === requestVersion.current) setBusy(false);
                  });
              }}
            >
              {busy ? "Attaching…" : "Attach"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {filePreview.error ? (
        <p role="alert" className="m-product-inline-error">
          {filePreview.error}
        </p>
      ) : null}
      {filePreview.dialog}
    </>
  );
}
