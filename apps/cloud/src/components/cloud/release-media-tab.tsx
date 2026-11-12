"use client";

import {
  Camera,
  Clapperboard,
  Download,
  Palette,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import type {
  ReleaseMedia,
  VideoInput,
  VisualInput,
} from "@/lib/cloud-release-media-contract";
import { cloudRequest, cloudUpload } from "./api-client";
import { ReleaseCaptureDialog } from "./release-capture-dialog";
import { mediaUrl } from "./release-display";
import type { StudioContext } from "./release-studio";
import { ReleaseVideoDialog } from "./release-video-dialog";
import { ReleaseVisualDialog } from "./release-visual-dialog";
import { useToast } from "./toast";

const roleLabels: Record<ReleaseMedia["role"], string> = {
  screenshot: "Screenshot",
  recording: "Recording",
  reference: "Reference",
  visual: "Visual",
  video: "Video",
  logo: "Logo",
};

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaThumbnail({ media }: { media: ReleaseMedia }) {
  return media.kind === "image" ? (
    <img
      src={mediaUrl(media.id)}
      alt={media.altText || media.caption || media.name}
      loading="lazy"
    />
  ) : (
    <video src={`${mediaUrl(media.id)}#t=1`} controls preload="metadata" />
  );
}

export function ReleaseMediaTab({ context }: { context: StudioContext }) {
  const { release, media, canWrite, capabilities } = context;
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dialog, setDialog] = useState<
    | { kind: "visual"; recipe?: VisualInput }
    | { kind: "video"; recipe?: VideoInput }
    | { kind: "capture" }
    | null
  >(null);
  const [dragging, setDragging] = useState(false);
  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setUploading(list.length);
    try {
      for (const file of list) {
        const query = new URLSearchParams({
          productId: release.productId,
          releaseId: release.id,
          name: file.name.slice(0, 200),
          role: file.type.startsWith("video/") ? "recording" : "screenshot",
        });
        await cloudUpload(`release-media?${query}`, file);
        setUploading((count) => count - 1);
      }
      toast(
        list.length === 1 ? "File uploaded" : `${list.length} files uploaded`,
      );
    } catch (reason) {
      toast(
        reason instanceof Error ? reason.message : "The upload failed.",
        "error",
      );
    } finally {
      setUploading(0);
      await context.refresh();
    }
  }
  async function update(entry: ReleaseMedia, caption: string) {
    if (caption === entry.caption) return;
    try {
      await cloudRequest(`release-media/${entry.id}`, {
        method: "PATCH",
        body: { caption, altText: entry.altText },
      });
      await context.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    }
  }
  return (
    <div
      className="cloud-release-media"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (canWrite) void upload(event.dataTransfer.files);
      }}
    >
      {canWrite && (
        <div className="cloud-release-toolbar">
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            disabled={uploading > 0}
            onClick={() => input.current?.click()}
          >
            <Upload />
            {uploading ? `Uploading ${uploading}…` : "Upload"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setDialog({ kind: "visual" })}
          >
            <Palette />
            Create visual
          </Button>
          <Button
            variant="outline"
            disabled={!capabilities.video || !media.length}
            title={
              !capabilities.video
                ? "Video needs ffmpeg on the Cloud server."
                : !media.length
                  ? "Add screenshots or recordings first."
                  : undefined
            }
            onClick={() => setDialog({ kind: "video" })}
          >
            <Clapperboard />
            Compose video
          </Button>
          <Button
            variant="outline"
            onClick={() => setDialog({ kind: "capture" })}
          >
            <Camera />
            Capture in sandbox
          </Button>
        </div>
      )}
      {!media.length ? (
        <div className="cloud-release-dropzone">
          <Upload aria-hidden="true" />
          <p>
            {canWrite
              ? "Drop screenshots or recordings here."
              : "No media yet."}
          </p>
        </div>
      ) : (
        <ul className="cloud-release-gallery" aria-label="Media">
          {media.map((entry) => (
            <li key={entry.id}>
              <div className="cloud-release-thumbnail" data-kind={entry.kind}>
                <MediaThumbnail media={entry} />
                <span className="cloud-release-role">
                  {roleLabels[entry.role]}
                </span>
              </div>
              <input
                className="cloud-release-caption"
                aria-label={`Caption for ${entry.name}`}
                defaultValue={entry.caption}
                placeholder="Add a caption"
                maxLength={300}
                disabled={!canWrite}
                onBlur={(event) =>
                  void update(entry, event.target.value.trim())
                }
              />
              <div className="cloud-release-media-meta">
                <span>
                  {entry.width && entry.height
                    ? `${entry.width}×${entry.height} · `
                    : ""}
                  {entry.durationMs
                    ? `${Math.round(entry.durationMs / 1000)} s · `
                    : ""}
                  {bytes(entry.byteLength)}
                </span>
                <span className="cloud-automation-spacer" />
                {canWrite && entry.recipe && (
                  <button
                    type="button"
                    aria-label={`Edit ${entry.name}`}
                    onClick={() =>
                      setDialog(
                        "template" in entry.recipe!
                          ? { kind: "visual", recipe: entry.recipe }
                          : { kind: "video", recipe: entry.recipe! },
                      )
                    }
                  >
                    <Pencil size={14} />
                  </button>
                )}
                <a
                  href={mediaUrl(entry.id)}
                  download={entry.name}
                  aria-label={`Download ${entry.name}`}
                >
                  <Download size={14} />
                </a>
                {canWrite && (
                  <ConfirmButton
                    trigger={
                      <button type="button" aria-label={`Delete ${entry.name}`}>
                        <Trash2 size={14} />
                      </button>
                    }
                    title="Delete file?"
                    description="It is removed from every draft post."
                    actionLabel="Delete"
                    onConfirm={async () => {
                      await cloudRequest(`release-media/${entry.id}`, {
                        method: "DELETE",
                      });
                      await context.refresh();
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === "visual" && (
        <ReleaseVisualDialog
          context={context}
          recipe={dialog.recipe}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "video" && (
        <ReleaseVideoDialog
          context={context}
          recipe={dialog.recipe}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "capture" && (
        <ReleaseCaptureDialog
          context={context}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
