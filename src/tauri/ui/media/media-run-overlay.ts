import type {
  MediaCompiledPlan,
  MediaFlow,
  MediaHumanReviewRecord,
  MediaRunDetail,
  MediaRunEvent,
} from "../../../core/media/contracts.js";

export type MediaRunOverlayNodeState =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | "retrying"
  | "completed"
  | "cached"
  | "skipped"
  | "failed"
  | "blocked"
  | "rejected"
  | "canceled"
  | "not-reached"
  | "not-observed";

export interface MediaRunOverlayNodeObservation {
  nodeId: string;
  state: MediaRunOverlayNodeState;
  label: string;
  detail: string;
  stepCount: number;
  observedEventCount: number;
}

export interface MediaRunOverlayProjection {
  runId: string;
  exactFlowMatch: boolean;
  flowIdentityMatches: boolean;
  fingerprintMatches: boolean;
  matchedNodeCount: number;
  missingSnapshotNodeCount: number;
  currentOnlyNodeCount: number;
  activeNodeIds: readonly string[];
  observations: ReadonlyMap<string, MediaRunOverlayNodeObservation>;
  stateCounts: ReadonlyMap<MediaRunOverlayNodeState, number>;
}

const STATE_LABELS: Record<MediaRunOverlayNodeState, string> = {
  pending: "Pending",
  queued: "Queued",
  running: "Running",
  waiting: "Awaiting review",
  retrying: "Retrying",
  completed: "Completed",
  cached: "Cached",
  skipped: "Skipped",
  failed: "Failed",
  blocked: "Blocked",
  rejected: "Rejected",
  canceled: "Canceled",
  "not-reached": "Not reached",
  "not-observed": "No node event",
};

const readEventState = (
  event: MediaRunEvent | undefined,
): MediaRunOverlayNodeState | null => {
  if (!event) return null;
  switch (event.kind) {
    case "run_failed":
    case "provider_failed":
      return "failed";
    case "human_review_requested":
    case "provider_review_required":
      return "waiting";
    case "human_review_rejected":
      return "rejected";
    case "human_review_approved":
    case "asset_published":
    case "run_completed":
      return "completed";
    case "run_canceled":
    case "cancel_requested":
    case "provider_cancel_requested":
      return "canceled";
    case "run_started":
    case "provider_submission_started":
    case "provider_accepted":
    case "provider_reconciled":
    case "provider_output_pending":
    case "provider_download_started":
      return "running";
    default:
      return null;
  }
};

const readReviewState = (
  review: MediaHumanReviewRecord | undefined,
  run: MediaRunDetail,
): MediaRunOverlayNodeState | null => {
  if (!review) return null;
  if (review.status === "approved") return "completed";
  if (review.status === "rejected") return "rejected";
  if (review.status === "queued") return "not-reached";
  if (run.status === "waiting-for-review") return "waiting";
  if (run.status === "canceled") return "canceled";
  return "not-observed";
};

const readBoundaryState = ({
  nodeFirstStep,
  nodeLastStep,
  boundaryStep,
  boundaryState,
}: {
  nodeFirstStep: number | null;
  nodeLastStep: number | null;
  boundaryStep: number;
  boundaryState: MediaRunOverlayNodeState;
}): MediaRunOverlayNodeState => {
  if (nodeFirstStep === null || nodeLastStep === null) return "not-observed";
  if (nodeLastStep < boundaryStep) return "completed";
  if (nodeFirstStep > boundaryStep) return "not-reached";
  return boundaryState;
};

const describeObservation = ({
  state,
  stepCount,
  observedEventCount,
}: Pick<
  MediaRunOverlayNodeObservation,
  "state" | "stepCount" | "observedEventCount"
>): string => {
  const stepLabel = `${stepCount} compiled step${stepCount === 1 ? "" : "s"}`;
  switch (state) {
    case "completed":
      return `${stepLabel} reached a terminal successful outcome.`;
    case "cached":
      return `${stepLabel} reused a verified cached result.`;
    case "skipped":
      return `${stepLabel} was intentionally skipped by the runtime.`;
    case "waiting":
      return "Execution is durably paused at this review gate.";
    case "failed":
      return "The structured failure context identifies this node.";
    case "blocked":
      return "Execution is durably blocked at this node and needs an external decision.";
    case "rejected":
      return "A durable human decision rejected this gate's candidates.";
    case "canceled":
      return "Execution was canceled while this node was the known boundary.";
    case "queued":
      return `${stepLabel} is part of the queued immutable plan.`;
    case "pending":
      return `${stepLabel} is waiting for its dependencies.`;
    case "not-reached":
      return "A prior terminal boundary prevented this node from running.";
    case "running":
      return `${observedEventCount} node-scoped runtime event${observedEventCount === 1 ? "" : "s"} observed.`;
    case "retrying":
      return "The node is durably queued to retry after a prior attempt.";
    case "not-observed":
      return stepCount === 0
        ? "Intent-only node; the plan has no separate runtime step."
        : "The runtime has not emitted node-scoped evidence for this step yet.";
  }
};

