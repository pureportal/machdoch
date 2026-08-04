import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
  utimes,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { RalphRunCheckpoint } from "../ralph.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

const CHECKPOINT_SCHEMA_VERSION = 1;
const LEASE_SCHEMA_VERSION = 1;
const MAX_STORED_CHECKPOINTS = 8;
const TRANSIENT_FILE_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

interface RalphCheckpointEnvelope {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  generation: number;
  createdAt: string;
  checksum: string;
  checkpoint: RalphRunCheckpoint;
}

export interface RalphRunStoreLease {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  runId: string;
  flowId: string;
  ownerId: string;
  generation: number;
  acquiredAt: string;
  durationMs: number;
  releasedAt?: string;
}

export interface RalphRunStoreLeaseState {
  lease: RalphRunStoreLease;
  heartbeatAt: string;
  active: boolean;
}

export interface RalphRunJournalEntry {
  sequence: number;
  at: string;
  kind: "checkpoint" | "heartbeat" | "route" | "outcome" | "recovery";
  blockId?: string;
  summary: string;
  checkpointGeneration?: number;
}

export interface RalphStoredJournalEntry extends RalphRunJournalEntry {
  checksum: string;
}

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const checkpointChecksum = (
  generation: number,
  checkpoint: RalphRunCheckpoint,
): string => hash(JSON.stringify({ generation, checkpoint }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTransientFileError = (error: unknown): boolean =>
  isRecord(error) &&
  typeof error.code === "string" &&
  TRANSIENT_FILE_ERROR_CODES.has(error.code);

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export class RalphRunStoreOwnershipError extends Error {}

export class RalphRunStore {
  public readonly directory: string;
  public readonly checkpointDirectory: string;
  public readonly leasePath: string;
  public readonly journalPath: string;
  private checkpointGeneration = 0;
  private journalSequence = 0;

  public constructor(directory: string) {
    this.directory = directory;
    this.checkpointDirectory = join(directory, "checkpoints");
    this.leasePath = join(directory, "run-lease.json");
    this.journalPath = join(directory, "journal.jsonl");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.checkpointDirectory, { recursive: true });
    const checkpoints = await this.listCheckpointFiles();
    this.checkpointGeneration = checkpoints.reduce((maximum, path) => {
      const generation = Number.parseInt(
        basename(path).split("-")[0] ?? "",
        10,
      );
      return Number.isInteger(generation)
        ? Math.max(maximum, generation)
        : maximum;
    }, 0);
    this.journalSequence = (await this.readJournal()).at(-1)?.sequence ?? 0;
  }

  private async listCheckpointFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.checkpointDirectory);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => /^\d{10}-[a-f\d-]+\.json$/iu.test(entry))
      .sort()
      .map((entry) => join(this.checkpointDirectory, entry));
  }

  public async persistCheckpoint(
    checkpoint: RalphRunCheckpoint,
    summary: string,
  ): Promise<{ generation: number; path: string }> {
    await mkdir(this.checkpointDirectory, { recursive: true });
    const generation = this.checkpointGeneration + 1;
    const envelope: RalphCheckpointEnvelope = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      generation,
      createdAt: new Date().toISOString(),
      checksum: checkpointChecksum(generation, checkpoint),
      checkpoint,
    };
    const path = join(
      this.checkpointDirectory,
      `${String(generation).padStart(10, "0")}-${randomUUID()}.json`,
    );
    await writeJsonAtomically(path, envelope);
    this.checkpointGeneration = generation;
    await this.appendJournal({
      kind: "checkpoint",
      summary,
      blockId: checkpoint.currentBlockId,
      checkpointGeneration: generation,
    });
    const checkpointFiles = await this.listCheckpointFiles();
    await Promise.all(
      checkpointFiles
        .slice(0, Math.max(0, checkpointFiles.length - MAX_STORED_CHECKPOINTS))
        .map((checkpointPath) => unlink(checkpointPath).catch(() => undefined)),
    );
    return { generation, path };
  }

  public async readLatestCheckpoint(): Promise<
    | { generation: number; path: string; checkpoint: RalphRunCheckpoint }
    | undefined
  > {
    const files = (await this.listCheckpointFiles()).reverse();
    for (const path of files) {
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (
          !isRecord(value) ||
          value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
          typeof value.generation !== "number" ||
          typeof value.checksum !== "string" ||
          !isRecord(value.checkpoint)
        ) {
          continue;
        }
        const checkpoint = value.checkpoint as unknown as RalphRunCheckpoint;
        if (
          value.checksum !== checkpointChecksum(value.generation, checkpoint)
        ) {
          continue;
        }
        return { generation: value.generation, path, checkpoint };
      } catch {
        // A crash may leave the newest generation unreadable. Older immutable
        // generations remain valid recovery points.
      }
    }
    return undefined;
  }

  public async acquireLease(
    lease: Omit<RalphRunStoreLease, "schemaVersion" | "durationMs">,
    durationMs: number,
  ): Promise<RalphRunStoreLease> {
    const stored: RalphRunStoreLease = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      ...lease,
      durationMs,
    };
    await writeJsonAtomically(this.leasePath, stored);
    return stored;
  }

  private async readLeaseOnce(): Promise<RalphRunStoreLeaseState | undefined> {
    let leaseFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      leaseFile = await open(this.leasePath, "r");
      const raw = await leaseFile.readFile("utf8");
      const leaseStat = await leaseFile.stat();
      const value = JSON.parse(raw) as unknown;
      if (
        !isRecord(value) ||
        value.schemaVersion !== LEASE_SCHEMA_VERSION ||
        typeof value.runId !== "string" ||
        typeof value.flowId !== "string" ||
        typeof value.ownerId !== "string" ||
        typeof value.generation !== "number" ||
        typeof value.acquiredAt !== "string" ||
        typeof value.durationMs !== "number"
      ) {
        throw new RalphRunStoreOwnershipError(
          "RALPH durable lease is invalid; refusing to assume that ownership is unclaimed.",
        );
      }
      const lease = value as unknown as RalphRunStoreLease;
      const heartbeatAt = leaseStat.mtime.toISOString();
      return {
        lease,
        heartbeatAt,
        active:
          !lease.releasedAt &&
          Date.now() - leaseStat.mtimeMs <= lease.durationMs,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    } finally {
      await leaseFile?.close();
    }
  }

  public async readLease(
    retryWindowMs = 1_000,
  ): Promise<RalphRunStoreLeaseState | undefined> {
    const deadline = Date.now() + Math.max(0, retryWindowMs);
    let retryDelayMs = 20;

    for (;;) {
      try {
        return await this.readLeaseOnce();
      } catch (error) {
        if (!isTransientFileError(error) || Date.now() >= deadline) {
          throw error;
        }
        await delay(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
        retryDelayMs = Math.min(250, retryDelayMs * 2);
      }
    }
  }

  public async heartbeat(
    expected: Pick<
      RalphRunStoreLease,
      "runId" | "flowId" | "ownerId" | "generation"
    >,
    retryWindowMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, retryWindowMs);
    let retryDelayMs = 20;

    for (;;) {
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        const current = await this.readLease(Math.min(1_000, remainingMs));
        if (
          !current ||
          current.lease.runId !== expected.runId ||
          current.lease.flowId !== expected.flowId ||
          current.lease.ownerId !== expected.ownerId ||
          current.lease.generation !== expected.generation ||
          current.lease.releasedAt
        ) {
          throw new RalphRunStoreOwnershipError(
            "RALPH durable lease ownership changed.",
          );
        }
        const now = new Date();
        await utimes(this.leasePath, now, now);
        const refreshed = await this.readLease(
          Math.min(1_000, Math.max(0, deadline - Date.now())),
        );
        if (
          !refreshed ||
          refreshed.lease.runId !== expected.runId ||
          refreshed.lease.flowId !== expected.flowId ||
          refreshed.lease.ownerId !== expected.ownerId ||
          refreshed.lease.generation !== expected.generation ||
          refreshed.lease.releasedAt
        ) {
          throw new RalphRunStoreOwnershipError(
            "RALPH durable lease ownership changed during heartbeat.",
          );
        }
        return;
      } catch (error) {
        if (!isTransientFileError(error) || Date.now() >= deadline) {
          throw error;
        }
        await delay(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
        retryDelayMs = Math.min(250, retryDelayMs * 2);
      }
    }
  }

  public async releaseLease(
    expected: Pick<
      RalphRunStoreLease,
      "runId" | "flowId" | "ownerId" | "generation"
    >,
  ): Promise<void> {
    const current = await this.readLease();
    if (
      !current ||
      current.lease.runId !== expected.runId ||
      current.lease.flowId !== expected.flowId ||
      current.lease.ownerId !== expected.ownerId ||
      current.lease.generation !== expected.generation
    ) {
      return;
    }
    await writeJsonAtomically(this.leasePath, {
      ...current.lease,
      releasedAt: new Date().toISOString(),
    });
  }

  public async appendJournal(
    entry: Omit<RalphRunJournalEntry, "sequence" | "at"> &
      Partial<Pick<RalphRunJournalEntry, "sequence" | "at">>,
  ): Promise<RalphStoredJournalEntry> {
    const payload: RalphRunJournalEntry = {
      sequence: entry.sequence ?? this.journalSequence + 1,
      at: entry.at ?? new Date().toISOString(),
      kind: entry.kind,
      summary: entry.summary,
      ...(entry.blockId ? { blockId: entry.blockId } : {}),
      ...(entry.checkpointGeneration !== undefined
        ? { checkpointGeneration: entry.checkpointGeneration }
        : {}),
    };
    const stored = { ...payload, checksum: hash(JSON.stringify(payload)) };
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.journalPath, `${JSON.stringify(stored)}\n`, "utf8");
    this.journalSequence = payload.sequence;
    return stored;
  }

  public async readJournal(): Promise<RalphStoredJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch {
      return [];
    }
    const entries: RalphStoredJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const value = JSON.parse(line) as unknown;
        if (
          !isRecord(value) ||
          typeof value.sequence !== "number" ||
          typeof value.at !== "string" ||
          typeof value.kind !== "string" ||
          typeof value.summary !== "string" ||
          typeof value.checksum !== "string"
        ) {
          continue;
        }
        const { checksum, ...payload } = value;
        if (checksum !== hash(JSON.stringify(payload))) {
          continue;
        }
        entries.push(value as unknown as RalphStoredJournalEntry);
      } catch {
        // Ignore a truncated final append after a process crash.
      }
    }
    return entries;
  }
}
