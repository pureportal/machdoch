import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { readStableRegularFile } from "../_helpers/read-stable-regular-file.helper.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "../_helpers/write-file-atomically.helper.js";
import {
  compareCanonicalStrings,
  digestJson,
  sha256,
} from "./digests.js";

const TOML_START = "# machdoch-managed:provider-enrollment:start";
const TOML_END = "# machdoch-managed:provider-enrollment:end";
const MAX_MANAGED_TARGET_BYTES = 16 * 1024 * 1024;
const LEGACY_OWNERSHIP_FORMAT = "markdown";
const OWNERSHIP_FORMAT_BY_PROVIDER = {
  "codex-cli": "toml",
  "claude-cli": "json",
  "copilot-cli": "json",
} as const;
type OwnershipProvider = keyof typeof OWNERSHIP_FORMAT_BY_PROVIDER;
const isOwnershipProvider = (value: unknown): value is OwnershipProvider =>
  typeof value === "string" &&
  Object.hasOwn(OWNERSHIP_FORMAT_BY_PROVIDER, value);
const TOML_KEY_SOURCE =
  String.raw`("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`;
const TOML_MCP_TABLE_PATTERN = new RegExp(
  String.raw`^\[\s*mcp_servers\s*\.\s*${TOML_KEY_SOURCE}(?:\s*\.|\s*\])`,
  "u",
);
const TOML_MCP_DOTTED_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`^mcp_servers\s*\.\s*${TOML_KEY_SOURCE}(?:\s*\.|\s*=)`,
  "u",
);

export type ManagedTargetFormat = "toml" | "json";

export interface ProviderOwnershipRecord {
  path: string;
  provider: string;
  scope: "user" | "workspace";
  format: ManagedTargetFormat;
  managedDigest: string;
  installedFileDigest: string;
  createdFile: boolean;
  managedKeys?: string[];
  installedAt: string;
}

export interface ProviderOwnershipManifest {
  schemaVersion: 1;
  targets: ProviderOwnershipRecord[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_OWNERSHIP_RECORDS = 4_096;
const MAX_MANAGED_KEYS_PER_RECORD = 4_096;
const OWNERSHIP_MANIFEST_KEYS = new Set(["schemaVersion", "targets"]);
const OWNERSHIP_TARGET_KEYS = new Set([
  "path",
  "provider",
  "scope",
  "format",
  "managedDigest",
  "installedFileDigest",
  "createdFile",
  "managedKeys",
  "installedAt",
]);
const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));
const hasAsciiControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f
    );
  });

export const getManagedTargetPathIdentity = (path: string): string => {
  let normalized = resolve(path);
  if (process.platform !== "win32") return normalized;
  const lower = normalized.toLocaleLowerCase("en-US");
  if (lower.startsWith("\\\\?\\unc\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (lower.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  return normalized.toLocaleLowerCase("en-US");
};

interface ManagedTextRegion {
  start: number;
  end: number;
  payload: string;
}

const findRegion = (
  content: string,
): ManagedTextRegion | undefined => {
  const start = content.indexOf(TOML_START);
  if (start < 0) return undefined;
  const endMarkerIndex = content.indexOf(TOML_END, start + TOML_START.length);
  if (endMarkerIndex < 0) return undefined;
  const payloadStart = start + TOML_START.length;
  return {
    start,
    end: endMarkerIndex + TOML_END.length,
    payload: content
      .slice(payloadStart, endMarkerIndex)
      .replace(/^\r?\n|\r?\n$/gu, ""),
  };
};

const findRegions = (
  content: string,
): ManagedTextRegion[] => {
  const regions: ManagedTextRegion[] = [];
  let offset = 0;
  while (offset < content.length) {
    const region = findRegion(content.slice(offset));
    if (!region) break;
    regions.push({
      start: offset + region.start,
      end: offset + region.end,
      payload: region.payload,
    });
    offset += region.end;
  }
  return regions;
};

const countOccurrences = (content: string, marker: string): number => {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(marker, offset)) >= 0) {
    count += 1;
    offset += marker.length;
  }
  return count;
};

