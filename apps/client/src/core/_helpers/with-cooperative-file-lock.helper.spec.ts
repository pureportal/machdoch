import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
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

  it("reaps stale candidates left by dead processes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-stale-candidate-"),
    );
    const destination = join(directory, "config.json");
    const candidatePath = join(
      directory,
      "old-runtime.machdoch.lock.candidate.2000000000.dead-owner.abandoned",
    );
    const ownerPath = join(candidatePath, "owner.dead-owner", "owner.json");

    try {
      await mkdir(join(candidatePath, "owner.dead-owner"), { recursive: true });
      await writeFile(
        ownerPath,
        JSON.stringify({ token: "dead-owner", pid: 2_000_000_000 }),
        "utf8",
      );
      const staleTime = new Date(Date.now() - 180_000);
      await utimes(ownerPath, staleTime, staleTime);

      await withCooperativeFileLock(destination, async () => undefined, {
        staleLockAgeMs: 120_000,
      });

      await expect(stat(candidatePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "atomically elects a populated Windows candidate under contention",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "machdoch-win-file-lock-"),
      );
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
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-owner-"),
    );
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
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-active-"),
    );
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

    const holder = withCooperativeFileLock(
      destination,
      async () => {
        markAcquired();
        await hold;
      },
      {
        ownerDescription: "active lock test holder",
      },
    );

    try {
      await acquired;
      await expect(
        inspectCooperativeFileLock(destination),
      ).resolves.toMatchObject({
        state: "active",
        owner: {
          pid: process.pid,
          processAlive: true,
          description: "active lock test holder",
        },
      });
      await expect(
        withCooperativeFileLock(destination, async () => undefined, {
          timeoutMs: 60,
          staleLockAgeMs: 1,
          ownerDescription: "timing out contender",
        }),
      ).rejects.toThrow(
        new RegExp(
          `actively owned by PID ${process.pid}.*active lock test holder`,
          "u",
        ),
      );
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      releaseHolder();
      await holder;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 84_681, 180_000])(
    "recovers a dead owner aged %i ms without waiting for the stale threshold",
    async (ageMs) => {
      const directory = await mkdtemp(
        join(tmpdir(), "machdoch-file-lock-orphan-"),
      );
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
        const modified = new Date(Date.now() - ageMs);
        await utimes(join(ownerDirectory, "owner.json"), modified, modified);

        await expect(
          withCooperativeFileLock(destination, async () => "refreshed", {
            timeoutMs: 1_000,
          }),
        ).resolves.toBe("refreshed");
        await expect(
          inspectCooperativeFileLock(destination),
        ).resolves.toMatchObject({
          state: "unlocked",
        });
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["EPERM", "EACCES", "EINVAL"])(
    "preserves a lock when the owner probe fails with %s",
    async (code) => {
      const directory = await mkdtemp(
        join(tmpdir(), "machdoch-file-lock-probe-"),
      );
      const destination = join(directory, "config.json");
      const ownerDirectory = join(
        `${destination}.machdoch.lock`,
        "owner.uncertain",
      );
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("Process probe failed"), { code });
      });

      try {
        await mkdir(ownerDirectory, { recursive: true });
        await writeFile(
          join(ownerDirectory, "owner.json"),
          JSON.stringify({
            token: "uncertain",
            pid: process.pid,
          }),
        );
        await expect(
          withCooperativeFileLock(destination, async () => undefined, {
            timeoutMs: 60,
            staleLockAgeMs: 1,
          }),
        ).rejects.toThrow(`actively owned by PID ${process.pid}`);
        await expect(stat(ownerDirectory)).resolves.toBeDefined();
      } finally {
        probe.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("releases its lock when the operation fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-release-"),
    );
    const destination = join(directory, "config.json");

    try {
      await expect(
        withCooperativeFileLock(destination, async () => {
          throw new Error("Operation failed");
        }),
      ).rejects.toThrow("Operation failed");
      expect(await readdir(directory)).toEqual([]);
      await expect(
        withCooperativeFileLock(destination, async () => "refreshed"),
      ).resolves.toBe("refreshed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a lock left by a process exiting inside its operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "machdoch-file-lock-exit-"));
    const destination = join(directory, "config.json");
    const lockModuleUrl = new URL(
      "./with-cooperative-file-lock.helper.ts",
      import.meta.url,
    ).href;

    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { withCooperativeFileLock } from ${JSON.stringify(lockModuleUrl)};
         await withCooperativeFileLock(process.argv[1], async () => process.exit(0));`,
          destination,
        ],
        { windowsHide: true, timeout: 10_000 },
      );
      await expect(
        inspectCooperativeFileLock(destination),
      ).resolves.toMatchObject({
        state: "orphaned",
        staleAfterMs: 0,
        owner: { processAlive: false },
      });
      await expect(
        withCooperativeFileLock(destination, async () => "refreshed", {
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("refreshed");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves recent incomplete owner metadata", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-incomplete-"),
    );
    const destination = join(directory, "config.json");
    const ownerDirectory = join(
      `${destination}.machdoch.lock`,
      "owner.incomplete",
    );

    try {
      await mkdir(ownerDirectory, { recursive: true });
      await writeFile(join(ownerDirectory, "owner.json"), "");
      await expect(
        withCooperativeFileLock(destination, async () => undefined, {
          timeoutMs: 60,
        }),
      ).rejects.toThrow("Owner metadata is not available yet");
      await expect(stat(ownerDirectory)).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 180_000])(
    "serializes contenders recovering the same dead owner aged %i ms",
    async (ageMs) => {
      const directory = await mkdtemp(
        join(tmpdir(), "machdoch-file-lock-stale-"),
      );
      const destination = join(directory, "config.json");
      const lockPath = `${destination}.machdoch.lock`;
      const ownerDirectory = join(lockPath, "owner.dead-owner");
      const ownerPath = join(ownerDirectory, "owner.json");
      const events: string[] = [];
      let activeOperations = 0;
      let maxActiveOperations = 0;

      const runOperation = async (
        name: string,
        delayMs: number,
      ): Promise<void> => {
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
        const staleTime = new Date(Date.now() - ageMs);
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
    },
  );

  it("recovers a stale token directory with truncated owner metadata", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "machdoch-file-lock-truncated-"),
    );
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
