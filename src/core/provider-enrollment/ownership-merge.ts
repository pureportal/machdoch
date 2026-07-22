import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomically, writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import { digestJson, sha256 } from "./digests.js";

const MARKDOWN_START = "<!-- machdoch-managed:provider-enrollment:start -->";
const MARKDOWN_END = "<!-- machdoch-managed:provider-enrollment:end -->";
const TOML_START = "# machdoch-managed:provider-enrollment:start";
const TOML_END = "# machdoch-managed:provider-enrollment:end";

export type ManagedTargetFormat = "markdown" | "toml" | "json";

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

const getMarkers = (format: Exclude<ManagedTargetFormat, "json">): readonly [string, string] => {
  return format === "markdown" ? [MARKDOWN_START, MARKDOWN_END] : [TOML_START, TOML_END];
};

const findRegion = (
  content: string,
  format: Exclude<ManagedTargetFormat, "json">,
): { start: number; end: number; payload: string } | undefined => {
  const [startMarker, endMarker] = getMarkers(format);
  const start = content.indexOf(startMarker);
  if (start < 0) return undefined;
  const endMarkerIndex = content.indexOf(endMarker, start + startMarker.length);
  if (endMarkerIndex < 0) return undefined;
  const payloadStart = start + startMarker.length;
  return {
    start,
    end: endMarkerIndex + endMarker.length,
    payload: content.slice(payloadStart, endMarkerIndex).replace(/^\r?\n|\r?\n$/gu, ""),
  };
};

