import {
  workspaceRequestSchema,
  type WorkspaceRequest,
} from "@machdoch/fleet-protocol/workspace";
import type { OperationResponse } from "@machdoch/fleet-protocol/operation";
import { FleetOperationStore } from "../../core/fleet-operations.js";
import { runWorkspaceLibraryRequest } from "../../core/workspace-library/index.js";
import { runMcpAppRequest } from "../../core/mcp/apps.js";
import { runLiveVoiceRequest } from "../../core/live-voice.js";

export class FleetWorkspaceLibraryRuntime {
  private readonly operations = new FleetOperationStore();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly assertWorkspace: (workspace: string) => Promise<string>,
  ) {}

  request(input: WorkspaceRequest): Promise<OperationResponse> {
    const request = workspaceRequestSchema.parse(input);
    if (this.stopped)
      return Promise.resolve({
        state: "failed",
        error: "Fleet service is stopping.",
      });
    return this.operations.handle(
      request,
      async () => {
        if (
          request.kind !== "invoke" ||
          !(
            request.command === "run_workspace_library_command" ||
            request.command === "run_mcp_app_command" ||
            request.command === "run_live_voice_command"
          )
        )
          throw new Error(
            "This host supports knowledge and research. Other workspace tools require a native client.",
          );
        const global =
          request.command === "run_mcp_app_command" &&
          (request.args.input.action === "settings" ||
            request.args.input.action === "set-enabled");
        const operation = (
          global
            ? Promise.resolve("")
            : this.assertWorkspace(request.args.workspaceRoot)
        ).then((root) =>
          request.command === "run_live_voice_command"
            ? runLiveVoiceRequest(root, request.args.input)
            : request.command === "run_mcp_app_command"
              ? runMcpAppRequest(root, request.args.input)
              : runWorkspaceLibraryRequest(root, request.args.input),
        );
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
}