const assertWellFormedTextRegions = (
  content: string,
  regions: readonly ManagedTextRegion[],
  path: string,
): void => {
  if (
    countOccurrences(content, TOML_START) !== regions.length ||
    countOccurrences(content, TOML_END) !== regions.length
  ) {
    throw new Error(
      `Machdoch-managed region markers are malformed or ambiguous in ${path}.`,
    );
  }
};

const selectOwnedTextRegion = (
  regions: readonly ManagedTextRegion[],
  record: ProviderOwnershipRecord,
): ManagedTextRegion | undefined => {
  if (regions.length <= 1) return regions[0];
  const matches = regions.filter(
    (region) => sha256(region.payload) === record.managedDigest,
  );
  if (matches.length === 1) return matches[0];
  throw new Error(
    `Could not identify the owned Machdoch-managed region in ${record.path}.`,
  );
};

const removeTextRegion = (
  content: string,
  region: ManagedTextRegion,
): string => `${content.slice(0, region.start)}${content.slice(region.end)}`;

const mergeTextRegion = (
  existing: string,
  payload: string,
  current: ManagedTextRegion | undefined,
): string => {
  const regionText = `${TOML_START}\n${payload.trim()}\n${TOML_END}`;
  if (current) {
    return `${existing.slice(0, current.start)}${regionText}${existing.slice(current.end)}`;
  }
  const unmanaged = existing.trimEnd();
  return unmanaged.length > 0
    ? `${unmanaged}\n\n${regionText}\n`
    : `${regionText}\n`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const decodeTomlKey = (raw: string): string | undefined => {
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw) as unknown;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return raw.startsWith("'") ? raw.slice(1, -1) : raw;
};

const inventoryTomlMcpServers = (
  content: string,
): { names: Set<string>; ambiguous: boolean } => {
  const names = new Set<string>();
  let ambiguous = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const candidatePattern = line.startsWith("[")
      ? TOML_MCP_TABLE_PATTERN
      : TOML_MCP_DOTTED_ASSIGNMENT_PATTERN;
    const match = candidatePattern.exec(line);
    if (match?.[1]) {
      const name = decodeTomlKey(match[1]);
      if (name === undefined) {
        ambiguous = true;
      } else {
        names.add(name);
      }
      continue;
    }
    if (
      line.startsWith("mcp_servers") ||
      (line.startsWith("[") && /\bmcp_servers\b/u.test(line))
    ) {
      ambiguous = true;
    }
  }
  return { names, ambiguous };
};

