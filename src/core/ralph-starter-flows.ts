import { discoverRalphFlowVariables } from "./_helpers/ralph-placeholders.helper.js";
import { createRalphFlowFingerprint } from "./_helpers/create-ralph-flow-fingerprint.helper.js";
import type { RalphFlow, RalphFlowBlock } from "./ralph.js";
import { autonomousCodeImprovementLoopStarterFlow } from "./ralph-starter-flows/autonomous-code-improvement-loop.js";
import { autonomousFeatureGenerationLoopStarterFlow } from "./ralph-starter-flows/autonomous-feature-generation-loop.js";
import { autonomousUiImprovementLoopStarterFlow } from "./ralph-starter-flows/autonomous-ui-improvement-loop.js";
import { featureImplementationChecklistLoopStarterFlow } from "./ralph-starter-flows/feature-implementation-checklist-loop.js";
import { repositoryRefactorValidationLoopStarterFlow } from "./ralph-starter-flows/repository-refactor-validation-loop.js";
import { securityReviewFixLoopStarterFlow } from "./ralph-starter-flows/security-review-fix-loop.js";

export type RalphStarterFlowId =
  | "security-fix-loop"
  | "autonomous-refactoring-flow"
  | "full-feature-implementation"
  | "autonomous-feature-generation-loop"
  | "autonomous-code-improvement-loop"
  | "autonomous-ui-improvement-loop";

export interface RalphStarterFlow {
  id: RalphStarterFlowId;
  version: number;
  defaultAlias: string;
  category: string;
  tags: string[];
  flow: RalphFlow;
}

export interface RalphStarterFlowSummary {
  id: RalphStarterFlowId;
  version: number;
  defaultAlias: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  blockCount: number;
  edgeCount: number;
  variableCount: number;
  requiredVariableNames: string[];
  autonomyReady: boolean;
  hasHumanInputBlocks: boolean;
  modelBlockCount: number;
  runCheckCount: number;
  visualReviewConfigured: boolean;
  visualReviewEnabledByDefault: boolean;
  artifactPathCount: number;
  capabilities: string[];
}

export interface RalphStarterFlowImportOptions {
  id: string;
  alias: string;
  importedAt: string;
}

const RAW_STARTER_RALPH_FLOWS = [
  autonomousFeatureGenerationLoopStarterFlow,
  autonomousCodeImprovementLoopStarterFlow,
  autonomousUiImprovementLoopStarterFlow,
  repositoryRefactorValidationLoopStarterFlow,
  featureImplementationChecklistLoopStarterFlow,
  securityReviewFixLoopStarterFlow,
] as const satisfies readonly RalphStarterFlow[];

const cloneRalphFlow = (flow: RalphFlow): RalphFlow => {
  return JSON.parse(JSON.stringify(flow)) as RalphFlow;
};

const createTemplateVariableDefaults = (
  flow: RalphFlow,
): Record<string, string | undefined> => {
  return Object.fromEntries(
    (flow.variables ?? []).map((variable) => [variable.name, variable.default]),
  );
};

