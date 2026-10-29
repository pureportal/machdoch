import {
  managedSecretPlaceholderPattern,
  managedSettingsPolicyFields,
  type FleetManagedMcpServer,
  type FleetManagedSettingsDocument,
  type ManagedSettingsPolicyField,
} from "@machdoch/fleet-protocol";

/**
 * Identity used to match instructions and context packs across sources. It
 * folds case the way the device's instruction library detects duplicate names
 * (upper then lower case, so "Straße" and "STRASSE" are one item).
 */
export const normalizeManagedItemName = (value: string): string =>
  value.trim().normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");

/** Identity used to match prompts across sources. */
export const normalizeManagedPromptPath = (value: string): string =>
  value.trim().toLocaleLowerCase("en-US");

export const managedSecretPolicyKey = (secretId: string): string =>
  `secret:${secretId}`;

/**
 * Documents written before schema version 3 have no policy; every value they
 * configure keeps the historical "always wins" behavior.
 */
export const isManagedSettingEnforced = (
  document: Pick<FleetManagedSettingsDocument, "policy">,
  key: string,
): boolean =>
  document.policy === undefined || document.policy.enforced.includes(key);

type FieldAccess = {
  isSet: (document: FleetManagedSettingsDocument) => boolean;
  copy: (
    target: FleetManagedSettingsDocument,
    source: FleetManagedSettingsDocument,
  ) => void;
};

const defaultsField = (
  key: Exclude<
    keyof FleetManagedSettingsDocument["defaults"],
    "provider" | "model"
  >,
): FieldAccess => ({
  isSet: (document) => document.defaults[key] !== null,
  copy: (target, source) => {
    target.defaults[key] = source.defaults[key];
  },
});

const agentLimitField = (
  key: keyof FleetManagedSettingsDocument["agentLimits"],
): FieldAccess => ({
  isSet: (document) => document.agentLimits[key] !== null,
  copy: (target, source) => {
    Object.assign(target.agentLimits, { [key]: source.agentLimits[key] });
  },
});

export const managedSettingsFieldAccess: Record<
  ManagedSettingsPolicyField,
  FieldAccess
> = {
  model: {
    isSet: (document) => document.defaults.provider !== null,
    copy: (target, source) => {
      target.defaults.provider = source.defaults.provider;
      target.defaults.model = source.defaults.model;
    },
  },
  mode: defaultsField("mode"),
  reasoning: defaultsField("reasoning"),
  webSearchProvider: defaultsField("webSearchProvider"),
  theme: defaultsField("theme"),
  density: defaultsField("density"),
  accent: defaultsField("accent"),
  infinite: agentLimitField("infinite"),
  executorTurns: agentLimitField("executorTurns"),
  autopilotExecutorIterations: agentLimitField("autopilotExecutorIterations"),
};

export const emptyManagedSettingsDocument =
  (): FleetManagedSettingsDocument => ({
    defaults: {
      provider: null,
      model: null,
      mode: null,
      reasoning: null,
      webSearchProvider: null,
      theme: null,
      density: null,
      accent: null,
    },
    agentLimits: {
      infinite: null,
      executorTurns: null,
      autopilotExecutorIterations: null,
    },
    instructions: [],
    contextPacks: [],
    prompts: [],
    policy: { enforced: [] },
    mcpServers: [],
  });

/** Returns the policy with every implicit legacy enforcement made explicit. */
export function explicitManagedSettingsPolicy(
  document: FleetManagedSettingsDocument,
  secretIds: Iterable<string>,
): string[] {
  if (document.policy) return [...document.policy.enforced];
  return [
    ...managedSettingsPolicyFields.filter((field) =>
      managedSettingsFieldAccess[field].isSet(document),
    ),
    ...[...secretIds].map(managedSecretPolicyKey),
  ];
}

export interface ManagedSettingsLayerSource {
  document: FleetManagedSettingsDocument;
  secrets: Record<string, string>;
}

/**
 * Combines assigned profiles, highest priority first. Enforced values beat
 * defaults from any layer; otherwise the earlier layer wins. Collections are
 * merged by name (prompts by path, MCP servers by id), earlier layers first.
 */
