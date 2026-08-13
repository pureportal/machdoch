import { createConnection } from "node:net";
import type { AgentToolDefinition } from "./agent-tools-shared.js";

type RunControlAction = "status" | "start" | "stop" | "restart";

interface RunControlResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const readConfigurationId = (
  args: Record<string, unknown>,
): string | undefined => {
  const value = args.configurationId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const sendRunControlRequest = async (
  action: RunControlAction,
  workspaceRoot: string,
  configurationId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  const address = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
  const token = process.env.MACHDOCH_RUN_CONTROL_TOKEN;
  if (!address || !token) {
    throw new Error("Workspace run control is unavailable in this runtime.");
  }
  const separator = address.lastIndexOf(":");
  const host = address.slice(0, separator);
  const port = Number(address.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Workspace run control has an invalid loopback address.");
  }

  return new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Workspace run control was cancelled."));
      return;
    }
    const socket = createConnection({ host, port });
    let responseText = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      callback();
    };
    const abort = (): void =>
      finish(() => reject(new Error("Workspace run control was cancelled.")));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          token,
          action,
          workspaceRoot,
          ...(configurationId ? { configurationId } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      responseText += chunk;
      if (responseText.length > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error("Workspace run response is too large.")));
        return;
      }
      const newline = responseText.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(
          responseText.slice(0, newline),
        ) as RunControlResponse;
        if (!response.ok) {
          finish(() =>
            reject(
              new Error(response.error || "Workspace run control failed."),
            ),
          );
          return;
        }
        finish(() => resolve(response.result));
      } catch (error) {
        finish(() =>
          reject(
            new Error(
              `Workspace run control returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
    socket.on("timeout", () =>
      finish(() => reject(new Error("Workspace run control timed out."))),
    );
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) {
        finish(() =>
          reject(new Error("Workspace run control closed without a response.")),
        );
      }
    });
  });
};

const createResult = (
  name: string,
  result: unknown,
  trace: string,
): Awaited<ReturnType<AgentToolDefinition["execute"]>> => ({
  toolResult: {
    callId: "",
    name,
    output: JSON.stringify(result, null, 2),
  },
  sections: [],
  traceLines: [trace],
});

const lifecycleInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    configurationId: {
      type: "string",
      description:
        "Saved configuration id. Omit it to use the primary configuration.",
    },
  },
} as const;

const lifecycleDefinition = (
  name: "start_workspace_run" | "stop_workspace_run" | "restart_workspace_run",
  action: "start" | "stop" | "restart",
  description: string,
): AgentToolDefinition => ({
  spec: { name, description, inputSchema: lifecycleInputSchema },
  backingTool: "run",
  riskLevel: "medium",
  effect: "write",
  execute: async (args, context) => {
    const configurationId = readConfigurationId(args);
    const result = await sendRunControlRequest(
      action,
      context.workspaceRoot,
      configurationId,
      context.signal,
    );
    return createResult(
      name,
      result,
      `${name} -> ${configurationId ?? "primary"}`,
    );
  },
});

export const createRunToolDefinitions = (): AgentToolDefinition[] => {
  if (
    !process.env.MACHDOCH_RUN_CONTROL_ADDRESS ||
    !process.env.MACHDOCH_RUN_CONTROL_TOKEN
  ) {
    return [];
  }
  return [
    {
      spec: {
        name: "get_workspace_run_status",
        description:
          "Read current workspace run configurations, parent and child lifecycle state, health checks, ports, URLs, restart history, hot-reload support, and recent diagnostics.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "run",
      riskLevel: "low",
      effect: "read",
      execute: async (_args, context) => {
        const result = await sendRunControlRequest(
          "status",
          context.workspaceRoot,
          undefined,
          context.signal,
        );
        return createResult(
          "get_workspace_run_status",
          result,
          "get_workspace_run_status -> workspace",
        );
      },
    },
    lifecycleDefinition(
      "start_workspace_run",
      "start",
      "Start a saved workspace run configuration once. An already active task is reused instead of launched again.",
    ),
    lifecycleDefinition(
      "stop_workspace_run",
      "stop",
      "Stop a saved workspace run configuration and its managed process trees.",
    ),
    lifecycleDefinition(
      "restart_workspace_run",
      "restart",
      "Stop and start a saved workspace run configuration, including tasks that do not support hot reload.",
    ),
  ];
};
