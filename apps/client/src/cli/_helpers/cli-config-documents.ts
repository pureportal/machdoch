import { readFile } from "node:fs/promises";
import {
  getUserMcpConfigPath,
  getWorkspaceMcpConfigPath,
  parseMcpConfigFile,
} from "../../core/mcp/config.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../../core/_helpers/write-file-atomically.helper.js";
import { CliUsageError } from "./cli-error.js";
import type {
  CliConfigFamily,
  ConfigSetResult,
  CliConfigEntry,
  CliConfigSettingDefinition,
} from "./cli-config-types.js";

export const CONFIG_DOCUMENT_DEFINITIONS: readonly CliConfigSettingDefinition[] =
  [
    {
      setting: "mcp.global",
      label: "MCP connections",
      category: "MCP",
      scope: "user",
      description: "Global MCP connections",
      acceptedValues: "JSON object",
      document: true,
    },
    {
      setting: "workspace.mcp",
      label: "MCP connections",
      category: "Workspace",
      scope: "workspace",
      description: "Workspace MCP connections",
      acceptedValues: "JSON object",
      document: true,
    },
  ];

const defaultMcpDocument = { schemaVersion: 1, servers: [] };

export const loadConfigDocument = async (
  workspaceRoot: string,
  setting: string,
): Promise<{ path: string; raw: string; storedRaw: string | undefined }> => {
  const path =
    setting === "mcp.global"
      ? getUserMcpConfigPath()
      : getWorkspaceMcpConfigPath(workspaceRoot);
  let storedRaw: string | undefined;
  try {
    storedRaw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    path,
    raw: storedRaw ?? JSON.stringify(defaultMcpDocument, null, 2),
    storedRaw,
  };
};

const parseDocument = (raw: string): Record<string, unknown> => {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new CliUsageError("Enter valid JSON and save again.");
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  )
    throw new CliUsageError("Enter a JSON object.");
  const config = document as Record<string, unknown>;
  const normalized = parseMcpConfigFile(raw);
  const count =
    config.servers === undefined
      ? 0
      : Array.isArray(config.servers)
        ? config.servers.length
        : config.servers !== null && typeof config.servers === "object"
          ? Object.keys(config.servers).length
          : -1;
  if (count !== (normalized.servers?.length ?? 0))
    throw new CliUsageError(
      "One or more MCP servers are invalid. Check their ids and connection settings.",
    );
  return document as Record<string, unknown>;
};

export const saveConfigDocument = async (
  workspaceRoot: string,
  setting: string,
  raw: string,
  expected?: { storedRaw: string | undefined },
): Promise<ConfigSetResult> => {
  const document = parseDocument(raw);
  const loaded = await loadConfigDocument(workspaceRoot, setting);
  await withCooperativeFileLock(loaded.path, async () => {
    const current = await loadConfigDocument(workspaceRoot, setting);
    if (expected && current.storedRaw !== expected.storedRaw)
      throw new Error(
        "These settings changed while you were editing. Open them again and reapply your changes.",
      );
    await writeJsonAtomically(loaded.path, document);
  });
  return {
    setting,
    scope: setting.startsWith("workspace.") ? "workspace" : "user",
    configPath: loaded.path,
    status: "configured",
  };
};

export const documentConfigFamily: CliConfigFamily = {
  definitions: CONFIG_DOCUMENT_DEFINITIONS,
  save: async (workspaceRoot, setting, value) =>
    await saveConfigDocument(
      workspaceRoot,
      setting.trim().toLowerCase(),
      value,
    ),
  reset: () => {
    throw new CliUsageError(
      "Edit this configuration to remove or reset individual connections.",
    );
  },
};

export const loadConfigDocumentEntries = async (
  workspaceRoot: string,
): Promise<CliConfigEntry[]> =>
  await Promise.all(
    CONFIG_DOCUMENT_DEFINITIONS.map(async (definition) => {
      const document = await loadConfigDocument(
        workspaceRoot,
        definition.setting,
      );
      try {
        parseDocument(document.raw);
        const servers = parseMcpConfigFile(document.raw).servers ?? [];
        return {
          ...definition,
          value: `${servers.length} connections`,
          source: document.storedRaw === undefined ? "default" : "saved",
        };
      } catch (error) {
        return {
          ...definition,
          value:
            error instanceof Error ? error.message : "Invalid configuration",
          source: "invalid",
        };
      }
    }),
  );
