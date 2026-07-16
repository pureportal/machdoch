import type {
  DiscoveredInstruction,
  InstructionTargetAudience,
  ResolvedTaskContext,
  TaskCustomizationMatch,
} from "../types.js";
import { sha256 } from "./digests.js";
import {
  PROVIDER_ENROLLMENT_SCHEMA_VERSION,
  type CompiledInstructionBundle,
  type CompiledInstructionSource,
} from "./types.js";

const DEFAULT_MAX_RENDERED_CHARS = 128 * 1024;
const TRUNCATION_MARKER = "\n[truncated by Machdoch provider enrollment]\n";

const normalizeIdentifierPart = (value: string): string => {
  return value.trim().replaceAll("\\", "/").toLowerCase();
};

export const createStableInstructionId = (input: {
  name: string;
  path?: string;
  scope?: string;
}): string => {
  const identity = [
    input.scope ?? "workspace",
    input.path ?? input.name,
    input.name,
  ]
    .map(normalizeIdentifierPart)
    .join("\u0000");

  return `instruction-${sha256(identity).slice(0, 20)}`;
};

const normalizeInstructionBody = (body: string): string => body
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n")
  .normalize("NFC");

export const getInstructionBodyHash = (body: string): string => sha256(
  normalizeInstructionBody(body),
);

const renderSource = (source: CompiledInstructionSource): string => {
  return [
    `<managed_instruction id="${source.id}" name=${JSON.stringify(source.name)} priority="${source.priority}">`,
    source.body.trim(),
    "</managed_instruction>",
  ].join("\n");
};

export const renderCompiledInstructionSources = (
  sources: readonly CompiledInstructionSource[],
): string => sources.map(renderSource).join("\n\n");

const toCompiledSource = (
  match: TaskCustomizationMatch,
): CompiledInstructionSource => {
  const body = normalizeInstructionBody(match.body);
  const id =
    match.id ??
    createStableInstructionId({
      name: match.name,
      path: match.path,
      ...(match.scope ? { scope: match.scope } : {}),
    });

  return {
    id,
    name: match.name,
    sourcePath: match.path,
    bodyHash: getInstructionBodyHash(body),
    sourceIds: [id],
    priority: match.priority,
    body,
  };
};