const parseOwnershipManifest = (
  value: unknown,
  path: string,
): ProviderOwnershipManifest => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, OWNERSHIP_MANIFEST_KEYS) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length > MAX_OWNERSHIP_RECORDS
  ) {
    throw new Error(`${path} is not a valid provider ownership manifest.`);
  }

  const seenPaths = new Set<string>();
  const seenPathAuthorities = new Map<
    string,
    { provider: string; scope: "user" | "workspace"; format: string }
  >();
  const targets = value.targets.map((candidate, index): ProviderOwnershipRecord | undefined => {
    const label = `${path} target ${index}`;
    const format = isRecord(candidate) ? candidate.format : undefined;
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, OWNERSHIP_TARGET_KEYS) ||
      typeof candidate.path !== "string" ||
      !isAbsolute(candidate.path) ||
      candidate.path.length > 32_768 ||
      !isOwnershipProvider(candidate.provider) ||
      (candidate.scope !== "user" && candidate.scope !== "workspace") ||
      (format !== LEGACY_OWNERSHIP_FORMAT &&
        format !== OWNERSHIP_FORMAT_BY_PROVIDER[candidate.provider]) ||
      typeof candidate.managedDigest !== "string" ||
      !SHA256_PATTERN.test(candidate.managedDigest) ||
      typeof candidate.installedFileDigest !== "string" ||
      !SHA256_PATTERN.test(candidate.installedFileDigest) ||
      typeof candidate.createdFile !== "boolean" ||
      typeof candidate.installedAt !== "string" ||
      candidate.installedAt.length > 100 ||
      !Number.isFinite(Date.parse(candidate.installedAt))
    ) {
      throw new Error(`${label} is malformed.`);
    }
    const provider = candidate.provider;
    const targetFormat = format as
      | ManagedTargetFormat
      | typeof LEGACY_OWNERSHIP_FORMAT;
    if (seenPaths.has(candidate.path)) {
      throw new Error(`${path} contains duplicate ownership for ${candidate.path}.`);
    }
    seenPaths.add(candidate.path);
    const pathIdentity = getManagedTargetPathIdentity(candidate.path);
    const previousAuthority = seenPathAuthorities.get(pathIdentity);
    if (
      previousAuthority &&
      (previousAuthority.provider !== provider ||
        previousAuthority.scope !== candidate.scope ||
        previousAuthority.format !== targetFormat)
    ) {
      throw new Error(
        `${path} contains ambiguous ownership for ${candidate.path}.`,
      );
    }
    seenPathAuthorities.set(pathIdentity, {
      provider,
      scope: candidate.scope,
      format: targetFormat,
    });

    let managedKeys: string[] | undefined;
    if (targetFormat === "json" && candidate.managedKeys === undefined) {
      throw new Error(`${label} has invalid managed MCP keys.`);
    }
    if (
      targetFormat !== "json" &&
      candidate.managedKeys !== undefined
    ) {
      throw new Error(`${label} has invalid managed MCP keys.`);
    }
    if (candidate.managedKeys !== undefined) {
      if (
        !Array.isArray(candidate.managedKeys) ||
        candidate.managedKeys.length > MAX_MANAGED_KEYS_PER_RECORD ||
        !candidate.managedKeys.every(
          (key) =>
            typeof key === "string" &&
            key.length > 0 &&
            key.length <= 1_024 &&
            !hasAsciiControlCharacter(key),
        )
      ) {
        throw new Error(`${label} has invalid managed MCP keys.`);
      }
      managedKeys = [...new Set(candidate.managedKeys)].sort(
        compareCanonicalStrings,
      );
      if (managedKeys.length !== candidate.managedKeys.length) {
        throw new Error(`${label} has duplicate managed MCP keys.`);
      }
    }

    // Persistent instruction targets predate MCP-only sync. Retire their
    // ownership metadata without changing the referenced instruction file.
    if (targetFormat === LEGACY_OWNERSHIP_FORMAT) return undefined;
    return {
      path: candidate.path,
      provider,
      scope: candidate.scope,
      format: targetFormat,
      managedDigest: candidate.managedDigest,
      installedFileDigest: candidate.installedFileDigest,
      createdFile: candidate.createdFile,
      ...(managedKeys ? { managedKeys } : {}),
      installedAt: candidate.installedAt,
    };
  }).filter(
    (target): target is ProviderOwnershipRecord => target !== undefined,
  );

  return {
    schemaVersion: 1,
    targets: targets.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
};

const parseJsonRecord = (content: string): Record<string, unknown> => {
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed))
    throw new Error("Managed provider JSON target must contain an object.");
  return parsed;
};

const getManagedMcpServers = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const raw = value.mcpServers;
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new Error(
      "Managed provider JSON target mcpServers must be an object when present.",
    );
  }
  return raw;
};

export interface StableManagedTargetSnapshot {
  content: string;
  contentDigest: string;
}

export const readStableManagedTarget = async (
  path: string,
): Promise<StableManagedTargetSnapshot | undefined> => {
  const bytes = await readStableRegularFile(path, {
    maxBytes: MAX_MANAGED_TARGET_BYTES,
  });
  if (bytes === undefined) return undefined;

  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8.`, { cause: error });
  }
  return { content, contentDigest: sha256(bytes) };
};

export const assertStableManagedTargetUnchanged = async (
  path: string,
  expected: StableManagedTargetSnapshot | undefined,
): Promise<void> => {
  const current = await readStableManagedTarget(path);
  if (current?.contentDigest !== expected?.contentDigest) {
    throw new Error(
      `${path} changed externally while Machdoch was preparing its managed update; no stale update was committed.`,
    );
  }
};

const createBackup = async (
  path: string,
  reviewedContent: string,
): Promise<string> => {
  const backupPath = `${path}.machdoch-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  await writeFileAtomically(backupPath, reviewedContent);
  return backupPath;
};

