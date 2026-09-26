import { useState, type JSX } from "react";
import {
  MEDIA_POSE_PRESETS,
  type MediaPoseMap,
  type MediaSavedPoseScene,
} from "../../../../core/media/pose-map.js";
import type { PoseTemplate } from "./media-pose-templates.js";
import { PosePreview } from "./media-pose-visuals.js";

type SavedScene = MediaSavedPoseScene & { map: MediaPoseMap };

interface MediaPoseLibraryProps {
  templates: readonly PoseTemplate[];
  savedScenes: readonly SavedScene[];
  peopleCount: number;
  disabled: boolean;
  pending: boolean;
  onAdd: (template: PoseTemplate) => void;
  onEdit: (template: PoseTemplate, isDefault: boolean) => void;
  onDuplicate: (template: PoseTemplate) => void;
  onDelete: (template: PoseTemplate) => void;
  onEditScene: (scene: SavedScene) => void;
  onDuplicateScene: (scene: SavedScene) => void;
  onRenameScene?: (id: string, title: string) => void;
}

export function MediaPoseLibrary({
  templates,
  savedScenes,
  peopleCount,
  disabled,
  pending,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onEditScene,
  onDuplicateScene,
  onRenameScene,
}: MediaPoseLibraryProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "saved">("all");
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [sceneName, setSceneName] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visibleScenes = savedScenes.filter((scene) =>
    scene.label.toLocaleLowerCase().includes(query),
  );
  const visibleTemplates = templates.filter(
    (template) =>
      (filter === "all" ||
        !MEDIA_POSE_PRESETS.some((preset) => preset.id === template.id)) &&
      template.label.toLocaleLowerCase().includes(query),
  );

  return (
    <section aria-label="Pose library" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium text-slate-200">Poses</h3>
        <input
          aria-label="Search poses"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search poses"
          className="min-w-0 w-44 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
        />
        <select
          aria-label="Filter poses"
          value={filter}
          onChange={(event) => setFilter(event.target.value as "all" | "saved")}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
        >
          <option value="all">All poses</option>
          <option value="saved">My poses</option>
        </select>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {visibleScenes.map((scene) => (
          <div
            key={scene.id}
            className="w-48 shrink-0 overflow-hidden rounded-lg border border-sky-800 bg-slate-900/50 text-sm text-slate-100"
          >
            <button
              type="button"
              aria-label={`Edit ${scene.label}`}
              disabled={disabled || pending}
              onClick={() => onEditScene(scene)}
              className="block w-full p-2 text-left hover:bg-slate-800 disabled:opacity-40"
            >
              <PosePreview
                people={scene.map.people}
                aspectRatio={scene.map.aspectRatio}
              />
              <span className="mt-2 block truncate font-medium">
                {scene.label}
              </span>
              <span className="block text-xs text-slate-400">
                Pose chat scene
              </span>
            </button>
            {renamingSceneId === scene.id ? (
              <div className="space-y-2 border-t border-slate-700 p-2">
                <input
                  aria-label="Scene name"
                  autoFocus
                  maxLength={60}
                  value={sceneName}
                  onChange={(event) => setSceneName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && sceneName.trim()) {
                      onRenameScene?.(scene.id, sceneName.trim());
                      setRenamingSceneId(null);
                    }
                  }}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                />
                <div className="flex gap-2 text-sm">
                  <button
                    type="button"
                    disabled={!sceneName.trim()}
                    onClick={() => {
                      onRenameScene?.(scene.id, sceneName.trim());
                      setRenamingSceneId(null);
                    }}
                    className="rounded-md border border-sky-700 px-2 py-1.5 text-sky-300 disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingSceneId(null)}
                    className="rounded-md border border-slate-700 px-2 py-1.5 text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex border-t border-slate-700 text-center text-sm">
              <button
                type="button"
                aria-label={`Duplicate ${scene.label}`}
                disabled={disabled || pending}
                onClick={() => onDuplicateScene(scene)}
                className="flex-1 py-2.5 hover:bg-slate-800 hover:text-sky-300 disabled:opacity-40"
              >
                Duplicate
              </button>
              {onRenameScene ? (
                <button
                  type="button"
                  aria-label={`Rename ${scene.label}`}
                  disabled={disabled || pending}
                  onClick={() => {
                    setSceneName(scene.label);
                    setRenamingSceneId(scene.id);
                  }}
                  className="flex-1 border-l border-slate-700 py-2.5 hover:bg-slate-800 hover:text-sky-300 disabled:opacity-40"
                >
                  Rename
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {visibleTemplates.map((template) => {
          const isDefault = MEDIA_POSE_PRESETS.some(
            (preset) => preset.id === template.id,
          );
          return (
            <div
              key={template.id}
              className="w-48 shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-900/50 text-sm text-slate-300"
            >
              <button
                type="button"
                aria-label={`Add ${template.label}`}
                disabled={disabled || peopleCount + template.people.length > 4}
                onClick={() => onAdd(template)}
                className="block w-full p-2 text-left hover:bg-slate-800 disabled:opacity-40"
              >
                <PosePreview
                  people={template.people}
                  aspectRatio={template.aspectRatio}
                />
                <span className="mt-1.5 block truncate px-1 font-medium text-slate-100">
                  Add {template.label}
                </span>
              </button>
              <div className="flex border-t border-slate-700 text-center">
                <button
                  type="button"
                  aria-label={`Duplicate ${template.label}`}
                  disabled={disabled || pending}
                  onClick={() => onDuplicate(template)}
                  className="min-w-0 flex-1 py-2 hover:bg-slate-800 hover:text-sky-300 disabled:opacity-40"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${template.label}`}
                  disabled={disabled || pending}
                  onClick={() => onEdit(template, isDefault)}
                  className="min-w-0 flex-1 border-l border-slate-700 py-2 hover:bg-slate-800 hover:text-sky-300 disabled:opacity-40"
                >
                  Edit
                </button>
                {!isDefault ? (
                  <button
                    type="button"
                    aria-label={`Delete ${template.label}`}
                    disabled={disabled || pending}
                    onClick={() => onDelete(template)}
                    className="min-w-0 flex-1 border-l border-slate-700 py-2 hover:bg-slate-800 hover:text-red-300 disabled:opacity-40"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {visibleTemplates.length === 0 && visibleScenes.length === 0 ? (
          <p role="status" className="py-6 text-sm text-slate-400">
            No poses found
          </p>
        ) : null}
      </div>
    </section>
  );
}
