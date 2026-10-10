import { z } from "zod";
import { sessionDataCommands } from "@machdoch/fleet-protocol/session-data-commands";
import { resetTaskTimeoutCommandSchema } from "@machdoch/fleet-protocol/task-thinking";
import { hasUnpairedUtf16Surrogate } from "@machdoch/fleet-protocol/unicode";
import {
  operationReadSchema,
  operationReleaseSchema,
  operationResponseSchema,
} from "@machdoch/fleet-protocol/operation";

export const workspaceToolsCapability = "workspace-tools.v1";
export const maximumWorkspaceFileBytes = 1024 * 1024;
export const maximumWorkspaceRequestBodyBytes = 3_000_000;

export function encodeWorkspaceFileContent(content: string): string {
  if (hasUnpairedUtf16Surrogate(content))
    throw new Error("The file contains invalid Unicode.");
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > maximumWorkspaceFileBytes)
    throw new Error("The file exceeds the 1 MiB editing limit.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary);
}

const fileContent = z
  .string()
  .max(Math.ceil(maximumWorkspaceFileBytes / 3) * 4)
  .refine((value) => {
    try {
      const binary = atob(value);
      if (binary.length > maximumWorkspaceFileBytes || btoa(binary) !== value)
        return false;
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      );
      return true;
    } catch {
      return false;
    }
  });

const root = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\0"));
const path = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/^(?:[\\/]|[a-z]:)/iu.test(value) &&
      !value.split(/[\\/]/u).includes(".."),
  );
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\\/]/u.test(value) &&
      value !== "." &&
      value !== "..",
  );
const repository = { workspaceRoot: root, repositoryRoot: root };
const mcpServer = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("-") && !value.includes("\0"));
const mcpArguments = z.union([
  z.tuple([z.literal("servers")]),
  z.tuple([z.literal("servers"), z.literal("--include-disabled")]),
  z.tuple([z.literal("cache")]),
  z.tuple([
    z.enum(["discover", "refresh", "oauth-start", "oauth-authorize"]),
    mcpServer,
  ]),
  z.tuple([
    z.literal("oauth-finish"),
    mcpServer,
    z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine((value) => !value.includes("\0")),
  ]),
]);
const action = z.discriminatedUnion("action", [
  z.strictObject({ ...repository, action: z.literal("fetch") }),
  z.strictObject({ ...repository, action: z.literal("pull") }),
  z.strictObject({
    ...repository,
    action: z.literal("checkout"),
    branchName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    ...repository,
    action: z.literal("checkout-remote"),
    branchName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    ...repository,
    action: z.literal("create-branch"),
    branchName: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    ...repository,
    action: z.literal("add-remote"),
    remoteName: z.string().trim().min(1).max(240),
    remoteUrl: z.string().trim().min(1).max(2048),
  }),
  z.strictObject({
    ...repository,
    action: z.literal("remove-remote"),
    remoteName: z.string().trim().min(1).max(240),
  }),
]);
const command = <T extends string, S extends z.ZodType>(value: T, args: S) =>
  z.strictObject({
    kind: z.literal("invoke"),
    id: z.string().uuid(),
    command: z.literal(value),
    args,
  });

