import type { FleetManagedSettingsDocument as ManagedSettingsDocument } from "@machdoch/fleet-protocol";
import {
  addableSettingsItem,
  canonicalJson,
  renamedSettingsItem,
  sameSettingsItemContent,
  sameSettingsItemContentIgnoringName,
  settingsItemKey,
  settingsItemKinds,
  settingsItemLabels,
  settingsItemName,
  settingsItems,
  settingsItemSections,
  withSettingsItems,
  type SettingsItem,
  type SettingsItemKind,
} from "./settings-items";

export interface SettingsMergeSource {
  name: string;
  document: ManagedSettingsDocument;
}

export interface SettingsMergeVariant {
  value: unknown;
  /** Names of the devices that have exactly this value. */
  sources: string[];
}

export interface SettingsMergeConflict {
  key: string;
  label: string;
  kind: "field" | SettingsItemKind;
  /** `null` when the profile has no value and the devices disagree. */
  profileValue: unknown;
  variants: SettingsMergeVariant[];
  /** Item fields whose values differ between the profile and the devices. */
  differences: string[];
  /** The current choice applies; a stale one (for example a missing variant) does not. */
  resolved: boolean;
}

export interface SettingsMergeAddition {
  key: string;
  label: string;
  value: unknown;
  sources: string[];
}

/**
 * `device` takes the first variant, `device:<n>` a specific one, `both` keeps
 * the profile item and adds every device variant as a renamed copy (items
 * only), and
 * `{ edit }` uses an administrator-edited value.
 */
export type SettingsMergeResolution =
  | "profile"
  | "device"
  | `device:${number}`
  | "both"
  | { edit: unknown };
export type SettingsMergeChoices = Record<string, SettingsMergeResolution>;

// Labels match the General tab.
const settingLabels = {
  mode: "Mode",
  reasoning: "Reasoning",
  webSearchProvider: "Web search",
  theme: "Theme",
  density: "Density",
  accent: "Accent",
  infinite: "Infinite mode",
  executorTurns: "Executor turns",
  autopilotExecutorIterations: "Autopilot iterations",
};
const defaultKeys = [
  "mode",
  "reasoning",
  "webSearchProvider",
  "theme",
  "density",
  "accent",
] as const;
const limitKeys = [
  "infinite",
  "executorTurns",
  "autopilotExecutorIterations",
] as const;
/** Groups equal values (compared as canonical JSON) and keeps their sources. */
function variantsOf(
  values: Array<{ value: unknown; source: string }>,
  same: (left: unknown, right: unknown) => boolean = (left, right) =>
    canonicalJson(left) === canonicalJson(right),
): SettingsMergeVariant[] {
  const variants: SettingsMergeVariant[] = [];
  for (const { value, source } of values) {
    const existing = variants.find((variant) => same(variant.value, value));
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else variants.push({ value, sources: [source] });
  }
  return variants;
}

function variantIndex(resolution: SettingsMergeResolution | undefined): number {
  if (resolution === "device") return 0;
  if (typeof resolution === "string" && resolution.startsWith("device:"))
    return Number(resolution.slice("device:".length));
  return -1;
}

function isResolved(
  resolution: SettingsMergeResolution | undefined,
  kind: SettingsMergeConflict["kind"],
  variants: number,
): boolean {
  if (resolution === undefined) return false;
  if (resolution === "profile" || typeof resolution === "object") return true;
  if (resolution === "both") return kind !== "field";
  const index = variantIndex(resolution);
  return Number.isInteger(index) && index >= 0 && index < variants;
}

export function itemDifferences(left: unknown, right: unknown): string[] {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return [];
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => key !== "id" && canonicalJson(a[key]) !== canonicalJson(b[key]),
  );
}

