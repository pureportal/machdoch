import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type JSX } from "react";
import {
  addMediaAssetCategory,
  removeMediaAssetCategory,
  renameMediaAssetCategory,
} from "../../../../core/media/asset-categories.js";
import type {
  MediaAssetCategory,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { ControlTooltip } from "../../components/ui/tooltip";

interface MediaCategoryManagerDialogProps {
  categories: readonly MediaAssetCategory[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  onChange: (
    categories: MediaAssetCategory[],
    metadata: Record<string, MediaGenerationAssetMetadata>,
  ) => void;
  onClose: () => void;
}

const createCategoryId = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? `category:${globalThis.crypto.randomUUID()}`
    : `category:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;

export const MediaCategoryManagerDialog = ({
  categories,
  metadata,
  onChange,
  onClose,
}: MediaCategoryManagerDialogProps): JSX.Element => {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignedCount = (categoryId: string): number =>
    Object.values(metadata).filter((entry) =>
      entry.categoryIds.includes(categoryId),
    ).length;

  const addCategory = (): void => {
    try {
      const nextCategories = addMediaAssetCategory(
        categories,
        newName,
        createCategoryId(),
      );
      onChange(nextCategories, { ...metadata });
      setNewName("");
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Category not added.",
      );
    }
  };

  const saveRename = (): void => {
    if (!editingId) return;
    try {
      const nextCategories = renameMediaAssetCategory(
        categories,
        editingId,
        editingName,
      );
      onChange(nextCategories, { ...metadata });
      setEditingId(null);
      setEditingName("");
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Category not renamed.",
      );
    }
  };

  const confirmRemove = (categoryId: string): void => {
    const next = removeMediaAssetCategory(categories, metadata, categoryId);
    onChange(next.categories, next.metadata);
    setDeletingId(null);
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-category-manager-title"
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h1
            id="media-category-manager-title"
            className="text-sm font-semibold text-slate-100"
          >
            Categories
          </h1>
          <ControlTooltip content="Close">
            <button
              type="button"
              aria-label="Close categories"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </ControlTooltip>
        </header>
        <div className="flex gap-2 border-b border-slate-800 p-4">
          <input
            value={newName}
            aria-label="New category"
            placeholder="New category"
            maxLength={64}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCategory();
            }}
            className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
          <Button
            type="button"
            onClick={addCategory}
            disabled={!newName.trim()}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
          {categories.map((category) => {
            const count = assignedCount(category.id);
            const editing = editingId === category.id;
            const deleting = deletingId === category.id;
            return (
              <div
                key={category.id}
                className="rounded-xl border border-slate-800 bg-slate-900/45 px-3 py-2"
              >
                {deleting ? (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-xs text-slate-300">
                      {count > 0
                        ? `Remove from ${count} asset${count === 1 ? "" : "s"}?`
                        : "Remove category?"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeletingId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => confirmRemove(category.id)}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {editing ? (
                      <input
                        value={editingName}
                        aria-label={`Rename ${category.name}`}
                        maxLength={64}
                        autoFocus
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveRename();
                          if (event.key === "Escape") setEditingId(null);
                        }}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-500"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                        {category.name}
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500">{count}</span>
                    {editing ? (
                      <ControlTooltip content={`Save ${category.name}`}>
                        <button
                          type="button"
                          aria-label={`Save ${category.name}`}
                          onClick={saveRename}
                          className="rounded-md p-1.5 text-emerald-300 hover:bg-slate-800"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </ControlTooltip>
                    ) : (
                      <ControlTooltip content={`Rename ${category.name}`}>
                        <button
                          type="button"
                          aria-label={`Rename ${category.name}`}
                          onClick={() => {
                            setEditingId(category.id);
                            setEditingName(category.name);
                            setDeletingId(null);
                            setError(null);
                          }}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </ControlTooltip>
                    )}
                    <ControlTooltip content={`Remove ${category.name}`}>
                      <button
                        type="button"
                        aria-label={`Remove ${category.name}`}
                        onClick={() => {
                          setDeletingId(category.id);
                          setEditingId(null);
                          setError(null);
                        }}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </ControlTooltip>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error ? (
          <p className="border-t border-slate-800 px-4 py-3 text-xs text-rose-300">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
};