export interface InstallManagedTargetParams {
  path: string;
  provider: string;
  scope: "user" | "workspace";
  format: ManagedTargetFormat;
  payload: string | Record<string, unknown>;
  previous?: ProviderOwnershipRecord;
  beforeTargetCommit?: (record: ProviderOwnershipRecord) => Promise<void>;
}

export interface InstallManagedTargetResult {
  record: ProviderOwnershipRecord;
  changed: boolean;
  warnings: string[];
}

const installManagedTargetUnlocked = async (
  params: InstallManagedTargetParams,
): Promise<InstallManagedTargetResult> => {
  if (
    params.previous &&
    (getManagedTargetPathIdentity(params.previous.path) !==
      getManagedTargetPathIdentity(params.path) ||
      params.previous.provider !== params.provider ||
      params.previous.scope !== params.scope ||
      params.previous.format !== params.format)
  ) {
    throw new Error(
      `Previous ownership metadata does not describe ${params.provider} ${params.scope} target ${params.path}.`,
    );
  }
  const before = await readStableManagedTarget(params.path);
  const existed = Boolean(before);
  const existing = before?.content ?? "";
  const warnings: string[] = [];
  let managedDigest: string;
  let content: string;
  let managedKeys: string[] | undefined;

  if (params.format === "json") {
    if (!isRecord(params.payload) || !isRecord(params.payload.mcpServers)) {
      throw new Error(
        "Managed provider JSON payload must contain an mcpServers object.",
      );
    }
    const payload = params.payload;
    const generatedServers = getManagedMcpServers(payload);
    managedKeys = Object.keys(generatedServers).sort(compareCanonicalStrings);
    managedDigest = digestJson(generatedServers);
    const current = parseJsonRecord(existing);
    const currentServers = getManagedMcpServers(current);
    const previouslyOwnedKeys = new Set(params.previous?.managedKeys ?? []);
    const unmanagedCollisions = managedKeys.filter(
      (key) =>
        Object.hasOwn(currentServers, key) && !previouslyOwnedKeys.has(key),
    );
    if (unmanagedCollisions.length > 0) {
      throw new Error(
        `Refusing to overwrite unmanaged MCP server entr${unmanagedCollisions.length === 1 ? "y" : "ies"} in ${params.path}: ${unmanagedCollisions.join(", ")}.`,
      );
    }
    const previousManaged = Object.fromEntries(
      (params.previous?.managedKeys ?? []).flatMap((key) =>
        Object.hasOwn(currentServers, key)
          ? [[key, currentServers[key]] as const]
          : [],
      ),
    );
    if (
      params.previous &&
      digestJson(previousManaged) !== params.previous.managedDigest
    ) {
      const backupPath = await createBackup(params.path, existing);
      warnings.push(
        `Externally changed managed MCP entries were backed up to ${backupPath} and reconciled.`,
      );
    }
    const nextServers: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(currentServers)) {
      nextServers[key] = value;
    }
    for (const key of params.previous?.managedKeys ?? [])
      delete nextServers[key];
    for (const [key, value] of Object.entries(generatedServers)) {
      nextServers[key] = value;
    }
    content = `${JSON.stringify({ ...current, mcpServers: nextServers }, null, 2)}\n`;
  } else {
    const payload = String(params.payload).trim();
    managedDigest = sha256(payload);
    const currentRegions = findRegions(existing);
    assertWellFormedTextRegions(existing, currentRegions, params.path);
    if (!params.previous && currentRegions.length > 0) {
      throw new Error(
        `Refusing to overwrite an unowned Machdoch-managed region in ${params.path}; remove the stale region or restore its ownership metadata first.`,
      );
    }
    const currentRegion = params.previous
      ? selectOwnedTextRegion(currentRegions, params.previous)
      : undefined;
    const generated = inventoryTomlMcpServers(payload);
    const unmanaged = inventoryTomlMcpServers(
      currentRegion ? removeTextRegion(existing, currentRegion) : existing,
    );
    const collisions = [...generated.names]
      .filter((name) => unmanaged.names.has(name))
      .sort(compareCanonicalStrings);
    if (collisions.length > 0 || (generated.names.size > 0 && unmanaged.ambiguous)) {
      throw new Error(
        collisions.length > 0
          ? `Refusing to create duplicate unmanaged Codex MCP table${collisions.length === 1 ? "" : "s"} in ${params.path}: ${collisions.join(", ")}.`
          : `Refusing to merge MCP tables into ambiguous unmanaged mcp_servers TOML in ${params.path}.`,
      );
    }
    if (
      params.previous &&
      sha256(currentRegion?.payload ?? "") !== params.previous.managedDigest
    ) {
      const backupPath = await createBackup(params.path, existing);
      warnings.push(
        `An externally changed managed region was backed up to ${backupPath} and reconciled.`,
      );
    }
    content = mergeTextRegion(existing, payload, currentRegion);
  }

  const record: ProviderOwnershipRecord = {
    path: params.path,
    provider: params.provider,
    scope: params.scope,
    format: params.format,
    managedDigest,
    installedFileDigest: sha256(content),
    createdFile: params.previous?.createdFile ?? !existed,
    ...(managedKeys ? { managedKeys } : {}),
    installedAt: new Date().toISOString(),
  };
  const changed = content !== existing;
  if (changed) {
    await writeFileAtomically(params.path, content, "utf8", {
      beforeCommit: async () => {
        await assertStableManagedTargetUnchanged(params.path, before);
        await params.beforeTargetCommit?.(record);
      },
    });
  }
  const verified = await readStableManagedTarget(params.path);
  if (!verified || verified.content !== content) {
    throw new Error(
      `${params.path} changed externally before the managed update could be verified.`,
    );
  }
  return { record, changed, warnings };
};

