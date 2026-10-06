import {
  instructionRequestSchema,
  instructionActions,
  instructionReferencedWorkspaces,
  type InstructionRequest,
} from "@machdoch/fleet-protocol/instructions";
import type { OperationResponse } from "@machdoch/fleet-protocol/operation";
import { FleetOperationStore } from "../../core/fleet-operations.js";
import { parseCliArgs } from "./cli-args.js";
import { printInstructionSummary } from "./cli-instruction-commands.js";

export class FleetInstructionRuntime {
  private readonly operations = new FleetOperationStore();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly assertWorkspace: (workspace: string) => Promise<string>,
    private readonly hostWorkspace: () => string,
  ) {}

  request(input: InstructionRequest): Promise<OperationResponse> {
    const request = instructionRequestSchema.parse(input);
    if (this.stopped)
      return Promise.resolve({
        state: "failed",
        error: "Fleet service is stopping.",
      });
    return this.operations.handle(
      request,
      async () => {
        if (request.kind !== "invoke")
          throw new Error("Expected instruction operation.");
        const operation = this.execute(request);
        this.pending.add(operation);
        try {
          return await operation;
        } finally {
          this.pending.delete(operation);
        }
      },
      true,
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.pending);
  }

  private async execute(
    request: Extract<InstructionRequest, { kind: "invoke" }>,
  ): Promise<unknown> {
    const { arguments: argumentsList, workspaceRoot } = request.args.request;
    const workspace = workspaceRoot
      ? await this.assertWorkspace(workspaceRoot)
      : this.hostWorkspace();
    if (this.stopped) throw new Error("Fleet service is stopping.");
    for (const root of instructionReferencedWorkspaces(argumentsList))
      await this.assertWorkspace(root);
    if (argumentsList[0] === "workspaces" && argumentsList[1] === "relink") {
      const pathIndex = argumentsList.indexOf("--path");
      if (pathIndex < 0)
        throw new Error("Workspace relinking requires a root.");
    }
    const action =
      instructionActions[
        `${argumentsList[0]}.${argumentsList[1]}` as keyof typeof instructionActions
      ];
    const valueFlags: readonly string[] = action.values;
    const cliArguments: string[] = argumentsList.slice(0, 2);
    for (let index = 2; index < argumentsList.length; index += 1) {
      const argument = argumentsList[index]!;
      cliArguments.push(
        valueFlags.includes(argument)
          ? `${argument}=${argumentsList[++index]!}`
          : argument,
      );
    }
    const parsed = parseCliArgs([
      "--json",
      "--cwd",
      workspace,
      "instructions",
      ...cliArguments,
    ]);
    let result: unknown;
    await printInstructionSummary(parsed, (value) => {
      result = value;
    });
    if (result === undefined)
      throw new Error("Instructions returned no result.");
    return result;
  }
}
