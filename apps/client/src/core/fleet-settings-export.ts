import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  managedMcpServerSchema,
  managedSettingsDocumentSchema,
  maximumManagedMcpServers,
  maximumManagedSettingsCollectionEntries,
  type FleetManagedSettingsDocument,
} from "@machdoch/fleet-protocol";
import {
  emptyManagedSettingsDocument,
  normalizeManagedPromptPath,
} from "@machdoch/fleet-protocol/managed-settings";
import { loadWorkspaceConfigFile } from "./config.js";
import {
  discoverCustomizations,
  getUserPromptRelativePath,
} from "./customizations.js";
import { sanitizeMcpServerForFleet } from "./fleet-mcp.js";
import { loadOwnUserMcpServers } from "./mcp/config.js";
import { loadUserConfigFile } from "./env.js";
import { loadInstructionLibrary } from "./instruction-system/library-store.js";

const {
  defaults: defaultsSchema,
  agentLimits: agentLimitsSchema,
  instructions: { element: instructionSchema },
  prompts: { element: promptSchema },
} = managedSettingsDocumentSchema.shape;

interface SafeParser<T> {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false };
}

/**
 * The device's own settings in the shape machdoch.cloud stores, plus how many
 * local values were left out because machdoch.cloud would reject them.
 */
export async function collectFleetLocalSettings(
  workspaceRoot: string,
): Promise<{ document: FleetManagedSettingsDocument; leftOut: number }> {
  const [{ config }, { config: user }, library, customizations, mcpServers] =
    await Promise.all([
      loadWorkspaceConfigFile(workspaceRoot),
      loadUserConfigFile(),
      loadInstructionLibrary(),
      discoverCustomizations(workspaceRoot, {
        discoverUserCustomizations: true,
        discoverFleetManagedPrompts: false,
      }),
      loadOwnUserMcpServers(),
    ]);
  const prompts = await Promise.all(
    customizations.prompts
      .filter(
        (prompt) =>
          prompt.scope === "user" && !prompt.path.startsWith("fleet:"),
      )
      .map(async (prompt) => {
        const relativePath = getUserPromptRelativePath(prompt.path);
        return {
          id: stablePromptId(relativePath),
          relativePath,
          content: await readFile(prompt.path, "utf8"),
        };
      }),
  );
  const empty = emptyManagedSettingsDocument();
  const sections = {
    defaults: acceptedFields(
      defaultsSchema,
      {
        provider: config.provider ?? null,
        model: config.provider ? (config.model ?? null) : null,
        mode: config.defaultMode ?? null,
        reasoning: config.reasoning ?? null,
        webSearchProvider: user.webSearch?.activeProvider ?? null,
        theme: null,
        density: null,
        accent: null,
      },
      empty.defaults,
    ),
    agentLimits: acceptedFields(
      agentLimitsSchema,
      {
        infinite: user.agentLimits?.infinite ?? null,
        executorTurns: user.agentLimits?.executorTurns ?? null,
        autopilotExecutorIterations:
          user.agentLimits?.autopilotExecutorIterations ?? null,
      },
      empty.agentLimits,
    ),
    instructions: acceptedItems(
      instructionSchema,
      library.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        body: profile.body,
        enabled: profile.enabled,
        global: profile.global,
        tags: profile.tags,
      })),
      (instruction) => [
        `id:${instruction.id}`,
        `name:${instruction.name.toLocaleLowerCase()}`,
      ],
      maximumManagedSettingsCollectionEntries,
    ),
    prompts: acceptedItems(
      promptSchema,
      prompts,
      (prompt) => [prompt.relativePath.toLocaleLowerCase()],
      maximumManagedSettingsCollectionEntries,
    ),
    mcpServers: acceptedItems(
      managedMcpServerSchema,
      mcpServers.map((server) => sanitizeMcpServerForFleet(server)),
      (server) => [server.id],
      maximumManagedMcpServers,
    ),
  };
  return {
    document: managedSettingsDocumentSchema.parse({
      defaults: sections.defaults.value,
      agentLimits: sections.agentLimits.value,
      instructions: sections.instructions.value,
      contextPacks: [],
      prompts: sections.prompts.value,
      mcpServers: sections.mcpServers.value,
    }),
    leftOut: Object.values(sections).reduce(
      (total, section) => total + section.leftOut,
      0,
    ),
  };
}

export async function exportFleetLocalSettings(
  workspaceRoot: string,
): Promise<FleetManagedSettingsDocument> {
  return (await collectFleetLocalSettings(workspaceRoot)).document;
}

/**
 * Derives a UUID-shaped id from the prompt path so a prompt keeps its identity
 * across snapshots. Version 8 and the RFC variant keep the uuid checks happy.
 */
export function stablePromptId(relativePath: string): string {
  const hex = createHash("sha256")
    .update(normalizeManagedPromptPath(relativePath))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Keeps the items machdoch.cloud accepts, without duplicates and within the
 * collection limit, so one unusual local item cannot block the whole upload.
 */
function acceptedItems<T>(
  schema: SafeParser<T>,
  items: unknown[],
  identities: (item: T) => string[],
  maximum: number,
): { value: T[]; leftOut: number } {
  const seen = new Set<string>();
  const value: T[] = [];
  for (const item of items) {
    const parsed = item === null ? null : schema.safeParse(item);
    if (!parsed?.success || value.length === maximum) continue;
    const keys = identities(parsed.data);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    value.push(parsed.data);
  }
  return { value, leftOut: items.length - value.length };
}

/** Keeps the fields machdoch.cloud accepts; rejected ones fall back to unset. */
function acceptedFields<T>(
  schema: SafeParser<T>,
  fields: Record<string, unknown>,
  empty: object,
): { value: T; leftOut: number } {
  let accepted: Record<string, unknown> = { ...empty };
  let leftOut = 0;
  for (const [key, field] of Object.entries(fields)) {
    const candidate = { ...accepted, [key]: field };
    if (schema.safeParse(candidate).success) accepted = candidate;
    else if (field !== null) leftOut += 1;
  }
  const parsed = schema.safeParse(accepted);
  if (!parsed.success) throw new Error("Device settings could not be read.");
  return { value: parsed.data, leftOut };
}
