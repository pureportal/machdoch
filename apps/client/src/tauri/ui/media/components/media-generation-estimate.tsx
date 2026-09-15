import { useEffect, useState, type JSX } from "react";
import type { MediaRunDetail } from "../../../../core/media/contracts.js";
import {
  formatMediaRemainingTime,
  mediaGenerationTiming,
} from "../media-generation-timing";

export const MediaGenerationEstimate = ({
  run,
}: {
  run: MediaRunDetail;
}): JSX.Element | null => {
  const [now, setNow] = useState(Date.now);
  const active = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const estimate = mediaGenerationTiming.estimate(run, now);
  return (
    <span
      aria-label="Estimated time remaining"
      className="text-xs tabular-nums text-sky-300"
    >
      {estimate
        ? `About ${formatMediaRemainingTime(estimate.remainingMs)} ${estimate.scope === "step" ? "for this step" : run.status === "queued" ? "after start" : "left"}`
        : run.status === "queued"
          ? "Waiting to start"
          : "Estimating time…"}
    </span>
  );
};
