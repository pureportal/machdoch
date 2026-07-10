import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCooperativeFileLock } from "./with-cooperative-file-lock.helper.ts";

describe("withCooperativeFileLock", () => {
  it("serializes operations targeting the same file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-"));
    const destination = join(directory, "config.json");
    let activeOperations = 0;
    let maxActiveOperations = 0;

    const operation = async (): Promise<void> => {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      activeOperations -= 1;
    };

    try {
      await Promise.all([
        withCooperativeFileLock(destination, operation),
        withCooperativeFileLock(destination, operation),
      ]);
      expect(maxActiveOperations).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "uses the canonical directory as the Windows winner election under contention",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "machdoch-win-file-lock-"));
      const destination = join(directory, "config.json");
      const lockPath = `${destination}.machdoch.lock`;
      let activeOperations = 0;
      let maxActiveOperations = 0;

      try {
        await Promise.all(
          Array.from({ length: 12 }, async () => {
            await withCooperativeFileLock(destination, async () => {
              activeOperations += 1;
              maxActiveOperations = Math.max(
                maxActiveOperations,
                activeOperations,
              );
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              activeOperations -= 1;
            });
          }),
        );

        expect(maxActiveOperations).toBe(1);
        await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await readdir(directory)).some((entry) =>
            entry.includes(".machdoch.lock.candidate."),
          ),
        ).toBe(false);
      } finally {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
    },
  );

  it("does not release a lock after its owner token changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-owner-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;

    try {
      await withCooperativeFileLock(destination, async () => {
        const ownerDirectory = (await readdir(lockPath)).find((entry) =>
          entry.startsWith("owner."),
        );
        if (!ownerDirectory) {
          throw new Error("Expected the lock owner directory to exist.");
        }
        await writeFile(
          join(lockPath, ownerDirectory, "owner.json"),
          JSON.stringify({ token: "replacement", pid: process.pid }),
          "utf8",
        );
      });

      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes two contenders recovering the same stale owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-stale-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;
    const ownerDirectory = join(lockPath, "owner.dead-owner");
    const ownerPath = join(ownerDirectory, "owner.json");
    const events: string[] = [];
    let activeOperations = 0;
    let maxActiveOperations = 0;

    const runOperation = async (name: string, delayMs: number): Promise<void> => {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      events.push(`${name}-start`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      events.push(`${name}-end`);
      activeOperations -= 1;
    };

    try {
      await mkdir(lockPath);
      await mkdir(ownerDirectory);
      await writeFile(
        ownerPath,
        JSON.stringify({ token: "dead-owner", pid: 2_000_000_000 }),
        "utf8",
      );
      const staleTime = new Date(Date.now() - 180_000);
      await utimes(ownerPath, staleTime, staleTime);

      await Promise.all([
        withCooperativeFileLock(destination, () => runOperation("first", 40)),
        withCooperativeFileLock(destination, () => runOperation("second", 0)),
      ]);

      expect(maxActiveOperations).toBe(1);
      expect(events).toHaveLength(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