export const installManagedTarget = async (
  params: InstallManagedTargetParams,
): Promise<InstallManagedTargetResult> =>
  await withCooperativeFileLock(params.path, async () =>
    installManagedTargetUnlocked(params),
  );

export interface UninstallManagedTargetOptions {
  force?: boolean;
}

const uninstallManagedTargetUnlocked = async (
  record: ProviderOwnershipRecord,
  options: UninstallManagedTargetOptions = {},
): Promise<{ removed: boolean; warning?: string }> => {
  const before = await readStableManagedTarget(record.path);
  if (!before) return { removed: true };
  const existing = before.content;
  let next: string;
  let warning: string | undefined;

  if (record.format === "json") {
    const current = parseJsonRecord(existing);
    const servers = getManagedMcpServers(current);
    const managed = Object.fromEntries(
      (record.managedKeys ?? []).flatMap((key) =>
        Object.hasOwn(servers, key) ? [[key, servers[key]] as const] : [],
      ),
    );
    if (
      Object.keys(managed).length > 0 &&
      digestJson(managed) !== record.managedDigest
    ) {
      if (!options.force) {
        return {
          removed: false,
          warning: `Skipped ${record.path}: managed MCP entries changed externally.`,
        };
      }
      const backupPath = await createBackup(record.path, existing);
      warning = `Externally changed managed MCP entries were backed up to ${backupPath} and removed.`;
    }
    const nextServers = { ...servers };
    for (const key of record.managedKeys ?? []) delete nextServers[key];
    const nextObject = { ...current, mcpServers: nextServers };
    next = `${JSON.stringify(nextObject, null, 2)}\n`;
    if (
      record.createdFile &&
      Object.keys(nextServers).length === 0 &&
      Object.keys(current).every((key) => key === "mcpServers")
    ) {
      next = "";
    }
  } else {
    const regions = findRegions(existing);
    assertWellFormedTextRegions(existing, regions, record.path);
    if (regions.length === 0) return { removed: true };
    const region = selectOwnedTextRegion(regions, record);
    if (!region) return { removed: true };
    const isCurrent = sha256(region.payload) === record.managedDigest;
    if (!isCurrent) {
      if (!options.force) {
        return {
          removed: false,
          warning: `Skipped ${record.path}: managed region changed externally.`,
        };
      }
      const backupPath = await createBackup(record.path, existing);
      warning = `An externally changed managed region was backed up to ${backupPath} and removed.`;
    }
    next = removeTextRegion(existing, region);
  }

  if (record.createdFile && !next.trim()) {
    await assertStableManagedTargetUnchanged(record.path, before);
    await rm(record.path, { force: true });
  } else {
    await writeFileAtomically(record.path, next, "utf8", {
      beforeCommit: async () =>
        assertStableManagedTargetUnchanged(record.path, before),
    });
    const verified = await readStableManagedTarget(record.path);
    if (!verified || verified.content !== next) {
      throw new Error(
        `${record.path} changed externally before the managed removal could be verified.`,
      );
    }
  }
  return { removed: true, ...(warning ? { warning } : {}) };
};