export function mergeSettings(
  profile: ManagedSettingsDocument,
  devices: ManagedSettingsDocument | SettingsMergeSource[],
  choices: SettingsMergeChoices = {},
): {
  document: ManagedSettingsDocument;
  conflicts: SettingsMergeConflict[];
  additions: SettingsMergeAddition[];
} {
  const sources = Array.isArray(devices)
    ? devices
    : [{ name: "Device", document: devices }];
  let document = structuredClone(profile);
  const conflicts: SettingsMergeConflict[] = [];
  const additions: SettingsMergeAddition[] = [];

  const mergeField = (
    key: string,
    label: string,
    current: unknown,
    isCurrentSet: boolean,
    candidates: Array<{ value: unknown; source: string }>,
    apply: (value: unknown) => void,
  ) => {
    const variants = variantsOf(candidates);
    if (!variants.length) return;
    if (!isCurrentSet && variants.length === 1) {
      additions.push({ key, label, ...variants[0]! });
      apply(variants[0]!.value);
      return;
    }
    const differing = isCurrentSet
      ? variants.filter(
          (variant) => canonicalJson(variant.value) !== canonicalJson(current),
        )
      : variants;
    if (!differing.length) return;
    conflicts.push({
      key,
      label,
      kind: "field",
      profileValue: isCurrentSet ? current : null,
      variants: differing,
      differences: [],
      resolved: isResolved(choices[key], "field", differing.length),
    });
    const resolution = choices[key];
    const index = variantIndex(resolution);
    if (index >= 0 && differing[index]) apply(differing[index].value);
    else if (resolution && typeof resolution === "object")
      apply(resolution.edit);
  };

  mergeField(
    "defaults.model",
    "Provider and model",
    { provider: profile.defaults.provider, model: profile.defaults.model },
    profile.defaults.provider !== null,
    sources
      .filter((source) => source.document.defaults.provider !== null)
      .map((source) => ({
        value: {
          provider: source.document.defaults.provider,
          model: source.document.defaults.model,
        },
        source: source.name,
      })),
    (value) => Object.assign(document.defaults, value),
  );
  for (const key of defaultKeys)
    mergeField(
      `defaults.${key}`,
      settingLabels[key],
      profile.defaults[key],
      profile.defaults[key] !== null,
      sources
        .filter((source) => source.document.defaults[key] !== null)
        .map((source) => ({
          value: source.document.defaults[key],
          source: source.name,
        })),
      (value) => {
        document.defaults = { ...document.defaults, [key]: value };
      },
    );
  for (const key of limitKeys)
    mergeField(
      `agentLimits.${key}`,
      settingLabels[key],
      profile.agentLimits[key],
      profile.agentLimits[key] !== null,
      sources
        .filter((source) => source.document.agentLimits[key] !== null)
        .map((source) => ({
          value: source.document.agentLimits[key],
          source: source.name,
        })),
      (value) => {
        document.agentLimits = { ...document.agentLimits, [key]: value };
      },
    );

  for (const kind of settingsItemKinds) {
    const section = settingsItemSections[kind];
    const current = settingsItems(profile, kind);
    const merged: SettingsItem[] = structuredClone(current);
    const label = (item: SettingsItem) =>
      `${settingsItemLabels[kind]}: ${settingsItemName(kind, item)}`;
    const groups = new Map<
      string,
      {
        target: SettingsItem | null;
        values: Array<{ value: SettingsItem; source: string }>;
      }
    >();
    for (const source of sources) {
      for (const item of settingsItems(source.document, kind)) {
        const key = settingsItemKey(kind, item);
        const target =
          current.find(
            (entry) => entry.id === item.id && kind !== "mcpServer",
          ) ??
          current.find((entry) => settingsItemKey(kind, entry) === key) ??
          null;
        const groupKey = target ? target.id : `new:${key}`;
        const group = groups.get(groupKey) ?? { target, values: [] };
        group.values.push({ value: item, source: source.name });
        groups.set(groupKey, group);
      }
    }
    const addCopy = (item: SettingsItem) => {
      merged.push(renamedSettingsItem(kind, item, merged));
    };
    const addNew = (item: SettingsItem) => {
      merged.push(addableSettingsItem(kind, structuredClone(item), merged));
    };
    for (const [groupKey, group] of groups) {
      const same = (left: unknown, right: unknown) =>
        sameSettingsItemContent(
          kind,
          left as SettingsItem,
          right as SettingsItem,
        );
      const variants = variantsOf(group.values, same);
      const conflictKey = `${section}.${groupKey}`;
      const resolution = choices[conflictKey];
      if (!group.target) {
        if (variants.length === 1) {
          const item = variants[0]!.value as SettingsItem;
          additions.push({
            key: conflictKey,
            label: label(item),
            value: item,
            sources: variants[0]!.sources,
          });
          addNew(item);
          continue;
        }
        conflicts.push({
          key: conflictKey,
          label: label(variants[0]!.value as SettingsItem),
          kind,
          profileValue: null,
          variants,
          differences: [
            ...new Set(
              variants
                .slice(1)
                .flatMap((variant) =>
                  itemDifferences(variants[0]!.value, variant.value),
                ),
            ),
          ],
          resolved: isResolved(resolution, kind, variants.length),
        });
        const index = variantIndex(resolution);
        if (index >= 0 && variants[index])
          addNew(variants[index].value as SettingsItem);
        else if (resolution === "both")
          for (const variant of variants) addNew(variant.value as SettingsItem);
        else if (resolution && typeof resolution === "object")
          addNew(resolution.edit as SettingsItem);
        continue;
      }
      const target = group.target;
      const differing = variants
        .filter(
          (variant) =>
            !same(target, variant.value) &&
            // A copy kept earlier under another name already holds this version.
            !current.some(
              (entry) =>
                entry.id !== target.id &&
                sameSettingsItemContentIgnoringName(
                  kind,
                  entry,
                  variant.value as SettingsItem,
                ),
            ),
        )
        .map((variant) => ({
          ...variant,
          value: { ...(variant.value as SettingsItem), id: target.id },
        }));
      if (!differing.length) continue;
      conflicts.push({
        key: conflictKey,
        label: label(target),
        kind,
        profileValue: target,
        variants: differing,
        differences: [
          ...new Set(
            differing.flatMap((variant) =>
              itemDifferences(target, variant.value),
            ),
          ),
        ],
        resolved: isResolved(resolution, kind, differing.length),
      });
      const position = merged.findIndex((entry) => entry.id === target.id);
      const index = variantIndex(resolution);
      if (index >= 0 && differing[index])
        merged[position] = differing[index].value as SettingsItem;
      else if (resolution === "both")
        for (const variant of differing) addCopy(variant.value as SettingsItem);
      else if (resolution && typeof resolution === "object")
        merged[position] = {
          ...(resolution.edit as SettingsItem),
          id: target.id,
        };
    }
    if (
      kind === "mcpServer" &&
      profile.mcpServers === undefined &&
      !merged.length
    )
      continue;
    document = withSettingsItems(
      document,
      kind,
      merged as Array<SettingsItem<typeof kind>>,
    );
  }
  return { document, conflicts, additions };
}

/** Line-based diff (longest common subsequence) for previews of long text. */
export function diffLines(
  before: string,
  after: string,
): Array<{ type: "same" | "removed" | "added"; text: string }> | null {
  const left = before.split(/\r?\n/u);
  const right = after.split(/\r?\n/u);
  if (left.length * right.length > 4_000_000) return null;
  const table = Array.from(
    { length: left.length + 1 },
    () => new Uint32Array(right.length + 1),
  );
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const result: Array<{ type: "same" | "removed" | "added"; text: string }> =
    [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ type: "same", text: left[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ type: "removed", text: left[i++]! });
    } else {
      result.push({ type: "added", text: right[j++]! });
    }
  }
  while (i < left.length) result.push({ type: "removed", text: left[i++]! });
  while (j < right.length) result.push({ type: "added", text: right[j++]! });
  return result;
}
