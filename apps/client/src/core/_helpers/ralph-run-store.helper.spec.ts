import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RalphRunCheckpoint } from "../ralph.js";
import {
  RalphRunStore,
  RalphRunStoreCorruptionError,
  RalphRunStoreOwnershipError,
} from "./ralph-run-store.helper.js";
import { MAX_RALPH_JOURNAL_ENTRY_BYTES } from "./ralph-run-journal.helper.js";

const directories: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
  };
});
const checkpoint = (currentBlockId: string): RalphRunCheckpoint => ({
  currentBlockId,
  transitions: 1,
  variables: {},
  resultsByBlock: {},
  runLog: [],
  blockResults: [],
  events: [],
  errorCounts: {},
  repeatedFailures: {},
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RALPH run store", () => {
  it("rejects an oversized entry before changing the journal or sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const contents = await readFile(store.journalPath, "utf8");
    await expect(
      store.appendJournal({
        kind: "route",
        summary: "x".repeat(MAX_RALPH_JOURNAL_ENTRY_BYTES),
      }),
    ).rejects.toThrow("exceeds its storage limit");
    expect(await readFile(store.journalPath, "utf8")).toBe(contents);
    expect(
      await store.appendJournal({ kind: "route", summary: "second" }),
    ).toMatchObject({ sequence: 2 });
  });

  it("repairs an oversized incomplete tail while preserving earlier records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const contents = await readFile(store.journalPath, "utf8");
    await writeFile(
      store.journalPath,
      contents + "x".repeat(MAX_RALPH_JOURNAL_ENTRY_BYTES + 4_096),
    );
    await store.initialize();
    expect(await readFile(store.journalPath, "utf8")).toBe(contents);
    await store.appendJournal({ kind: "recovery", summary: "second" });
    expect((await store.readJournal()).map((entry) => entry.summary)).toEqual([
      "first",
      "second",
    ]);
  });

  it("refuses to discard an oversized terminated record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const contents = await readFile(store.journalPath, "utf8");
    await writeFile(
      store.journalPath,
      contents + "x".repeat(MAX_RALPH_JOURNAL_ENTRY_BYTES + 4_096) + "\n",
    );
    await expect(store.initialize()).rejects.toBeInstanceOf(
      RalphRunStoreCorruptionError,
    );
  });

  it("retries a journal flush without duplicating its committed record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const handle = await filesystem.open(store.journalPath, "r+");
    vi.spyOn(filesystem, "open").mockResolvedValueOnce(handle);
    vi.spyOn(handle, "sync").mockRejectedValueOnce(
      Object.assign(new Error("Journal temporarily busy"), { code: "EBUSY" }),
    );

    await expect(
      store.appendJournal({ kind: "recovery", summary: "second" }),
    ).resolves.toMatchObject({ sequence: 2 });
    expect((await store.readJournal()).map((entry) => entry.summary)).toEqual([
      "first",
      "second",
    ]);
    const restored = new RalphRunStore(directory);
    await restored.initialize();
    expect(
      await restored.appendJournal({ kind: "route", summary: "third" }),
    ).toMatchObject({ sequence: 3 });
  });

  it("replaces a partial journal append before retrying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const handle = await filesystem.open(store.journalPath, "r+");
    vi.spyOn(filesystem, "open").mockResolvedValueOnce(handle);
    const originalWrite = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementationOnce(async () => {
      await originalWrite(
        Buffer.from('{"sequence":2'),
        0,
        13,
        (await handle.stat()).size,
      );
      throw Object.assign(new Error("Partial write interrupted"), {
        code: "EBUSY",
      });
    });

    await expect(
      store.appendJournal({ kind: "recovery", summary: "second" }),
    ).resolves.toMatchObject({ sequence: 2 });
    expect((await store.readJournal()).map((entry) => entry.summary)).toEqual([
      "first",
      "second",
    ]);
  });

  it("streams initialization and repairs Unicode tails without reading the whole journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    const lines = Array.from({ length: 1_000 }, (_, index) => {
      const payload = {
        sequence: index + 1,
        at: new Date().toISOString(),
        kind: "route",
        summary: `Step ${index}: ${"🌍".repeat(80)}`,
      };
      return JSON.stringify({
        ...payload,
        checksum: createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex"),
      });
    });
    await filesystem.mkdir(directory, { recursive: true });
    await writeFile(store.journalPath, `${lines.join("\n")}\n{"sequence":1001`);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.spyOn(filesystem, "readFile").mockImplementation((...args) => {
      if (args[0] === store.journalPath) {
        throw new Error("Journal recovery must stream its history");
      }
      return actual.readFile(...args);
    });

    await store.initialize();
    expect(
      await store.appendJournal({ kind: "recovery", summary: "recovered 🌍" }),
    ).toMatchObject({ sequence: 1_001 });
    const journal = await store.readJournal();
    expect(journal).toHaveLength(1_001);
    expect(journal[0]?.summary).toBe(`Step 0: ${"🌍".repeat(80)}`);
    expect(journal.at(-1)?.summary).toBe("recovered 🌍");
  });

  it("refuses more appends after a failed rollback until the journal is repaired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first" });
    const handle = await filesystem.open(store.journalPath, "r+");
    vi.spyOn(filesystem, "open").mockResolvedValueOnce(handle);
    const originalWrite = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementationOnce(async () => {
      await originalWrite(
        Buffer.from('{"sequence":2'),
        0,
        13,
        (await handle.stat()).size,
      );
      throw Object.assign(new Error("Device failed during write"), {
        code: "EIO",
      });
    });
    vi.spyOn(handle, "truncate")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Device failed during rollback"));

    const failedAppend = store.appendJournal({
      kind: "route",
      summary: "failed",
    });
    await expect(failedAppend).rejects.toBeInstanceOf(AggregateError);
    await expect(failedAppend).rejects.toThrow("Device failed during write");
    await expect(failedAppend).rejects.toThrow("Device failed during rollback");
    await expect(
      store.appendJournal({ kind: "route", summary: "unsafe" }),
    ).rejects.toBeInstanceOf(AggregateError);
    await store.initialize();
    expect(
      await store.appendJournal({ kind: "recovery", summary: "repaired" }),
    ).toMatchObject({ sequence: 2 });
    expect((await store.readJournal()).map((entry) => entry.summary)).toEqual([
      "first",
      "repaired",
    ]);
  });

  it("terminates a valid flushed crash tail before writing its next record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "first 🌍" });
    await writeFile(
      store.journalPath,
      (await readFile(store.journalPath, "utf8")).trimEnd(),
    );
    const restored = new RalphRunStore(directory);
    await restored.initialize();
    await restored.appendJournal({ kind: "recovery", summary: "second" });
    expect(
      (await restored.readJournal()).map((entry) => entry.summary),
    ).toEqual(["first 🌍", "second"]);
  });

  it("falls back to the newest valid immutable checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.persistCheckpoint(checkpoint("one"), "one");
    const newest = await store.persistCheckpoint(checkpoint("two"), "two");
    await writeFile(newest.path, "{truncated", "utf8");

    expect(
      (await store.readLatestCheckpoint())?.checkpoint.currentBlockId,
    ).toBe("one");
  });

  it("heartbeats a tiny independent lease without rewriting its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    const identity = {
      runId: "run",
      flowId: "flow",
      ownerId: "owner",
      generation: 1,
      acquiredAt: new Date().toISOString(),
    };
    await store.acquireLease(identity, 5_000);
    const before = await stat(store.leasePath);
    const contents = await readFile(store.leasePath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.heartbeat(identity, 100);
    const after = await stat(store.leasePath);

    expect(await readFile(store.leasePath, "utf8")).toBe(contents);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  });

  it("fails closed when a durable lease exists but is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await writeFile(store.leasePath, "{truncated", "utf8");

    await expect(store.readLease()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("detects ownership replacement during a heartbeat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    const identity = {
      runId: "run",
      flowId: "flow",
      ownerId: "owner",
      generation: 1,
      acquiredAt: new Date().toISOString(),
    };
    await store.acquireLease(identity, 5_000);
    const owned = await store.readLease();
    vi.spyOn(store, "readLease")
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce({
        lease: {
          ...identity,
          schemaVersion: 1,
          durationMs: 5_000,
          ownerId: "replacement",
          generation: 2,
        },
        heartbeatAt: new Date().toISOString(),
        active: true,
      });

    await expect(store.heartbeat(identity, 100)).rejects.toBeInstanceOf(
      RalphRunStoreOwnershipError,
    );
  });

  it("ignores a truncated journal tail after a crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "valid" });
    await writeFile(
      store.journalPath,
      `${await readFile(store.journalPath, "utf8")}{"sequence":2`,
      "utf8",
    );

    expect(await store.readJournal()).toHaveLength(1);
  });

  it("repairs a truncated journal tail before appending new recovery state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const first = new RalphRunStore(directory);
    await first.initialize();
    await first.appendJournal({ kind: "route", summary: "first" });
    await writeFile(
      first.journalPath,
      `${await readFile(first.journalPath, "utf8")}{"sequence":2`,
      "utf8",
    );

    const resumed = new RalphRunStore(directory);
    await resumed.initialize();
    await resumed.appendJournal({ kind: "recovery", summary: "second" });

    expect((await resumed.readJournal()).map((entry) => entry.summary)).toEqual(
      ["first", "second"],
    );
    for (const line of (await readFile(resumed.journalPath, "utf8"))
      .split("\n")
      .filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("fails closed on a corrupt terminated journal entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();
    await store.appendJournal({ kind: "route", summary: "valid" });
    await writeFile(
      store.journalPath,
      `${await readFile(store.journalPath, "utf8")}{"sequence":2}\n`,
      "utf8",
    );

    await expect(store.readJournal()).rejects.toBeInstanceOf(
      RalphRunStoreCorruptionError,
    );
  });

  it("bounds immutable checkpoint storage while retaining recovery generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-store-"));
    directories.push(directory);
    const store = new RalphRunStore(directory);
    await store.initialize();

    for (let generation = 1; generation <= 12; generation += 1) {
      await store.persistCheckpoint(
        checkpoint(`block-${generation}`),
        `generation ${generation}`,
      );
    }

    expect(await readdir(store.checkpointDirectory)).toHaveLength(8);
    expect(
      (await store.readLatestCheckpoint())?.checkpoint.currentBlockId,
    ).toBe("block-12");
  });
});