export const workspaceRequestSchema = z.union([
  operationReadSchema,
  operationReleaseSchema,
  z.discriminatedUnion("command", [
    command(
      "get_session_file_change_files",
      sessionDataCommands.get_session_file_change_files,
    ),
    command(
      "get_session_file_change_hunks",
      sessionDataCommands.get_session_file_change_hunks,
    ),
    command("get_session_export", sessionDataCommands.get_session_export),
    command("reset_desktop_task_timeout", resetTaskTimeoutCommandSchema),
    command(
      "get_session_composer_text",
      sessionDataCommands.get_session_composer_text,
    ),
    command("import_session_export", sessionDataCommands.import_session_export),
    command("get_session_index", sessionDataCommands.get_session_index),
    command(
      "get_session_message_page",
      sessionDataCommands.get_session_message_page,
    ),
    command(
      "get_context_pack_documents",
      z.strictObject({ sessionId: z.string().trim().min(1).max(240) }),
    ),
    command(
      "import_context_attachment",
      z.strictObject({
        path: root,
        name: z
          .string()
          .min(1)
          .max(200)
          .refine(
            (value) =>
              !value.startsWith(".") &&
              !/[\\/:]/u.test(value) &&
              [...value].every(
                (character) =>
                  character.charCodeAt(0) >= 32 &&
                  character.charCodeAt(0) !== 127,
              ),
          ),
      }),
    ),
    command(
      "read_context_attachment_preview",
      z.strictObject({
        path: root,
        sessionId: z.string().trim().min(1).max(240),
        messageId: z.string().trim().min(1).max(240).optional(),
      }),
    ),
    command("get_runtime_snapshot", z.strictObject({ workspaceRoot: root })),
    command(
      "stop_all_workspace_terminals",
      z.strictObject({ workspaceRoot: root }),
    ),
    ...(
      [
        "get_workspace_run_configuration_document",
        "get_workspace_run_snapshot",
      ] as const
    ).map((value) => command(value, z.strictObject({ workspaceRoot: root }))),
    command(
      "save_workspace_run_configuration_document",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          documentBase64: fileContent,
        }),
      }),
    ),
    command(
      "precheck_workspace_run_configuration_json",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          documentBase64: fileContent,
        }),
      }),
    ),
    ...(
      [
        "start_workspace_run_configuration",
        "stop_workspace_run_configuration",
        "restart_workspace_run_configuration",
      ] as const
    ).map((value) =>
      command(
        value,
        z.strictObject({
          request: z.strictObject({
            workspaceRoot: root,
            configurationId: z
              .string()
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
              .optional(),
          }),
        }),
      ),
    ),
    command(
      "run_mcp_command",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          arguments: mcpArguments,
        }),
      }),
    ),
    command(
      "run_provider_sync_command",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          arguments: z.tuple([
            z.enum([
              "status",
              "refresh",
              "enable",
              "disable",
              "doctor",
              "plan",
            ]),
          ]),
        }),
      }),
    ),
    command("get_user_memory_settings", z.strictObject({})),
    ...(
      [
        "get_workspace_memory_entries",
        "get_workspace_reasoning_bank_lessons",
        "get_workspace_mcp_config_document",
      ] as const
    ).map((value) => command(value, z.strictObject({ workspaceRoot: root }))),
    command(
      "forget_workspace_memory",
      z.strictObject({ workspaceRoot: root, id: z.string().min(1).max(240) }),
    ),
    command(
      "save_workspace_default_mode",
      z.strictObject({
        workspaceRoot: root,
        mode: z.enum(["ask", "machdoch"]),
      }),
    ),
    ...(
      [
        "save_workspace_memory_override",
        "save_workspace_adaptive_controller_override",
      ] as const
    ).map((value) =>
      command(
        value,
        z.strictObject({
          workspaceRoot: root,
          enabled: z.boolean().nullable(),
        }),
      ),
    ),
    command(
      "save_workspace_reasoning_bank_enabled",
      z.strictObject({ workspaceRoot: root, enabled: z.boolean() }),
    ),
    command(
      "save_workspace_auto_gitignore",
      z.strictObject({ workspaceRoot: root, enabled: z.boolean() }),
    ),
    command(
      "save_workspace_reasoning_mode",
      z.strictObject({
        workspaceRoot: root,
        reasoning: z.enum([
          "default",
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
          "aeon",
        ]),
      }),
    ),
    command(
      "save_workspace_reasoning_execution_mode",
      z.strictObject({
        workspaceRoot: root,
        reasoningMode: z.enum(["standard", "pro"]),
      }),
    ),
    command(
      "save_workspace_context_window",
      z.strictObject({
        workspaceRoot: root,
        contextWindow: z.union([
          z.enum(["default", "long"]),
          z.number().int().min(1).max(10_000_000),
        ]),
      }),
    ),
    command(
      "save_workspace_mcp_config_document",
      z.strictObject({
        workspaceRoot: root,
        rawBase64: fileContent,
        expectedRawBase64: fileContent,
      }),
    ),
    command(
      "list_workspace_directory",
      z.strictObject({
        workspaceRoot: root,
        relativePath: path,
        offset: z.number().int().nonnegative().max(20_000),
      }),
    ),
    command(
      "read_workspace_file",
      z.strictObject({ workspaceRoot: root, relativePath: path }),
    ),
    command(
      "read_workspace_file_preview",
      z.strictObject({ workspaceRoot: root, relativePath: path }),
    ),
    command(
      "open_workspace_path",
      z.strictObject({ workspaceRoot: root, relativePath: path }),
    ),
    command(
      "discover_workspace_shells",
      z.strictObject({ workspaceRoot: root }),
    ),
    command(
      "start_workspace_terminal",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          shellId: z.string().min(1).max(240),
          columns: z.number().int().min(1).max(500),
          rows: z.number().int().min(1).max(300),
        }),
      }),
    ),
    command(
      "read_workspace_terminal_events",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
        after: z.number().int().nonnegative(),
      }),
    ),
    command(
      "write_workspace_terminal",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
        data: z
          .string()
          .max(65536)
          .refine(
            (value) =>
              !hasUnpairedUtf16Surrogate(value) &&
              new TextEncoder().encode(value).length <= 65536,
          ),
      }),
    ),
    command(
      "write_workspace_terminal_binary",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
        data: z
          .string()
          .max(87384)
          .refine((value) => {
            try {
              const bytes = atob(value);
              return bytes.length <= 65536 && btoa(bytes) === value;
            } catch {
              return false;
            }
          }),
      }),
    ),
    command(
      "acknowledge_workspace_terminal_output",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(896 * 1024),
      }),
    ),
    command(
      "resize_workspace_terminal",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
        columns: z.number().int().min(1).max(500),
        rows: z.number().int().min(1).max(300),
      }),
    ),
    command(
      "stop_workspace_terminal",
      z.strictObject({
        workspaceRoot: root,
        sessionId: z.string().min(1).max(240),
      }),
    ),
    command(
      "stop_workspace_terminals",
      z.strictObject({ workspaceRoot: root }),
    ),
    command(
      "open_workspace_terminal_host",
      z.strictObject({
        workspaceRoot: root,
        terminalId: z.string().min(1).max(240),
      }),
    ),
    command(
      "save_workspace_file",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          relativePath: path,
          contentBase64: fileContent,
          expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
          force: z.boolean(),
          bom: z.boolean(),
        }),
      }),
    ),
    command(
      "create_workspace_entry",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          parentPath: path,
          name,
          kind: z.enum(["file", "directory"]),
        }),
      }),
    ),
    command(
      "rename_workspace_entry",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          relativePath: path,
          name,
        }),
      }),
    ),
    command(
      "delete_workspace_entry",
      z.strictObject({
        request: z.strictObject({
          workspaceRoot: root,
          relativePath: path,
          recursive: z.boolean(),
        }),
      }),
    ),
    command(
      "discover_workspace_git_repositories",
      z.strictObject({ workspaceRoot: root }),
    ),
    command(
      "get_workspace_git_overview",
      z.strictObject({ request: z.strictObject(repository) }),
    ),
    command(
      "get_workspace_git_diff",
      z.strictObject({
        request: z.strictObject({ ...repository, relativePath: path }),
      }),
    ),
    command(
      "get_workspace_pull_requests",
      z.strictObject({ request: z.strictObject(repository) }),
    ),
    command("run_workspace_git_action", z.strictObject({ request: action })),
  ]),
]);

export const workspaceResponseSchema = operationResponseSchema;
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
