import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scavengeAtomicTemporaryFiles,
  writeFileAtomically,
} from "./write-file-atomically.helper.js";

describe("atomic file persistence", () => {
  const directories: string[] = [];
  const createTemporaryDirectory = async (prefix: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("replaces a file and leaves no temporary artifact", async () => {
    const directory = await createTemporaryDirectory("ralph-atomic-");
    const path = join(directory, "record.json");

    await writeFileAtomically(path, "first");
    await writeFileAtomically(path, "second");

    expect(await readFile(path, "utf8")).toBe("second");
    expect(await scavengeAtomicTemporaryFiles(directory, { maxAgeMs: 0 })).toBe(
      0,
    );
  });

  it("runs a final stale-write guard before replacing the destination", async () => {
    const directory = await createTemporaryDirectory("atomic-guard-");
    const path = join(directory, "record.json");
    await writeFile(path, "external", "utf8");

    await expect(
      writeFileAtomically(path, "pending", "utf8", {
        beforeCommit: () => {
          throw new Error("stale destination");
        },
      }),
    ).rejects.toThrow("stale destination");
    expect(await readFile(path, "utf8")).toBe("external");
    expect(await scavengeAtomicTemporaryFiles(directory, { maxAgeMs: 0 })).toBe(
      0,
    );
  });

  it("stages a complete replacement outside the destination directory", async () => {
    const directory = await createTemporaryDirectory("atomic-staging-");
    const startupDirectory = join(directory, "Startup");
    const temporaryDirectory = join(directory, "staging");
    const path = join(startupDirectory, "launcher.vbs");
    await mkdir(startupDirectory);
    await writeFile(path, "installed", "utf8");

    await writeFileAtomically(path, "replacement", "utf8", {
      temporaryDirectory,
      beforeCommit: async () => {
        expect(await readdir(startupDirectory)).toEqual(["launcher.vbs"]);
        expect(await readFile(path, "utf8")).toBe("installed");
        const stagedFiles = await readdir(temporaryDirectory);
        expect(stagedFiles).toHaveLength(1);
        expect(
          await readFile(join(temporaryDirectory, stagedFiles[0]!), "utf8"),
        ).toBe("replacement");
      },
    });

    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("removes an external staged file when its commit is rejected", async () => {
    const directory = await createTemporaryDirectory("atomic-staging-failure-");
    const temporaryDirectory = join(directory, "staging");
    const path = join(directory, "record.json");
    await writeFile(path, "installed", "utf8");

    await expect(
      writeFileAtomically(path, "replacement", "utf8", {
        temporaryDirectory,
        beforeCommit: () => {
          throw new Error("commit rejected");
        },
      }),
    ).rejects.toThrow("commit rejected");

    expect(await readFile(path, "utf8")).toBe("installed");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing file permissions when replacing content",
    async () => {
      const directory = await createTemporaryDirectory("atomic-mode-");
      const path = join(directory, "credentials.json");
      await writeFile(path, "first", "utf8");
      await chmod(path, 0o600);

      await writeFileAtomically(path, "second");

      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).toBe("second");
    },
  );

  it.runIf(process.platform === "win32")(
    "waits through short Windows destination locks before replacing a file",
    async () => {
      const directory = await createTemporaryDirectory("atomic-lock-");
      const path = join(directory, "record.json");
      await writeFile(path, "first", "utf8");
      const lock = await open(path, "r+");
      let releaseLock = Promise.resolve();
      const releaseTimer = setTimeout(() => {
        releaseLock = lock.close();
      }, 600);

      try {
        await writeFileAtomically(path, "second");
      } finally {
        clearTimeout(releaseTimer);
        await releaseLock;
        await lock.close().catch(() => undefined);
      }

      expect(await readFile(path, "utf8")).toBe("second");
    },
  );

  it("removes abandoned atomic temporary files after the retention window", async () => {
    const directory = await createTemporaryDirectory("ralph-atomic-stale-");
    await mkdir(directory, { recursive: true });
    const path = join(
      directory,
      ".run.json.42.11111111-1111-1111-1111-111111111111.tmp",
    );
    await writeFile(path, "partial", "utf8");
    const metadata = await stat(path);

    expect(
      await scavengeAtomicTemporaryFiles(directory, {
        maxAgeMs: 1,
        now: metadata.mtimeMs + 2,
      }),
    ).toBe(1);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
