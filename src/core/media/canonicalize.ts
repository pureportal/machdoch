import { hash as sha256 } from "fast-sha256";
import type { MediaFlow, MediaFlowLayout } from "./contracts.js";

const toHex = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export const canonicalizeMediaValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeMediaValue);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeMediaValue(entry)]),
  );
};

const createExecutionProjection = (flow: MediaFlow): unknown => {
  return {
    schemaVersion: flow.schemaVersion,
    ...(flow.variables.length > 0
      ? {
          variables: [...flow.variables]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(({ id, type, required, defaultValue, constraints }) => ({
              id,
              type,
              required,
              defaultValue,
              constraints,
            })),
        }
      : {}),
    ...(Object.keys(flow.variableBindings).length > 0
      ? { variableBindings: flow.variableBindings }
      : {}),
    nodes: [...flow.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        type: node.type,
        version: node.version,
        config: node.config,
      })),
    edges: [...flow.edges]
      .sort((left, right) => {
        const leftIdentity = [
          left.fromNodeId,
          left.fromPortId,
          left.toNodeId,
          left.toPortId,
          left.id,
        ].join("\u0000");
        const rightIdentity = [
          right.fromNodeId,
          right.fromPortId,
          right.toNodeId,
          right.toPortId,
          right.id,
        ].join("\u0000");

        return leftIdentity.localeCompare(rightIdentity);
      })
      .map((edge) => ({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        fromPortId: edge.fromPortId,
        toNodeId: edge.toNodeId,
        toPortId: edge.toPortId,
      })),
  };
};

const digestCanonicalValue = (value: unknown): string => {
  const canonical = JSON.stringify(canonicalizeMediaValue(value));
  return `sha256:${toHex(sha256(new TextEncoder().encode(canonical)))}`;
};

export const createMediaFlowDocumentDigest = (flow: MediaFlow): string =>
  digestCanonicalValue((() => {
    const {
      variables,
      variableBindings,
      presets,
      activePresetId,
      ...document
    } = flow;
    return {
      ...document,
      ...(variables.length > 0 ? { variables } : {}),
      ...(Object.keys(variableBindings).length > 0 ? { variableBindings } : {}),
      ...(presets.length > 0 ? { presets } : {}),
      ...(activePresetId !== null ? { activePresetId } : {}),
    };
  })());

export const createMediaFlowLayoutDigest = (
  layout: MediaFlowLayout,
): string =>
  digestCanonicalValue({
    schemaVersion: layout.schemaVersion,
    flowId: layout.flowId,
    nodes: [...layout.nodes].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    ...(layout.groups.length > 0
      ? {
          groups: [...layout.groups]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((group) => ({
              ...group,
              nodeIds: [...group.nodeIds].sort((left, right) =>
                left.localeCompare(right),
              ),
            })),
        }
      : {}),
    ...(layout.comments.length > 0
      ? {
          comments: [...layout.comments].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
        }
      : {}),
  });

export const createMediaFlowFingerprint = (flow: MediaFlow): string => {
  return digestCanonicalValue(createExecutionProjection(flow));
};
