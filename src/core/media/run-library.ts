import type {
  MediaRunRecord,
  MediaRunPage,
  MediaRuntimeRunRecord,
} from "./contracts.js";
import {
  collectRevisionedMediaPages,
  type RevisionedMediaLibrarySnapshot,
  type RevisionedMediaPageRequest,
} from "./revisioned-library.js";

export type MediaRunLibrarySnapshot =
  RevisionedMediaLibrarySnapshot<MediaRuntimeRunRecord>;

interface CollectMediaRunPagesOptions {
  loadPage: (request: RevisionedMediaPageRequest) => Promise<MediaRunPage>;
  cached: MediaRunLibrarySnapshot | null;
  pageSize?: number;
  maxRestarts?: number;
}

export const collectMediaRunPages = ({
  loadPage,
  cached,
  pageSize = 250,
  maxRestarts = 2,
}: CollectMediaRunPagesOptions): Promise<MediaRunLibrarySnapshot> =>
  collectRevisionedMediaPages({
    libraryLabel: "run history",
    itemLabel: "Run",
    loadPage,
    cached,
    pageSize,
    maxRestarts,
  });

const normalizeSearchValue = (value: string): string =>
  value.toLocaleLowerCase().replaceAll(/[-_:/.]+/g, " ");

export const matchesMediaRunQuery = (
  run: MediaRunRecord,
  query: string,
): boolean => {
  const terms = normalizeSearchValue(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const runtimeRun: MediaRuntimeRunRecord | null =
    "executor" in run ? (run as MediaRuntimeRunRecord) : null;
  const haystack = normalizeSearchValue(
    [
      run.id,
      run.flowId,
      run.flowRevisionId ?? "",
      run.flowName,
      run.planId,
      run.status,
      run.createdAt,
      runtimeRun?.updatedAt ?? "",
      run.prompt,
      run.modelLabel,
      run.target ?? "",
      run.outputCount.toString(),
      run.diagnosticCount.toString(),
      runtimeRun?.currentStep ?? "",
      runtimeRun?.executor ?? "",
      runtimeRun?.error ?? "",
      runtimeRun?.failure?.code ?? "",
      runtimeRun?.failure?.message ?? "",
      runtimeRun?.failure?.technicalDiagnostic ?? "",
    ].join(" "),
  );
  return terms.every((term) => haystack.includes(term));
};

export const mergeMediaRunUpdates = (
  snapshot: readonly MediaRuntimeRunRecord[],
  updates: readonly MediaRuntimeRunRecord[],
): MediaRuntimeRunRecord[] => {
  const updatesById = new Map(updates.map((run) => [run.id, run]));
  const snapshotIds = new Set(snapshot.map((run) => run.id));
  const newlyObserved = updates
    .filter((run) => !snapshotIds.has(run.id))
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  return [
    ...newlyObserved,
    ...snapshot.map((run) => updatesById.get(run.id) ?? run),
  ];
};
