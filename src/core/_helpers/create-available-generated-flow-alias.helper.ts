import { normalizeRalphFlowLayout } from "../ralph-layout.js";
import {
  listRalphFlows,
  normalizeFlowAlias,
  writeRalphFlow,
  type RalphFlow,
  type RalphFlowScope,
} from "../ralph.js";

const MAX_RALPH_GENERATED_FLOW_ALIAS_LENGTH = 80;
const MAX_RALPH_GENERATED_FLOW_ALIAS_ATTEMPTS = 1_000;
const MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS = 5;

export const isRalphFlowAliasCollisionError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    /^Ralph flow alias `[^`]+` is already used by `[^`]+`\.$/u.test(error.message)
  );
};

export const createGeneratedFlowAliasCandidate = (
  baseAlias: string,
  suffix: number,
): string => {
  if (suffix === 0) {
    return baseAlias;
  }

  const suffixText = `-${suffix}`;
  const maxBaseLength = Math.max(
    1,
    MAX_RALPH_GENERATED_FLOW_ALIAS_LENGTH - suffixText.length,
  );
  const trimmedBase = baseAlias.slice(0, maxBaseLength).replace(/-+$/gu, "");
  const candidate = normalizeFlowAlias(`${trimmedBase}${suffixText}`);

  if (!candidate) {
    throw new Error("Expected a Ralph flow alias candidate.");
  }

  return candidate;
};

const collectUnavailableGeneratedFlowAliases = async (
  workspaceRoot: string,
  scope: RalphFlowScope,
  currentFlowId: string,
): Promise<Set<string>> => {
  const unavailableAliases = new Set<string>();
  const normalizedCurrentFlowId = normalizeFlowAlias(currentFlowId);
  const flowSummaries = await listRalphFlows(workspaceRoot, { scope });

  for (const summary of flowSummaries) {
    const existingId = normalizeFlowAlias(summary.id);

    if (existingId && existingId !== normalizedCurrentFlowId) {
      unavailableAliases.add(existingId);
    }

    if (summary.alias) {
      const existingAlias = normalizeFlowAlias(summary.alias);

      if (existingAlias && existingId !== normalizedCurrentFlowId) {
        unavailableAliases.add(existingAlias);
      }
    }
  }

  return unavailableAliases;
};

export const createAvailableGeneratedFlowAlias = async (
  workspaceRoot: string,
  scope: RalphFlowScope,
  preferredAlias: string,
  currentFlowId: string,
): Promise<string> => {
  if (typeof preferredAlias !== "string") {
    throw new Error("Expected a Ralph flow alias before generation.");
  }

  const baseAlias = normalizeFlowAlias(preferredAlias);

  if (!baseAlias) {
    throw new Error("Expected a Ralph flow alias before generation.");
  }

  const unavailableAliases = await collectUnavailableGeneratedFlowAliases(
    workspaceRoot,
    scope,
    currentFlowId,
  );

  for (
    let suffix = 0;
    suffix < MAX_RALPH_GENERATED_FLOW_ALIAS_ATTEMPTS;
    suffix += 1
  ) {
    const candidate = createGeneratedFlowAliasCandidate(baseAlias, suffix);

    if (!unavailableAliases.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not allocate a unique Ralph flow alias from \`${preferredAlias}\`.`,
  );
};

export const writeGeneratedRalphFlowWithAliasFallback = async (
  workspaceRoot: string,
  flow: RalphFlow,
  options: {
    scope: RalphFlowScope;
    fallbackAliasBase: string;
    allowAliasFallback: boolean;
    expectedFingerprint?: string;
  },
): Promise<RalphFlow> => {
  let writableFlow = flow;

  for (
    let attempt = 1;
    attempt <= MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await writeRalphFlow(workspaceRoot, writableFlow, {
        createRevision: true,
        scope: options.scope,
        ...(options.expectedFingerprint
          ? { expectedFingerprint: options.expectedFingerprint }
          : {}),
      });

      return writableFlow;
    } catch (error) {
      if (
        !options.allowAliasFallback ||
        !isRalphFlowAliasCollisionError(error) ||
        attempt >= MAX_RALPH_GENERATED_FLOW_ALIAS_WRITE_ATTEMPTS
      ) {
        throw error;
      }

      const fallbackAlias = await createAvailableGeneratedFlowAlias(
        workspaceRoot,
        options.scope,
        writableFlow.alias ?? options.fallbackAliasBase,
        writableFlow.id,
      );

      writableFlow = normalizeRalphFlowLayout({
        ...writableFlow,
        alias: fallbackAlias,
      });
    }
  }

  return writableFlow;
};
