import { z } from "zod";
import {
  operationEventsSchema,
  operationReadSchema,
  operationReleaseSchema,
  operationResponseSchema,
} from "@machdoch/fleet-protocol/operation";

export const schedulerEditorCapability = "scheduler-editor.v1";
export const schedulerActions = [
  "list",
  "create",
  "pause",
  "resume",
  "delete",
  "runs",
  "run-due",
  "inspect-ralph",
  "trigger",
  "retry",
  "cancel",
] as const;
export const schedulerValueFlags = [
  "--request-id",
  "--name",
  "--cron",
  "--timezone",
  "--interval-ms",
  "--delay-ms",
  "--run-at",
  "--trigger",
  "--trigger-filter",
  "--trigger-recovery-filter",
  "--trigger-firing-mode",
  "--trigger-cooldown-ms",
  "--trigger-repeat-ms",
  "--trigger-debounce-ms",
  "--trigger-dedupe-key-template",
  "--trigger-max-events",
  "--trigger-window-ms",
  "--scheduler-target",
  "--scheduled-ralph-flow",
  "--scheduled-ralph-flow-scope",
  "--scheduled-ralph-run-log-scope",
  "--scheduled-ralph-max-transitions",
  "--scheduled-ralph-profile",
  "--scheduled-ralph-resume-policy",
  "--scheduled-ralph-param",
  "--scheduled-ralph-allowed-root",
  "--scheduled-ralph-allow-commands",
  "--scheduled-ralph-allow-writes",
  "--scheduled-ralph-allow-network",
  "--scheduled-ralph-allow-mcp-tools",
  "--prompt",
  "--prompt-file",
  "--context",
  "--image",
  "--context-pack",
  "--macro",
  "--missed-run-policy",
  "--missed-run-grace-ms",
  "--retry-attempts",
  "--retry-min-ms",
  "--retry-max-ms",
  "--retry-factor",
  "--retry-randomize",
  "--dedupe-key",
  "--ttl-ms",
  "--max-duration-ms",
  "--concurrency-key",
  "--concurrency-limit",
  "--history-limit",
  "--max-catch-up-runs",
  "--mode",
  "--runtime-provider",
  "--model",
  "--reasoning",
] as const;

const text = z
  .string()
  .max(1_800_000)
  .refine((value) => !value.includes("\0"));
export const schedulerArgumentsSchema = z
  .array(text)
  .min(1)
  .max(512)
  .superRefine((args, context) => {
    if (!schedulerActions.some((action) => action === args[0])) {
      context.addIssue({
        code: "custom",
        message: "Unknown Scheduler operation.",
      });
      return;
    }
    let positional = 0;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index]!;
      if (schedulerValueFlags.some((flag) => flag === value)) {
        if (++index >= args.length)
          context.addIssue({
            code: "custom",
            message: "Missing Scheduler option value.",
          });
      } else if (value.startsWith("-") || ++positional > 1) {
        context.addIssue({
          code: "custom",
          message: "Unknown Scheduler option.",
        });
      }
    }
    if (JSON.stringify(args).length > 1_900_000)
      context.addIssue({
        code: "custom",
        message: "Scheduler request is too large.",
      });
  });

const workspace = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\0"));
export const schedulerInvocationSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("run_scheduler_command"),
    args: z.strictObject({
      request: z.strictObject({
        workspaceRoot: workspace,
        arguments: schedulerArgumentsSchema,
      }),
    }),
  }),
  z.strictObject({
    command: z.literal("run_ralph_command"),
    args: z.strictObject({
      request: z.strictObject({
        workspaceRoot: workspace,
        arguments: z.tuple([
          z.literal("list"),
          z.literal("--scope"),
          z.enum(["workspace", "user"]),
        ]),
      }),
    }),
  }),
]);
export const schedulerRequestSchema = z.union([
  ...schedulerInvocationSchema.options.map((schema) =>
    schema.extend({ kind: z.literal("invoke"), id: z.string().uuid() }),
  ),
  operationReadSchema,
  operationReleaseSchema,
  operationEventsSchema,
]);
export const schedulerResponseSchema = operationResponseSchema;
export type SchedulerRequest = z.infer<typeof schedulerRequestSchema>;
