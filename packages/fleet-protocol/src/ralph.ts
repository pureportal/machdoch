import { z } from "zod";
import {
  operationEventsSchema,
  operationReadSchema,
  operationReleaseSchema,
  operationResponseSchema,
} from "@machdoch/fleet-protocol/operation";

export const ralphEditorCapability = "ralph-editor.v1";
export const ralphCommands = [
  "run_ralph_command",
  "get_active_desktop_tasks",
  "get_recent_desktop_task_results",
  "cancel_desktop_task",
  "get_user_internal_task_model_settings",
] as const;

const argument = z
  .string()
  .max(1_800_000)
  .refine((value) => !value.includes("\0"));
const actions = [
  "snapshot",
  "list",
  "show",
  "validate",
  "revisions",
  "runs",
  "log",
  "run-detail",
  "save",
  "delete",
  "restore",
  "run",
  "resume",
  "create",
  "interview",
];
const valueFlags = new Set([
  "--scope",
  "--mode",
  "--runtime-provider",
  "--model",
  "--reasoning",
  "--max-transitions",
  "--param",
  "--flow-json",
  "--expected-fingerprint",
  "--revision",
  "--name",
  "--prompt",
  "--existing-flow-json",
  "--flow-target",
  "--generation-mode",
  "--max-rounds",
  "--input-json",
]);
const booleanFlags = new Set(["--trace", "--isolated", "--retry-current"]);

export const ralphArgumentsSchema = z
  .array(argument)
  .min(1)
  .max(160)
  .superRefine((args, context) => {
    if (!actions.includes(args[0]!)) {
      context.addIssue({ code: "custom", message: "Unknown RALPH operation." });
      return;
    }
    let positional = 0;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index]!;
      if (booleanFlags.has(value)) continue;
      if (valueFlags.has(value)) {
        if (++index >= args.length)
          context.addIssue({
            code: "custom",
            message: "Missing RALPH option value.",
          });
        continue;
      }
      if (value.startsWith("-") || ++positional > 1) {
        context.addIssue({ code: "custom", message: "Unknown RALPH option." });
      }
    }
    if (JSON.stringify(args).length > 1_900_000)
      context.addIssue({
        code: "custom",
        message: "RALPH request is too large.",
      });
  });

export const ralphInvocationSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("run_ralph_command"),
    args: z.strictObject({
      request: z.strictObject({
        workspaceRoot: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .refine((value) => !value.includes("\0")),
        arguments: ralphArgumentsSchema,
        taskId: z
          .string()
          .min(1)
          .max(240)
          .regex(/^[a-zA-Z0-9._:-]+$/u)
          .optional(),
      }),
    }),
  }),
  z.strictObject({
    command: z.literal("get_active_desktop_tasks"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    command: z.literal("get_user_internal_task_model_settings"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    command: z.literal("get_recent_desktop_task_results"),
    args: z.strictObject({
      taskIds: z
        .array(
          z
            .string()
            .min(1)
            .max(240)
            .refine((value) => !value.includes("\0")),
        )
        .max(160),
    }),
  }),
  z.strictObject({
    command: z.literal("cancel_desktop_task"),
    args: z.strictObject({
      taskId: z
        .string()
        .min(1)
        .max(240)
        .refine((value) => !value.includes("\0")),
    }),
  }),
]);

export const ralphRequestSchema = z.union([
  ...ralphInvocationSchema.options.map((schema) =>
    schema.extend({ kind: z.literal("invoke"), id: z.string().uuid() }),
  ),
  operationReadSchema,
  operationReleaseSchema,
  operationEventsSchema,
]);
export const ralphResponseSchema = operationResponseSchema;
export type RalphRequest = z.infer<typeof ralphRequestSchema>;
export type RalphInvocation = z.infer<typeof ralphInvocationSchema>;
