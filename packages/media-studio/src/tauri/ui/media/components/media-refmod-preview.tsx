import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { refModOperation, type RefModInspection } from "../media-refmods";

export function MediaRefModPreview({
  workspaceRoot,
  inspection,
  visualStrength,
  audioStrength,
  disabled,
  onBusyChange,
}: {
  workspaceRoot: string;
  inspection: RefModInspection;
  visualStrength: number;
  audioStrength: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [member, setMember] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [compare, setCompare] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    kind: string;
    previews: string[];
  } | null>(null);
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
          console.error("Could not cancel the closed RefMod preview", failure);
        });
      }
    },
    [workspaceRoot],
  );
  const [error, setError] = useState<string | null>(null);
  const strength =
    inspection.members[member]?.kind === "audio"
      ? audioStrength
      : visualStrength;
  const previewKey = JSON.stringify([
    inspection.path,
    member,
    frameIndex,
    compare,
    strength,
  ]);
  const preview = async () => {
    setError(null);
    setPending(true);
    onBusyChange(true);
    setResult(null);
    const id = crypto.randomUUID();
    setOperationId(id);
    activeOperation.current = id;
    try {
      const decoded = await refModOperation<{
        kind: string;
        previews: string[];
      }>(workspaceRoot, {
        operation: "preview",
        operationId: id,
        path: inspection.path,
        member,
        frameIndex,
        compare,
        strength,
      });
      setResult({ ...decoded, key: previewKey });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
      activeOperation.current = null;
      onBusyChange(false);
      setOperationId(null);
      setCanceling(false);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <fieldset
        disabled={pending || disabled}
        className="flex flex-wrap items-center gap-2"
      >
        {inspection.members.length > 1 && (
          <label>
            Member{" "}
            <select
              value={member}
              onChange={(event) => {
                setMember(Number(event.target.value));
                setFrameIndex(0);
                setResult(null);
              }}
            >
              {inspection.members.map((entry, index) => (
                <option key={entry.key} value={index}>
                  {entry.name} ({entry.kind})
                </option>
              ))}
            </select>
          </label>
        )}
        {inspection.members[member]?.kind === "video" &&
          inspection.members[member]!.frameCount > 1 && (
            <label>
              Frame{" "}
              <input
                className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1"
                type="number"
                min={1}
                max={inspection.members[member]!.frameCount}
                step={1}
                value={frameIndex + 1}
                onChange={(event) =>
                  setFrameIndex(
                    Math.max(
                      0,
                      Math.min(
                        inspection.members[member]!.frameCount - 1,
                        Math.round(Number(event.target.value)) - 1,
                      ),
                    ),
                  )
                }
              />
            </label>
          )}
        <label>
          <input
            type="checkbox"
            checked={compare}
            onChange={(event) => setCompare(event.target.checked)}
          />{" "}
          Compare strength
        </label>
        <Button
          size="sm"
          disabled={pending || disabled}
          onClick={() => void preview()}
        >
          {pending ? "Decoding…" : "Preview"}
        </Button>
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
      {result?.key === previewKey &&
        result.previews.map((source, index) => (
          <div key={`${index}:${source.slice(0, 40)}`}>
            {compare && <p>{index === 0 ? "Stored" : "Strength applied"}</p>}
            {result.kind === "audio" ? (
              <audio controls preload="none" src={source} />
            ) : (
              <img
                className="max-h-64 rounded"
                src={source}
                alt={
                  compare && index > 0
                    ? "Reference with strength applied"
                    : "Stored reference"
                }
              />
            )}
          </div>
        ))}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
