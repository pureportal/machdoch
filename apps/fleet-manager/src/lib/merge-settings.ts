import type { FleetManagedSettingsDocument as ManagedSettingsDocument } from "@machdoch/fleet-protocol";

export interface SettingsMergeConflict {
  key: string;
  label: string;
  profileValue: unknown;
  deviceValue: unknown;
}
export type SettingsMergeChoices = Record<string, "profile" | "device">;
const settingLabels = {
  mode: "Mode",
  reasoning: "Reasoning",
  webSearchProvider: "Web search",
  theme: "Theme",
  density: "Density",
  accent: "Accent",
  infinite: "Unlimited turns",
  executorTurns: "Executor turns",
  autopilotExecutorIterations: "Autopilot iterations",
};

export function mergeSettings(
  profile: ManagedSettingsDocument,
  device: ManagedSettingsDocument,
  choices: SettingsMergeChoices = {},
): {
  document: ManagedSettingsDocument;
  conflicts: SettingsMergeConflict[];
  additions: Array<{ label: string; value: unknown }>;
} {
  const document = structuredClone(profile);
  const conflicts: SettingsMergeConflict[] = [];
  const additions: Array<{ label: string; value: unknown }> = [];
  const choose = (
    key: string,
    label: string,
    current: unknown,
    incoming: unknown,
  ): boolean => {
    if (JSON.stringify(current) === JSON.stringify(incoming)) return false;
    conflicts.push({
      key,
      label,
      profileValue: current,
      deviceValue: incoming,
    });
    return choices[key] === "device";
  };
  if (device.defaults.provider !== null) {
    const current = {
      provider: profile.defaults.provider,
      model: profile.defaults.model,
    };
    const incoming = {
      provider: device.defaults.provider,
      model: device.defaults.model,
    };
    if (
      current.provider === null ||
      choose("defaults.model", "Model", current, incoming)
    ) {
      if (current.provider === null)
        additions.push({ label: "Model", value: incoming });
      Object.assign(document.defaults, incoming);
    }
  }
  for (const key of Object.keys(device.defaults) as Array<
    keyof ManagedSettingsDocument["defaults"]
  >) {
    if (key === "provider" || key === "model" || device.defaults[key] === null)
      continue;
    const current = profile.defaults[key];
    const incoming = device.defaults[key];
    const label = settingLabels[key];
    if (
      current === null ||
      choose(`defaults.${key}`, label, current, incoming)
    ) {
      if (current === null) additions.push({ label, value: incoming });
      document.defaults[key] = incoming;
    }
  }
  for (const key of Object.keys(device.agentLimits) as Array<
    keyof ManagedSettingsDocument["agentLimits"]
  >) {
    const incoming = device.agentLimits[key];
    if (incoming === null) continue;
    const current = profile.agentLimits[key];
    const label = settingLabels[key];
    if (
      current === null ||
      choose(`agentLimits.${key}`, label, current, incoming)
    ) {
      if (current === null) additions.push({ label, value: incoming });
      Object.assign(document.agentLimits, { [key]: incoming });
    }
  }
  const mergeCollection = <T extends { id: string }>(
    section: string,
    target: T[],
    source: T[],
    identity: (item: T) => string,
    label: (item: T) => string,
  ): T[] => {
    const merged = structuredClone(target);
    for (const incoming of source) {
      const index = merged.findIndex(
        (item) =>
          item.id === incoming.id || identity(item) === identity(incoming),
      );
      const current = merged[index];
      if (!current) {
        merged.push(structuredClone(incoming));
        additions.push({ label: label(incoming), value: incoming });
        continue;
      }
      const replacement = { ...incoming, id: current.id };
      if (
        choose(`${section}.${current.id}`, label(current), current, replacement)
      )
        merged[index] = replacement;
    }
    return merged;
  };
  const nameKey = (item: { name: string }): string =>
    item.name.normalize("NFKC").toLocaleLowerCase("en-US");
  document.instructions = mergeCollection(
    "instructions",
    profile.instructions,
    device.instructions,
    nameKey,
    (item) => `Instruction: ${item.name}`,
  );
  document.contextPacks = mergeCollection(
    "contextPacks",
    profile.contextPacks,
    device.contextPacks,
    nameKey,
    (item) => `Context pack: ${item.name}`,
  );
  document.prompts = mergeCollection(
    "prompts",
    profile.prompts,
    device.prompts,
    (item) => item.relativePath.toLocaleLowerCase("en-US"),
    (item) => `Prompt: ${item.relativePath}`,
  );
  return { document, conflicts, additions };
}
