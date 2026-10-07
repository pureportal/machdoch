import { createHash, randomUUID } from "node:crypto";
import {
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
import { isRalphRunOwnerAlive } from "./is-ralph-run-owner-alive.helper.js";
import { retryTransientFileOperation } from "./retry-transient-file-operation.helper.js";
import {
  MAX_RALPH_JOURNAL_ENTRY_BYTES,
  readRalphRunJournal,
  type RalphJournalReadState,
} from "./ralph-run-journal.helper.js";
export { RalphRunStoreCorruptionError } from "./ralph-run-journal.helper.js";

const CHECKPOINT_SCHEMA_VERSION = 1;
const LEASE_SCHEMA_VERSION = 1;
const MAX_STORED_CHECKPOINTS = 8;

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

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

export class RalphRunStoreOwnershipError extends Error {}

export class RalphRunStore {
  public readonly directory: string;
  public readonly checkpointDirectory: string;
  public readonly leasePath: string;
  public readonly journalPath: string;
  private checkpointGeneration = 0;
  private journalSequence = 0;
  private journalFailure: Error | undefined;

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
    const journal = await this.readJournalState(false);
    await this.repairJournal(journal);
    this.journalSequence = journal.lastSequence;
    this.journalFailure = undefined;
  }

  private async listCheckpointFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await retryTransientFileOperation(() =>
        readdir(this.checkpointDirectory),
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => /^\d{10}-[a-f\d-]+\.json$/iu.test(entry))
      .sort()
      .map((entry) => join(this.checkpointDirectory, entry));
  }

  public async persistCheckpoint(
    checkpoint: RalphRunCheckpoint,
    summary: string,
    beforeCommit?: () => Promise<void>,
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
    await writeJsonAtomically(
      path,
      envelope,
      beforeCommit ? { beforeCommit } : {},
    );
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
        const value = JSON.parse(
          await retryTransientFileOperation(() => readFile(path, "utf8")),
        ) as unknown;
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
      } catch (error) {
        if (error instanceof SyntaxError || isMissingFileError(error)) {
          continue;
        }
        throw error;
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
          Date.now() - leaseStat.mtimeMs <= lease.durationMs &&
          isRalphRunOwnerAlive(lease.ownerId),
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
    return retryTransientFileOperation(
      () => this.readLeaseOnce(),
      retryWindowMs,
    );
  }

  public async heartbeat(
    expected: Pick<
      RalphRunStoreLease,
      "runId" | "flowId" | "ownerId" | "generation"
    >,
    retryWindowMs: number,
  ): Promise<void> {
    await retryTransientFileOperation(async () => {
      const current = await this.readLease(0);
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
      const refreshed = await this.readLease(0);
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
    }, retryWindowMs);
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
    if (this.journalFailure) throw this.journalFailure;
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
    const serialized = Buffer.from(`${JSON.stringify(stored)}\n`, "utf8");
    if (serialized.length - 1 > MAX_RALPH_JOURNAL_ENTRY_BYTES) {
      throw new Error("RALPH journal entry exceeds its storage limit.");
    }
    await mkdir(this.directory, { recursive: true });
    const journal = await retryTransientFileOperation(async () => {
      try {
        return await open(this.journalPath, "r+");
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        return open(this.journalPath, "wx+");
      }
    });
    try {
      const offset = (await journal.stat()).size;
      let appended = false;
      try {
        await retryTransientFileOperation(async () => {
          if (!appended) {
            await journal.truncate(offset);
            let writtenBytes = 0;
            while (writtenBytes < serialized.length) {
              const { bytesWritten } = await journal.write(
                serialized,
                writtenBytes,
                serialized.length - writtenBytes,
                offset + writtenBytes,
              );
              if (bytesWritten === 0) {
                throw new Error("RALPH journal write made no progress.");
              }
              writtenBytes += bytesWritten;
            }
            appended = true;
          }
          await journal.sync();
        });
      } catch (error) {
        try {
          await journal.truncate(offset);
          await journal.sync();
        } catch (rollbackError) {
          const writeReason =
            error instanceof Error ? error.message : String(error);
          const rollbackReason =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          this.journalFailure = new AggregateError(
            [error, rollbackError],
            `RALPH journal append failed: ${writeReason}\nIts partial write could not be removed: ${rollbackReason}`,
          );
          throw this.journalFailure;
        }
        throw error;
      }
      this.journalSequence = payload.sequence;
    } finally {
      await journal.close();
    }
    return stored;
  }

  private async readJournalState(
    collectEntries: boolean,
  ): Promise<RalphJournalReadState> {
    let journal: Awaited<ReturnType<typeof open>>;
    try {
      journal = await retryTransientFileOperation(() =>
        open(this.journalPath, "r"),
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return { entries: [], lastSequence: 0, validBytes: 0, repair: "none" };
      }
      throw error;
    }
    try {
      return await retryTransientFileOperation(() =>
        readRalphRunJournal(journal, collectEntries),
      );
    } finally {
      await journal.close();
    }
  }

  private async repairJournal(state: RalphJournalReadState): Promise<void> {
    if (state.repair === "none") {
      return;
    }
    await retryTransientFileOperation(async () => {
      const journal = await open(this.journalPath, "r+");
      try {
        if (state.repair === "truncate") {
          await journal.truncate(state.validBytes);
        } else {
          await journal.write(Buffer.from("\n"), 0, 1, state.validBytes);
        }
        await journal.sync();
      } finally {
        await journal.close();
      }
    });
  }

  public async readJournal(): Promise<RalphStoredJournalEntry[]> {
    return (await this.readJournalState(true)).entries;
  }
}