const findRegions = (
  content: string,
  format: Exclude<ManagedTargetFormat, "json">,
): Array<{ start: number; end: number; payload: string }> => {
  const regions: Array<{ start: number; end: number; payload: string }> = [];
  let offset = 0;
  while (offset < content.length) {
    const region = findRegion(content.slice(offset), format);
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

const removeTextRegions = (
  content: string,
  format: Exclude<ManagedTargetFormat, "json">,
): string => {
  let result = content;
  for (const region of findRegions(content, format).reverse()) {
    result = `${result.slice(0, region.start)}${result.slice(region.end)}`;
  }
  return result.trim();
};

export const stripManagedProviderRegions = (content: string): string => {
  let result = content;
  for (const format of ["markdown", "toml"] as const) {
    result = removeTextRegions(result, format);
  }
  return result.trim();
};

const mergeTextRegion = (
  existing: string,
  payload: string,
  format: Exclude<ManagedTargetFormat, "json">,
): string => {
  const [startMarker, endMarker] = getMarkers(format);
  const regionText = `${startMarker}\n${payload.trim()}\n${endMarker}`;
  const unmanaged = removeTextRegions(existing, format);
  return unmanaged.length > 0
    ? `${unmanaged}\n\n${regionText}\n`
    : `${regionText}\n`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseJsonRecord = (content: string): Record<string, unknown> => {
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("Managed provider JSON target must contain an object.");
  return parsed;
};

const getManagedMcpServers = (value: Record<string, unknown>): Record<string, unknown> => {
  const raw = value.mcpServers;
  return isRecord(raw) ? raw : {};
};

const createBackup = async (path: string): Promise<string> => {
  const backupPath = `${path}.machdoch-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  await copyFile(path, backupPath);
  return backupPath;
};

const pathExists = async (path: string): Promise<boolean> => {
  return await stat(path).then(() => true, () => false);
};

export interface InstallManagedTargetParams {
  path: string;
  provider: string;
  scope: "user" | "workspace";
  format: ManagedTargetFormat;
  payload: string | Record<string, unknown>;
  previous?: ProviderOwnershipRecord;
}

export interface InstallManagedTargetResult {
  record: ProviderOwnershipRecord;
  changed: boolean;
  warnings: string[];
}

export const installManagedTarget = async (
  params: InstallManagedTargetParams,
): Promise<InstallManagedTargetResult> => {
  const existed = await pathExists(params.path);
  const existing = existed ? await readFile(params.path, "utf8") : "";
  const warnings: string[] = [];
  let managedDigest: string;
  let content: string;
  let managedKeys: string[] | undefined;

  if (params.format === "json") {
    const payload = params.payload as Record<string, unknown>;
    const generatedServers = getManagedMcpServers(payload);
    managedKeys = Object.keys(generatedServers).sort();
    managedDigest = digestJson(generatedServers);
    const current = parseJsonRecord(existing);
    const currentServers = getManagedMcpServers(current);
    const previousManaged = Object.fromEntries(
      (params.previous?.managedKeys ?? []).flatMap((key) =>
        key in currentServers ? [[key, currentServers[key]] as const] : [],
      ),
    );
    if (
      params.previous &&
      Object.keys(previousManaged).length > 0 &&
      digestJson(previousManaged) !== params.previous.managedDigest
    ) {
      const backupPath = await createBackup(params.path);
      warnings.push(`Externally changed managed MCP entries were backed up to ${backupPath} and reconciled.`);
    }
    const nextServers = { ...currentServers };
    for (const key of params.previous?.managedKeys ?? []) delete nextServers[key];
    Object.assign(nextServers, generatedServers);
    content = `${JSON.stringify({ ...current, mcpServers: nextServers }, null, 2)}\n`;
  } else {
    const payload = String(params.payload).trim();
    managedDigest = sha256(payload);
    const currentRegions = findRegions(existing, params.format);
    const currentRegion = currentRegions[0];
    if (
      params.previous &&
      currentRegion && (
        currentRegions.length !== 1 ||
        sha256(currentRegion.payload) !== params.previous.managedDigest
      )
    ) {
      const backupPath = await createBackup(params.path);
      warnings.push(`An externally changed managed region was backed up to ${backupPath} and reconciled.`);
    }
    content = mergeTextRegion(existing, payload, params.format);
  }

  const changed = content !== existing;
  if (changed) await writeFileAtomically(params.path, content);
  const verified = await readFile(params.path, "utf8");
  const installedFileDigest = sha256(verified);
  const record: ProviderOwnershipRecord = {
    path: params.path,
    provider: params.provider,
    scope: params.scope,
    format: params.format,
    managedDigest,
    installedFileDigest,
    createdFile: params.previous?.createdFile ?? !existed,
    ...(managedKeys ? { managedKeys } : {}),
    installedAt: new Date().toISOString(),
  };
  return { record, changed, warnings };
};

export interface UninstallManagedTargetOptions {
  force?: boolean;
}

export const uninstallManagedTarget = async (
  record: ProviderOwnershipRecord,
  options: UninstallManagedTargetOptions = {},
): Promise<{ removed: boolean; warning?: string }> => {
  if (!(await pathExists(record.path))) return { removed: true };
  const existing = await readFile(record.path, "utf8");
  let next: string;
  let warning: string | undefined;

  if (record.format === "json") {
    const current = parseJsonRecord(existing);
    const servers = getManagedMcpServers(current);
    const managed = Object.fromEntries(
      (record.managedKeys ?? []).flatMap((key) =>
        key in servers ? [[key, servers[key]] as const] : [],
      ),
    );
    if (Object.keys(managed).length > 0 && digestJson(managed) !== record.managedDigest) {
      if (!options.force) {
        return { removed: false, warning: `Skipped ${record.path}: managed MCP entries changed externally.` };
      }
      const backupPath = await createBackup(record.path);
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
    const regions = findRegions(existing, record.format);
    if (regions.length === 0) return { removed: true };
    const isCurrent = regions.length === 1 &&
      sha256(regions[0]?.payload ?? "") === record.managedDigest;
    if (!isCurrent) {
      if (!options.force) {
        return { removed: false, warning: `Skipped ${record.path}: managed region changed externally.` };
      }
      const backupPath = await createBackup(record.path);
      warning = `An externally changed managed region was backed up to ${backupPath} and removed.`;
    }
    next = removeTextRegions(existing, record.format);
    if (next) next += "\n";
  }

  if (record.createdFile && !next.trim()) {
    await rm(record.path, { force: true });
  } else {
    await writeFileAtomically(record.path, next);
  }
  return { removed: true, ...(warning ? { warning } : {}) };
};

export const inspectManagedTarget = async (
  record: ProviderOwnershipRecord,
): Promise<{
  exists: boolean;
  syntaxValid: boolean;
  managedCurrent: boolean;
  error?: string;
}> => {
  if (!(await pathExists(record.path))) {
    return { exists: false, syntaxValid: false, managedCurrent: false };
  }
  try {
    const content = await readFile(record.path, "utf8");
    if (record.format === "json") {
      const parsed = parseJsonRecord(content);
      const servers = getManagedMcpServers(parsed);
      const managed = Object.fromEntries(
        (record.managedKeys ?? []).flatMap((key) =>
          key in servers ? [[key, servers[key]] as const] : [],
        ),
      );
      return {
        exists: true,
        syntaxValid: true,
        managedCurrent: digestJson(managed) === record.managedDigest,
      };
    }
    const region = findRegion(content, record.format);
    return {
      exists: true,
      syntaxValid: Boolean(region),
      managedCurrent: Boolean(region) && sha256(region?.payload ?? "") === record.managedDigest,
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

export const loadOwnershipManifest = async (
  path: string,
): Promise<ProviderOwnershipManifest> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ProviderOwnershipManifest;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.targets)
      ? parsed
      : { schemaVersion: 1, targets: [] };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: 1, targets: [] };
    }
    throw error;
  }
};

export const saveOwnershipManifest = async (
  path: string,
  manifest: ProviderOwnershipManifest,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomically(path, manifest);
};