const compareSources = (
  left: CompiledInstructionSource,
  right: CompiledInstructionSource,
): number => {
  return (
    right.priority - left.priority ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
};

const deduplicateSources = (
  sources: CompiledInstructionSource[],
): CompiledInstructionSource[] => {
  const byBodyHash = new Map<string, CompiledInstructionSource>();

  for (const source of sources.sort(compareSources)) {
    const existing = byBodyHash.get(source.bodyHash);
    if (!existing) {
      byBodyHash.set(source.bodyHash, source);
      continue;
    }

    existing.sourceIds = [...new Set([...existing.sourceIds, ...source.sourceIds])]
      .sort();
  }

  return [...byBodyHash.values()].sort(compareSources);
};

const addVirtualSections = (
  sources: CompiledInstructionSource[],
  sections: readonly string[],
): void => {
  for (const [index, body] of sections.entries()) {
    if (!body.trim()) {
      continue;
    }

    const name = `Machdoch runtime instruction ${index + 1}`;
    const id = createStableInstructionId({
      name,
      path: `runtime/system-prompt-section/${index}`,
      scope: "run",
    });
    sources.push({
      id,
      name,
      body: normalizeInstructionBody(body),
      bodyHash: getInstructionBodyHash(body),
      sourceIds: [id],
      priority: Number.MAX_SAFE_INTEGER - index,
    });
  }
};

const enforceBudget = (
  sources: CompiledInstructionSource[],
  maxRenderedChars: number,
): {
  sources: CompiledInstructionSource[];
  omittedSources: CompiledInstructionBundle["omittedSources"];
  degradedSourceIds: string[];
  renderedText: string;
  warnings: string[];
  truncated: boolean;
} => {
  const warnings: string[] = [];
  const included: CompiledInstructionSource[] = [];
  let remaining = maxRenderedChars;
  let truncated = false;
  const degradedSourceIds = new Set<string>();

  for (const source of sources) {
    const rendered = renderSource(source);
    const separatorLength = included.length > 0 ? 2 : 0;

    if (rendered.length + separatorLength <= remaining) {
      included.push(source);
      remaining -= rendered.length + separatorLength;
      continue;
    }

    if (remaining > TRUNCATION_MARKER.length + 120) {
      const availableBodyChars = Math.max(
        0,
        remaining - TRUNCATION_MARKER.length - 120,
      );
      included.push({
        ...source,
        body: `${source.body.slice(0, availableBodyChars)}${TRUNCATION_MARKER}`,
      });
      degradedSourceIds.add(source.id);
      warnings.push(`Instruction ${source.id} was truncated to fit the enrollment budget.`);
    } else {
      warnings.push(`Instruction ${source.id} was omitted because the enrollment budget was exhausted.`);
    }
    truncated = true;
    break;
  }

  if (included.length < sources.length) {
    truncated = true;
    for (const omitted of sources.slice(included.length)) {
      if (!warnings.some((warning) => warning.includes(omitted.id))) {
        warnings.push(`Instruction ${omitted.id} was omitted because the enrollment budget was exhausted.`);
      }
    }
  }

  const includedIds = new Set(included.map((source) => source.id));
  const omittedSources = sources
    .filter((source) => !includedIds.has(source.id))
    .map(({ id, name, sourcePath, bodyHash, sourceIds }) => ({
      id,
      name,
      ...(sourcePath ? { sourcePath } : {}),
      bodyHash,
      sourceIds,
    }));
  for (const source of omittedSources) degradedSourceIds.add(source.id);

  return {
    sources: included,
    omittedSources,
    degradedSourceIds: [...degradedSourceIds].sort(),
    renderedText: included.map(renderSource).join("\n\n"),
    warnings,
    truncated,
  };
};

export const compileInstructionBundle = (
  taskContext: ResolvedTaskContext,
  additionalSystemPromptSections: readonly string[] = [],
  options: { maxRenderedChars?: number } = {},
): CompiledInstructionBundle => {
  const sources = taskContext.applicableInstructions.map(toCompiledSource);
  addVirtualSections(sources, additionalSystemPromptSections);
  const deduplicated = deduplicateSources(sources);
  const conflicts = new Map<string, CompiledInstructionSource[]>();
  for (const source of deduplicated) {
    const key = source.name.trim().toLocaleLowerCase();
    conflicts.set(key, [...(conflicts.get(key) ?? []), source]);
  }
  const conflictWarnings = [...conflicts.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      `Instruction name conflict retained for source IDs ${group.map((source) => source.id).sort().join(", ")}.`,
    );
  const budgeted = enforceBudget(
    deduplicated,
    options.maxRenderedChars ?? DEFAULT_MAX_RENDERED_CHARS,
  );

  return {
    schemaVersion: PROVIDER_ENROLLMENT_SCHEMA_VERSION,
    audience: taskContext.instructionAudience ?? "executor",
    sources: budgeted.sources,
    omittedSources: budgeted.omittedSources,
    degradedSourceIds: budgeted.degradedSourceIds,
    renderedText: budgeted.renderedText,
    digest: sha256(budgeted.renderedText),
    estimatedTokens: Math.ceil(budgeted.renderedText.length / 4),
    truncated: budgeted.truncated,
    warnings: [...conflictWarnings, ...budgeted.warnings],
  };
};

const getPersistentInstructionMode = (
  instruction: DiscoveredInstruction,
): string => instruction.mode ?? (instruction.kind === "always-on" ? "always" : "auto");

const renderPersistentGuard = (
  instruction: DiscoveredInstruction,
): string => {
  const guards: string[] = [];
  const mode = getPersistentInstructionMode(instruction);

  if (mode !== "always") {
    guards.push(`mode=${mode}`);
  }
  if (instruction.audience && instruction.audience !== "all") {
    guards.push(`audience=${instruction.audience}`);
  }
  if (instruction.applyToPatterns?.length) {
    guards.push(`applyTo=${instruction.applyToPatterns.join(",")}`);
  } else if (instruction.applyTo) {
    guards.push(`applyTo=${instruction.applyTo}`);
  }
  if (instruction.excludePatterns?.length) {
    guards.push(`exclude=${instruction.excludePatterns.join(",")}`);
  }
  if (instruction.keywords.length > 0) {
    guards.push(`keywords=${instruction.keywords.join(",")}`);
  }

  return guards.length > 0
    ? `Apply this section only when ${guards.join("; ")}.\n\n${instruction.body}`
    : instruction.body;
};

export const compilePersistentInstructionBundle = (
  instructions: readonly DiscoveredInstruction[],
  audience: InstructionTargetAudience = "executor",
  options: { scope?: "user" | "workspace"; maxRenderedChars?: number } = {},
): CompiledInstructionBundle => {
  const matches: TaskCustomizationMatch[] = instructions
    .filter((instruction) => getPersistentInstructionMode(instruction) !== "disabled")
    .filter((instruction) => {
      if (!options.scope) {
        return true;
      }
      return options.scope === "user"
        ? instruction.scope === "user"
        : instruction.scope !== "user";
    })
    .map((instruction) => {
      const id = createStableInstructionId({
        name: instruction.name,
        path: instruction.path,
        ...(instruction.scope ? { scope: instruction.scope } : {}),
      });
      const body = renderPersistentGuard(instruction);
      return {
        id,
        bodyHash: getInstructionBodyHash(instruction.body),
        kind: instruction.kind,
        name: instruction.name,
        path: instruction.path,
        ...(instruction.scope ? { scope: instruction.scope } : {}),
        priority: instruction.priority ?? 0,
        body,
        reason: "Persistent baseline projection.",
      };
    });

  return compileInstructionBundle(
    {
      task: "provider-sync",
      effectiveTask: "provider-sync",
      taskContextText: "provider-sync",
      instructionContextText: "provider-sync",
      workspacePaths: [],
      suggestedTools: [],
      instructionAudience: audience,
      applicableInstructions: matches,
    },
    [],
    options,
  );
};
