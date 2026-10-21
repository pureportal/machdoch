import { useRef } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  File,
  Folder,
  Upload,
} from "lucide-react";
import type { WorkspaceDirectoryPage } from "@machdoch/fleet-protocol/workspace-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import type { AttachmentSelectionKind } from "./model";
import "./remote-attachments.css";

export type AttachmentActivity = "upload" | "browse" | "attach" | null;

interface RemoteAttachmentDialogProps {
  kind: AttachmentSelectionKind;
  workspace: string | null;
  browsing: boolean;
  directory: WorkspaceDirectoryPage | null;
  selected: string[];
  activity: AttachmentActivity;
  error: string | null;
  onClose: () => void;
  onBack: () => void;
  onBrowse: (path?: string, offset?: number) => void;
  onUpload: (files: File[]) => void;
  onSelect: (path: string, checked: boolean) => void;
  onAttach: () => void;
}

export function RemoteAttachmentDialog({
  kind,
  workspace,
  browsing,
  directory,
  selected,
  activity,
  error,
  onClose,
  onBack,
  onBrowse,
  onUpload,
  onSelect,
  onAttach,
}: RemoteAttachmentDialogProps): React.ReactElement {
  const uploadInput = useRef<HTMLInputElement>(null);
  const busy = activity !== null;
  const entries = directory?.entries.filter(
    (entry) =>
      entry.kind === "directory" ||
      (kind !== "folders" &&
        (kind !== "images" ||
          /\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|avif)$/iu.test(entry.name))),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="m-attachment-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader className="m-attachment-header">
          {browsing && kind !== "folders" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to attachment sources"
              tooltip={null}
              disabled={busy}
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <DialogTitle>Attach {kind}</DialogTitle>
        </DialogHeader>
        {kind !== "folders" ? (
          <input
            ref={uploadInput}
            type="file"
            multiple
            accept={kind === "images" ? "image/*" : undefined}
            aria-label="Upload attachments"
            hidden
            disabled={busy}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              onUpload(files);
            }}
          />
        ) : null}
        {!browsing ? (
          <div className="m-attachment-sources">
            <Button
              variant="outline"
              className="m-attachment-source"
              disabled={busy}
              onClick={() => uploadInput.current?.click()}
            >
              <Upload aria-hidden="true" />
              <span>Upload from this device</span>
              <ChevronRight aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              className="m-attachment-source"
              disabled={busy || !workspace}
              onClick={() => onBrowse()}
            >
              <Folder aria-hidden="true" />
              <span>Browse workspace</span>
              <ChevronRight aria-hidden="true" />
            </Button>
            {!workspace ? (
              <p className="m-attachment-status">
                Choose a workspace to browse files.
              </p>
            ) : null}
          </div>
        ) : null}
        {browsing && directory ? (
          <>
            <div className="m-attachment-path">
              <Button
                variant="outline"
                size="icon"
                aria-label="Up"
                tooltip={null}
                disabled={busy || !directory.path || directory.path === "."}
                onClick={() =>
                  onBrowse(
                    directory.path.split(/[\\/]/u).slice(0, -1).join("/"),
                  )
                }
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <span>
                {directory.path && directory.path !== "."
                  ? directory.path
                  : workspace}
              </span>
            </div>
            <div
              className="m-attachment-directory"
              aria-busy={activity === "browse"}
            >
              {kind === "folders" &&
              (!directory.path || directory.path === ".") ? (
                <label className="m-attachment-file">
                  <input
                    type="checkbox"
                    checked={selected.includes("")}
                    disabled={busy}
                    onChange={(event) => onSelect("", event.target.checked)}
                  />
                  <Folder aria-hidden="true" />
                  <span>{workspace}</span>
                </label>
              ) : null}
              {entries?.map((entry) => (
                <div key={entry.path} className="m-attachment-entry">
                  {entry.kind === "directory" ? (
                    <>
                      {kind === "folders" ? (
                        <label className="m-attachment-directory-select">
                          <input
                            type="checkbox"
                            aria-label={`Select ${entry.name}`}
                            checked={selected.includes(entry.path)}
                            disabled={busy}
                            onChange={(event) =>
                              onSelect(entry.path, event.target.checked)
                            }
                          />
                        </label>
                      ) : null}
                      <Button
                        variant="ghost"
                        className="m-attachment-folder"
                        disabled={busy}
                        onClick={() => onBrowse(entry.path)}
                      >
                        <Folder aria-hidden="true" />
                        <span>{entry.name}/</span>
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </>
                  ) : (
                    <label className="m-attachment-file">
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.name}`}
                        checked={selected.includes(entry.path)}
                        disabled={busy}
                        onChange={(event) =>
                          onSelect(entry.path, event.target.checked)
                        }
                      />
                      <File aria-hidden="true" />
                      <span>{entry.name}</span>
                    </label>
                  )}
                </div>
              ))}
              {!entries?.length && directory.nextOffset === null && !busy ? (
                <p className="m-attachment-empty">No {kind} in this folder.</p>
              ) : null}
              {directory.nextOffset !== null ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    onBrowse(directory.path, directory.nextOffset ?? 0)
                  }
                >
                  More files
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {activity ? (
          <p role="status" className="m-attachment-status">
            {activity === "upload"
              ? "Uploading…"
              : activity === "browse"
                ? "Loading files…"
                : "Attaching…"}
          </p>
        ) : null}
        {error ? (
          <div className="m-attachment-error">
            <p role="alert" className="m-product-inline-error">
              {error}
            </p>
            {browsing && !directory && workspace ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onBrowse()}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
        {browsing && directory ? (
          <DialogFooter className="m-attachment-dialog-footer">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="m-attachment-confirm"
              disabled={busy || !selected.length}
              onClick={onAttach}
            >
              {selected.length ? `Attach (${selected.length})` : "Attach"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
