import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type {
  RalphRunJournalEntry,
  RalphStoredJournalEntry,
} from "./ralph-run-store.helper.js";

export const MAX_RALPH_JOURNAL_ENTRY_BYTES = 8 * 1024 * 1024;

export class RalphRunStoreCorruptionError extends Error {}

const JOURNAL_ENTRY_KINDS = new Set<RalphRunJournalEntry["kind"]>([
  "checkpoint",
  "heartbeat",
  "route",
  "outcome",
  "recovery",
]);

export interface RalphJournalReadState {
  entries: RalphStoredJournalEntry[];
  lastSequence: number;
  validBytes: number;
  repair: "none" | "truncate" | "append-newline";
}

const parseJournalEntry = (
  line: Buffer,
  expectedSequence: number,
): RalphStoredJournalEntry | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.sequence !== expectedSequence ||
    typeof record.at !== "string" ||
    typeof record.kind !== "string" ||
    !JOURNAL_ENTRY_KINDS.has(record.kind as RalphRunJournalEntry["kind"]) ||
    typeof record.summary !== "string" ||
    typeof record.checksum !== "string"
  ) {
    return undefined;
  }
  const { checksum, ...payload } = record;
  if (
    checksum !==
    createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  ) {
    return undefined;
  }
  return value as RalphStoredJournalEntry;
};

export const readRalphRunJournal = async (
  handle: FileHandle,
  collectEntries: boolean,
): Promise<RalphJournalReadState> => {
  const state: RalphJournalReadState = {
    entries: [],
    lastSequence: 0,
    validBytes: 0,
    repair: "none",
  };
  const buffer = Buffer.alloc(64 * 1024);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let oversized = false;
  let position = 0;

  const append = (entry: RalphStoredJournalEntry): void => {
    state.lastSequence = entry.sequence;
    if (collectEntries) state.entries.push(entry);
  };

  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let offset = 0;
    while (offset < bytesRead) {
      const newline = buffer.indexOf(0x0a, offset);
      const terminated = newline >= 0 && newline < bytesRead;
      const end = terminated ? newline : bytesRead;
      const fragment = buffer.subarray(offset, end);
      if (pendingBytes + fragment.length > MAX_RALPH_JOURNAL_ENTRY_BYTES) {
        oversized = true;
        pending = [];
        pendingBytes = 0;
      }
      if (!oversized && fragment.length > 0) {
        pending.push(Buffer.from(fragment));
        pendingBytes += fragment.length;
      }
      if (terminated) {
        const entry = oversized
          ? undefined
          : parseJournalEntry(
              Buffer.concat(pending, pendingBytes),
              state.lastSequence + 1,
            );
        if (!entry) {
          throw new RalphRunStoreCorruptionError(
            `RALPH journal is corrupt after sequence ${state.lastSequence}.`,
          );
        }
        append(entry);
        state.validBytes = position + end + 1;
        pending = [];
        pendingBytes = 0;
        oversized = false;
      }
      offset = terminated ? end + 1 : end;
    }
    position += bytesRead;
  }

  if (oversized || pendingBytes > 0) {
    const entry = oversized
      ? undefined
      : parseJournalEntry(
          Buffer.concat(pending, pendingBytes),
          state.lastSequence + 1,
        );
    if (entry) {
      append(entry);
      state.validBytes = position;
      state.repair = "append-newline";
    } else {
      state.repair = "truncate";
    }
  }
  return state;
};
