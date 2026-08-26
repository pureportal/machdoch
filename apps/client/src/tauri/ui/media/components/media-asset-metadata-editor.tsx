import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState, type JSX } from "react";
import {
  normalizeMediaExternalLink,
  normalizeMediaTriggerWords,
} from "../../../../core/media/asset-metadata.js";
import type {
  MediaAssetCategory,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import { ControlTooltip } from "../../components/ui/tooltip";
import { MediaCategoryPicker } from "./media-category-picker";

interface MediaAssetMetadataEditorProps {
  resourceId: string;
  metadata: MediaGenerationAssetMetadata;
  categories: readonly MediaAssetCategory[];
  showTriggerWords: boolean;
  showSourceUrl?: boolean;
  tagLoading?: boolean;
  onChange: (metadata: MediaGenerationAssetMetadata) => void;
  onTagsChange?: (tags: string[]) => void;
  onManageCategories: () => void;
}

const normalizeTags = (value: string): string[] => {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(/[,\r\n]+/u)) {
    if (tags.length >= 24) break;
    const normalized = candidate.replaceAll(/\s+/gu, " ").trim().slice(0, 64);
    const comparisonValue = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(comparisonValue)) continue;
    seen.add(comparisonValue);
    tags.push(normalized);
  }
  return tags;
};

export const MediaAssetMetadataEditor = ({
  resourceId,
  metadata,
  categories,
  showTriggerWords,
  showSourceUrl = true,
  tagLoading = false,
  onChange,
  onTagsChange,
  onManageCategories,
}: MediaAssetMetadataEditorProps): JSX.Element => {
  const sourceInputId = useId();
  const [tags, setTags] = useState(metadata.tags.join(", "));
  const [triggerWords, setTriggerWords] = useState(metadata.triggerWords);
  const [sourceUrl, setSourceUrl] = useState(metadata.sourceUrl ?? "");
  const [sourceUrlError, setSourceUrlError] = useState<string | null>(null);

  useEffect(() => setTags(metadata.tags.join(", ")), [metadata.tags]);
  useEffect(
    () => setTriggerWords(metadata.triggerWords),
    [metadata.triggerWords],
  );
  useEffect(() => {
    setSourceUrl(metadata.sourceUrl ?? "");
    setSourceUrlError(null);
  }, [metadata.sourceUrl, resourceId]);

  const saveTags = (): void => {
    const normalized = normalizeTags(tags);
    setTags(normalized.join(", "));
    onChange({ ...metadata, tags: normalized });
    onTagsChange?.(normalized);
  };

  const saveTriggerWords = (): void => {
    const normalized = normalizeMediaTriggerWords(triggerWords);
    setTriggerWords(normalized);
    onChange({ ...metadata, triggerWords: normalized });
  };

  const saveSourceUrl = (): void => {
    const normalized = sourceUrl.trim()
      ? normalizeMediaExternalLink(sourceUrl)
      : null;
    if (sourceUrl.trim() && !normalized) {
      setSourceUrlError("Enter an HTTPS URL.");
      return;
    }
    setSourceUrl(normalized ?? "");
    setSourceUrlError(null);
    onChange({ ...metadata, sourceUrl: normalized });
  };

  const openSourceUrl = async (): Promise<void> => {
    const normalized = normalizeMediaExternalLink(sourceUrl);
    if (!normalized) {
      setSourceUrlError("Enter an HTTPS URL.");
      return;
    }
    try {
      await openUrl(normalized);
      setSourceUrlError(null);
    } catch {
      setSourceUrlError("The source URL could not be opened.");
    }
  };

  return (
    <div className="space-y-3">
      <div className="block space-y-1 text-xs text-slate-400">
        <span>Categories</span>
        <MediaCategoryPicker
          categories={categories}
          selectedIds={metadata.categoryIds}
          onChange={(categoryIds) => onChange({ ...metadata, categoryIds })}
          onManage={onManageCategories}
        />
      </div>
      <label className="block space-y-1 text-xs text-slate-400">
        <span>Tags</span>
        <div className="relative">
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            onBlur={saveTags}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 pr-8 text-slate-100 outline-none focus:border-sky-500"
          />
          {tagLoading ? (
            <LoaderCircle className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-slate-400" />
          ) : null}
        </div>
      </label>
      {showTriggerWords ? (
        <label className="block space-y-1 text-xs text-slate-400">
          <span>Trigger words</span>
          <input
            value={triggerWords}
            onChange={(event) => setTriggerWords(event.target.value)}
            onBlur={saveTriggerWords}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-slate-100 outline-none focus:border-sky-500"
          />
        </label>
      ) : null}
      {showSourceUrl ? (
        <div className="block space-y-1 text-xs text-slate-400">
          <label htmlFor={sourceInputId}>Source URL</label>
          <div className="flex gap-2">
            <input
              id={sourceInputId}
              type="url"
              value={sourceUrl}
              onChange={(event) => {
                setSourceUrl(event.target.value);
                setSourceUrlError(null);
              }}
              onBlur={saveSourceUrl}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 text-slate-100 outline-none focus:border-sky-500"
            />
            <ControlTooltip content="Open source URL">
              <button
                type="button"
                aria-label="Open source URL"
                disabled={!sourceUrl.trim()}
                onClick={() => void openSourceUrl()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-400 hover:border-slate-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            </ControlTooltip>
          </div>
          {sourceUrlError ? (
            <span className="text-rose-300">{sourceUrlError}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