const normalizeTemplateFlow = (flow: RalphFlow): RalphFlow => {
  const normalized = cloneRalphFlow(flow);

  // Match the persistence parser without importing the Node-only Ralph
  // storage/configuration graph into the browser bundle.
  normalized.blocks = normalized.blocks.map((block) => {
    const settings = block.settings
      ? {
          ...block.settings,
          attachments: block.settings.attachments ?? [],
          packs: block.settings.packs ?? [],
        }
      : undefined;

    if (block.type !== "UTILITY") {
      return settings ? { ...block, settings } : block;
    }

    const utility = { ...block.utility };
    for (const key of [
      "maxAttempts",
      "maxTasks",
      "maxResults",
      "maxDepth",
    ] as const) {
      if (typeof utility[key] === "string") {
        delete utility[key];
      }
    }

    if (utility.strategy?.startsWith("{{")) {
      delete utility.strategy;
    }

    return {
      ...block,
      ...(settings ? { settings } : {}),
      utility,
    };
  });

  if (normalized.variables) {
    // Flow persistence derives variables from placeholders and stores them in
    // name order. Declaration order does not affect execution, so template
    // identity must use the same canonical order before and after persistence.
    normalized.variables = [...normalized.variables].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  return normalized;
};

const createTemplateFingerprint = (flow: RalphFlow): string => {
  return createRalphFlowFingerprint(normalizeTemplateFlow(flow));
};

const createTemplateSnapshot = (
  flow: RalphFlow,
): Omit<RalphFlow, "source" | "createdAt" | "updatedAt"> => {
  const snapshot = normalizeTemplateFlow(flow);
  delete snapshot.source;
  delete snapshot.createdAt;
  delete snapshot.updatedAt;

  return snapshot;
};

const createImportedTemplateFingerprint = (
  flow: RalphFlow,
  starterFlow: RalphStarterFlow,
): string | null => {
  const expectedFingerprint = flow.source?.templateFingerprint;
  if (!expectedFingerprint) {
    return null;
  }

  const comparable = cloneRalphFlow(flow);
  comparable.id = starterFlow.flow.id;
  if (starterFlow.flow.alias === undefined) {
    delete comparable.alias;
  } else {
    comparable.alias = starterFlow.flow.alias;
  }
  delete comparable.createdAt;
  delete comparable.updatedAt;
  delete comparable.source;

  const templateVariableDefaults = flow.source?.templateVariableDefaults;
  if (comparable.variables && templateVariableDefaults) {
    comparable.variables = comparable.variables.map((variable) => {
      if (!Object.hasOwn(templateVariableDefaults, variable.name)) {
        return variable;
      }

      const templateDefault = templateVariableDefaults[variable.name];
      if (templateDefault === undefined) {
        const withoutDefault = { ...variable };
        delete withoutDefault.default;
        return withoutDefault;
      }
      return { ...variable, default: templateDefault };
    });
  }

  return createTemplateFingerprint(comparable);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const hardenStructuredSchema = (
  value: unknown,
  blockId: string,
  path: string[] = [],
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => hardenStructuredSchema(entry, blockId, path));
  }
  if (!isRecord(value)) {
    return value;
  }

  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      hardenStructuredSchema(entry, blockId, [...path, key]),
    ]),
  );

  if (
    result.type === "object" &&
    isRecord(result.properties) &&
    Object.keys(result.properties).length > 0
  ) {
    result.additionalProperties = false;
  }

  const propertyName = path.at(-1);
  if (result.type === "string" && propertyName === "decision" && !result.enum) {
    if (blockId.includes("review")) {
      result.enum = ["PASS", "FIX", "DEFER"];
    } else if (blockId.includes("choose")) {
      result.enum = ["IMPLEMENT", "STOP", "DEFER"];
    }
  }
  if (result.type === "string" && propertyName === "verificationTier") {
    result.enum = ["focused", "standard", "broad"];
  }
  if (result.type === "string" && propertyName === "reviewTier") {
    result.enum = ["validator-only", "strict"];
  }

  return result;
};

const isModelBackedBlock = (block: RalphFlowBlock): boolean => {
  if (
    block.type === "PROMPT" ||
    block.type === "VALIDATOR" ||
    block.type === "DECISION" ||
    block.type === "INTERVIEW"
  ) {
    return true;
  }

  return (
    block.type === "UTILITY" &&
    (block.utility.type === "PROMPT_JSON" ||
      block.utility.type === "VALIDATOR_JSON")
  );
};

