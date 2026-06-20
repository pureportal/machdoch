import type {
  ScheduledContextPackSnapshot,
  ScheduledJob,
  ScheduledMacroReference,
} from "../scheduler.js";

const formatContextPathBlock = (paths: string[]): string => {
  if (paths.length === 0) {
    return "";
  }

  if (paths.length === 1) {
    const [path] = paths;

    return path ? `Use this path: "${path}"` : "";
  }

  return ["Use these paths:", ...paths.map((path) => `- path: "${path}"`)].join(
    "\n",
  );
};

const replaceSnapshotVariables = (
  value: string,
  variables: Record<string, string> | undefined,
): string => {
  if (!variables) {
    return value;
  }

  return Object.entries(variables).reduce((current, [key, replacement]) => {
    return current.replaceAll(`{${key}}`, replacement);
  }, value);
};

const formatContextPackSection = (
  pack: ScheduledContextPackSnapshot,
): string => {
  const lines = [`## Context Pack: ${pack.name}`];
  const instructions = replaceSnapshotVariables(
    pack.instructions ?? "",
    pack.variableValues,
  ).trim();
  const prompt = replaceSnapshotVariables(
    pack.prompt ?? "",
    pack.variableValues,
  ).trim();
  const contextPathBlock = formatContextPathBlock(pack.contextPaths ?? []);

  if (instructions) {
    lines.push(`### Instructions\n${instructions}`);
  }

  if (prompt) {
    lines.push(`### Prompt\n${prompt}`);
  }

  if (contextPathBlock) {
    lines.push(`### Context Paths\n${contextPathBlock}`);
  }

  return lines.join("\n\n");
};

const formatMacroSection = (macro: ScheduledMacroReference): string => {
  const lines = [`## Saved Macro: ${macro.name}`];

  if (macro.promptInvocation) {
    lines.push(`Run this saved prompt or macro invocation:\n${macro.promptInvocation}`);
  } else {
    lines.push(`Run the saved macro named "${macro.name}".`);
  }

  if (macro.inputValues && Object.keys(macro.inputValues).length > 0) {
    lines.push(
      [
        "Inputs:",
        ...Object.entries(macro.inputValues).map(
          ([key, value]) => `- ${key}: ${value}`,
        ),
      ].join("\n"),
    );
  }

  return lines.join("\n\n");
};

export const createScheduledJobTaskText = (job: ScheduledJob): string => {
  if (job.target.type === "ralph-flow") {
    return job.target.prompt.trim();
  }

  const sections = [
    ...job.target.contextPacks.map(formatContextPackSection),
    ...job.target.macros.map(formatMacroSection),
    job.target.prompt,
  ].filter((section) => section.trim().length > 0);
  const contextPathBlock = formatContextPathBlock(job.target.contextPaths);

  if (contextPathBlock) {
    sections.push(contextPathBlock);
  }

  return sections.join("\n\n").trim();
};
