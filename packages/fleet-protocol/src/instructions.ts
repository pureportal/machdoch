import { z } from "zod";
import {
  operationEventsSchema,
  operationReadSchema,
  operationReleaseSchema,
  operationResponseSchema,
} from "@machdoch/fleet-protocol/operation";

export const instructionEditorCapability = "instruction-editor.v1";

interface InstructionAction {
  positional: number;
  values: readonly string[];
  toggles: readonly string[];
}

export const instructionActions = {
  "profiles.list": {
    positional: 0,
    values: [],
    toggles: ["--include-content"],
  },
  "profiles.create": {
    positional: 0,
    values: [
      "--name",
      "--description",
      "--prompt",
      "--metadata-json",
      "--expected-revision",
    ],
    toggles: [],
  },
  "profiles.edit": {
    positional: 1,
    values: [
      "--name",
      "--description",
      "--prompt",
      "--metadata-json",
      "--expected-revision",
    ],
    toggles: [],
  },
  "profiles.duplicate": {
    positional: 1,
    values: ["--name", "--expected-revision"],
    toggles: [],
  },
  "profiles.delete": {
    positional: 1,
    values: ["--expected-revision"],
    toggles: [],
  },
  "workspaces.list": { positional: 0, values: [], toggles: [] },
  "workspaces.configure": {
    positional: 1,
    values: ["--name", "--metadata-json", "--expected-revision"],
    toggles: [],
  },
  "workspaces.relink": {
    positional: 1,
    values: ["--path", "--expected-revision"],
    toggles: [],
  },
  "workspaces.remove": {
    positional: 1,
    values: ["--expected-revision"],
    toggles: ["--confirm-assignment-removal"],
  },
  "assignments.set": {
    positional: 1,
    values: ["--path", "--profile", "--expected-revision"],
    toggles: [],
  },
  "assignments.remove": {
    positional: 1,
    values: ["--path", "--expected-revision"],
    toggles: [],
  },
  "recovery.status": { positional: 0, values: [], toggles: [] },
  "recovery.restore": {
    positional: 0,
    values: ["--expected-digest"],
    toggles: [],
  },
  "recovery.reset": {
    positional: 0,
    values: ["--expected-digest"],
    toggles: [],
  },
} as const satisfies Record<string, InstructionAction>;

const text = z
  .string()
  .max(1_800_000)
  .refine((value) => !value.includes("\0"));
export const instructionArgumentsSchema = z
  .array(text)
  .min(2)
  .max(256)
  .superRefine((args, context) => {
    const key = `${args[0]}.${args[1]}`;
    const action: InstructionAction | undefined = Object.hasOwn(
      instructionActions,
      key,
    )
      ? instructionActions[key as keyof typeof instructionActions]
      : undefined;
    const reject = (message: string): void =>
      context.addIssue({ code: "custom", message });
    if (!action) {
      reject("Unknown instruction operation.");
      return;
    }
    let positional = 0;
    const seen = new Set<string>();
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]!;
      if (
        action.values.includes(argument) ||
        action.toggles.includes(argument)
      ) {
        if (seen.has(argument) && argument !== "--profile")
          reject("Duplicate instruction option.");
        seen.add(argument);
        if (action.values.includes(argument) && ++index >= args.length)
          reject("Missing instruction option value.");
      } else if (argument.startsWith("-"))
        reject("Unknown instruction option.");
      else positional += 1;
    }
    if (positional !== action.positional)
      reject("Instruction operation has an invalid target.");
    if (JSON.stringify(args).length > 1_900_000)
      reject("Instruction request is too large.");
  });

export const instructionRequestSchema = z.union([
  z.strictObject({
    kind: z.literal("invoke"),
    id: z.string().uuid(),
    command: z.literal("run_instruction_command"),
    args: z.strictObject({
      request: z.strictObject({
        workspaceRoot: z
          .string()
          .trim()
          .max(2048)
          .refine((value) => !value.includes("\0")),
        arguments: instructionArgumentsSchema,
      }),
    }),
  }),
  operationReadSchema,
  operationReleaseSchema,
  operationEventsSchema,
]);
export const instructionResponseSchema = operationResponseSchema;
export type InstructionRequest = z.infer<typeof instructionRequestSchema>;

export function instructionReferencedWorkspaces(
  args: readonly string[],
): string[] {
  if (args[0] !== "workspaces") return [];
  if (args[1] === "relink") {
    const index = args.indexOf("--path");
    return index < 0 ? [] : [args[index + 1]!];
  }
  if (args[1] !== "configure") return [];
  for (let index = 2; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) index += 1;
    else return [args[index]!];
  }
  return [];
}
