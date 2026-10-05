import type { RalphRunSummaryStatus } from "../ralph.js";

export const isRecoverableRalphRunStatus = (
  status: RalphRunSummaryStatus,
  effectiveStatus: RalphRunSummaryStatus = status,
): boolean =>
  status === "blocked" ||
  status === "crashed" ||
  status === "stopped" ||
  effectiveStatus === "abandoned";
