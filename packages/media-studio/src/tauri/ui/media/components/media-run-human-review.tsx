import { Images, MessageSquareText } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type {
  MediaAssetRecord,
  MediaHumanReviewDecisionRequest,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";

export const MediaRunHumanReview = ({
  run,
  onResolveHumanReview,
  humanReviewPending,
}: {
  run: MediaRunDetail;
  onResolveHumanReview: (request: MediaHumanReviewDecisionRequest) => void;
  humanReviewPending: boolean;
}): JSX.Element | null => {
  const pendingReview = run.humanReviews.find(
    (review) => review.status === "pending",
  );
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [decisionId, setDecisionId] = useState(() => crypto.randomUUID());
  const [rejectArmed, setRejectArmed] = useState(false);
  useEffect(() => {
    setSelectedAssetIds([]);
    setComment("");
    setDecisionId(crypto.randomUUID());
    setRejectArmed(false);
  }, [pendingReview?.id, run.id]);
  const reviewAssets = pendingReview
    ? pendingReview.candidateAssetIds
        .map((assetId) => run.assets.find((asset) => asset.id === assetId))
        .filter((asset): asset is MediaAssetRecord => Boolean(asset))
    : [];
  const reviewCommentValid =
    !pendingReview?.requireComment || comment.trim().length > 0;
  const toggleReviewAsset = (assetId: string): void => {
    setRejectArmed(false);
    setSelectedAssetIds((current) => {
      if (current.includes(assetId)) {
        return current.filter((candidate) => candidate !== assetId);
      }
      if (!pendingReview || current.length >= pendingReview.maxSelections) {
        return pendingReview?.maxSelections === 1 ? [assetId] : current;
      }
      return [...current, assetId];
    });
  };
  const submitHumanReview = (action: "approve" | "reject"): void => {
    if (!pendingReview) return;
    onResolveHumanReview({
      reviewId: pendingReview.id,
      decisionId,
      action,
      selectedAssetIds: action === "approve" ? selectedAssetIds : [],
      comment,
    });
  };
  if (run.humanReviews.length === 0) return null;
  return (
    <section
      aria-labelledby="human-review-heading"
      className="mt-5 rounded-lg border border-slate-800 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="human-review-heading"
            className="flex items-center gap-2 text-xs font-semibold text-fuchsia-100"
          >
            <Images className="h-3.5 w-3.5" /> Human review
          </h3>
        </div>
      </div>

      {pendingReview ? (
        <div className="mt-3">
          <div className="rounded-lg border border-fuchsia-300/15 bg-slate-950/35 p-3">
            <p className="text-xs font-medium leading-4 text-fuchsia-50">
              {pendingReview.instructions}
            </p>
            <p className="mt-1.5 text-xs text-slate-400">
              {pendingReview.maxSelections === 1
                ? "Select one candidate."
                : `Select up to ${pendingReview.maxSelections} candidates.`}
            </p>
          </div>

          <div
            className="mt-3 grid grid-cols-2 gap-2"
            aria-label="Review candidates"
          >
            {reviewAssets.map((asset) => {
              const selected = selectedAssetIds.includes(asset.id);
              const atLimit =
                selectedAssetIds.length >= pendingReview.maxSelections;
              return (
                <button
                  key={asset.id}
                  type="button"
                  aria-pressed={selected}
                  aria-label={
                    "Candidate " +
                    (asset.outputIndex + 1) +
                    (selected ? ", selected" : ", not selected")
                  }
                  disabled={
                    humanReviewPending ||
                    (!selected && atLimit && pendingReview.maxSelections > 1)
                  }
                  onClick={() => toggleReviewAsset(asset.id)}
                  className={cn(
                    "group relative overflow-hidden rounded-lg border bg-slate-950/60 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-fuchsia-300/70 disabled:cursor-not-allowed disabled:opacity-45",
                    selected
                      ? "border-fuchsia-300/70 ring-1 ring-fuchsia-300/30"
                      : "border-slate-800 hover:border-fuchsia-300/35",
                  )}
                >
                  <span className="block aspect-square bg-slate-900">
                    <MediaAssetPreview
                      asset={asset}
                      maxEdge={384}
                      className="h-full w-full"
                    />
                  </span>
                  <span className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="text-xs font-medium text-slate-300">
                      Candidate {asset.outputIndex + 1}
                    </span>
                    <span className="font-mono text-xs text-slate-400">
                      {asset.width}×{asset.height}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border text-xs font-bold shadow-lg backdrop-blur",
                      selected
                        ? "border-fuchsia-100/70 bg-fuchsia-300 text-slate-950"
                        : "border-white/25 bg-slate-950/60 text-transparent",
                    )}
                  >
                    ✓
                  </span>
                </button>
              );
            })}
          </div>

          <label className="mt-3 block">
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <MessageSquareText className="h-3 w-3" /> Review note
              {pendingReview.requireComment ? " · required" : " · optional"}
            </span>
            <textarea
              value={comment}
              maxLength={2_000}
              disabled={humanReviewPending}
              onChange={(event) => {
                setComment(event.target.value);
                setRejectArmed(false);
              }}
              placeholder="Record the reason for this decision…"
              className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-700/80 bg-slate-950/65 px-3 py-2 text-xs leading-4 text-slate-200 outline-none placeholder:text-slate-500 focus:border-fuchsia-300/55 focus:ring-2 focus:ring-fuchsia-300/15 disabled:opacity-50"
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              disabled={
                humanReviewPending ||
                selectedAssetIds.length === 0 ||
                !reviewCommentValid
              }
              onClick={() => submitHumanReview("approve")}
              className="h-auto min-h-9 whitespace-normal bg-fuchsia-300 px-2 py-2 text-xs leading-4 text-slate-950 hover:bg-fuchsia-200"
            >
              {humanReviewPending
                ? "Recording…"
                : selectedAssetIds.length > 0
                  ? "Approve " + selectedAssetIds.length
                  : "Approve selection"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={humanReviewPending || !reviewCommentValid}
              onClick={() => {
                if (rejectArmed) {
                  submitHumanReview("reject");
                } else {
                  setRejectArmed(true);
                }
              }}
              className={cn(
                "h-auto min-h-9 whitespace-normal px-2 py-2 text-xs leading-4",
                rejectArmed
                  ? "border-rose-300/50 bg-rose-400/15 text-rose-100 hover:bg-rose-400/20"
                  : "border-slate-700 text-slate-400 hover:bg-slate-800",
              )}
            >
              {rejectArmed ? "Confirm reject all" : "Reject all candidates"}
            </Button>
          </div>
        </div>
      ) : null}

      {run.humanReviews.some(
        (review) =>
          review.status === "approved" || review.status === "rejected",
      ) ? (
        <ol className="mt-3 space-y-2 border-t border-fuchsia-300/10 pt-3">
          {run.humanReviews
            .filter(
              (review) =>
                review.status === "approved" || review.status === "rejected",
            )
            .map((review) => (
              <li
                key={review.id}
                className="rounded-lg bg-slate-950/40 p-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize text-slate-300">
                    Gate {review.sequence} · {review.status}
                  </span>
                  <span className="text-slate-400">
                    {review.selectedAssetIds.length} selected
                  </span>
                </div>
                {review.comment ? (
                  <p className="mt-1.5 whitespace-pre-wrap leading-4 text-slate-500">
                    {review.comment}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-xs text-slate-500">
                  {review.actor ?? "unknown actor"} · {review.decisionId}
                </p>
              </li>
            ))}
        </ol>
      ) : null}
    </section>
  );
};
