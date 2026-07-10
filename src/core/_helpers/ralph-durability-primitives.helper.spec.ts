import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRalphFileMutationLock,
  readRalphExecutionHistoryResults,
} from "../ralph.js";
import type { RalphRunLogPaths } from "./create-ralph-storage-paths.helper.js";

const createPaths = (directory: string): RalphRunLogPaths => ({
  id: "durability-test",
  directory,
  recordPath: join(directory, "run.json"),
  simpleJsonlPath: join(directory, "simple.jsonl"),
  simpleMarkdownPath: join(directory, "simple.md"),
  traceJsonlPath: join(directory, "trace.jsonl"),
});

describe("Ralph durability primitives", () => {
  it("allows only one simultaneous mutation-lock acquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-lock-race-"));
    const target = join(directory, "state.json");

    try {
      const attempts = await Promise.allSettled([
        acquireRalphFileMutationLock(target, "first"),
        acquireRalphFileMutationLock(target, "second"),
      ]);
      const acquired = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRalphFileMutationLock>>> =>
          attempt.status === "fulfilled",
      );
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");

      expect(acquired).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      await expect(acquired[0]!.value.assertOwnership()).resolves.toBeUndefined();
      await acquired[0]!.value.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a replacement lock when the stale lock owner releases late", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-lock-owner-"));
    const target = join(directory, "state.json");
    const lockPath = `${target}.ralph.lock`;

    try {
      const first = await acquireRalphFileMutationLock(target, "first", 20);
      const stale = new Date(Date.now() - 1_000);
      await utimes(lockPath, stale, stale);
      const second = await acquireRalphFileMutationLock(target, "second", 20);
      const replacement = await readFile(lockPath, "utf8");

      await first.release();

      await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
      await second.release();
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only an unterminated partial execution-history tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-history-tail-"));
    const paths = createPaths(directory);
    const valid = JSON.stringify({
      kind: "block-result",
      result: {
        blockId: "start",
        output: "SUCCESS",
        status: "completed",
        attempt: 1,
        summary: "Started.",
      },
    });

    try {
      await writeFile(
        join(directory, "execution-history.jsonl"),
        `${valid}\n{"kind":"block-res`,
        "utf8",
      );
      await expect(readRalphExecutionHistoryResults(paths)).resolves.toEqual([
        expect.objectContaining({ blockId: "start", output: "SUCCESS" }),
      ]);

      await writeFile(
        join(directory, "execution-history.jsonl"),
        `${valid}\nnot-json\n`,
        "utf8",
      );
      await expect(readRalphExecutionHistoryResults(paths)).rejects.toThrow(
        "Corrupt Ralph execution history",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on non-ENOENT execution-history read errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-history-io-"));
    const paths = createPaths(directory);

    try {
      await mkdir(join(directory, "execution-history.jsonl"));
      await expect(readRalphExecutionHistoryResults(paths)).rejects.toThrow(
        "Could not read Ralph execution history",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
