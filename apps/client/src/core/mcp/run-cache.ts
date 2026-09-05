import { createMcpMetadataHash } from "./discovery-metadata.js";
import type { McpOperationCacheOptions } from "./types.js";

export interface McpRunCacheLookupOptions {
  workspaceRoot: string;
  serverId: string;
  serverIdentity?: string;
  operation: McpOperationCacheOptions["operation"];
  target: string;
  args?: unknown;
  policy?: McpOperationCacheOptions;
}

export interface McpRunCacheEntry<T> {
  key: string;
  runId: string;
  createdAt: number;
  expiresAt?: number;
  value: T;
}

export interface McpRunCacheResult<T> {
  hit: boolean;
  key: string;
  entry?: McpRunCacheEntry<T>;
}

export interface McpRunCacheManagerOptions {
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

const DEFAULT_MCP_RUN_CACHE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const normalizeLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;

export class McpRunCacheManager {
  private readonly entries = new Map<string, McpRunCacheEntry<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly entryBytes = new Map<string, number>();
  private retainedBytes = 0;
  private lastPrunedAt: number | undefined;

  constructor(options: McpRunCacheManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = normalizeLimit(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntryBytes = normalizeLimit(
      options.maxEntryBytes,
      DEFAULT_MAX_ENTRY_BYTES,
    );
  }

  createKey(options: McpRunCacheLookupOptions): string {
    return createMcpMetadataHash({
      workspaceRoot: options.workspaceRoot,
      runId: options.policy?.runId ?? null,
      serverId: options.serverId,
      serverIdentity: options.serverIdentity ?? null,
      operation: options.operation,
      target: options.target,
      args: options.args ?? null,
    });
  }

  get<T>(options: McpRunCacheLookupOptions): McpRunCacheResult<T> {
    const key = this.createKey(options);
    const policy = options.policy;

    if (
      !policy?.runId ||
      policy.enabled === false ||
      policy.forceRefresh === true
    ) {
      return { hit: false, key };
    }

    const entry = this.entries.get(key) as McpRunCacheEntry<T> | undefined;

    if (!entry) {
      return { hit: false, key };
    }

    if (
      (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) ||
      (policy.ttlMs !== undefined &&
        policy.ttlMs > 0 &&
        entry.createdAt + policy.ttlMs <= this.now())
    ) {
      this.deleteEntry(key);
      return { hit: false, key };
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return {
      hit: true,
      key,
      entry: { ...entry, value: structuredClone(entry.value) },
    };
  }

  set<T>(
    options: McpRunCacheLookupOptions,
    value: T,
  ): McpRunCacheEntry<T> | undefined {
    const policy = options.policy;

    if (!policy?.runId || policy.enabled === false) {
      return undefined;
    }

    const key = this.createKey(options);
    this.deleteEntry(key);
    if (this.maxEntries === 0 || this.maxBytes === 0) return undefined;
    let byteLength: number;
    let cachedValue: T;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return undefined;
      byteLength = Buffer.byteLength(serialized, "utf8");
      if (byteLength > this.maxEntryBytes || byteLength > this.maxBytes)
        return undefined;
      cachedValue = structuredClone(value);
    } catch {
      return undefined;
    }
    const ttlMs = normalizeLimit(policy.ttlMs, DEFAULT_MCP_RUN_CACHE_TTL_MS);
    const createdAt = this.now();
    const entry: McpRunCacheEntry<T> = {
      key,
      runId: policy.runId,
      createdAt,
      ...(ttlMs > 0 ? { expiresAt: createdAt + ttlMs } : {}),
      value: cachedValue,
    };

    this.entries.set(key, entry);
    this.entryBytes.set(key, byteLength);
    this.retainedBytes += byteLength;
    this.prune();

    return { ...entry, value };
  }

  deleteRun(runId: string): number {
    let deleted = 0;

    for (const [key, entry] of this.entries) {
      if (entry.runId === runId) {
        this.deleteEntry(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  clear(): void {
    this.entries.clear();
    this.entryBytes.clear();
    this.retainedBytes = 0;
    this.lastPrunedAt = undefined;
  }

  size(): number {
    return this.entries.size;
  }

  private deleteEntry(key: string): void {
    this.retainedBytes -= this.entryBytes.get(key) ?? 0;
    this.entryBytes.delete(key);
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();

    if (
      this.lastPrunedAt === undefined ||
      now - this.lastPrunedAt >= 1000 ||
      now < this.lastPrunedAt
    ) {
      this.lastPrunedAt = now;
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now)
          this.deleteEntry(key);
      }
    }

    while (
      this.entries.size > this.maxEntries ||
      this.retainedBytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;

      if (!oldestKey) {
        return;
      }

      this.deleteEntry(oldestKey);
    }
  }
}

export const mcpRunCacheManager = new McpRunCacheManager();
