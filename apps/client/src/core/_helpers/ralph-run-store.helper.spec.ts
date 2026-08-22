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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RalphRunCheckpoint } from "../ralph.js";
import {
  RalphRunStore,
  RalphRunStoreOwnershipError,
} from "./ralph-run-store.helper.js";

const directories: string[] = [];
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
