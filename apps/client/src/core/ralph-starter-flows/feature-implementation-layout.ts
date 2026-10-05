import type { RalphFlow } from "../ralph.js";

import { layoutRalphStarterPhases } from "./starter-phase-layout.js";

const phases = [
  {
    id: "feature-planning",
    title: "Plan",
    childBlockIds: [
      "start",
      "detect-project-commands",
      "resolve-checklist-path",
      "checklist-exists",
      "read-checklist",
      "checklist-matches-feature",
      "archive-mismatched-checklist",
      "prepare-feature-brief",
      "research-decision",
      "initial-research",
      "specification-checklist",
    ],
  },
  {
    id: "feature-implementation",
    title: "Implement",
    childBlockIds: [
      "assess-checklist-tasks",
      "select-next-task",
      "git-snapshot-before",
      "baseline-verification",
      "count-implementation-pass",
      "read-selected-checklist",
      "implement-feature",
      "mark-tasks-verifying",
      "git-diff-summary",
      "work-yield-analysis",
    ],
  },
  {
    id: "feature-verification",
    title: "Verify",
    childBlockIds: [
      "verification-decision",
      "run-configured-checks",
      "visual-decision",
      "visual-analysis",
      "validate-progress",
      "mark-tasks-completed",
      "mark-tasks-repairing",
      "mark-tasks-deferred",
      "read-completed-checklist",
      "count-feature-review",
      "verify-complete-feature",
      "validate-feature",
      "repair-feature-gaps",
      "resolve-feature-scope",
      "scope-change-guard",
    ],
  },
  {
    id: "feature-outcomes",
    title: "Record outcome",
    childBlockIds: [
      "record-done-outcome",
      "record-deferred-outcome",
      "record-blocked-outcome",
      "record-invalid-outcome",
      "final-report",
      "retained-checklist-report",
      "outcome-ledger-persisted",
      "archive-feature-checklist",
      "feature-outcome-is-done",
      "record-autonomy-deferral",
      "complete",
      "deferred",
    ],
  },
] as const;

export const layoutFeatureImplementationFlow = (flow: RalphFlow): RalphFlow =>
  layoutRalphStarterPhases(flow, phases);
