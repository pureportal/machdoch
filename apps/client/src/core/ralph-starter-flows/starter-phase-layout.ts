import type { RalphFlow, RalphGroupBlock } from "../ralph.js";
import type { RalphStarterFlowId } from "../ralph-starter-flows.js";

export interface RalphStarterPhase {
  id: string;
  title: string;
  childBlockIds: readonly string[];
}

export const layoutRalphStarterPhases = (
  flow: RalphFlow,
  phases: readonly RalphStarterPhase[],
): RalphFlow => {
  const blocksById = new Map(flow.blocks.map((block) => [block.id, block]));
  const placedIds = new Set<string>();
  const tones = ["amber", "lime", "sky", "slate"] as const;
  const blocks = phases.flatMap((phase, phaseIndex) => {
    const origin = { x: phaseIndex * 896, y: 0 };
    const children = phase.childBlockIds.map((id, index) => {
      const block = blocksById.get(id);
      if (!block || placedIds.has(id)) {
        throw new Error(`Invalid starter phase member: ${id}.`);
      }
      placedIds.add(id);
      return {
        ...block,
        parentGroupId: phase.id,
        position: {
          x: origin.x + 56 + (index % 2) * 396,
          y: 88 + Math.floor(index / 2) * 400,
        },
        size: { width: 300, height: Math.max(220, block.size?.height ?? 220) },
      };
    });
    const group: RalphGroupBlock = {
      id: phase.id,
      type: "GROUP",
      title: phase.title,
      tone: tones[phaseIndex % tones.length]!,
      position: origin,
      size: { width: 808, height: 144 + Math.ceil(children.length / 2) * 400 },
      childBlockIds: [...phase.childBlockIds],
      collapsed: true,
      moveChildren: true,
      layoutMode: "freeform",
      executionBoundary: { mode: "none" },
    };
    return [group, ...children];
  });
  if (placedIds.size !== flow.blocks.length) {
    throw new Error("Every starter block must belong to exactly one phase.");
  }
  return { ...flow, blocks };
};

type GroupedStarterId = Exclude<
  RalphStarterFlowId,
  "full-feature-implementation"
>;

const stageDefinitions = {
  "autonomous-feature-generation-loop": {
    titles: ["Discover", "Implement", "Verify", "Record outcome"],
    starts: [
      "start",
      "read-canonical-active-goal",
      "verification-decision",
      "read-completed-goal",
    ],
    lateVerification: [],
  },
  "autonomous-code-improvement-loop": {
    titles: ["Discover", "Improve", "Verify", "Record outcome"],
    starts: [
      "start",
      "read-active-improvement",
      "verification-decision",
      "read-completed-improvement-plan",
    ],
    lateVerification: [],
  },
  "autonomous-ui-improvement-loop": {
    titles: ["Inspect", "Improve", "Verify", "Record outcome"],
    starts: [
      "start",
      "git-snapshot-before",
      "select-verification-command",
      "final-report",
    ],
    lateVerification: [],
  },
  "autonomous-refactoring-flow": {
    titles: ["Analyze", "Refactor", "Verify", "Record outcome"],
    starts: [
      "start",
      "git-snapshot-before",
      "validation-decision",
      "final-report",
    ],
    lateVerification: [
      "scope-change-guard",
      "refactor-progress-analysis",
      "refactor-progress-produced",
    ],
  },
  "security-fix-loop": {
    titles: ["Audit", "Fix", "Verify", "Record outcome"],
    starts: [
      "start",
      "baseline-verification",
      "verification-decision",
      "final-report",
    ],
    lateVerification: ["scope-change-guard"],
  },
} as const satisfies Record<
  GroupedStarterId,
  {
    titles: readonly string[];
    starts: readonly string[];
    lateVerification: readonly string[];
  }
>;

export const layoutGroupedRalphStarterFlow = (
  id: GroupedStarterId,
  flow: RalphFlow,
): RalphFlow => {
  const definition = stageDefinitions[id];
  const indexes = definition.starts.map((start) =>
    flow.blocks.findIndex((block) => block.id === start),
  );
  if (
    indexes.some(
      (index, position) =>
        index < 0 || (position > 0 && index <= indexes[position - 1]!),
    )
  ) {
    throw new Error(`Invalid stage boundaries for starter ${id}.`);
  }
  const verificationIds = new Set<string>(definition.lateVerification);
  const phases = indexes.map((index, phaseIndex) => ({
    id: `${id}-phase-${phaseIndex + 1}`,
    title: definition.titles[phaseIndex]!,
    childBlockIds: flow.blocks
      .slice(index, indexes[phaseIndex + 1] ?? flow.blocks.length)
      .map((block) => block.id)
      .filter((blockId) => !verificationIds.has(blockId)),
  }));
  phases[2]!.childBlockIds.push(...verificationIds);
  return layoutRalphStarterPhases(flow, phases);
};
