import type { ProductCommand, ProductRalph } from "@machdoch/fleet-protocol";
import { loadRalphSnapshot } from "../../core/ralph-snapshot.js";
import {
  createRalphRunLogger,
  readRalphFlow,
  readRalphRunRecord,
  runRalphFlow,
  validateRalphFlow,
  type RalphFlowScope,
} from "../../core/ralph.js";
import { discoverCustomizations } from "../../core/customizations.js";
import type { RuntimeConfig } from "../../core/runtime-contract.generated.js";
import {
  createRalphFlowDiscoveryOptions,
  createResumeRunLogPaths,
} from "./cli-ralph-commands.js";

type RalphCommand = Extract<
  ProductCommand,
  { kind: "ralph-run" | "ralph-resume-run" }
>;

export class FleetRalphRuntime {
  private readonly active = new Map<
    string,
    {
      workspace: string;
      scope: RalphFlowScope;
      runId: string;
      controller: AbortController;
      settled: Promise<unknown>;
    }
  >();
  private readonly errors = new Map<string, string>();

  hasTask(taskId: string): boolean {
    return this.active.has(taskId);
  }
  isWorkspaceBusy(workspace: string): boolean {
    return [...this.active.values()].some((run) => run.workspace === workspace);
  }

  async prepare(
    command: RalphCommand,
    workspace: string,
    config: RuntimeConfig,
    taskId: string,
  ): Promise<() => void> {
    if (this.isWorkspaceBusy(workspace))
      throw new Error("A RALPH run is already active in this workspace.");
    const scope = command.scope;
    const previous =
      command.kind === "ralph-resume-run"
        ? await readRalphRunRecord(workspace, command.runId, { scope })
        : null;
    if (
      previous &&
      (!previous.record.checkpoint ||
        !["crashed", "blocked", "abandoned"].includes(previous.effectiveStatus))
    )
      throw new Error("This RALPH run cannot be recovered.");
    const flow = await readRalphFlow(
      workspace,
      command.kind === "ralph-run" ? command.flowId : previous!.record.flowId,
      { scope },
    );
    const variableValues =
      command.kind === "ralph-run"
        ? command.parameters
        : previous!.record.variableValues;
    const validation = validateRalphFlow(flow, { config, variableValues });
    if (!validation.valid) throw new Error(validation.errors.join("\n"));
    const customizations = await discoverCustomizations(
      workspace,
      createRalphFlowDiscoveryOptions(
        config.compatibility.discoverGithubCustomizations,
        flow,
        scope,
      ),
    );
    const controller = new AbortController();
    return () => {
      this.errors.delete(workspace);
      const settled = (async () => {
        const logger = await createRalphRunLogger(workspace, flow, {
          runId: previous?.record.id ?? taskId,
          variableValues,
          scope,
          ...(previous
            ? {
                paths: createResumeRunLogPaths(previous.path, previous.record),
                append: true,
                deferWritesUntilActivated: true,
              }
            : {}),
        });
        await runRalphFlow(flow, config, customizations, {
          runId: logger.runId,
          logger,
          variableValues,
          signal: controller.signal,
          ...(previous?.record.checkpoint
            ? { checkpoint: previous.record.checkpoint }
            : {}),
          ...(command.maxTransitions !== undefined
            ? { maxTransitions: command.maxTransitions }
            : {}),
        });
      })()
        .catch((error: unknown) => {
          this.errors.set(
            workspace,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => this.active.delete(taskId));
      this.active.set(taskId, {
        workspace,
        scope,
        runId: previous?.record.id ?? taskId,
        controller,
        settled,
      });
    };
  }

  cancel(taskId: string): void {
    this.active.get(taskId)?.controller.abort("RALPH cancelled from Fleet.");
  }

  async shutdown(): Promise<void> {
    for (const run of this.active.values())
      run.controller.abort("Fleet service stopped.");
    await Promise.all([...this.active.values()].map((run) => run.settled));
  }

  async snapshot(workspace: string): Promise<ProductRalph> {
    const { scopes } = await loadRalphSnapshot(workspace);
    const error = this.errors.get(workspace);
    return {
      workspaceRoot: workspace,
      loading: false,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
      flows: scopes
        .flatMap(({ scope, flows }) =>
          flows.map((flow) => ({
            id: flow.id,
            name: flow.name,
            scope,
            blockCount: flow.blockCount,
            edgeCount: flow.edgeCount,
            variables: flow.variables,
            ...(flow.alias ? { alias: flow.alias } : {}),
            ...(flow.description ? { description: flow.description } : {}),
            ...(flow.maxTransitions
              ? { maxTransitions: flow.maxTransitions }
              : {}),
          })),
        )
        .slice(0, 160),
      runs: scopes
        .flatMap(({ scope, runs }) =>
          runs.map((run) => {
            const task = [...this.active.entries()].find(
              ([, active]) =>
                active.workspace === workspace &&
                active.scope === scope &&
                active.runId === run.id,
            );
            return {
              id: run.id,
              flowId: run.flowId,
              flowName: run.flowName,
              scope,
              status: run.status,
              summary: run.summary,
              createdAt: Date.parse(run.createdAt),
              blockCount: run.blockCount,
              eventCount: run.eventCount,
              ...(run.finishedAt
                ? { finishedAt: Date.parse(run.finishedAt) }
                : {}),
              ...(task ? { taskId: task[0] } : {}),
              cancellable: Boolean(task),
              recoverable: !task && run.recoverable,
            };
          }),
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 160),
    };
  }
}
