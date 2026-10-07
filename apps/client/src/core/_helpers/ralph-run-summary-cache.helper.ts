import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RalphRunLease, RalphRunSummary } from "../ralph.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export interface CachedRalphRunSummary {
  summary: RalphRunSummary;
  hasCheckpoint: boolean;
  checkpointLease?: RalphRunLease;
}

interface CacheEntry extends CachedRalphRunSummary {
  fingerprint: string;
}

const fingerprintRecord = async (path: string): Promise<string> => {
  const metadata = await stat(path, { bigint: true });
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`;
};

export class RalphRunSummaryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly usedKeys = new Set<string>();
  private changed = false;
  private readonly path: string;

  constructor(
    private readonly runDirectory: string,
    cacheDirectory: string,
  ) {
    this.path = join(cacheDirectory, "run-summary-cache.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (
        value?.schemaVersion !== 1 ||
        !value.entries ||
        typeof value.entries !== "object" ||
        Array.isArray(value.entries)
      )
        throw new Error("Invalid summary cache.");
      for (const [key, entry] of Object.entries(value.entries)) {
        const cached = entry as CacheEntry;
        if (
          typeof cached?.fingerprint !== "string" ||
          typeof cached.hasCheckpoint !== "boolean" ||
          typeof cached.summary?.id !== "string" ||
          typeof cached.summary.status !== "string" ||
          typeof cached.summary.flowId !== "string" ||
          typeof cached.summary.flowName !== "string" ||
          typeof cached.summary.path !== "string" ||
          typeof cached.summary.createdAt !== "string" ||
          typeof cached.summary.summary !== "string" ||
          typeof cached.summary.recoverable !== "boolean" ||
          !Number.isSafeInteger(cached.summary.blockCount) ||
          !Number.isSafeInteger(cached.summary.eventCount)
        )
          throw new Error("Invalid cached run summary.");
        this.entries.set(key, cached);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Ralph summary cache will be rebuilt: ${String(error)}`);
        this.entries.clear();
        this.changed = true;
      }
    }
  }

  async read(
    path: string,
    load: () => Promise<CachedRalphRunSummary | undefined>,
  ): Promise<CachedRalphRunSummary | undefined> {
    const key = relative(this.runDirectory, path).replaceAll("\\", "/");
    this.usedKeys.add(key);
    let fingerprint: string;
    try {
      fingerprint = await fingerprintRecord(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const cached = this.entries.get(key);
    if (cached?.fingerprint === fingerprint && cached.summary.path === path)
      return cached;
    const loaded = await load();
    if (!loaded) {
      this.changed = this.entries.delete(key) || this.changed;
      return undefined;
    }
    this.entries.set(key, { ...loaded, fingerprint });
    this.changed = true;
    return loaded;
  }

  async save(): Promise<void> {
    for (const key of this.entries.keys()) {
      if (!this.usedKeys.has(key)) {
        this.entries.delete(key);
        this.changed = true;
      }
    }
    if (!this.changed) return;
    try {
      await writeJsonAtomically(this.path, {
        schemaVersion: 1,
        entries: Object.fromEntries(this.entries),
      });
    } catch (error) {
      console.warn(`Ralph summary cache could not be saved: ${String(error)}`);
    }
  }
}
