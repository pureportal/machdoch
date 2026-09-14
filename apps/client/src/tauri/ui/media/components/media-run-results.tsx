import { useState, type JSX } from "react";
import type {
  MediaAssetRecord,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
import { Button } from "../../components/ui/button";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaSaveAssetButton } from "./media-save-asset-button";

export const MediaRunResults = ({
  run,
  onOpenAsset,
}: {
  run: MediaRunDetail;
  onOpenAsset: (asset: MediaAssetRecord) => void;
}): JSX.Element | null => {
  const results = run.assets.filter((asset) =>
    run.executor === "media-workflow"
      ? asset.operation?.kind === "workflow" &&
        asset.operation.details.finalOutput === true
      : true,
  );
  const intermediates = run.assets.filter((asset) => !results.includes(asset));
  const [intermediatesOpen, setIntermediatesOpen] = useState(
    results.length === 0,
  );
  const gallery = (assets: readonly MediaAssetRecord[]): JSX.Element => (
    <div className="mt-2 grid gap-3">
      {assets.map((asset) => {
        const operation =
          asset.operation?.kind === "workflow" ? asset.operation : null;
        const verdict = operation?.details.verdict;
        return (
          <article
            key={asset.id}
            className="space-y-2 rounded-xl border border-slate-800 p-2"
          >
            {operation && !operation.details.finalOutput ? (
              <p className="text-xs text-slate-400">
                {run.planSnapshot?.nodes.find(
                  (node) => node.id === operation.sourceNodeId,
                )?.label ?? mediaAssetLabel(asset)}{" "}
                · Attempt {operation.iteration}
              </p>
            ) : null}
            {asset.kind === "report" ? (
              <p className="text-sm text-slate-200">
                {verdict === "pass"
                  ? "Passed"
                  : verdict === "fail"
                    ? "Failed"
                    : verdict === "unknown"
                      ? "Inconclusive"
                      : "Quality report"}
              </p>
            ) : (
              <>
                <MediaAssetPreview
                  asset={asset}
                  maxEdge={512}
                  controls={asset.kind === "video"}
                  fit="contain"
                  className="aspect-video max-h-64 w-full rounded-lg"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => onOpenAsset(asset)}
                >
                  View {mediaAssetLabel(asset)}
                </Button>
              </>
            )}
            <MediaSaveAssetButton asset={asset} />
          </article>
        );
      })}
    </div>
  );
  if (run.assets.length === 0) return null;
  return (
    <section aria-label="Run results" className="mt-4">
      {results.length > 0 ? (
        <>
          <h3 className="text-sm font-semibold text-slate-100">Results</h3>
          {gallery(results)}
        </>
      ) : null}
      {intermediates.length > 0 ? (
        <details
          className="mt-3"
          open={intermediatesOpen}
          onToggle={(event) => setIntermediatesOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs text-slate-400">
            Intermediate results ({intermediates.length})
          </summary>
          {intermediatesOpen ? gallery([...intermediates].reverse()) : null}
        </details>
      ) : null}
    </section>
  );
};
