import { canonicalizeMediaValue } from "./canonicalize.js";
import type {
  MediaFlowEdge,
  MediaFlowNode,
  MediaFlowRevision,
  MediaFlowRevisionDiff,
  MediaFlowRevisionEdgeChange,
  MediaFlowRevisionLayoutChange,
  MediaFlowRevisionNodeChange,
  MediaFlowRevisionPresetChange,
  MediaFlowRevisionVariableChange,
} from "./contracts.js";

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalizeMediaValue(left)) ===
  JSON.stringify(canonicalizeMediaValue(right));

const compareNodes = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionNodeChange[] => {
  const baseById = new Map(base.flow.nodes.map((node) => [node.id, node]));
  const targetById = new Map(
    target.flow.nodes.map((node) => [node.id, node]),
  );
  const nodeIds = [...new Set([...baseById.keys(), ...targetById.keys()])].sort();

  return nodeIds.flatMap((nodeId) => {
    const before = baseById.get(nodeId);
    const after = targetById.get(nodeId);
    if (!before && after) {
      return [createAddedOrRemovedNodeChange(after, "added")];
    }
    if (before && !after) {
      return [createAddedOrRemovedNodeChange(before, "removed")];
    }
    if (!before || !after) {
      return [];
    }
    const changedFields = changedNodeFields(before, after);
    if (changedFields.length === 0) {
      return [];
    }
    return [
      {
        nodeId,
        nodeLabel: after.label,
        kind: "modified" as const,
        changedFields,
        executionAffecting: changedFields.some(
          (field) =>
            field === "type" ||
            field === "version" ||
            field.startsWith("config."),
        ),
      },
    ];
  });
};

const createAddedOrRemovedNodeChange = (
  node: MediaFlowNode,
  kind: "added" | "removed",
): MediaFlowRevisionNodeChange => ({
  nodeId: node.id,
  nodeLabel: node.label,
  kind,
  changedFields: ["node"],
  executionAffecting: true,
});

const changedNodeFields = (
  before: MediaFlowNode,
  after: MediaFlowNode,
): string[] => {
  const changed: string[] = [];
  if (before.type !== after.type) changed.push("type");
  if (before.version !== after.version) changed.push("version");
  if (before.label !== after.label) changed.push("label");
  if (before.layer !== after.layer) changed.push("layer");
  const configKeys = [
    ...new Set([...Object.keys(before.config), ...Object.keys(after.config)]),
  ].sort();
  for (const key of configKeys) {
    if (!canonicalEqual(before.config[key], after.config[key])) {
      changed.push(`config.${key}`);
    }
  }
  return changed;
};

const edgeIdentity = (edge: MediaFlowEdge): string =>
  `${edge.fromNodeId}.${edge.fromPortId} → ${edge.toNodeId}.${edge.toPortId}`;

const compareEdges = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionEdgeChange[] => {
  const baseById = new Map(base.flow.edges.map((edge) => [edge.id, edge]));
  const targetById = new Map(
    target.flow.edges.map((edge) => [edge.id, edge]),
  );
  const edgeIds = [...new Set([...baseById.keys(), ...targetById.keys()])].sort();
  const changes: MediaFlowRevisionEdgeChange[] = [];
  for (const edgeId of edgeIds) {
    const before = baseById.get(edgeId);
    const after = targetById.get(edgeId);
    if (!before && after) {
      changes.push({ edgeId, kind: "added", description: edgeIdentity(after) });
      continue;
    }
    if (before && !after) {
      changes.push(
        { edgeId, kind: "removed" as const, description: edgeIdentity(before) },
      );
      continue;
    }
    if (!before || !after || canonicalEqual(before, after)) {
      continue;
    }
    changes.push({
      edgeId,
      kind: "modified",
      description: `${edgeIdentity(before)} → ${edgeIdentity(after)}`,
    });
  }
  return changes;
};

