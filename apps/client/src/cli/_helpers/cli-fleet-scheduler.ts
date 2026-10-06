import {
  schedulerRequestSchema,
  type SchedulerRequest,
  type OperationResponse,
} from "@machdoch/fleet-protocol";
import { FleetOperationStore } from "../../core/fleet-operations.js";
import { listRalphFlows } from "../../core/ralph.js";
import { runSchedulerFleetService } from "../../core/scheduler-fleet-service.js";
import { parseCliArgs } from "./cli-args.js";
import { writeStderrLine } from "./cli-io.js";
import {
  createSchedulerExecutor,
  printSchedulerSummary,
} from "./cli-scheduler-commands.js";

export class FleetSchedulerRuntime {
  private readonly operations = new FleetOperationStore();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly controller = new AbortController();
  private service: Promise<unknown> | undefined;
  private servicesStarted = false;

  constructor(
    private readonly assertWorkspace: (workspace: string) => Promise<string>,
    private readonly listWorkspaces: () => Promise<readonly string[]>,
  ) {}

  start(): void {
    if (this.stopped) throw new Error("Fleet service is stopping.");
    this.servicesStarted = true;
    this.startService();
  }

  async request(input: SchedulerRequest): Promise<OperationResponse> {
    const request = schedulerRequestSchema.parse(input);
    if (this.stopped)
      return { state: "failed", error: "Fleet service is stopping." };
    return this.operations.handle(
      request,
      async () => {
        if (request.kind !== "invoke")
          throw new Error("Expected Scheduler operation.");
        const operation = this.execute(request);
        this.pending.add(operation);
        try {
          return await operation;
        } finally {
          this.pending.delete(operation);
        }
      },
      request.kind === "invoke" &&
        (request.command === "run_ralph_command" ||
          !["trigger", "retry", "run-due"].includes(
            request.args.request.arguments[0]!,
          )),
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.controller.abort("Fleet service stopped.");
    await Promise.allSettled([
      ...this.pending,
      ...(this.service ? [this.service] : []),
    ]);
  }

  private startService(): void {
    if (this.stopped || this.service) return;
    this.service = runSchedulerFleetService({
      workspaceRoots: this.listWorkspaces,
      executor: createSchedulerExecutor(),
      signal: this.controller.signal,
      onError: (error, workspace, phase) => {
        if (!this.stopped)
          writeStderrLine(
            `Scheduler ${phase} failed for ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
          );
      },
    })
      .catch((error: unknown) => {
        if (!this.stopped)
          writeStderrLine(
            `Scheduler service failed: ${error instanceof Error ? error.message : String(error)}`,
          );
      })
      .finally(() => {
        this.service = undefined;
      });
  }

  private async execute(
    request: Extract<SchedulerRequest, { kind: "invoke" }>,
  ): Promise<unknown> {
    const workspace = await this.assertWorkspace(
      request.args.request.workspaceRoot,
    );
    if (this.stopped) throw new Error("Fleet service is stopping.");
    if (this.servicesStarted) {
      this.startService();
    }
    if (request.command === "run_ralph_command") {
      const scope = request.args.request.arguments[2];
      return { flows: await listRalphFlows(workspace, { scope }) };
    }
    const argumentsList = [...request.args.request.arguments];
    if (
      [
        "create",
        "pause",
        "resume",
        "delete",
        "trigger",
        "retry",
        "cancel",
      ].includes(argumentsList[0]!) &&
      !argumentsList.includes("--request-id")
    )
      argumentsList.push("--request-id", request.id);
    const parsed = parseCliArgs([
      "--json",
      "--cwd",
      workspace,
      "scheduler",
      ...argumentsList,
    ]);
    let result: unknown;
    await printSchedulerSummary(
      parsed,
      (value) => {
        result = value;
      },
      this.controller.signal,
    );
    if (result === undefined) throw new Error("Scheduler returned no result.");
    return result;
  }
}