export const projectMediaRunOverlay = ({
  flow,
  plan,
  run,
}: {
  flow: MediaFlow;
  plan: MediaCompiledPlan;
  run: MediaRunDetail;
}): MediaRunOverlayProjection | null => {
  const snapshot = run.planSnapshot;
  if (!snapshot) return null;

  const currentNodeIds = new Set(flow.nodes.map((node) => node.id));
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const matchedNodeCount = snapshot.nodes.filter((node) =>
    currentNodeIds.has(node.id),
  ).length;
  const missingSnapshotNodeCount = snapshot.nodes.length - matchedNodeCount;
  const currentOnlyNodeCount = flow.nodes.filter(
    (node) => !snapshotNodeIds.has(node.id),
  ).length;
  const flowIdentityMatches = snapshot.flowId === flow.id;
  const fingerprintMatches = snapshot.flowFingerprint === plan.flowFingerprint;

  const stepIndicesByNode = new Map<string, number[]>();
  snapshot.steps.forEach((step, index) => {
    const indices = stepIndicesByNode.get(step.sourceNodeId) ?? [];
    indices.push(index);
    stepIndicesByNode.set(step.sourceNodeId, indices);
  });
  const stepSourceById = new Map(
    snapshot.steps.map((step) => [step.id, step.sourceNodeId] as const),
  );
  const eventsByNode = new Map<string, MediaRunEvent[]>();
  run.events.forEach((event) => {
    const nodeId = event.nodeId ?? (event.stepId
      ? snapshotNodeIds.has(event.stepId)
        ? event.stepId
        : stepSourceById.get(event.stepId)
      : undefined);
    if (!nodeId) return;
    const events = eventsByNode.get(nodeId) ?? [];
    events.push(event);
    eventsByNode.set(nodeId, events);
  });
  const reviewsByNode = new Map(
    run.humanReviews.map((review) => [review.nodeId, review] as const),
  );
  const pendingReview = run.humanReviews.find(
    (review) => review.status === "pending",
  );
  const rejectedReview = [...run.humanReviews]
    .reverse()
    .find((review) => review.status === "rejected");
  const failureNodeId = run.failure?.context.nodeId ?? null;
  const boundaryNodeId =
    rejectedReview?.nodeId ?? pendingReview?.nodeId ?? failureNodeId;
  const boundaryIndices = boundaryNodeId
    ? stepIndicesByNode.get(boundaryNodeId) ?? []
    : [];
  const boundaryStep = boundaryIndices.at(-1) ?? null;
  const boundaryState: MediaRunOverlayNodeState | null = rejectedReview
    ? "rejected"
    : pendingReview
      ? run.status === "canceled"
        ? "canceled"
        : "waiting"
      : failureNodeId
        ? "failed"
        : null;
  const nodeExecutionsByNode = new Map(
    (run.nodeExecutions ?? []).map((execution) => [execution.nodeId, execution] as const),
  );
  const hasDurableNodeExecutions = nodeExecutionsByNode.size > 0;

  const observations = new Map<string, MediaRunOverlayNodeObservation>();
  snapshot.nodes.forEach((node) => {
    const stepIndices = stepIndicesByNode.get(node.id) ?? [];
    const nodeEvents = eventsByNode.get(node.id) ?? [];
    const nodeExecution = nodeExecutionsByNode.get(node.id);
    const reviewState = readReviewState(reviewsByNode.get(node.id), run);
    const latestEventState = readEventState(nodeEvents.at(-1));
    const nodeFirstStep = stepIndices.at(0) ?? null;
    const nodeLastStep = stepIndices.at(-1) ?? null;
    let state: MediaRunOverlayNodeState;

    if (nodeExecution) {
      switch (nodeExecution.status) {
        case "waiting-for-review":
          state = "waiting";
          break;
        case "pending":
          state = matchesTerminalRun(run.status) ? "not-reached" : "pending";
          break;
        default:
          state = nodeExecution.status;
      }
      if (reviewState === "rejected") state = "rejected";
    } else if (hasDurableNodeExecutions) {
      state = "not-observed";
    } else if (run.status === "completed" && stepIndices.length > 0) {
      state = "completed";
    } else if (boundaryStep !== null && boundaryState) {
      state = readBoundaryState({
        nodeFirstStep,
        nodeLastStep,
        boundaryStep,
        boundaryState,
      });
      if (reviewState === "completed") state = "completed";
      if (reviewState === "rejected") state = "rejected";
      if (reviewState === "canceled") state = "canceled";
    } else if (reviewState) {
      state = reviewState;
    } else if (latestEventState) {
      state = latestEventState;
    } else if (run.status === "queued" && stepIndices.length > 0) {
      state = "queued";
    } else {
      state = "not-observed";
    }

    const observation: MediaRunOverlayNodeObservation = {
      nodeId: node.id,
      state,
      label: STATE_LABELS[state],
      detail: "",
      stepCount: stepIndices.length,
      observedEventCount: nodeEvents.length,
    };
    observation.detail = nodeExecution?.message ?? describeObservation(observation);
    observations.set(node.id, observation);
  });

  const stateCounts = new Map<MediaRunOverlayNodeState, number>();
  observations.forEach((observation) => {
    stateCounts.set(
      observation.state,
      (stateCounts.get(observation.state) ?? 0) + 1,
    );
  });

  return {
    runId: run.id,
    exactFlowMatch:
      flowIdentityMatches &&
      fingerprintMatches &&
      missingSnapshotNodeCount === 0 &&
      currentOnlyNodeCount === 0,
    flowIdentityMatches,
    fingerprintMatches,
    matchedNodeCount,
    missingSnapshotNodeCount,
    currentOnlyNodeCount,
    activeNodeIds: Array.from(observations.values())
      .filter((observation) =>
        ["running", "retrying", "waiting", "blocked"].includes(observation.state),
      )
      .map((observation) => observation.nodeId),
    observations,
    stateCounts,
  };
};

const matchesTerminalRun = (status: MediaRunDetail["status"]): boolean =>
  status === "completed" || status === "failed" || status === "canceled";
