import {
  managedMcpServerSchema,
  managedSecretPlaceholderPattern,
  type FleetManagedSettingsDocument as ManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import {
  managedMcpServerSecretReferences,
  normalizeManagedItemName,
  normalizeManagedPromptPath,
} from "@machdoch/fleet-protocol/managed-settings";

export const settingsItemKinds = [
  "instruction",
  "contextPack",
  "prompt",
  "mcpServer",
] as const;
export type SettingsItemKind = (typeof settingsItemKinds)[number];

type Collections = {
  instruction: ManagedSettingsDocument["instructions"][number];
  contextPack: ManagedSettingsDocument["contextPacks"][number];
  prompt: ManagedSettingsDocument["prompts"][number];
  mcpServer: NonNullable<ManagedSettingsDocument["mcpServers"]>[number];
};
export type SettingsItem<K extends SettingsItemKind = SettingsItemKind> =
  Collections[K];

export const settingsItemLabels: Record<SettingsItemKind, string> = {
  instruction: "Instruction",
  contextPack: "Context pack",
  prompt: "Prompt",
  mcpServer: "MCP server",
};

/** The document collection that holds each kind of item. */
export const settingsItemSections = {
  instruction: "instructions",
  contextPack: "contextPacks",
  prompt: "prompts",
  mcpServer: "mcpServers",
} as const satisfies Record<SettingsItemKind, keyof ManagedSettingsDocument>;

export function settingsItems<K extends SettingsItemKind>(
  document: ManagedSettingsDocument,
  kind: K,
): Array<SettingsItem<K>> {
  return (document[settingsItemSections[kind]] ?? []) as Array<SettingsItem<K>>;
}

export function withSettingsItems<K extends SettingsItemKind>(
  document: ManagedSettingsDocument,
  kind: K,
  items: Array<SettingsItem<K>>,
): ManagedSettingsDocument {
  return { ...document, [settingsItemSections[kind]]: items };
}

/** The identity used to match items across profiles and devices. */
export function settingsItemKey(
  kind: SettingsItemKind,
  item: SettingsItem,
): string {
  if (kind === "prompt")
    return normalizeManagedPromptPath(
      (item as SettingsItem<"prompt">).relativePath,
    );
  if (kind === "mcpServer") return (item as SettingsItem<"mcpServer">).id;
  return normalizeManagedItemName((item as { name: string }).name);
}

export function settingsItemName(
  kind: SettingsItemKind,
  item: SettingsItem,
): string {
  if (kind === "prompt") return (item as SettingsItem<"prompt">).relativePath;
  if (kind === "mcpServer") {
    const server = item as SettingsItem<"mcpServer">;
    return server.title ?? server.id;
  }
  return (item as { name: string }).name;
}

/** Stable JSON with sorted keys, used to compare content independent of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  return value;
}

/**
 * Compares items while ignoring their ids (MCP ids are their identity) and
 * spelling differences in names or paths that still match the same item.
 */
export function sameSettingsItemContent(
  kind: SettingsItemKind,
  left: SettingsItem,
  right: SettingsItem,
): boolean {
  if (kind === "mcpServer") return canonicalJson(left) === canonicalJson(right);
  const comparable = (item: SettingsItem) => ({
    ...item,
    id: "",
    [kind === "prompt" ? "relativePath" : "name"]: settingsItemKey(kind, item),
  });
  return canonicalJson(comparable(left)) === canonicalJson(comparable(right));
}

/** Compares content only, so a renamed "keep both" copy still matches. */
export function sameSettingsItemContentIgnoringName(
  kind: SettingsItemKind,
  left: SettingsItem,
  right: SettingsItem,
): boolean {
  if (kind === "mcpServer") {
    const strip = (item: SettingsItem) => ({ ...item, id: "", title: null });
    return canonicalJson(strip(left)) === canonicalJson(strip(right));
  }
  const field = kind === "prompt" ? "relativePath" : "name";
  const strip = (item: SettingsItem) => ({ ...item, id: "", [field]: "" });
  return canonicalJson(strip(left)) === canonicalJson(strip(right));
}

const promptExtension = ".prompt.md";
const maximumPromptPathComponent = 120;

/**
 * Returns a copy that can sit next to the existing items: a new id and a
 * name, path or MCP id that does not collide with any of them.
 */
export function renamedSettingsItem<K extends SettingsItemKind>(
  kind: K,
  item: SettingsItem<K>,
  existing: Array<SettingsItem<K>>,
): SettingsItem<K> {
  const keys = new Set(existing.map((entry) => settingsItemKey(kind, entry)));
  for (let suffix = 2; suffix < 1000; suffix++) {
    let candidate: SettingsItem;
    if (kind === "prompt") {
      const prompt = item as SettingsItem<"prompt">;
      const stem = prompt.relativePath.slice(0, -promptExtension.length);
      // Path components are limited to 120 characters.
      const length =
        stem.lastIndexOf("/") +
        1 +
        maximumPromptPathComponent -
        promptExtension.length -
        `-${suffix}`.length;
      candidate = {
        ...prompt,
        id: crypto.randomUUID(),
        relativePath: `${stem.slice(0, length)}-${suffix}${promptExtension}`,
      };
    } else if (kind === "mcpServer") {
      const server = item as SettingsItem<"mcpServer">;
      candidate = {
        ...server,
        id: `${server.id.slice(0, 60)}-${suffix}`,
        title: server.title
          ? `${server.title.slice(0, 190)} (${suffix})`
          : null,
      };
    } else {
      const named = item as SettingsItem<"instruction">;
      candidate = {
        ...named,
        id: crypto.randomUUID(),
        name: `${named.name.slice(0, 190)} (${suffix})`,
      } as SettingsItem;
    }
    if (!keys.has(settingsItemKey(kind, candidate)))
      return candidate as SettingsItem<K>;
  }
  throw new Error("No free name is available for the copy.");
}

export type ProposalResolution = "add" | "replace" | "keep-both";

export class SettingsItemConflictError extends Error {}

/**
 * Returns the item ready to be appended: renamed when its name, path or MCP id
 * is taken, with a fresh id when only its id is taken.
 */
export function addableSettingsItem<K extends SettingsItemKind>(
  kind: K,
  item: SettingsItem<K>,
  existing: Array<SettingsItem<K>>,
): SettingsItem<K> {
  const key = settingsItemKey(kind, item);
  if (existing.some((entry) => settingsItemKey(kind, entry) === key))
    return renamedSettingsItem(kind, item, existing);
  // MCP ids are their names, so a free name means a free id.
  return existing.some((entry) => entry.id === item.id)
    ? { ...item, id: crypto.randomUUID() }
    : item;
}

/** Adds one item to a document, honoring how a same-named item is resolved. */
export function applySettingsItem<K extends SettingsItemKind>(
  document: ManagedSettingsDocument,
  kind: K,
  item: SettingsItem<K>,
  resolution: ProposalResolution,
): ManagedSettingsDocument {
  const items = [...settingsItems(document, kind)];
  const key = settingsItemKey(kind, item);
  const index = items.findIndex(
    (entry) => settingsItemKey(kind, entry) === key,
  );
  if (index >= 0 && resolution === "add")
    throw new SettingsItemConflictError(
      `${settingsItemLabels[kind]} "${settingsItemName(kind, item)}" already exists. Replace it or keep both.`,
    );
  if (index >= 0 && resolution === "replace")
    items[index] = { ...item, id: items[index]!.id };
  else items.push(addableSettingsItem(kind, item, items));
  return withSettingsItems(document, kind, items);
}

/** Explains why the protocol rejects an MCP server, or returns null. */
export function mcpServerProblem(server: unknown): string | null {
  const result = managedMcpServerSchema.safeParse(server);
  if (result.success) return null;
  const issue = result.error.issues[0]!;
  const [section, field, key] = issue.path.map(String);
  if (issue.code === "unrecognized_keys")
    return `Remove the unknown field ${issue.keys.join(", ")}.`;
  if (section === "id")
    return "Use lowercase letters, digits, dots, dashes or underscores for the server id, starting with a letter or digit.";
  if (section === "title") return "Use a title of up to 200 characters.";
  if (section !== "transport") return "The MCP server is invalid.";
  if (field === "command") return "Enter the command that starts the server.";
  if (field === "url") return "Enter an http:// or https:// URL.";
  if (field === "args")
    return "Use at most 128 arguments of up to 8,192 characters each.";
  if (field === "env" && issue.code === "invalid_key")
    return `${key} is not a valid environment variable name. Use letters, digits and underscores, and do not start with a digit.`;
  if (field === "headers" && issue.code === "invalid_key")
    return `${key} is not a valid header name.`;
  if (field === "env" || field === "headers")
    return `Use at most 64 ${field === "env" ? "environment variables" : "headers"} with values of up to 8,192 characters.`;
  return "Use the stdio, streamable-http or sse transport.";
}

const looseSecretPlaceholders = /\{\{\s*secret\s*:[^}]*\}\}/giu;

/**
 * Explains `{{secret:<id>}}` placeholders that devices cannot resolve: typos
 * that stay literal text, and ids no profile secret can be stored under.
 */
export function mcpSecretPlaceholderProblem(
  server: SettingsItem<"mcpServer">,
  isStorable: (secretId: string) => boolean,
): string | null {
  const values =
    server.transport.type === "stdio"
      ? [
          server.transport.command,
          ...server.transport.args,
          ...Object.values(server.transport.env),
        ]
      : [server.transport.url, ...Object.values(server.transport.headers)];
  const strict = new RegExp(managedSecretPlaceholderPattern.source, "gu");
  const malformed = values
    .flatMap(
      (value) =>
        value.replaceAll(strict, "").match(looseSecretPlaceholders) ?? [],
    )
    .at(0);
  if (malformed)
    return `${malformed} is not a valid secret placeholder. Use lowercase ids such as {{secret:mcp_github}}.`;
  const unknown = managedMcpServerSecretReferences(server).find(
    (secretId) => !isStorable(secretId),
  );
  return unknown
    ? `{{secret:${unknown}}} cannot be stored as a profile secret. Use an id that starts with mcp_, such as mcp_github.`
    : null;
}
