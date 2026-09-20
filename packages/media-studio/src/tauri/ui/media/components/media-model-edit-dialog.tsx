import {
  SubmitShortcut,
  SUBMIT_SHORTCUT_ACTION_PROPS,
} from "../../components/ui/submit-shortcut";
import { useId, useRef, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import {
  createEmptyMediaGenerationAssetMetadata,
  normalizeMediaAssetTags,
  normalizeMediaExternalLink,
  normalizeMediaTriggerWords,
  parseMediaTriggerWords,
} from "../../../../core/media/asset-metadata.js";
import { MEDIA_MODEL_ARCHITECTURES } from "../../../../core/media/model-architectures.js";
import type {
  MediaAssetCategory,
  MediaAssetImportResult,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
  UpdateMediaModelResourceRequest,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { MediaCategoryPicker } from "./media-category-picker";
import { MediaSampleImagesInput } from "./media-sample-images-input";
import { MediaResourcePreview } from "./media-visual-preview";

interface MediaModelEditDialogProps {
  resource: MediaModelDescriptor | MediaModelAddonDescriptor;
  metadata: MediaGenerationAssetMetadata;
  categories: readonly MediaAssetCategory[];
  assets: readonly MediaAssetRecord[];
  onSave: (
    request: UpdateMediaModelResourceRequest | null,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<void>;
  onImportMedia: (
    path: string,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<MediaAssetImportResult | null>;
  onImportSampleUrl: (url: string) => Promise<MediaAssetImportResult | null>;
  onManageCategories: () => void;
  onClose: () => void;
}

const inputClass =
  "h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-60 read-only:text-slate-400";
const labelClass = "grid gap-1.5 text-xs text-slate-400";

export const MediaModelEditDialog = ({
  resource,
  metadata,
  categories,
  assets,
  onSave,
  onImportMedia,
  onImportSampleUrl,
  onManageCategories,
  onClose,
}: MediaModelEditDialogProps): JSX.Element => {
  const addon = "kind" in resource ? resource : null;
  const editable =
    addon !== null || ("userImported" in resource && resource.userImported);
  const embedding = addon?.kind === "textual-inversion";
  const [name, setName] = useState(resource.displayName);
  const [architecture, setArchitecture] = useState(resource.architecture ?? "");
  const [license, setLicense] = useState(resource.license.name);
  const [commercialUse, setCommercialUse] = useState(
    resource.license.commercialUse,
  );
  const [draft, setDraft] = useState(metadata);
  const [tags, setTags] = useState(metadata.tags.join(", "));
  const [sourceUrl, setSourceUrl] = useState(metadata.sourceUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<
    "name" | "source" | "token" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [samplePending, setSamplePending] = useState(false);
  const pending = useRef(false);
  const errorId = useId();
  const busy = saving || samplePending;
  const dirty =
    name !== resource.displayName ||
    architecture !== (resource.architecture ?? "") ||
    license !== resource.license.name ||
    commercialUse !== resource.license.commercialUse ||
    tags !== metadata.tags.join(", ") ||
    sourceUrl !== (metadata.sourceUrl ?? "") ||
    JSON.stringify(draft) !== JSON.stringify(metadata);
  const architectures = MEDIA_MODEL_ARCHITECTURES.filter(
    (item) =>
      addon ||
      !["ltx-video", "framepack-i2v", "hunyuan-video-1.5-i2v"].includes(
        item.value,
      ),
  );

  const save = async (): Promise<void> => {
    if (pending.current || samplePending) return;
    setError(null);
    setFieldError(null);
    const normalizedUrl = sourceUrl.trim()
      ? normalizeMediaExternalLink(sourceUrl)
      : null;
    if (!name.trim()) {
      setFieldError("name");
      setError("Enter a model name.");
      return;
    }
    if (sourceUrl.trim() && !normalizedUrl) {
      setFieldError("source");
      setError("Enter an HTTPS URL.");
      return;
    }
    const triggers = parseMediaTriggerWords(draft.triggerWords);
    if (embedding && (triggers.length !== 1 || /\s/u.test(triggers[0] ?? ""))) {
      setFieldError("token");
      setError("Enter one token without spaces.");
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      await onSave(
        editable
          ? {
              resourceId: resource.id,
              displayName: name.trim(),
              architecture,
              sourceUrl: normalizedUrl,
              licenseName: license.trim() || null,
              commercialUse:
                commercialUse === "allowed" ||
                commercialUse === "review-required"
                  ? commercialUse
                  : null,
              triggerWords: triggers,
            }
          : null,
        {
          ...draft,
          categoryIds: draft.categoryIds.filter((id) =>
            categories.some((category) => category.id === id),
          ),
          tags: normalizeMediaAssetTags(tags),
          sourceUrl: normalizedUrl,
          triggerWords: normalizeMediaTriggerWords(draft.triggerWords),
        },
      );
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The model could not be saved. Try again.",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={!busy}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        confirmOnInteractOutside={
          dirty
            ? {
                title: "Discard changes?",
                description: "Your edits will not be saved.",
                cancelLabel: "Keep editing",
                confirmLabel: "Discard",
              }
            : false
        }
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-3xl"
      >
        <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12">
          <DialogTitle>
            {addon
              ? embedding
                ? "Edit embedding"
                : "Edit LoRA"
              : "Edit model"}
          </DialogTitle>
        </DialogHeader>
        <SubmitShortcut asChild>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset
              disabled={busy}
              className="min-h-0 space-y-5 overflow-y-auto p-6"
            >
              <div className="grid gap-5 sm:grid-cols-[160px_minmax(0,1fr)]">
                <MediaResourcePreview
                  resourceId={resource.id}
                  metadata={{ [resource.id]: draft }}
                  assets={assets}
                  className="aspect-square w-full max-w-40 rounded-xl"
                />
                <div className="grid content-start gap-4">
                  <label className={labelClass}>
                    <span>Name</span>
                    <input
                      autoFocus
                      value={name}
                      readOnly={!editable}
                      maxLength={120}
                      aria-invalid={fieldError === "name"}
                      aria-describedby={
                        fieldError === "name" ? errorId : undefined
                      }
                      onChange={(event) => setName(event.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    <span>Model type</span>
                    <select
                      value={architecture}
                      disabled={!editable}
                      onChange={(event) => setArchitecture(event.target.value)}
                      className={inputClass}
                    >
                      {!architectures.some(
                        (item) => item.value === architecture,
                      ) ? (
                        <option value={architecture}>
                          {architecture ||
                            ("family" in resource
                              ? resource.family
                              : "Unknown")}
                        </option>
                      ) : null}
                      {architectures.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!editable ? (
                    <p className="text-xs text-slate-400">
                      Name, type, and license are managed by the model provider.
                    </p>
                  ) : null}
                </div>
              </div>
              <label className={labelClass}>
                <span>Source URL</span>
                <input
                  value={sourceUrl}
                  aria-invalid={fieldError === "source"}
                  aria-describedby={
                    fieldError === "source" ? errorId : undefined
                  }
                  onChange={(event) => setSourceUrl(event.target.value)}
                  className={inputClass}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>
                  <span>License</span>
                  <input
                    value={license}
                    maxLength={256}
                    readOnly={!editable}
                    onChange={(event) => setLicense(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  <span>Commercial use</span>
                  <select
                    value={commercialUse}
                    disabled={!editable}
                    onChange={(event) =>
                      setCommercialUse(
                        event.target.value as typeof commercialUse,
                      )
                    }
                    className={inputClass}
                  >
                    <option value="unknown">Not set</option>
                    <option value="allowed">Allowed</option>
                    <option value="review-required">Review required</option>
                    {commercialUse === "provider-terms" ? (
                      <option value="provider-terms">Provider terms</option>
                    ) : null}
                  </select>
                </label>
                <div className={labelClass}>
                  <span>Categories</span>
                  <MediaCategoryPicker
                    categories={categories}
                    selectedIds={draft.categoryIds}
                    onChange={(categoryIds) =>
                      setDraft((current) => ({ ...current, categoryIds }))
                    }
                    onManage={onManageCategories}
                  />
                </div>
                <label className={labelClass}>
                  <span>Tags</span>
                  <input
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>
              <label className={labelClass}>
                <span>{embedding ? "Token" : "Trigger words"}</span>
                <input
                  value={draft.triggerWords}
                  maxLength={embedding ? 128 : undefined}
                  aria-invalid={fieldError === "token"}
                  aria-describedby={
                    fieldError === "token" ? errorId : undefined
                  }
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      triggerWords: event.target.value,
                    }))
                  }
                  className={inputClass}
                />
              </label>
              <MediaSampleImagesInput
                assets={assets}
                sampleAssetIds={draft.sampleAssetIds}
                sampleImages={draft.sampleImages}
                disabled={busy}
                onChange={(sampleAssetIds, sampleImages) =>
                  setDraft((current) => ({
                    ...current,
                    sampleAssetIds,
                    sampleImages,
                  }))
                }
                onImportPaths={async (paths) => {
                  setSamplePending(true);
                  try {
                    const ids: string[] = [];
                    for (const path of paths) {
                      const result = await onImportMedia(
                        path,
                        createEmptyMediaGenerationAssetMetadata(),
                      );
                      if (!result)
                        throw new Error(
                          "The sample image could not be imported.",
                        );
                      ids.push(result.asset.id);
                    }
                    return ids;
                  } finally {
                    setSamplePending(false);
                  }
                }}
                onDownloadUrl={async (url) => {
                  setSamplePending(true);
                  try {
                    return (await onImportSampleUrl(url))?.asset.id ?? null;
                  } finally {
                    setSamplePending(false);
                  }
                }}
              />
            </fieldset>
            <footer className="space-y-3 border-t border-slate-800 px-6 py-4">
              {error ? (
                <p id={errorId} role="alert" className="text-sm text-rose-300">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={onClose}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !dirty}
                  {...SUBMIT_SHORTCUT_ACTION_PROPS}
                >
                  {saving ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : null}
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </footer>
          </form>
        </SubmitShortcut>
      </DialogContent>
    </Dialog>
  );
};
