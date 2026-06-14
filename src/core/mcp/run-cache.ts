import { createMcpMetadataHash } from "./discovery-metadata.js";
import type { McpOperationCacheOptions } from "./types.js";

export interface McpRunCacheLookupOptions {
  workspaceRoot: string;
  serverId: string;
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
}

const DEFAULT_MCP_RUN_CACHE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;

export class McpRunCacheManager {
  private readonly entries = new Map<string, McpRunCacheEntry<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: McpRunCacheManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  createKey(options: McpRunCacheLookupOptions): string {
    return createMcpMetadataHash({
      workspaceRoot: options.workspaceRoot,
      runId: options.policy?.runId ?? null,
      serverId: options.serverId,
      operation: options.operation,
      target: options.target,
      args: options.args ?? null,
    });
  }

  get<T>(options: McpRunCacheLookupOptions): McpRunCacheResult<T> {
    const key = this.createKey(options);
    const policy = options.policy;

    if (!policy?.runId || policy.enabled === false || policy.forceRefresh === true) {
      return { hit: false, key };
    }

    const entry = this.entries.get(key) as McpRunCacheEntry<T> | undefined;

    if (!entry) {
      return { hit: false, key };
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return { hit: false, key };
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return { hit: true, key, entry };
  }

  set<T>(options: McpRunCacheLookupOptions, value: T): McpRunCacheEntry<T> | undefined {
    const policy = options.policy;

    if (!policy?.runId || policy.enabled === false) {
      return undefined;
    }

    const key = this.createKey(options);
    const ttlMs = policy.ttlMs ?? DEFAULT_MCP_RUN_CACHE_TTL_MS;
    const createdAt = this.now();
    const entry: McpRunCacheEntry<T> = {
      key,
      runId: policy.runId,
      createdAt,
      ...(ttlMs > 0 ? { expiresAt: createdAt + ttlMs } : {}),
      value,
    };

    this.entries.set(key, entry);
    this.prune();

    return entry;
  }

  deleteRun(runId: string): number {
    let deleted = 0;

    for (const [key, entry] of this.entries) {
      if (entry.runId === runId) {
        this.entries.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;

      if (!oldestKey) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }
}

export const mcpRunCacheManager = new McpRunCacheManager();
