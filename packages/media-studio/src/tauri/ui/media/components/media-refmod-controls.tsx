import { useEffect, useState } from "react";
import type {
  MediaRefModSelection,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import { isActiveRefMod } from "../../../../core/media/refmods.js";
import { Button } from "../../components/ui/button";
import { isRemoteMedia, open, save } from "../media-platform";
import { refModOperation, type RefModInspection } from "../media-refmods";
import { MediaRefModCreator } from "./media-refmod-creator";
import { MediaRefModPreview } from "./media-refmod-preview";

interface Props {
  workspaceRoot: string;
  settings: Pick<MediaVideoRecipeSettings, "refMods" | "refModMaxTokens">;
  onChange: (
    settings: Pick<MediaVideoRecipeSettings, "refMods" | "refModMaxTokens">,
  ) => void;
  onInsertLabel?: (label: string) => void;
  imageCount?: number;
}

export function MediaRefModControls({
  workspaceRoot,
  settings,
  onChange,
  onInsertLabel,
  imageCount = 0,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const busy = pending || creating || previewing;
  const [library, setLibrary] = useState<RefModInspection[] | null>(null);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState("");
  const [inspections, setInspections] = useState<
    Record<string, RefModInspection>
  >({});
  const slots = settings.refMods ?? [];
  const paths = JSON.stringify([
    ...new Set(slots.filter(isActiveRefMod).map((slot) => slot.path)),
  ]);
  useEffect(() => {
    let active = true;
    const inspect = async () => {
      const selected = JSON.parse(paths) as string[];
      if (!selected.length) {
        setInspections({});
        return;
      }
      try {
        const results = await refModOperation<
          Array<
            | { path: string; record: RefModInspection; error?: never }
            | { path: string; error: string; record?: never }
          >
        >(workspaceRoot, { operation: "inspect-many", paths: selected });
        if (!active) return;
        const values: Record<string, RefModInspection> = {};
        const failures: string[] = [];
        for (const result of results) {
          if (result.record) values[result.path] = result.record;
          else failures.push(`${result.path}: ${result.error}`);
        }
        setInspections(values);
        setError(failures.length ? failures.join("\n") : null);
      } catch (failure) {
        if (!active) return;
        setInspections({});
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void inspect();
    return () => {
      active = false;
    };
  }, [paths, workspaceRoot]);
  const perform = async (work: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  const add = (pathsToAdd: string[]) => {
    if (slots.length + pathsToAdd.length > 256) {
      setError("Choose at most 256 RefMods.");
      return;
    }
    onChange({
      ...settings,
      refMods: [
        ...slots,
        ...pathsToAdd.map((path) => ({
          path,
          enabled: true,
          selection: "all" as const,
          visualStrength: 1,
          audioStrength: 1,
          copies: 1,
        })),
      ],
    });
  };
  const update = (index: number, change: Partial<MediaRefModSelection>) =>
    onChange({
      ...settings,
      refMods: slots.map((slot, position) =>
        position === index ? { ...slot, ...change } : slot,
      ),
    });
  const move = (index: number, offset: number) => {
    const reordered = [...slots];
    const [slot] = reordered.splice(index, 1);
    if (slot) reordered.splice(index + offset, 0, slot);
    onChange({ ...settings, refMods: reordered });
  };
  const counters = { image: imageCount, video: 0, audio: 0 };
  const labels: string[] = [];
  let total = 0;
  const members = slots
    .filter(isActiveRefMod)
    .flatMap((slot) =>
      (inspections[slot.path]?.members ?? []).flatMap((member) =>
        (
          member.kind === "audio"
            ? slot.selection !== "visual" && slot.audioStrength > 0
            : slot.selection !== "audio" && slot.visualStrength > 0
        )
          ? Array.from({ length: slot.copies }, () => member)
          : [],
      ),
    );
  members.sort(
    (a, b) => Number(a.kind === "audio") - Number(b.kind === "audio"),
  );
  for (const member of members) {
    counters[member.kind]++;
    labels.push(
      `<${{ image: "Picture", video: "Video", audio: "Audio" }[member.kind]} ${counters[member.kind]}>`,
    );
    total += member.tokens;
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-700 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm">RefMods</h3>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const selected = await open({
                multiple: true,
                filters: [{ name: "RefMod", extensions: ["safetensors"] }],
              });
              if (!selected) return;
              const paths = Array.isArray(selected) ? selected : [selected];
              if (slots.length + paths.length > 256)
                throw new Error("Choose at most 256 RefMods.");
              const imported: string[] = [];
              for (const path of paths) {
                imported.push(
                  (
                    await refModOperation<RefModInspection>(workspaceRoot, {
                      operation: "import",
                      path,
                    })
                  ).path,
                );
                add(imported);
              }
            })
          }
        >
          Add files
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const chosenDirectory = isRemoteMedia()
                ? directory
                : await open({ directory: true, multiple: false });
              if (
                typeof chosenDirectory !== "string" ||
                !chosenDirectory.trim()
              )
                return;
              const result = await refModOperation<{
                records: RefModInspection[];
                errors: Array<{ path: string; error: string }>;
              }>(workspaceRoot, {
                operation: "list",
                directory: chosenDirectory,
              });
              setLibrary(result.records);
              if (result.errors.length)
                setError(
                  result.errors
                    .map((entry) => `${entry.path}: ${entry.error}`)
                    .join("\n"),
                );
            })
          }
        >
          Browse folder
        </Button>
        <Button
          size="sm"
          disabled={busy || slots.length >= 256}
          onClick={() => setCreateOpen(!createOpen)}
        >
          Create RefMod
        </Button>
        {slots.length > 0 && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const outputPath = await save({
                  defaultPath: "references.safetensors",
                  filters: [{ name: "RefMod", extensions: ["safetensors"] }],
                });
                if (outputPath)
                  await refModOperation(workspaceRoot, {
                    operation: "save",
                    slots,
                    outputPath,
                    name: "References",
                    maxTokens: settings.refModMaxTokens ?? 65536,
                  });
              })
            }
          >
            Export bundle
          </Button>
        )}
      </div>
      {isRemoteMedia() && (
        <label className="block text-xs">
          Host folder
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            className="ml-2 rounded border border-slate-700 bg-slate-950 p-2"
          />
        </label>
      )}
      {library !== null && (
        <fieldset disabled={busy} className="space-y-2">
          <input
            aria-label="Search RefMods"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2"
          />
          {library
            .filter((record) =>
              `${record.name} ${record.path}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((record) => (
              <div
                key={record.path}
                className="flex items-center gap-2 text-sm"
              >
                <span className="mr-auto">
                  {record.name} · {record.tokens.toLocaleString()} tokens
                </span>
                <Button size="sm" onClick={() => add([record.path])}>
                  Add
                </Button>
              </div>
            ))}
          <Button size="sm" onClick={() => setLibrary(null)}>
            Close folder
          </Button>
        </fieldset>
      )}
      {createOpen && (
        <MediaRefModCreator
          workspaceRoot={workspaceRoot}
          disabled={pending || previewing}
          onBusyChange={setCreating}
          onCreated={(path) => {
            add([path]);
            setCreateOpen(false);
          }}
        />
      )}
      {slots.map((slot, index) => (
        <div
          key={`${index}:${slot.path}`}
          className="space-y-2 border-t border-slate-700 pt-2"
        >
          <fieldset disabled={busy} className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Enable RefMod ${index + 1}`}
                checked={slot.enabled}
                onChange={(event) =>
                  update(index, { enabled: event.target.checked })
                }
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {inspections[slot.path]?.name ??
                  slot.path.split(/[\\/]/u).at(-1)}
              </span>
              <Button
                size="sm"
                aria-label={`Move RefMod ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                aria-label={`Move RefMod ${index + 1} down`}
                disabled={index === slots.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  onChange({
                    ...settings,
                    refMods: slots.filter((_, position) => position !== index),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              <label>
                Modality{" "}
                <select
                  value={slot.selection}
                  onChange={(event) =>
                    update(index, {
                      selection: event.target
                        .value as MediaRefModSelection["selection"],
                    })
                  }
                >
                  <option value="all">All</option>
                  <option value="visual">Visual</option>
                  <option value="audio">Audio</option>
                </select>
              </label>
              {slot.selection !== "audio" && (
                <label>
                  Visual strength{" "}
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={slot.visualStrength}
                    onChange={(event) =>
                      update(index, {
                        visualStrength: Math.max(
                          0,
                          Math.min(1, Number(event.target.value)),
                        ),
                      })
                    }
                    className="w-16 bg-slate-950"
                  />
                </label>
              )}
              {slot.selection !== "visual" && (
                <label>
                  Audio strength{" "}
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={slot.audioStrength}
                    onChange={(event) =>
                      update(index, {
                        audioStrength: Math.max(
                          0,
                          Math.min(1, Number(event.target.value)),
                        ),
                      })
                    }
                    className="w-16 bg-slate-950"
                  />
                </label>
              )}
              <label>
                Copies{" "}
                <input
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  value={slot.copies}
                  onChange={(event) =>
                    update(index, {
                      copies: Math.max(
                        1,
                        Math.min(8, Math.round(Number(event.target.value))),
                      ),
                    })
                  }
                  className="w-12 bg-slate-950"
                />
              </label>
            </div>
            <details className="text-xs">
              <summary>Curves</summary>
              <div className="mt-2 flex flex-wrap gap-3">
                {(["stepCurve", "frameCurve"] as const).map((field) => (
                  <label key={field}>
                    {field === "stepCurve"
                      ? "Denoising steps"
                      : "Reference frames"}{" "}
                    <select
                      value={slot[field] ?? "constant"}
                      onChange={(event) =>
                        update(index, {
                          [field]: event.target.value as NonNullable<
                            MediaRefModSelection[typeof field]
                          >,
                        })
                      }
                    >
                      <option value="constant">Constant</option>
                      <option value="increase">Increase</option>
                      <option value="decrease">Decrease</option>
                      <option value="middle">Middle</option>
                      <option value="ends">Ends</option>
                    </select>
                  </label>
                ))}
              </div>
            </details>
          </fieldset>
          {inspections[slot.path] && (
            <details className="text-xs">
              <summary>Inspect reference</summary>
              <p className="break-all">{slot.path}</p>
              {inspections[slot.path]!.members.map((member) => (
                <p key={member.key}>
                  {member.name} · {member.kind} · {member.shape.join(" × ")} ·{" "}
                  {member.tokens.toLocaleString()} tokens
                </p>
              ))}
              <MediaRefModPreview
                workspaceRoot={workspaceRoot}
                inspection={inspections[slot.path]!}
                visualStrength={slot.visualStrength}
                audioStrength={slot.audioStrength}
                disabled={busy}
                onBusyChange={setPreviewing}
              />
            </details>
          )}
        </div>
      ))}
      {slots.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>{total.toLocaleString()} tokens</span>
          <label>
            {settings.refModMaxTokens === 0
              ? "Token limit (unlimited)"
              : "Token limit"}{" "}
            <input
              type="number"
              min={0}
              max={1048576}
              step={1}
              value={settings.refModMaxTokens ?? 65536}
              onChange={(event) =>
                onChange({
                  ...settings,
                  refModMaxTokens: Math.max(
                    0,
                    Math.min(1048576, Math.round(Number(event.target.value))),
                  ),
                })
              }
              className="w-24 bg-slate-950"
            />
          </label>
          {labels.map((label) => (
            <Button
              key={label}
              size="sm"
              disabled={!onInsertLabel}
              onClick={() => onInsertLabel?.(label)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {settings.refModMaxTokens !== 0 &&
        total > (settings.refModMaxTokens ?? 65536) && (
          <p role="alert" className="text-sm text-red-300">
            Reduce references or copies, or raise the token limit.
          </p>
        )}
      {pending && <p role="status">Loading RefMods…</p>}
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
