import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { isRemoteMedia, open, save } from "../media-platform";
import { refModOperation, type RefModInspection } from "../media-refmods";

type Source = {
  path: string;
  kind: "image" | "video" | "audio";
  startSeconds: number;
  maskPath?: string;
};

export function MediaRefModCreator({
  workspaceRoot,
  onCreated,
  onBusyChange,
  disabled,
}: {
  workspaceRoot: string;
  onCreated: (path: string) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("encode");
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [gridSize, setGridSize] = useState(16);
  const [temporalSize, setTemporalSize] = useState(3);
  const [refinementSteps, setRefinementSteps] = useState(0);
  const [maxFrames, setMaxFrames] = useState(22);
  const [maxSeconds, setMaxSeconds] = useState(30);
  const [maxTokens, setMaxTokens] = useState(65536);
  const [concept, setConcept] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const activeOperation = useRef<string | null>(null);
  useEffect(
    () => () => {
      const operationId = activeOperation.current;
      if (operationId) {
        activeOperation.current = null;
        void refModOperation(workspaceRoot, {
          operation: "cancel",
          operationId,
        }).catch((failure) => {
          console.error("Could not cancel the closed RefMod creation", failure);
        });
      }
    },
    [workspaceRoot],
  );
  const [error, setError] = useState<string | null>(null);
  const perform = async (work: () => Promise<void>) => {
    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      activeOperation.current = null;
      setOperationId(null);
      setCanceling(false);
      setPending(false);
      onBusyChange(false);
    }
  };
  const addSources = (kind: Source["kind"]) =>
    void perform(async () => {
      const extensions = {
        image: ["png", "jpg", "jpeg", "webp", "bmp"],
        video: ["mp4", "mov", "mkv", "webm"],
        audio: ["wav", "mp3", "flac", "ogg", "m4a"],
      }[kind];
      const selected = await open({
        multiple: true,
        filters: [{ name: kind, extensions }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setSources((current) => [
        ...current,
        ...paths.map((path) => ({ path, kind, startSeconds: 0 })),
      ]);
      if (!name)
        setName(
          paths[0]!
            .split(/[\\/]/u)
            .at(-1)!
            .replace(/\.[^.]+$/u, ""),
        );
    });
  const updateSource = (index: number, patch: Partial<Source>) =>
    setSources((current) =>
      current.map((source, position) =>
        position === index ? { ...source, ...patch } : source,
      ),
    );
  const submit = () =>
    void perform(async () => {
      const outputPath = await save({
        defaultPath: `${name.trim() || "reference"}.safetensors`,
        filters: [{ name: "RefMod", extensions: ["safetensors"] }],
      });
      if (!outputPath) return;
      const id = crypto.randomUUID();
      setOperationId(id);
      activeOperation.current = id;
      const result = await refModOperation<RefModInspection>(workspaceRoot, {
        operation: "create",
        operationId: id,
        sources,
        outputPath,
        name,
        mode,
        width,
        height,
        gridSize,
        temporalSize,
        refinementSteps,
        maxFrames,
        maxSeconds,
        maxTokens,
        concept,
        description,
        keepInLibrary: isRemoteMedia(),
      });
      activeOperation.current = null;
      onCreated(result.path);
    });
  const numberClass =
    "ml-2 w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1";
  return (
    <div className="space-y-2">
      <fieldset
        disabled={pending || disabled}
        className="space-y-3 rounded border border-slate-700 p-3"
      >
        <legend className="px-1 text-sm">Create RefMod</legend>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => addSources("image")}>
            Add images
          </Button>
          <Button size="sm" onClick={() => addSources("video")}>
            Add videos
          </Button>
          <Button size="sm" onClick={() => addSources("audio")}>
            Add audio
          </Button>
          {!isRemoteMedia() && (
            <Button
              size="sm"
              onClick={() =>
                void perform(async () => {
                  const directory = await open({
                    directory: true,
                    multiple: false,
                  });
                  if (typeof directory === "string") {
                    const selected = await refModOperation<Source[]>(
                      workspaceRoot,
                      { operation: "sources", directory },
                    );
                    setSources((current) => [...current, ...selected]);
                  }
                })
              }
            >
              Add folder
            </Button>
          )}
        </div>
        {sources.map((source, index) => (
          <div
            key={`${index}:${source.path}`}
            className="space-y-2 border-t border-slate-700 pt-2 text-xs"
          >
            <div className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">
                {source.path.split(/[\\/]/u).at(-1)}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  setSources((current) =>
                    current.filter((_, position) => position !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
            {source.kind !== "image" && (
              <label>
                Start (seconds)
                <input
                  className={numberClass}
                  type="number"
                  min={0}
                  step={0.1}
                  value={source.startSeconds}
                  onChange={(event) =>
                    updateSource(index, {
                      startSeconds: Math.max(0, Number(event.target.value)),
                    })
                  }
                />
              </label>
            )}
            {source.kind !== "audio" && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void perform(async () => {
                      const selected = await open({
                        multiple: false,
                        filters: [
                          { name: "Mask", extensions: ["png", "webp", "jpg"] },
                        ],
                      });
                      if (typeof selected === "string")
                        updateSource(index, { maskPath: selected });
                    })
                  }
                >
                  Choose mask
                </Button>
                {source.maskPath && (
                  <>
                    <span className="truncate">
                      {source.maskPath.split(/[\\/]/u).at(-1)}
                    </span>
                    <Button
                      size="sm"
                      onClick={() =>
                        updateSource(index, { maskPath: undefined })
                      }
                    >
                      Remove mask
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        <label className="block text-xs">
          Name
          <input
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 p-2"
            maxLength={256}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {sources.some((source) => source.kind !== "audio") && (
          <label className="block text-xs">
            Compression
            <select
              className={numberClass}
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="encode">Full</option>
              <option value="compressed">Compressed</option>
            </select>
          </label>
        )}
        <details className="text-xs">
          <summary>Encoding settings</summary>
          <div className="mt-2 flex flex-wrap gap-3">
            {sources.some((source) => source.kind !== "audio") && (
              <>
                <label>
                  Width
                  <input
                    className={numberClass}
                    type="number"
                    min={32}
                    max={2048}
                    step={32}
                    value={width}
                    onChange={(event) => setWidth(Number(event.target.value))}
                  />
                </label>
                <label>
                  Height
                  <input
                    className={numberClass}
                    type="number"
                    min={32}
                    max={2048}
                    step={32}
                    value={height}
                    onChange={(event) => setHeight(Number(event.target.value))}
                  />
                </label>
                {mode === "compressed" && (
                  <>
                    <label>
                      Latent grid
                      <input
                        className={numberClass}
                        type="number"
                        min={2}
                        max={128}
                        step={2}
                        value={gridSize}
                        onChange={(event) =>
                          setGridSize(Number(event.target.value))
                        }
                      />
                    </label>
                    {sources.some((source) => source.kind === "video") && (
                      <label>
                        Latent frames
                        <input
                          className={numberClass}
                          type="number"
                          min={1}
                          max={107}
                          step={1}
                          value={temporalSize}
                          onChange={(event) =>
                            setTemporalSize(Number(event.target.value))
                          }
                        />
                      </label>
                    )}
                    <label>
                      Refinement steps
                      <input
                        className={numberClass}
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={refinementSteps}
                        onChange={(event) =>
                          setRefinementSteps(Number(event.target.value))
                        }
                      />
                    </label>
                  </>
                )}
              </>
            )}
            {sources.some((source) => source.kind === "video") && (
              <label>
                Clip frames
                <input
                  className={numberClass}
                  type="number"
                  min={5}
                  max={362}
                  step={17}
                  value={maxFrames}
                  onChange={(event) => setMaxFrames(Number(event.target.value))}
                />
              </label>
            )}
            {sources.some((source) => source.kind === "audio") && (
              <label>
                Audio seconds
                <input
                  className={numberClass}
                  type="number"
                  min={1}
                  max={300}
                  step={1}
                  value={maxSeconds}
                  onChange={(event) =>
                    setMaxSeconds(Number(event.target.value))
                  }
                />
              </label>
            )}
            <label>
              {maxTokens === 0 ? "Token limit (unlimited)" : "Token limit"}
              <input
                className={numberClass}
                type="number"
                min={0}
                max={1048576}
                step={1}
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            </label>
            <label>
              Concept
              <input
                className={numberClass}
                maxLength={256}
                value={concept}
                onChange={(event) => setConcept(event.target.value)}
              />
            </label>
            <label className="w-full">
              Description
              <textarea
                className="mt-1 w-full rounded border border-slate-700 bg-slate-950 p-2"
                maxLength={4096}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        </details>
        <Button
          size="sm"
          disabled={!sources.length || !name.trim() || pending}
          onClick={submit}
        >
          {pending ? "Creating…" : "Create and save"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </fieldset>
      {operationId && (
        <Button
          size="sm"
          disabled={canceling}
          onClick={() => {
            setCanceling(true);
            void refModOperation(workspaceRoot, {
              operation: "cancel",
              operationId,
            }).catch((failure) => {
              setCanceling(false);
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            });
          }}
        >
          {canceling ? "Canceling…" : "Cancel"}
        </Button>
      )}
    </div>
  );
}
