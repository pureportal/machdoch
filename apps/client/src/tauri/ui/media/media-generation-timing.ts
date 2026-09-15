import type {
  MediaFlow,
  MediaFlowNode,
  MediaRunDetail,
} from "../../../core/media/contracts.js";

const VARIABLE_INPUTS = new Set([
  "prompt",
  "negativePrompt",
  "seed",
  "assetId",
  "sourceAssetId",
  "baseImageAssetId",
  "poseImageAssetId",
  "referenceAssetId",
  "label",
  "description",
]);

const timingConfig = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(timingConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => entry != null && key !== "seed")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [
        key,
        VARIABLE_INPUTS.has(key)
          ? Boolean(entry)
          : key === "editMask"
            ? Boolean(entry)
            : timingConfig(entry),
      ]),
  );
};

const nodeKey = (node: MediaFlowNode, flow: MediaFlow): string =>
  JSON.stringify([
    node.type,
    timingConfig(node.config),
    flow.edges
      .filter((edge) => edge.toNodeId === node.id && edge.toPortId !== "seed")
      .map((edge) => edge.toPortId)
      .sort(),
  ]);

const measuredNodes = (flow: MediaFlow): MediaFlowNode[] =>
  flow.nodes.filter(
    (node) =>
      !node.type.startsWith("source.") && !node.type.startsWith("output."),
  );

interface TimingSample {
  runId: string;
  key: string;
  duration: number;
  at: number;
}

const runStartedAt = (run: MediaRunDetail): number =>
  Date.parse(
    run.events.find((event) => event.kind === "run_started")?.createdAt ??
      run.createdAt,
  );

export interface MediaTimeEstimate {
  remainingMs: number;
  scope: "run" | "step";
}

export class MediaGenerationTiming {
  private readonly flows = new Map<string, MediaFlow>();
  private samples: TimingSample[] = [];
  private hardware = "";

  setHardware(key: string): void {
    this.hardware = key;
  }

  registerFlow(revisionId: string, flow: MediaFlow): void {
    this.flows.set(revisionId, flow);
  }

  hasFlow(revisionId: string): boolean {
    return this.flows.has(revisionId);
  }

  record(run: MediaRunDetail, hardware: string): void {
    if (
      run.status !== "completed" ||
      !run.flowRevisionId ||
      this.samples.some((sample) => sample.runId === run.id)
    )
      return;
    if (run.events.some((event) => /review/i.test(event.kind))) return;
    const flow = this.flows.get(run.flowRevisionId);
    if (!flow) return;
    const at = Date.parse(
      run.events.filter((event) => event.kind === "run_completed").at(-1)
        ?.createdAt ?? run.updatedAt,
    );
    const duration = at - runStartedAt(run);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const key = this.flowKey(flow, hardware);
    this.samples.push({ runId: run.id, key, duration, at });
    for (const execution of run.nodeExecutions) {
      if (
        execution.status !== "completed" ||
        !execution.startedAt ||
        !execution.finishedAt ||
        execution.attempt !== 1
      )
        continue;
      const node = flow.nodes.find(
        (candidate) => candidate.id === execution.nodeId,
      );
      const elapsed =
        Date.parse(execution.finishedAt) - Date.parse(execution.startedAt);
      if (!node || !Number.isFinite(elapsed) || elapsed <= 0) continue;
      this.samples.push({
        runId: run.id,
        key: hardware + nodeKey(node, flow),
        duration: elapsed,
        at,
      });
    }
    this.samples = this.samples.sort((a, b) => a.at - b.at).slice(-600);
  }

