import type { ChatInputNeededPlaceholder } from "../composer/chat-input-needed-placeholders";
import { extractChatInputNeededPlaceholders } from "../composer/chat-input-needed-placeholders";
import { MAX_REQUEST_ITERATIONS } from "../composer/model";
import {
  areSmartContextPackWorkspacesEqual,
  getSmartContextPackScope,
  getSmartContextPackSortTimestamp,
  getSmartContextPacksForWorkspace,
} from "./helpers";
import type {
  ContextPackFlow,
  ContextPackFlowStep,
  SmartContextPack,
  SmartContextPackScope,
} from "./model";

export const MAX_CONTEXT_PACK_FLOW_STEPS = MAX_REQUEST_ITERATIONS;
export const MAX_CONTEXT_PACK_FLOWS = 100;

export type ContextPackFlowStepIssue = "missing-pack" | "empty-pack";

export interface ResolvedContextPackFlowStep {
  step: ContextPackFlowStep;
  pack: SmartContextPack | null;
  issue: ContextPackFlowStepIssue | null;
}

export const getContextPackFlowsForWorkspace = (
  flows: ContextPackFlow[],
  workspace: string | null,
): ContextPackFlow[] =>
  flows
    .filter(
      (flow) =>
        getSmartContextPackScope(flow) === "global" ||
        areSmartContextPackWorkspacesEqual(flow.workspace, workspace),
    )
    .sort(
      (left, right) =>
        getSmartContextPackSortTimestamp(right) -
        getSmartContextPackSortTimestamp(left),
    );

export const getContextPackFlowPackOptions = (
  packs: SmartContextPack[],
  scope: SmartContextPackScope,
  workspace: string | null,
): SmartContextPack[] =>
  scope === "global"
    ? packs.filter((pack) => getSmartContextPackScope(pack) === "global")
    : getSmartContextPacksForWorkspace(packs, workspace);

export const isContextPackFlowStepPackEmpty = (
  pack: SmartContextPack,
): boolean =>
  !pack.instructions.trim() &&
  !pack.prompt.trim() &&
  pack.contextAttachments.length === 0;

export const resolveContextPackFlowSteps = (
  flow: Pick<ContextPackFlow, "steps"> & { workspace: string | null },
  packs: SmartContextPack[],
): ResolvedContextPackFlowStep[] => {
  const availablePacks = getContextPackFlowPackOptions(
    packs,
    getSmartContextPackScope(flow),
    flow.workspace,
  );

  return flow.steps.map((step) => {
    const pack = availablePacks.find((entry) => entry.id === step.packId);

    if (!pack) {
      return { step, pack: null, issue: "missing-pack" };
    }

    return {
      step,
      pack,
      issue: isContextPackFlowStepPackEmpty(pack) ? "empty-pack" : null,
    };
  });
};

export const getContextPackFlowStepIssueLabel = (
  issue: ContextPackFlowStepIssue,
): string =>
  issue === "missing-pack" ? "Pack unavailable" : "Pack has no prompt";

export const getContextPackFlowIssue = (
  resolvedSteps: ResolvedContextPackFlowStep[],
): string | null => {
  if (resolvedSteps.length === 0) {
    return "Add at least one step";
  }

  if (resolvedSteps.length > MAX_CONTEXT_PACK_FLOW_STEPS) {
    return `Use at most ${MAX_CONTEXT_PACK_FLOW_STEPS} steps`;
  }

  const issueIndex = resolvedSteps.findIndex((entry) => entry.issue);
  const issue = resolvedSteps[issueIndex]?.issue;

  return issue
    ? `Step ${issueIndex + 1}: ${getContextPackFlowStepIssueLabel(issue)}`
    : null;
};

export const getContextPackFlowStepDropIndex = (
  fromIndex: number,
  dropSlot: number,
  stepCount: number,
): number | null => {
  if (
    fromIndex < 0 ||
    fromIndex >= stepCount ||
    dropSlot < 0 ||
    dropSlot > stepCount
  ) {
    return null;
  }

  const targetIndex = dropSlot > fromIndex ? dropSlot - 1 : dropSlot;

  return targetIndex === fromIndex ? null : targetIndex;
};

export const moveContextPackFlowStep = <Step>(
  steps: Step[],
  fromIndex: number,
  toIndex: number,
): Step[] => {
  const moved = steps[fromIndex];

  if (
    moved === undefined ||
    toIndex < 0 ||
    toIndex >= steps.length ||
    fromIndex === toIndex
  ) {
    return steps;
  }

  const next = steps.filter((_, index) => index !== fromIndex);
  next.splice(toIndex, 0, moved);

  return next;
};

export const matchesContextPackFlowSearch = (
  flow: ContextPackFlow,
  packs: SmartContextPack[],
  query: string,
): boolean => {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);

  if (terms.length === 0) {
    return true;
  }

  const packNames = new Map(packs.map((pack) => [pack.id, pack.name]));
  const haystack = [
    flow.name,
    ...flow.steps.map((step) => packNames.get(step.packId) ?? ""),
  ]
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
};

const getPackPlaceholders = (
  pack: SmartContextPack,
): ChatInputNeededPlaceholder[] => {
  const placeholders = extractChatInputNeededPlaceholders(
    `${pack.instructions}\n${pack.prompt}`,
  );

  for (const variable of pack.variables) {
    const lookupKey = variable.name.toLowerCase();
    const existing = placeholders.find(
      (placeholder) => placeholder.lookupKey === lookupKey,
    );

    if (existing) {
      existing.occurrenceCount += 1;
      existing.defaultValue ??= variable.defaultValue;
      delete existing.optional;
      continue;
    }

    placeholders.push({
      key: variable.name,
      lookupKey,
      occurrenceCount: 1,
      ...(variable.defaultValue ? { defaultValue: variable.defaultValue } : {}),
    });
  }

  return placeholders;
};

export const collectContextPackFlowPlaceholders = (
  packs: SmartContextPack[],
  rememberedValues: Record<string, string>,
): ChatInputNeededPlaceholder[] => {
  const placeholders: ChatInputNeededPlaceholder[] = [];
  const placeholderByLookupKey = new Map<string, ChatInputNeededPlaceholder>();

  for (const pack of packs) {
    for (const placeholder of getPackPlaceholders(pack)) {
      if (Object.hasOwn(rememberedValues, placeholder.lookupKey)) {
        continue;
      }

      const existing = placeholderByLookupKey.get(placeholder.lookupKey);

      if (!existing) {
        const entry = { ...placeholder };
        placeholderByLookupKey.set(placeholder.lookupKey, entry);
        placeholders.push(entry);
        continue;
      }

      existing.occurrenceCount += placeholder.occurrenceCount;
      existing.defaultValue ??= placeholder.defaultValue;
      existing.options ??= placeholder.options;

      if (!placeholder.optional) {
        delete existing.optional;
      }
    }
  }

  return placeholders;
};
