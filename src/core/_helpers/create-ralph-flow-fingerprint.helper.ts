import { hash as sha256 } from "fast-sha256";
import type { RalphFlow } from "../ralph.js";

export const canonicalizeRalphValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeRalphValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeRalphValue(entry)]),
  );
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const createRalphFlowFingerprint = (flow: RalphFlow): string => {
  const semanticFlow = {
    schemaVersion: flow.schemaVersion,
    id: flow.id,
    alias: flow.alias,
    name: flow.name,
    description: flow.description,
    settings: flow.settings,
    variables: flow.variables,
    blocks: flow.blocks,
    edges: flow.edges,
    annotationLinks: flow.annotationLinks,
  };
  const canonicalFlow = JSON.stringify(canonicalizeRalphValue(semanticFlow));

  return toHex(sha256(new TextEncoder().encode(canonicalFlow)));
};