const compareLayout = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionLayoutChange[] => {
  const baseById = new Map(
    base.layout.nodes.map(({ nodeId, x, y }) => [nodeId, { x, y }]),
  );
  const targetById = new Map(
    target.layout.nodes.map(({ nodeId, x, y }) => [nodeId, { x, y }]),
  );
  const nodeIds = [...new Set([...baseById.keys(), ...targetById.keys()])].sort();
  const changes: MediaFlowRevisionLayoutChange[] = [];
  for (const nodeId of nodeIds) {
    const before = baseById.get(nodeId) ?? null;
    const after = targetById.get(nodeId) ?? null;
    if (!before && after) {
      changes.push({ nodeId, kind: "added", before, after });
      continue;
    }
    if (before && !after) {
      changes.push({ nodeId, kind: "removed", before, after });
      continue;
    }
    if (
      !before ||
      !after ||
      (before.x === after.x && before.y === after.y)
    ) {
      continue;
    }
    changes.push({ nodeId, kind: "modified", before, after });
  }
  return changes;
};

const compareVariables = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionVariableChange[] => {
  const beforeById = new Map(base.flow.variables.map((variable) => [variable.id, variable]));
  const afterById = new Map(target.flow.variables.map((variable) => [variable.id, variable]));
  const changes: MediaFlowRevisionVariableChange[] = [];
  for (const variableId of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) {
    const before = beforeById.get(variableId);
    const after = afterById.get(variableId);
    if (!before && after) {
      changes.push({ variableId, variableName: after.name, kind: "added", changedFields: ["variable"], executionAffecting: true });
      continue;
    }
    if (before && !after) {
      changes.push({ variableId, variableName: before.name, kind: "removed", changedFields: ["variable"], executionAffecting: true });
      continue;
    }
    if (!before || !after) continue;
    const changedFields: string[] = (["name", "description", "type", "required", "defaultValue", "constraints"] as const)
      .filter((field) => !canonicalEqual(before[field], after[field]));
    const beforeHasBinding = Object.hasOwn(base.flow.variableBindings, variableId);
    const afterHasBinding = Object.hasOwn(target.flow.variableBindings, variableId);
    if (
      beforeHasBinding !== afterHasBinding ||
      (beforeHasBinding && !canonicalEqual(base.flow.variableBindings[variableId], target.flow.variableBindings[variableId]))
    ) {
      changedFields.push("binding");
    }
    if (changedFields.length === 0) continue;
    changes.push({
      variableId,
      variableName: after.name,
      kind: "modified",
      changedFields,
      executionAffecting: changedFields.some((field) => field !== "name" && field !== "description"),
    });
  }
  return changes;
};

const comparePresets = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionPresetChange[] => {
  const beforeById = new Map(base.flow.presets.map((preset) => [preset.id, preset]));
  const afterById = new Map(target.flow.presets.map((preset) => [preset.id, preset]));
  const changes: MediaFlowRevisionPresetChange[] = [];
  for (const presetId of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) {
    const before = beforeById.get(presetId);
    const after = afterById.get(presetId);
    if (!before && after) {
      changes.push({ presetId, presetName: after.name, kind: "added", changedFields: ["preset"] });
      continue;
    }
    if (before && !after) {
      changes.push({ presetId, presetName: before.name, kind: "removed", changedFields: ["preset"] });
      continue;
    }
    if (!before || !after) continue;
    const changedFields: string[] = (["name", "description", "values"] as const)
      .filter((field) => !canonicalEqual(before[field], after[field]));
    const beforeActive = base.flow.activePresetId === presetId;
    const afterActive = target.flow.activePresetId === presetId;
    if (beforeActive !== afterActive) changedFields.push("active");
    if (changedFields.length > 0) {
      changes.push({ presetId, presetName: after.name, kind: "modified", changedFields });
    }
  }
  return changes;
};

export const createMediaFlowRevisionDiff = (
  base: MediaFlowRevision,
  target: MediaFlowRevision,
): MediaFlowRevisionDiff => {
  if (base.flowId !== target.flowId) {
    throw new Error("Flow revisions can only be compared within one flow identity.");
  }
  const metadataFieldsChanged = (
    ["name", "description", "createdAt", "updatedAt"] as const
  ).filter((field) => base.flow[field] !== target.flow[field]);

  return {
    schemaVersion: 1,
    baseRevisionId: base.revisionId,
    targetRevisionId: target.revisionId,
    documentChanged: base.documentDigest !== target.documentDigest,
    executionChanged: base.executionDigest !== target.executionDigest,
    layoutChanged: base.layoutDigest !== target.layoutDigest,
    metadataFieldsChanged,
    nodeChanges: compareNodes(base, target),
    edgeChanges: compareEdges(base, target),
    layoutChanges: compareLayout(base, target),
    variableChanges: compareVariables(base, target),
    presetChanges: comparePresets(base, target),
  };
};