const hardenStarterFlow = (starterFlow: RalphStarterFlow): RalphStarterFlow => {
  const flow = cloneRalphFlow(starterFlow.flow);

  if (flow.variables) {
    flow.variables = flow.variables.map((variable) => {
      if (
        variable.name === "allowDependencyChanges" ||
        variable.name === "allowSchemaChanges" ||
        variable.name === "allowPublicApiChanges"
      ) {
        return { ...variable, default: "true" };
      }
      if (variable.name === "riskTolerance") {
        return { ...variable, default: "ambitious" };
      }
      return variable;
    });
  }

  flow.blocks = flow.blocks.map((block) => {
    const settings = isModelBackedBlock(block)
      ? {
          ...block.settings,
          retry: block.settings?.retry ?? {
            mode: "finite" as const,
            maxRetries: 2,
            delaySeconds: 2,
          },
        }
      : block.settings;

    if (
      block.type === "UTILITY" &&
      (block.utility.type === "PROMPT_JSON" ||
        block.utility.type === "VALIDATOR_JSON") &&
      block.utility.schema
    ) {
      const utility = {
        ...block.utility,
        schema: hardenStructuredSchema(block.utility.schema, block.id),
      };
      return settings ? { ...block, settings, utility } : { ...block, utility };
    }

    return settings ? { ...block, settings } : block;
  });

  return { ...starterFlow, flow };
};

export const STARTER_RALPH_FLOWS: readonly RalphStarterFlow[] =
  RAW_STARTER_RALPH_FLOWS.map(hardenStarterFlow);

export const getRalphStarterFlow = (
  id: string,
): RalphStarterFlow | undefined => {
  return STARTER_RALPH_FLOWS.find((starterFlow) => starterFlow.id === id);
};

export const createRalphStarterFlowSummary = (
  starterFlow: RalphStarterFlow,
): RalphStarterFlowSummary => {
  const requiredVariableNames = (starterFlow.flow.variables ?? [])
    .filter((variable) => variable.required && !(variable.default ?? "").trim())
    .map((variable) => variable.name);
  const hasHumanInputBlocks = starterFlow.flow.blocks.some(
    (block) => block.type === "ASK_USER" || block.type === "INTERVIEW",
  );
  const hasBlockingHumanInput = starterFlow.flow.blocks.some(
    (block) => block.type === "ASK_USER",
  ) ||
    (starterFlow.flow.blocks.some((block) => block.type === "INTERVIEW") &&
      starterFlow.flow.variables?.find(
        (variable) => variable.name === "enableInterview",
      )?.default === "true");
  const autonomyReady =
    requiredVariableNames.length === 0 && !hasBlockingHumanInput;
  const modelBlockCount = starterFlow.flow.blocks.filter(isModelBackedBlock).length;
  const runCheckCount = starterFlow.flow.blocks.filter(
    (block) => block.type === "UTILITY" && block.utility.type === "RUN_CHECK",
  ).length;
  const visualReviewConfigured = starterFlow.flow.blocks.some(
    (block) => block.type === "UTILITY" && block.utility.type === "UI_ANALYZE",
  );
  const visualReviewEnabledByDefault =
    starterFlow.flow.variables?.find(
      (variable) => variable.name === "enableVisualReview",
    )?.default === "true";
  const artifactPathCount = (starterFlow.flow.variables ?? []).filter(
    (variable) => variable.type === "path" && Boolean(variable.default?.trim()),
  ).length;
  const capabilities = [
    modelBlockCount > 0 ? "model" : undefined,
    runCheckCount > 0 ? "verification" : undefined,
    visualReviewConfigured ? "visual-review" : undefined,
    artifactPathCount > 0 ? "persistent-artifacts" : undefined,
    starterFlow.flow.blocks.some(
      (block) => block.type === "UTILITY" && block.utility.type === "QUERY_JSONL",
    )
      ? "bounded-history"
      : undefined,
    hasHumanInputBlocks ? "human-input-optional" : "unattended",
  ].filter((value): value is string => Boolean(value));

  return {
    id: starterFlow.id,
    version: starterFlow.version,
    defaultAlias: starterFlow.defaultAlias,
    name: starterFlow.flow.name,
    description: starterFlow.flow.description ?? "",
    category: starterFlow.category,
    tags: [...starterFlow.tags],
    blockCount: starterFlow.flow.blocks.length,
    edgeCount: starterFlow.flow.edges.length,
    variableCount: discoverRalphFlowVariables(starterFlow.flow).length,
    requiredVariableNames,
    autonomyReady,
    hasHumanInputBlocks,
    modelBlockCount,
    runCheckCount,
    visualReviewConfigured,
    visualReviewEnabledByDefault,
    artifactPathCount,
    capabilities,
  };
};

