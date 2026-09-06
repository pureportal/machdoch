import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  AgentToolDefinition,
  AgentToolExecutionContext,
} from "./agent-tools-shared.js";
import {
  createToolErrorResult,
  resolveWorkspaceTarget,
} from "./agent-tools-shared.js";
import { createRalphFlowFingerprint } from "./create-ralph-flow-fingerprint.helper.js";
import {
  getRalphFlowPath,
  getRalphRevisionDirectory,
} from "./create-ralph-storage-paths.helper.js";
import { join } from "node:path";

const referenceSchema = {
  type: "string",
  minLength: 1,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$",
};

const workflowTool = (
  name: string,
  description: string,
  effect: "read" | "write",
  properties: Record<string, unknown>,
  required: string[],
  execute: (
    args: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ) => Promise<unknown>,
): AgentToolDefinition => ({
  spec: {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  },
  backingTool: "workflows",
  riskLevel: effect === "read" ? "low" : "high",
  effect,
  execute: async (args, context) => {
    try {
      const flowId =
        typeof args.id === "string"
          ? args.id
          : typeof args.flow === "object" &&
              args.flow !== null &&
              "id" in args.flow &&
              typeof args.flow.id === "string"
            ? args.flow.id
            : undefined;
      const paths = [
        ...["flows", "revisions", "runs", "artifacts"].map((directory) =>
          join(".machdoch", "ralph", directory),
        ),
        ...(flowId
          ? [
              getRalphFlowPath(context.workspaceRoot, flowId),
              getRalphRevisionDirectory(context.workspaceRoot, flowId),
            ]
          : []),
        ...(typeof args.runId === "string"
          ? [join(".machdoch", "ralph", "runs", args.runId)]
          : []),
      ];
      for (const path of paths) {
        if (
          !(await resolveWorkspaceTarget(context.workspaceRoot, path))
            .insideWorkspace
        )
          throw new Error("Workflow storage is outside the active workspace.");
      }
      const output = await execute(args, context);
      return {
        toolResult: {
          callId: "",
          name,
          output: JSON.stringify(output, null, 2),
        },
        sections: [],
        traceLines: [name],
      };
    } catch (error) {
      return createToolErrorResult(
        "",
        name,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});

export const createWorkflowToolDefinitions = (
  config: RuntimeConfig,
): AgentToolDefinition[] => [
  workflowTool(
    "list_workflows",
    "List saved workspace workflows.",
    "read",
    {},
    [],
    async (_args, context) => {
      const { listRalphFlows } = await import("../ralph.js");
      return listRalphFlows(context.workspaceRoot);
    },
  ),
  workflowTool(
    "read_workflow",
    "Read a workspace workflow and its revision fingerprint.",
    "read",
    { id: referenceSchema },
    ["id"],
    async (args, context) => {
      const { readRalphFlow } = await import("../ralph.js");
      const flow = await readRalphFlow(
        context.workspaceRoot,
        args.id as string,
        { allowInvalid: true },
      );
      return { flow, fingerprint: createRalphFlowFingerprint(flow) };
    },
  ),
  workflowTool(
    "validate_workflow",
    "Validate a workflow document before saving or running it.",
    "read",
    { flow: { type: "object" } },
    ["flow"],
    async (args) => {
      const { parseRalphFlowJson, validateRalphFlow } =
        await import("../ralph.js");
      return validateRalphFlow(parseRalphFlowJson(JSON.stringify(args.flow)), {
        config,
      });
    },
  ),
  workflowTool(
    "save_workflow",
    "Save a valid workspace workflow. Use the fingerprint from read_workflow to prevent overwriting concurrent edits.",
    "write",
    {
      flow: { type: "object" },
      expectedFingerprint: { type: "string", minLength: 1 },
    },
    ["flow"],
    async (args, context) => {
      const { parseRalphFlowJson, writeRalphFlow } =
        await import("../ralph.js");
      const flow = parseRalphFlowJson(JSON.stringify(args.flow));
      const path = await writeRalphFlow(context.workspaceRoot, flow, {
        ...(typeof args.expectedFingerprint === "string"
          ? { expectedFingerprint: args.expectedFingerprint }
          : {}),
      });
      return {
        id: flow.id,
        path,
        fingerprint: createRalphFlowFingerprint(flow),
      };
    },
  ),
  workflowTool(
    "delete_workflow",
    "Delete a workspace workflow and its saved revisions.",
    "write",
    {
      id: referenceSchema,
      expectedFingerprint: { type: "string", minLength: 1 },
    },
    ["id", "expectedFingerprint"],
    async (args, context) => {
      const { deleteRalphFlow } = await import("../ralph.js");
      return deleteRalphFlow(context.workspaceRoot, args.id as string, {
        expectedFingerprint: args.expectedFingerprint as string,
      });
    },
  ),
  workflowTool(
    "run_workflow",
    "Run a saved workspace workflow and return its result. Cancelling the call cancels the run.",
    "write",
    {
      id: referenceSchema,
      variables: { type: "object", additionalProperties: { type: "string" } },
      maxTransitions: { type: "integer", minimum: 1 },
    },
    ["id"],
    async (args, context) => {
      const { readRalphFlow, createRalphRunLogger, runRalphFlow } =
        await import("../ralph.js");
      const { discoverCustomizations } = await import("../customizations.js");
      const flow = await readRalphFlow(
        context.workspaceRoot,
        args.id as string,
      );
      const customizations = await discoverCustomizations(
        context.workspaceRoot,
        {
          discoverGithubCustomizations:
            config.compatibility.discoverGithubCustomizations === true,
        },
      );
      const variableValues = (args.variables ?? {}) as Record<string, string>;
      const logger = await createRalphRunLogger(context.workspaceRoot, flow, {
        variableValues,
      });
      try {
        return await runRalphFlow(flow, config, customizations, {
          variableValues,
          logger,
          workspaceBoundary: context.workspaceRoot,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(typeof args.maxTransitions === "number"
            ? { maxTransitions: args.maxTransitions }
            : {}),
        });
      } finally {
        await logger.flush();
      }
    },
  ),
  workflowTool(
    "list_workflow_runs",
    "List recent workspace workflow runs.",
    "read",
    {
      flowId: referenceSchema,
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    [],
    async (args, context) => {
      const { listRalphRunRecords } = await import("../ralph.js");
      return listRalphRunRecords(context.workspaceRoot, {
        ...(typeof args.flowId === "string" ? { flowId: args.flowId } : {}),
        limit: typeof args.limit === "number" ? args.limit : 20,
      });
    },
  ),
  workflowTool(
    "read_workflow_run",
    "Read a workspace workflow run and its current status.",
    "read",
    { runId: referenceSchema },
    ["runId"],
    async (args, context) => {
      const { readRalphRunRecord } = await import("../ralph.js");
      return readRalphRunRecord(context.workspaceRoot, args.runId as string);
    },
  ),
];
