import type { MediaRuntimeRunRecord } from "../../../core/media/contracts.js";

type MediaRunActivityRecord = Pick<
  MediaRuntimeRunRecord,
  "executor" | "id" | "status"
>;

const QUEUED_WORKER_EXECUTORS = new Set([
  "deterministic-fixture",
  "mock-remote-provider",
]);

export const isMediaRunActive = (run: MediaRunActivityRecord): boolean =>
  run.status === "running" ||
  run.status === "canceling" ||
  (run.status === "queued" && QUEUED_WORKER_EXECUTORS.has(run.executor));