export const createImportedRalphStarterFlow = (
  starterFlow: RalphStarterFlow,
  options: RalphStarterFlowImportOptions,
): RalphFlow => {
  const flow = cloneRalphFlow(starterFlow.flow);

  return {
    ...flow,
    id: options.id,
    alias: options.alias,
    createdAt: options.importedAt,
    updatedAt: options.importedAt,
    source: {
      kind: "starter",
      id: starterFlow.id,
      version: starterFlow.version,
      importedAt: options.importedAt,
      templateFingerprint: createTemplateFingerprint(starterFlow.flow),
      templateVariableDefaults: createTemplateVariableDefaults(starterFlow.flow),
      templateSnapshot: createTemplateSnapshot(starterFlow.flow),
    },
  };
};

export interface RalphStarterFlowUpgradeReport {
  applied: boolean;
  strategy: "replace-unmodified" | "three-way-merge" | "blocked";
  fromVersion?: number;
  toVersion: number;
  preservedVariableDefaultNames: string[];
  adoptedVariableDefaultNames: string[];
  addedVariableNames: string[];
  removedVariableNames: string[];
  conflicts: string[];
}

export interface RalphStarterFlowUpgradeResult {
  flow: RalphFlow;
  report: RalphStarterFlowUpgradeReport;
}

const ABSENT_TEMPLATE_VALUE = Symbol("absent-template-value");
type MergeTemplateValue = unknown | typeof ABSENT_TEMPLATE_VALUE;

const canonicalizeTemplateValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeTemplateValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeTemplateValue(entry)]),
  );
};

const templateValuesEqual = (
  left: MergeTemplateValue,
  right: MergeTemplateValue,
): boolean => {
  if (left === ABSENT_TEMPLATE_VALUE || right === ABSENT_TEMPLATE_VALUE) {
    return left === right;
  }

  return JSON.stringify(canonicalizeTemplateValue(left)) ===
    JSON.stringify(canonicalizeTemplateValue(right));
};

const getMergeArrayKey = (arrays: unknown[][]): "id" | "name" | undefined => {
  const values = arrays.flat();

  if (values.length === 0 || values.some((value) => !isRecord(value))) {
    return undefined;
  }
  const records = values.filter(isRecord);
  if (records.every((value) => typeof value.id === "string")) {
    return "id";
  }
  if (records.every((value) => typeof value.name === "string")) {
    return "name";
  }

  return undefined;
};

const describeMergePath = (path: string[]): string => {
  return path.length > 0 ? path.join(".") : "flow";
};

const mergeTemplateValue = (
  base: MergeTemplateValue,
  local: MergeTemplateValue,
  upstream: MergeTemplateValue,
  path: string[],
  conflicts: string[],
): MergeTemplateValue => {
  if (templateValuesEqual(local, base)) {
    return upstream;
  }
  if (templateValuesEqual(upstream, base) || templateValuesEqual(local, upstream)) {
    return local;
  }

  if (
    base !== ABSENT_TEMPLATE_VALUE &&
    local !== ABSENT_TEMPLATE_VALUE &&
    upstream !== ABSENT_TEMPLATE_VALUE &&
    isRecord(base) &&
    isRecord(local) &&
    isRecord(upstream)
  ) {
    const result: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(upstream),
    ]);

    for (const key of keys) {
      const merged = mergeTemplateValue(
        Object.hasOwn(base, key) ? base[key] : ABSENT_TEMPLATE_VALUE,
        Object.hasOwn(local, key) ? local[key] : ABSENT_TEMPLATE_VALUE,
        Object.hasOwn(upstream, key) ? upstream[key] : ABSENT_TEMPLATE_VALUE,
        [...path, key],
        conflicts,
      );

      if (merged !== ABSENT_TEMPLATE_VALUE) {
        result[key] = merged;
      }
    }

    return result;
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(upstream)) {
    const keyName = getMergeArrayKey([base, local, upstream]);

    if (keyName) {
      const toMap = (values: unknown[]): Map<string, unknown> => new Map(
        values.map((value) => [String((value as Record<string, unknown>)[keyName]), value]),
      );
      const baseByKey = toMap(base);
      const localByKey = toMap(local);
      const upstreamByKey = toMap(upstream);
      const orderedKeys = Array.from(new Set([
        ...upstreamByKey.keys(),
        ...localByKey.keys(),
        ...baseByKey.keys(),
      ]));

      return orderedKeys.flatMap((key) => {
        const merged = mergeTemplateValue(
          baseByKey.get(key) ?? ABSENT_TEMPLATE_VALUE,
          localByKey.get(key) ?? ABSENT_TEMPLATE_VALUE,
          upstreamByKey.get(key) ?? ABSENT_TEMPLATE_VALUE,
          [...path, `${keyName}=${key}`],
          conflicts,
        );

        return merged === ABSENT_TEMPLATE_VALUE ? [] : [merged];
      });
    }
  }

  conflicts.push(
    `Starter upgrade conflict at ${describeMergePath(path)}; preserved the local value.`,
  );
  return local;
};

