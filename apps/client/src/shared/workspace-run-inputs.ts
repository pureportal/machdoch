import type {
  WorkspaceRunInputValue,
  WorkspaceRunInputValues,
} from "./workspace-run.js";

export type WorkspaceRunInputDefinition =
  | {
      type: "select";
      id: string;
      label: string;
      options: readonly { value: string }[];
      default?: string | undefined;
    }
  | {
      type: "text";
      id: string;
      label: string;
      default: string;
      required: boolean;
    }
  | {
      type: "boolean";
      id: string;
      label: string;
      default: boolean;
      trueValue: string;
      falseValue: string;
    };

interface WorkspaceRunInputTemplate {
  command: string;
  environment: Record<string, string>;
}

const INPUT_REFERENCE_PATTERN =
  /\$\{input:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}/gu;
const MAX_INPUT_VALUE_CHARS = 1_024;

export const workspaceRunInputReferences = (text: string): string[] =>
  Array.from(text.matchAll(INPUT_REFERENCE_PATTERN), (match) => match[1]!);

export const workspaceRunTaskInputIds = (
  task: WorkspaceRunInputTemplate,
): string[] => {
  const environmentValues = Object.keys(task.environment)
    .sort()
    .map((key) => task.environment[key]!);
  return Array.from(
    new Set(
      [task.command, ...environmentValues].flatMap(workspaceRunInputReferences),
    ),
  );
};

export const workspaceRunDefaultInputValue = (
  input: WorkspaceRunInputDefinition,
): WorkspaceRunInputValue => {
  if (input.type === "select") {
    return input.default ?? input.options[0]?.value ?? "";
  }
  return input.default;
};

export const workspaceRunInputValueError = (
  input: WorkspaceRunInputDefinition,
  value: WorkspaceRunInputValue,
): string | null => {
  if (input.type === "boolean") {
    return typeof value === "boolean"
      ? null
      : `${input.label} must be true or false.`;
  }
  if (typeof value !== "string") return `${input.label} must be text.`;
  if (input.type === "select") {
    return input.options.some((option) => option.value === value)
      ? null
      : `Choose one of the options for ${input.label}.`;
  }
  if (
    value.length > MAX_INPUT_VALUE_CHARS ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return `${input.label} must be a single line of at most ${MAX_INPUT_VALUE_CHARS} characters.`;
  }
  return input.required && !value.trim() ? `${input.label} is required.` : null;
};

export const workspaceRunInputArgument = (
  input: WorkspaceRunInputDefinition,
  value: WorkspaceRunInputValue,
): string => {
  if (input.type === "boolean" && typeof value === "boolean") {
    return value ? input.trueValue : input.falseValue;
  }
  return String(value);
};

export const resolveWorkspaceRunInputText = (
  text: string,
  inputs: readonly WorkspaceRunInputDefinition[],
  values: WorkspaceRunInputValues,
): string =>
  text.replace(INPUT_REFERENCE_PATTERN, (reference, id: string) => {
    const input = inputs.find((candidate) => candidate.id === id);
    if (!input) return reference;
    return workspaceRunInputArgument(
      input,
      values[id] ?? workspaceRunDefaultInputValue(input),
    );
  });

export const resolveWorkspaceRunTaskInputs = <
  Task extends WorkspaceRunInputTemplate,
>(
  task: Task,
  inputs: readonly WorkspaceRunInputDefinition[],
  values: WorkspaceRunInputValues,
): Task => {
  for (const id of workspaceRunTaskInputIds(task)) {
    const input = inputs.find((candidate) => candidate.id === id);
    if (!input) throw new Error(`Run input \`${id}\` does not exist.`);
    const error = workspaceRunInputValueError(
      input,
      values[id] ?? workspaceRunDefaultInputValue(input),
    );
    if (error) throw new Error(error);
  }
  return {
    ...task,
    command: resolveWorkspaceRunInputText(task.command, inputs, values),
    environment: Object.fromEntries(
      Object.entries(task.environment).map(([key, value]) => [
        key,
        resolveWorkspaceRunInputText(value, inputs, values),
      ]),
    ),
  };
};
