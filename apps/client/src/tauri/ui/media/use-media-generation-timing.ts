import { useEffect } from "react";
import type {
  MediaLocalDiffusersRuntimeStatus,
  MediaRunDetail,
  MediaRuntimeRunRecord,
} from "../../../core/media/contracts.js";
import type { MediaGenerationQueueJob } from "./media-generation-queue";
import { getMediaFlow, getMediaRunDetail } from "./media-runtime";
import { mediaGenerationTiming } from "./media-generation-timing";

const loadedRuns = new Set<string>();
const loadingFlows = new Map<string, Promise<void>>();

const loadFlow = async (flowId: string): Promise<void> => {
  const pending = loadingFlows.get(flowId);
  if (pending) return pending;
  const load = getMediaFlow(flowId)
    .then((history) => {
      for (const revision of history.revisions)
        mediaGenerationTiming.registerFlow(revision.revisionId, revision.flow);
    })
    .finally(() => loadingFlows.delete(flowId));
  loadingFlows.set(flowId, load);
  return load;
};

const hardwareKey = (value: {
  device: unknown;
  deviceLabel: unknown;
  deviceMemoryBytes: unknown;
  packages: unknown;
  physicalMemoryBytes?: unknown;
  performance?: unknown;
}): string => {
  const packages = value.packages as Record<string, unknown> | null;
  const performance = value.performance as Record<string, unknown> | null;
  return JSON.stringify([
    value.device,
    value.deviceLabel,
    value.deviceMemoryBytes,
    value.physicalMemoryBytes ?? performance?.physicalMemoryBytes,
    packages?.torch,
    packages?.diffusers,
  ]);
};

const recordedHardware = (run: MediaRunDetail): string | null => {
  const findHardware = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    if (
      "device" in value &&
      "deviceLabel" in value &&
      "deviceMemoryBytes" in value &&
      "packages" in value
    )
      return hardwareKey(value);
    for (const nested of Object.values(value)) {
      const key = findHardware(nested);
      if (key) return key;
    }
    return null;
  };
  return findHardware(run.assets.map((asset) => asset.operation));
};

export const useMediaGenerationTiming = (
  runs: readonly MediaRuntimeRunRecord[],
  jobs: readonly MediaGenerationQueueJob[],
  runtime: MediaLocalDiffusersRuntimeStatus | undefined,
): void => {
  useEffect(() => {
    if (!runtime) return;
    const key = hardwareKey(runtime);
    mediaGenerationTiming.setHardware(key);
    for (const run of runs.filter(
      (entry) => entry.status === "running" || entry.status === "queued",
    )) {
      if (
        run.flowRevisionId &&
        !mediaGenerationTiming.hasFlow(run.flowRevisionId)
      ) {
        void loadFlow(run.flowId).catch((error: unknown) =>
          console.error("Could not read active generation timing", error),
        );
      }
    }
    for (const job of jobs) {
      void (async () => {
        if (!mediaGenerationTiming.hasFlow(job.recipe.flowRevisionId))
          await loadFlow(job.recipe.flowId);
        if (job.runDetail) mediaGenerationTiming.record(job.runDetail, key);
      })().catch((error: unknown) =>
        console.error("Could not read generation timing", error),
      );
    }
    const history = runs
      .filter(
        (run) =>
          run.status === "completed" &&
          run.flowRevisionId &&
          !loadedRuns.has(run.id),
      )
      .slice(0, 30);
    void (async () => {
      for (const run of history) {
        if (loadedRuns.has(run.id)) continue;
        loadedRuns.add(run.id);
        try {
          const detail = await getMediaRunDetail(run.id);
          const measuredHardware = recordedHardware(detail);
          if (detail.target === "local" && !measuredHardware) continue;
          if (!mediaGenerationTiming.hasFlow(run.flowRevisionId!))
            await loadFlow(run.flowId);
          mediaGenerationTiming.record(detail, measuredHardware ?? key);
        } catch (error: unknown) {
          console.error("Could not read historical generation timing", error);
        }
      }
    })();
  }, [runs, jobs, runtime]);
};