export const uninstallManagedTarget = async (
  record: ProviderOwnershipRecord,
  options: UninstallManagedTargetOptions = {},
): Promise<{ removed: boolean; warning?: string }> =>
  await withCooperativeFileLock(record.path, async () =>
    uninstallManagedTargetUnlocked(record, options),
  );

export const inspectManagedTarget = async (
  record: ProviderOwnershipRecord,
): Promise<{
  exists: boolean;
  syntaxValid: boolean;
  managedCurrent: boolean;
  error?: string;
}> => {
  try {
    const snapshot = await readStableManagedTarget(record.path);
    if (!snapshot) {
      return { exists: false, syntaxValid: false, managedCurrent: false };
    }
    const content = snapshot.content;
    if (record.format === "json") {
      const parsed = parseJsonRecord(content);
      const servers = getManagedMcpServers(parsed);
      const managed = Object.fromEntries(
        (record.managedKeys ?? []).flatMap((key) =>
          Object.hasOwn(servers, key) ? [[key, servers[key]] as const] : [],
        ),
      );
      return {
        exists: true,
        syntaxValid: true,
        managedCurrent: digestJson(managed) === record.managedDigest,
      };
    }
    const regions = findRegions(content);
    assertWellFormedTextRegions(content, regions, record.path);
    const region = selectOwnedTextRegion(regions, record);
    return {
      exists: true,
      syntaxValid: Boolean(region),
      managedCurrent:
        Boolean(region) &&
        sha256(region?.payload ?? "") === record.managedDigest,
    };
  } catch (error) {
    return {
      exists: true,
      syntaxValid: false,
      managedCurrent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface LoadedOwnershipManifest {
  manifest: ProviderOwnershipManifest;
  targetSnapshot: StableManagedTargetSnapshot | undefined;
}

export const loadOwnershipManifestSnapshot = async (
  path: string,
): Promise<LoadedOwnershipManifest> => {
  const targetSnapshot = await readStableManagedTarget(path);
  return {
    manifest: targetSnapshot
      ? parseOwnershipManifest(JSON.parse(targetSnapshot.content), path)
      : { schemaVersion: 1, targets: [] },
    targetSnapshot,
  };
};

export const loadOwnershipManifest = async (
  path: string,
): Promise<ProviderOwnershipManifest> =>
  (await loadOwnershipManifestSnapshot(path)).manifest;

export const saveOwnershipManifest = async (
  path: string,
  manifest: ProviderOwnershipManifest,
  options: {
    expectedTargetSnapshot?: StableManagedTargetSnapshot | undefined;
  } = {},
): Promise<StableManagedTargetSnapshot> => {
  await mkdir(dirname(path), { recursive: true });
  const normalized = parseOwnershipManifest(manifest, path);
  await writeJsonAtomically(
    path,
    normalized,
    Object.hasOwn(options, "expectedTargetSnapshot")
      ? {
          beforeCommit: async () =>
            assertStableManagedTargetUnchanged(
              path,
              options.expectedTargetSnapshot,
            ),
        }
      : {},
  );
  const written = await readStableManagedTarget(path);
  if (!written) {
    throw new Error(`${path} disappeared after its ownership update.`);
  }
  return written;
};
