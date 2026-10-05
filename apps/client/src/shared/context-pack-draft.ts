export interface ContextPackText {
  name: string;
  instructions: string;
  prompt: string;
  variables: Array<{ name: string; defaultValue?: string | null }>;
}

function replaceContextPackVariables(
  value: string,
  variables: ContextPackText["variables"],
  values: Record<string, string>,
): string {
  const replacements = new Map<string, string>();
  for (const variable of variables) {
    const replacement =
      values[variable.name]?.trim() ?? variable.defaultValue ?? "";
    if (replacement) replacements.set(variable.name, replacement);
  }
  return value.replace(
    /\{([A-Za-z_][A-Za-z0-9_-]{0,79})\}/gu,
    (raw, name: string, offset: number, text: string) => {
      if (text[offset - 1] === "{" || text[offset + raw.length] === "}")
        return raw;
      return replacements.get(name) ?? raw;
    },
  );
}

export function createContextPackTextSections(
  pack: ContextPackText,
  values: Record<string, string> = {},
): string[] {
  const sections = [`## Context Pack: ${pack.name}`];
  const instructions = replaceContextPackVariables(
    pack.instructions,
    pack.variables,
    values,
  ).trim();
  const prompt = replaceContextPackVariables(
    pack.prompt,
    pack.variables,
    values,
  ).trim();
  if (instructions) sections.push(`### Instructions\n${instructions}`);
  if (prompt) sections.push(`### Prompt\n${prompt}`);
  return sections;
}

export function applyContextPackDraft(draft: string, block: string): string {
  if (!block) return draft;
  const normalized = draft.trim();
  return normalized ? `${block}\n\n## Current Task\n${normalized}` : block;
}
