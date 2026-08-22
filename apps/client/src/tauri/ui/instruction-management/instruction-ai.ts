export type InstructionAiMode = "create" | "improve";

export interface InstructionAiTaskInput {
  mode: InstructionAiMode;
  name: string;
  description?: string;
  body: string;
  request?: string;
}

const encodeBlock = (label: string, value: string): string =>
  `<${label}>\n${value.trim()}\n</${label}>`;

export const createInstructionAiTask = (
  input: InstructionAiTaskInput,
): string => {
  const action =
    input.mode === "create"
      ? "Create a reusable Markdown instruction file."
      : "Improve the reusable Markdown instruction file while preserving its intent.";
  return [
    action,
    "Return only the complete file body between <machdoch_instruction_file> and </machdoch_instruction_file>.",
    "Write direct, durable instructions. Do not add commentary, a title unless useful inside the file, or details that belong only to this editing request.",
    encodeBlock("instruction_name", input.name),
    input.description?.trim()
      ? encodeBlock("instruction_description", input.description)
      : undefined,
    input.body.trim()
      ? encodeBlock("current_instruction", input.body)
      : undefined,
    input.request?.trim()
      ? encodeBlock("editing_request", input.request)
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n\n");
};

export const extractInstructionAiBody = (value: string): string | null => {
  const match =
    /<machdoch_instruction_file>\s*([\s\S]*?)\s*<\/machdoch_instruction_file>/iu.exec(
      value,
    );
  const body = match?.[1]?.trim();
  return body ? body : null;
};
