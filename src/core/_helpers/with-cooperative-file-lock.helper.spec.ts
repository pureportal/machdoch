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
import {
  inspectCooperativeFileLock,
  withCooperativeFileLock,
} from "./with-cooperative-file-lock.helper.ts";

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
    "atomically elects a populated Windows candidate under contention",
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

  it("reports an active owner on timeout without deleting its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-active-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;
    let markAcquired: () => void = () => undefined;
    let releaseHolder: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = withCooperativeFileLock(destination, async () => {
      markAcquired();
      await hold;
    }, {
      ownerDescription: "active lock test holder",
    });

    try {
      await acquired;
      await expect(inspectCooperativeFileLock(destination)).resolves.toMatchObject({
        state: "active",
        owner: {
          pid: process.pid,
          processAlive: true,
          description: "active lock test holder",
        },
      });
      await expect(withCooperativeFileLock(destination, async () => undefined, {
        timeoutMs: 60,
        staleLockAgeMs: 1,
        ownerDescription: "timing out contender",
      })).rejects.toThrow(
        new RegExp(`actively owned by PID ${process.pid}.*active lock test holder`, "u"),
      );
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      releaseHolder();
      await holder;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explains when a recent orphan is not old enough to reclaim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-orphan-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;
    const ownerDirectory = join(lockPath, "owner.dead-owner");

    try {
      await mkdir(ownerDirectory, { recursive: true });
      await writeFile(
        join(ownerDirectory, "owner.json"),
        JSON.stringify({ token: "dead-owner", pid: 2_000_000_000 }),
        "utf8",
      );

      await expect(withCooperativeFileLock(destination, async () => undefined, {
        timeoutMs: 60,
        staleLockAgeMs: 5_000,
      })).rejects.toThrow(/Owner PID 2000000000 is no longer running.*safe recovery/iu);
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

  it("recovers a stale owner from the legacy flat layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-legacy-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;
    const ownerPath = join(lockPath, "owner.json");

    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        JSON.stringify({ token: "legacy-dead-owner", pid: 2_000_000_000 }),
        "utf8",
      );
      const staleTime = new Date(Date.now() - 180_000);
      await utimes(ownerPath, staleTime, staleTime);

      await withCooperativeFileLock(destination, async () => undefined);

      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale token directory with truncated owner metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-truncated-"));
    const destination = join(directory, "config.json");
    const lockPath = `${destination}.machdoch.lock`;
    const ownerDirectory = join(lockPath, "owner.truncated-owner");
    const ownerPath = join(ownerDirectory, "owner.json");

    try {
      await mkdir(ownerDirectory, { recursive: true });
      await writeFile(ownerPath, "", "utf8");
      const staleTime = new Date(Date.now() - 180_000);
      await Promise.all([
        utimes(ownerPath, staleTime, staleTime),
        utimes(lockPath, staleTime, staleTime),
      ]);

      await withCooperativeFileLock(destination, async () => undefined);

      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
