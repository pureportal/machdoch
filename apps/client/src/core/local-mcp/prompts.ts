import {
  ErrorCode,
  McpError,
  type GetPromptResult,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { callLocalTool, readRecords, readText } from "./tool-values.js";
import type { LocalToolRuntime } from "./runtime.js";

const WORKFLOW_PROMPT_PREFIX = "workflow_";

interface WorkflowPromptSource {
  id: string;
  name: string;
  description?: string;
  variables: { name: string; required: boolean }[];
}

const readWorkflows = (value: unknown): WorkflowPromptSource[] =>
  readRecords(value).flatMap((record) => {
    const id = readText(record, "id");
    if (!id) return [];
    const description = readText(record, "description");
    return [
      {
        id,
        name: readText(record, "name") ?? id,
        ...(description ? { description } : {}),
        variables: readRecords(record.variables).flatMap((variable) => {
          const name = readText(variable, "name");
          return name
            ? [
                {
                  name,
                  required:
                    variable.required === true && variable.default === undefined,
                },
              ]
            : [];
        }),
      },
    ];
  });

export const createLocalMcpPrompts = (runtime: LocalToolRuntime) => {
  const available = new Set(
    runtime.definitions.map((definition) => definition.spec.name),
  );
  const enabled = ["list_workflows", "run_workflow"].every((name) =>
    available.has(name),
  );
  const listWorkflows = async (signal?: AbortSignal) =>
    readWorkflows(await callLocalTool(runtime, "list_workflows", {}, signal));

  return {
    enabled,

    async list(signal?: AbortSignal): Promise<Prompt[]> {
      return (await listWorkflows(signal)).map((workflow) => ({
        name: `${WORKFLOW_PROMPT_PREFIX}${workflow.id}`,
        title: workflow.name,
        description: workflow.description ?? `Run ${workflow.name}.`,
        arguments: workflow.variables,
      }));
    },

    async get(
      name: string,
      args: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<GetPromptResult> {
      const workflow = name.startsWith(WORKFLOW_PROMPT_PREFIX)
        ? (await listWorkflows(signal)).find(
            (entry) =>
              entry.id === name.slice(WORKFLOW_PROMPT_PREFIX.length),
          )
        : undefined;
      if (!workflow)
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
      const missing = workflow.variables
        .filter((variable) => variable.required && !args[variable.name]?.trim())
        .map((variable) => variable.name);
      if (missing.length > 0)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Provide ${missing.join(", ")}.`,
        );
      const variables = Object.fromEntries(
        workflow.variables.flatMap((variable) => {
          const value = args[variable.name];
          return value?.trim() ? [[variable.name, value]] : [];
        }),
      );
      const runArguments = {
        id: workflow.id,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      };
      return {
        description: workflow.description ?? `Run ${workflow.name}.`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Run the saved Machdoch workflow "${workflow.name}" by calling the \`run_workflow\` tool with these arguments:`,
                "```json",
                JSON.stringify(runArguments, null, 2),
                "```",
                "Then report the run status and summary.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  };
};

export type LocalMcpPrompts = ReturnType<typeof createLocalMcpPrompts>;
