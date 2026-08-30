import type { ProductMedia } from "@machdoch/fleet-protocol";
import {
  Aperture,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatTimestamp } from "./format";
import { MediaStudioNavigation } from "./media-studio-navigation";
import type { ProductCommandHandler } from "./product-runtime";

type RemoteMediaSection = "generate" | "library" | "runs";

interface MediaDraft {
  prompt: string;
  target: "image" | "svg";
  modelId: string;
  aspectRatio: "1:1" | "4:5" | "16:9" | "9:16";
  outputCount: number;
  outputFormat: "png" | "jpeg" | "webp" | "svg";
  transparentBackground: boolean;
}

const activeRunStatuses = new Set([
  "queued",
  "running",
  "canceling",
  "needs-review",
  "waiting-for-review",
]);

export function MediaStudio({
  media,
  pending,
  onCommand,
}: {
  media: ProductMedia;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [section, setSection] = useState<RemoteMediaSection>("generate");
  const [draft, setDraft] = useState<MediaDraft>(() => draftFromMedia(media));
  const generationKey = JSON.stringify(media.generation);
  const lastGenerationKeyRef = useRef(generationKey);
  const [confirming, setConfirming] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  useEffect(() => {
    if (generationKey === lastGenerationKeyRef.current) return;
    lastGenerationKeyRef.current = generationKey;
    setDraft(draftFromMedia(media));
  }, [generationKey, media]);

  const models = useMemo(
    () => media.models.filter((model) => model.targets.includes(draft.target)),
    [draft.target, media.models],
  );
  const selectedModel =
    models.find((model) => model.id === draft.modelId) ?? models[0] ?? null;
  const selectedAsset =
    media.assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const unavailableReason = models.length
    ? null
    : draft.target === media.generation.target
      ? media.generation.unavailableReason
      : `No ready model supports ${draft.target === "svg" ? "SVG" : "images"}.`;
  const canGenerate =
    !media.loading &&
    !media.error &&
    !media.busy &&
    !pending &&
    draft.prompt.trim().length > 0 &&
    selectedModel !== null;

  useEffect(() => {
    if (selectedModel && selectedModel.id !== draft.modelId) {
      setDraft((current) => ({ ...current, modelId: selectedModel.id }));
    }
  }, [draft.modelId, selectedModel]);

  const generate = async (): Promise<void> => {
    if (!canGenerate || !selectedModel) return;
    setConfirming(false);
    await onCommand({
      kind: "generate-media",
      prompt: draft.prompt,
      target: draft.target,
      modelId: selectedModel.id,
      aspectRatio: draft.aspectRatio,
      outputCount: draft.outputCount,
      outputFormat: draft.target === "svg" ? "svg" : draft.outputFormat,
      transparentBackground: draft.transparentBackground,
    });
  };

  const requestGeneration = (): void => {
    if (!canGenerate || !selectedModel) return;
    if (selectedModel.target === "remote") setConfirming(true);
    else void generate();
  };

  return (
    <div className="m-media-studio-layout">
      <MediaStudioNavigation
        activeSection={section}
        availableSections={["generate", "library", "runs"]}
        onSelect={(next) => setSection(next as RemoteMediaSection)}
      />
      <section className="m-media-surface">
        {media.error ? (
          <div className="m-media-error" role="alert">
            {media.error}
          </div>
        ) : null}
        {section === "generate" ? (
          <div className="m-media-create">
            <header className="m-media-header">
              <div>
                <Aperture aria-hidden="true" />
                <h1>Create</h1>
              </div>
              {media.busy ? (
                <span className="m-media-busy">
                  <LoaderCircle aria-hidden="true" /> Running
                </span>
              ) : null}
            </header>
            <div className="m-media-create-body">
              <div className="m-media-targets" aria-label="Media type">
                {(["image", "svg"] as const).map((target) => (
                  <button
                    key={target}
                    type="button"
                    data-active={draft.target === target}
                    aria-pressed={draft.target === target}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        target,
                        outputFormat:
                          target === "svg"
                            ? "svg"
                            : current.outputFormat === "svg"
                              ? "png"
                              : current.outputFormat,
                      }))
                    }
                  >
                    {target === "svg" ? "SVG" : "Image"}
                  </button>
                ))}
              </div>
              <label className="m-media-prompt">
                <span>Prompt</span>
                <textarea
                  value={draft.prompt}
                  maxLength={8_000}
                  placeholder="Describe what to create"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      prompt: event.target.value,
                    }))
                  }
                />
              </label>
              <div className="m-media-controls">
                <label>
                  <span>Model</span>
                  <select
                    value={selectedModel?.id ?? ""}
                    disabled={models.length === 0}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        modelId: event.target.value,
                      }))
                    }
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Aspect ratio</span>
                  <select
                    value={draft.aspectRatio}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        aspectRatio: event.target
                          .value as MediaDraft["aspectRatio"],
                      }))
                    }
                  >
                    <option value="1:1">1:1</option>
                    <option value="4:5">4:5</option>
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                  </select>
                </label>
                <label>
                  <span>Outputs</span>
                  <select
                    value={draft.outputCount}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        outputCount: Number(event.target.value),
                      }))
                    }
                  >
                    {[1, 2, 3, 4, 6, 8].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.target === "image" ? (
                  <label>
                    <span>Format</span>
                    <select
                      value={draft.outputFormat}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          outputFormat: event.target
                            .value as MediaDraft["outputFormat"],
                        }))
                      }
                    >
                      <option value="png">PNG</option>
                      <option value="jpeg">JPEG</option>
                      <option value="webp">WebP</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <label className="m-media-checkbox">
                <input
                  type="checkbox"
                  checked={draft.transparentBackground}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      transparentBackground: event.target.checked,
                    }))
                  }
                />
                Transparent background
              </label>
              <div className="m-media-create-actions">
                {unavailableReason ? <span>{unavailableReason}</span> : null}
                <button
                  type="button"
                  className="m-product-primary-button"
                  disabled={!canGenerate}
                  onClick={requestGeneration}
                >
                  {media.busy || pending ? (
                    <LoaderCircle
                      className="m-product-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Play aria-hidden="true" />
                  )}
                  Generate
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {section === "library" ? (
          <div className="m-media-collection">
            <header className="m-media-header">
              <div>
                <ImageIcon aria-hidden="true" />
                <h1>Assets</h1>
              </div>
              <span>{media.assetCount}</span>
            </header>
            {media.assets.length ? (
              <div className="m-media-asset-grid">
                {media.assets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className="m-media-asset"
                    onClick={() => setSelectedAssetId(asset.id)}
                  >
                    <span className="m-media-asset-preview">
                      {asset.previewDataUrl ? (
                        <img src={asset.previewDataUrl} alt="" />
                      ) : (
                        <ImageIcon aria-hidden="true" />
                      )}
                    </span>
                    <strong>{asset.kind}</strong>
                    <span>
                      {asset.width && asset.height
                        ? `${asset.width} x ${asset.height}`
                        : formatBytes(asset.byteSize)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="m-product-empty-small">No assets</div>
            )}
          </div>
        ) : null}
        {section === "runs" ? (
          <div className="m-media-collection">
            <header className="m-media-header">
              <div>
                <LoaderCircle aria-hidden="true" />
                <h1>Activity</h1>
              </div>
              <span>{media.runCount}</span>
            </header>
            {media.runs.length ? (
              <div className="m-media-run-list">
                {media.runs.map((run) => (
                  <article key={run.id} className="m-media-run">
                    <div className="m-media-run-heading">
                      <strong>{run.modelLabel}</strong>
                      <span data-state={run.status}>{run.status}</span>
                    </div>
                    <p>{run.prompt}</p>
                    <div className="m-media-progress" aria-label="Progress">
                      <span style={{ width: `${run.progress * 100}%` }} />
                    </div>
                    <div className="m-media-run-footer">
                      <span>
                        {run.currentStep || formatTimestamp(run.updatedAt)}
                      </span>
                      {activeRunStatuses.has(run.status) ? (
                        <button
                          type="button"
                          disabled={pending || run.status === "canceling"}
                          onClick={() =>
                            void onCommand({
                              kind: "cancel-media-run",
                              runId: run.id,
                            })
                          }
                        >
                          <Square aria-hidden="true" /> Cancel
                        </button>
                      ) : null}
                    </div>
                    {run.error ? (
                      <div className="m-media-run-error">{run.error}</div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="m-product-empty-small">No activity</div>
            )}
          </div>
        ) : null}
      </section>
      {confirming && selectedModel ? (
        <div className="m-media-modal-backdrop" role="presentation">
          <div
            className="m-media-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="m-media-confirm-title"
          >
            <button
              type="button"
              className="m-media-modal-close"
              aria-label="Close"
              onClick={() => setConfirming(false)}
            >
              <X aria-hidden="true" />
            </button>
            <h2 id="m-media-confirm-title">
              Generate with {selectedModel.label}?
            </h2>
            <p>
              {selectedModel.costHint ??
                "This request may incur provider charges."}
            </p>
            <div>
              <button
                type="button"
                className="m-product-secondary-button"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="m-product-primary-button"
                onClick={() => void generate()}
              >
                <Play aria-hidden="true" /> Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {selectedAsset ? (
        <div className="m-media-modal-backdrop" role="presentation">
          <div
            className="m-media-asset-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Asset preview"
          >
            <button
              type="button"
              className="m-media-modal-close"
              aria-label="Close"
              onClick={() => setSelectedAssetId(null)}
            >
              <X aria-hidden="true" />
            </button>
            {selectedAsset.previewDataUrl ? (
              <img src={selectedAsset.previewDataUrl} alt="" />
            ) : (
              <ImageIcon aria-hidden="true" />
            )}
            <div>
              <strong>{selectedAsset.kind}</strong>
              <span>
                {selectedAsset.width} x {selectedAsset.height} /{" "}
                {formatBytes(selectedAsset.byteSize)}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function draftFromMedia(media: ProductMedia): MediaDraft {
  const generation = media.generation;
  return {
    prompt: generation.prompt,
    target: generation.target,
    modelId: generation.modelId ?? "",
    aspectRatio: generation.aspectRatio,
    outputCount: generation.outputCount,
    outputFormat: generation.outputFormat,
    transparentBackground: generation.transparentBackground,
  };
}
