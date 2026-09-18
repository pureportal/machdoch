import type {
  MediaAssetRecord,
  MediaRunDetail,
  MediaRunRecord,
  MediaRuntimeRunRecord,
} from "../../../core/media/contracts.js";

export const isRuntimeRun = (
  run: MediaRunRecord,
): run is MediaRuntimeRunRecord => "executor" in run;

export const canCancelMediaRun = (run: MediaRunDetail): boolean =>
  run.status === "queued" ||
  (!["openai-image-api", "codex-cli-image"].includes(run.executor) &&
    ["running", "waiting-for-review"].includes(run.status));

export const formatRunDateTime = (createdAt: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(createdAt));

export const groupRunsByDate = (
  runs: readonly MediaRunRecord[],
  now = new Date(),
): Array<{ date: string; label: string; runs: MediaRunRecord[] }> => {
  const today = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<
    string,
    { date: string; label: string; runs: MediaRunRecord[] }
  >();
  for (const run of runs) {
    const created = new Date(run.createdAt);
    const date = created.toDateString();
    let group = groups.get(date);
    if (!group) {
      group = {
        date,
        label:
          date === today
            ? "Today"
            : date === yesterday.toDateString()
              ? "Yesterday"
              : new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                }).format(created),
        runs: [],
      };
      groups.set(date, group);
    }
    group.runs.push(run);
  }
  return [...groups.values()];
};

export const selectRunPreview = (
  run: MediaRunRecord,
  assets: readonly MediaAssetRecord[],
): MediaAssetRecord | undefined => {
  const candidates = assets.filter((asset) => asset.kind !== "report");
  if (!isRuntimeRun(run) || run.executor !== "media-workflow")
    return candidates[0];
  return candidates.sort((left, right) => {
    const leftFinal =
      left.operation?.kind === "workflow" &&
      left.operation.details.finalOutput === true;
    const rightFinal =
      right.operation?.kind === "workflow" &&
      right.operation.details.finalOutput === true;
    return (
      Number(rightFinal) - Number(leftFinal) ||
      right.outputIndex - left.outputIndex
    );
  })[0];
};