export function composeManagedSettingsLayers(
  layers: ManagedSettingsLayerSource[],
): ManagedSettingsLayerSource {
  const document = emptyManagedSettingsDocument();
  const enforced: string[] = [];
  const secrets: Record<string, string> = {};
  const pick = <T>(
    candidates: T[],
    isEnforced: (candidate: T) => boolean,
  ): { candidate: T; enforced: boolean } | null => {
    const strong = candidates.find(isEnforced);
    if (strong) return { candidate: strong, enforced: true };
    const first = candidates[0];
    return first === undefined ? null : { candidate: first, enforced: false };
  };
  for (const field of managedSettingsPolicyFields) {
    const access = managedSettingsFieldAccess[field];
    const chosen = pick(
      layers.filter((layer) => access.isSet(layer.document)),
      (layer) => isManagedSettingEnforced(layer.document, field),
    );
    if (!chosen) continue;
    access.copy(document, chosen.candidate.document);
    if (chosen.enforced) enforced.push(field);
  }
  const secretIds = [
    ...new Set(layers.flatMap((layer) => Object.keys(layer.secrets))),
  ].sort();
  for (const secretId of secretIds) {
    const key = managedSecretPolicyKey(secretId);
    const chosen = pick(
      layers.filter((layer) => layer.secrets[secretId] !== undefined),
      (layer) => isManagedSettingEnforced(layer.document, key),
    );
    if (!chosen) continue;
    secrets[secretId] = chosen.candidate.secrets[secretId]!;
    if (chosen.enforced) enforced.push(key);
  }
  const union = <T extends { id: string }>(
    items: (layer: ManagedSettingsLayerSource) => T[],
    identity: (item: T) => string,
  ): T[] => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    const merged: T[] = [];
    for (const layer of layers) {
      for (const item of items(layer)) {
        const key = identity(item);
        if (ids.has(item.id) || keys.has(key)) continue;
        ids.add(item.id);
        keys.add(key);
        merged.push(structuredClone(item));
      }
    }
    return merged;
  };
  document.instructions = union(
    (layer) => layer.document.instructions,
    (item) => normalizeManagedItemName(item.name),
  );
  document.contextPacks = union(
    (layer) => layer.document.contextPacks,
    (item) => normalizeManagedItemName(item.name),
  );
  document.prompts = union(
    (layer) => layer.document.prompts,
    (item) => normalizeManagedPromptPath(item.relativePath),
  );
  document.mcpServers = union(
    (layer) => layer.document.mcpServers ?? [],
    (item) => item.id,
  );
  document.policy = { enforced };
  return { document, secrets };
}

/** Removes schema version 3 fields for clients that only accept version 2. */
export function toLegacyManagedSettingsDocument(
  document: FleetManagedSettingsDocument,
): FleetManagedSettingsDocument {
  const { policy: _policy, mcpServers: _mcpServers, ...legacy } = document;
  return legacy;
}

// A fresh global copy per call keeps the shared pattern free of lastIndex state.
const placeholders = (): RegExp =>
  new RegExp(managedSecretPlaceholderPattern.source, "gu");

export function managedSecretReferences(value: string): string[] {
  return [...value.matchAll(placeholders())].map((match) => match[1]!);
}

export function managedMcpServerSecretReferences(
  server: FleetManagedMcpServer,
): string[] {
  const values =
    server.transport.type === "stdio"
      ? [
          server.transport.command,
          ...server.transport.args,
          ...Object.values(server.transport.env),
        ]
      : [server.transport.url, ...Object.values(server.transport.headers)];
  return [...new Set(values.flatMap(managedSecretReferences))].sort();
}

/** Replaces `{{secret:<id>}}` placeholders; unknown ids are reported. */
export function substituteManagedSecrets(
  value: string,
  secrets: Record<string, string>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const substituted = value.replaceAll(
    placeholders(),
    (placeholder, secretId: string) => {
      const secret = secrets[secretId];
      if (secret !== undefined) return secret;
      missing.push(secretId);
      return placeholder;
    },
  );
  return { value: substituted, missing: [...new Set(missing)] };
}