  estimate(run: MediaRunDetail, now: number): MediaTimeEstimate | null {
    if (!["queued", "running"].includes(run.status)) return null;
    const flow = run.flowRevisionId
      ? this.flows.get(run.flowRevisionId)
      : undefined;
    const elapsed = Math.max(0, now - runStartedAt(run));
    const total = flow ? this.average(this.flowKey(flow, this.hardware)) : null;
    const sampling = this.samplingEstimate(run, now);
    if (total !== null && (run.status === "queued" || total > elapsed)) {
      return {
        remainingMs: Math.max(
          run.status === "queued" ? total : total - elapsed,
          sampling ?? 0,
        ),
        scope: "run",
      };
    }
    if (flow) {
      const remaining = measuredNodes(flow).flatMap((node) => {
        const execution = run.nodeExecutions.find(
          (entry) => entry.nodeId === node.id,
        );
        if (
          execution?.status === "completed" ||
          execution?.status === "cached" ||
          execution?.status === "skipped"
        )
          return [];
        const average = this.average(this.hardware + nodeKey(node, flow));
        const spent = execution?.startedAt
          ? Math.max(0, now - Date.parse(execution.startedAt))
          : 0;
        return [average === null || average <= spent ? null : average - spent];
      });
      if (remaining.length && remaining.every((value) => value !== null)) {
        return {
          remainingMs: Math.max(
            remaining.reduce<number>((sum, value) => sum + (value ?? 0), 0),
            sampling ?? 0,
          ),
          scope: "run",
        };
      }
    }
    return sampling === null ? null : { remainingMs: sampling, scope: "step" };
  }

  private flowKey(flow: MediaFlow, hardware: string): string {
    return (
      hardware +
      JSON.stringify([
        measuredNodes(flow).map((node) => nodeKey(node, flow)),
        flow.edges
          .filter((edge) => edge.toPortId !== "seed")
          .map((edge) => [
            edge.fromNodeId,
            edge.fromPortId,
            edge.toNodeId,
            edge.toPortId,
          ]),
      ])
    );
  }

  private average(key: string): number | null {
    const samples = this.samples
      .filter((sample) => sample.key === key)
      .slice(-12);
    if (!samples.length) return null;
    const durations = samples
      .map((sample) => sample.duration)
      .sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)]!;
    const recent = samples.filter(
      (sample) =>
        sample.duration >= median / 3 && sample.duration <= median * 3,
    );
    const weights = recent.map((_, index) => index + 1);
    return (
      recent.reduce(
        (sum, sample, index) => sum + sample.duration * weights[index]!,
        0,
      ) / weights.reduce((sum, weight) => sum + weight, 0)
    );
  }

  private samplingEstimate(run: MediaRunDetail, now: number): number | null {
    const current = /Sampling (\d+)\/(\d+)/i.exec(run.currentStep);
    if (!current) return null;
    const points: { step: number; total: number; at: number }[] = [];
    for (const event of run.events) {
      const match = /Sampling (\d+)\/(\d+)/i.exec(event.message);
      if (!match) {
        if (points.length) points.length = 0;
        continue;
      }
      const step = Number(match[1]);
      const total = Number(match[2]);
      const previous = points.at(-1);
      if (previous && (step < previous.step || total !== previous.total))
        points.length = 0;
      if (points.at(-1)?.step !== step)
        points.push({ step, total, at: Date.parse(event.createdAt) });
    }
    const latest = points.at(-1);
    const first = points.slice(-6)[0];
    if (
      !latest ||
      !first ||
      latest.step <= first.step ||
      latest.step >= latest.total ||
      latest.total !== Number(current[2]) ||
      latest.step !== Number(current[1])
    )
      return null;
    const perStep = (latest.at - first.at) / (latest.step - first.step);
    if (!Number.isFinite(perStep) || perStep <= 0) return null;
    const sinceLast = Math.max(0, now - latest.at);
    if (sinceLast > perStep * 3) return null;
    return Math.max(
      perStep,
      (latest.total - latest.step) * perStep - sinceLast,
    );
  }
}

export const mediaGenerationTiming = new MediaGenerationTiming();

export const formatMediaRemainingTime = (milliseconds: number): string => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
};
