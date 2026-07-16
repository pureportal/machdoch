import type {
  EnrollmentCoverageEntry,
  EnrollmentCoverageSummary,
} from "./types.js";

export const summarizeEnrollmentCoverage = (
  entries: readonly EnrollmentCoverageEntry[],
): EnrollmentCoverageSummary => {
  const uncoveredEntityIds = entries
    .filter((entry) => !entry.covered)
    .map((entry) => entry.entityId);
  const routes: EnrollmentCoverageSummary["routes"] = {};

  for (const entry of entries) {
    routes[entry.route] = (routes[entry.route] ?? 0) + 1;
  }

  return {
    total: entries.length,
    covered: entries.length - uncoveredEntityIds.length,
    uncovered: uncoveredEntityIds.length,
    complete: uncoveredEntityIds.length === 0,
    uncoveredEntityIds,
    routes,
  };
};