const createComparableImportedSnapshot = (
  existingFlow: RalphFlow,
  template: Omit<RalphFlow, "source" | "createdAt" | "updatedAt">,
): Omit<RalphFlow, "source" | "createdAt" | "updatedAt"> => {
  const comparable = cloneRalphFlow(existingFlow);
  comparable.id = template.id;
  if (template.alias === undefined) {
    delete comparable.alias;
  } else {
    comparable.alias = template.alias;
  }
  delete comparable.createdAt;
  delete comparable.updatedAt;
  delete comparable.source;

  return createTemplateSnapshot(comparable);
};

export const createUpgradedRalphStarterFlowWithReport = (
  existingFlow: RalphFlow,
  starterFlow: RalphStarterFlow,
  updatedAt: string,
): RalphStarterFlowUpgradeResult => {
  const latestTemplateSnapshot = createTemplateSnapshot(starterFlow.flow);
  const structuralConflicts: string[] = [];
  const expectedTemplateFingerprint = existingFlow.source?.templateFingerprint;
  const importedTemplateFingerprint = createImportedTemplateFingerprint(
    existingFlow,
    starterFlow,
  );
  const fingerprintMatches =
    Boolean(expectedTemplateFingerprint) &&
    importedTemplateFingerprint === expectedTemplateFingerprint;
  const legacyPersistedRoundTripMatches =
    existingFlow.source?.version === starterFlow.version &&
    importedTemplateFingerprint === createTemplateFingerprint(starterFlow.flow);
  const baseTemplateSnapshot = existingFlow.source?.templateSnapshot;
  const graphUpgradeConflict = !expectedTemplateFingerprint
    ? "The imported starter has no template fingerprint, so its graph cannot be upgraded without risking local changes. Re-import the latest starter or restore the original graph before upgrading."
    : !fingerprintMatches && !legacyPersistedRoundTripMatches && !baseTemplateSnapshot
      ? "The imported starter graph has local changes but its legacy metadata has no base snapshot for a structural three-way merge. Re-import once to enable mergeable upgrades."
      : null;

  if (graphUpgradeConflict) {
    return {
      flow: cloneRalphFlow(existingFlow),
      report: {
        applied: false,
        strategy: "blocked",
        ...(existingFlow.source?.version !== undefined
          ? { fromVersion: existingFlow.source.version }
          : {}),
        toVersion: starterFlow.version,
        preservedVariableDefaultNames: [],
        adoptedVariableDefaultNames: [],
        addedVariableNames: [],
        removedVariableNames: [],
        conflicts: [graphUpgradeConflict],
      },
    };
  }

  const upgraded = fingerprintMatches || legacyPersistedRoundTripMatches
    ? cloneRalphFlow(starterFlow.flow)
    : cloneRalphFlow(
        mergeTemplateValue(
          baseTemplateSnapshot ?? latestTemplateSnapshot,
          createComparableImportedSnapshot(
            existingFlow,
            baseTemplateSnapshot ?? latestTemplateSnapshot,
          ),
          latestTemplateSnapshot,
          [],
          structuralConflicts,
        ) as RalphFlow,
      );

  const existingVariables = new Map(
    (existingFlow.variables ?? []).map((variable) => [variable.name, variable]),
  );
  const latestVariableNames = new Set(
    (starterFlow.flow.variables ?? []).map((variable) => variable.name),
  );
  const previousTemplateDefaults = existingFlow.source?.templateVariableDefaults;
  const hasPreviousTemplateDefaults = previousTemplateDefaults !== undefined;
  const preservedVariableDefaultNames: string[] = [];
  const adoptedVariableDefaultNames: string[] = [];

  if (upgraded.variables) {
    upgraded.variables = upgraded.variables.map((variable) => {
      const existingVariable = existingVariables.get(variable.name);
      if (!existingVariable) {
        return variable;
      }

      const previousTemplateDefault = previousTemplateDefaults?.[variable.name];
      const isUserOverride =
        !hasPreviousTemplateDefaults ||
        existingVariable.default !== previousTemplateDefault;

      if (isUserOverride) {
        preservedVariableDefaultNames.push(variable.name);
        if (existingVariable.default === undefined) {
          const withoutDefault = { ...variable };
          delete withoutDefault.default;
          return withoutDefault;
        }
        return { ...variable, default: existingVariable.default };
      }

      adoptedVariableDefaultNames.push(variable.name);
      return variable;
    });
  }

  const addedVariableNames = (starterFlow.flow.variables ?? [])
    .filter((variable) => !existingVariables.has(variable.name))
    .map((variable) => variable.name);
  const removedVariableNames = [...existingVariables.keys()].filter(
    (name) => !latestVariableNames.has(name),
  );
  const conflicts = [...structuralConflicts];
  for (const name of removedVariableNames) {
    const previousTemplateDefault = previousTemplateDefaults?.[name];
    const existingVariable = existingVariables.get(name);
    const hadLocalOverride =
      existingVariable !== undefined &&
      (!hasPreviousTemplateDefaults || existingVariable.default !== previousTemplateDefault);

    if (hadLocalOverride || upgraded.variables?.some((variable) => variable.name === name)) {
      conflicts.push(
        `Variable ${name} was removed in starter version ${starterFlow.version}; its locally changed definition was preserved and needs review.`,
      );
    }
  }
  if (!hasPreviousTemplateDefaults) {
    conflicts.unshift(
      "Legacy import has no starter base snapshot; all matching variable defaults were conservatively treated as user overrides.",
    );
  }

  const flow: RalphFlow = {
    ...upgraded,
    id: existingFlow.id,
    ...(existingFlow.alias !== undefined ? { alias: existingFlow.alias } : {}),
    ...(existingFlow.createdAt !== undefined
      ? { createdAt: existingFlow.createdAt }
      : {}),
    updatedAt,
    source: {
      kind: "starter",
      id: starterFlow.id,
      version: starterFlow.version,
      ...(existingFlow.source?.importedAt
        ? { importedAt: existingFlow.source.importedAt }
        : {}),
      templateFingerprint: createTemplateFingerprint(starterFlow.flow),
      templateVariableDefaults: createTemplateVariableDefaults(starterFlow.flow),
      templateSnapshot: createTemplateSnapshot(starterFlow.flow),
    },
  };

  return {
    flow,
    report: {
      applied: true,
      strategy:
        fingerprintMatches || legacyPersistedRoundTripMatches
          ? "replace-unmodified"
          : "three-way-merge",
      ...(existingFlow.source?.version !== undefined
        ? { fromVersion: existingFlow.source.version }
        : {}),
      toVersion: starterFlow.version,
      preservedVariableDefaultNames,
      adoptedVariableDefaultNames,
      addedVariableNames,
      removedVariableNames,
      conflicts,
    },
  };
};

export const createUpgradedRalphStarterFlow = (
  existingFlow: RalphFlow,
  starterFlow: RalphStarterFlow,
  updatedAt: string,
): RalphFlow => {
  return createUpgradedRalphStarterFlowWithReport(
    existingFlow,
    starterFlow,
    updatedAt,
  ).flow;
};
