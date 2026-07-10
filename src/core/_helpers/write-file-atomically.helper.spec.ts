import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("replaces a file and leaves no temporary artifact", async () => {
    const directory = await createTemporaryDirectory("ralph-atomic-");
    const path = join(directory, "record.json");

    await writeFileAtomically(path, "first");
    await writeFileAtomically(path, "second");

    expect(await readFile(path, "utf8")).toBe("second");
    expect(await scavengeAtomicTemporaryFiles(directory, { maxAgeMs: 0 })).toBe(0);
  });

  it("removes abandoned atomic temporary files after the retention window", async () => {
    const directory = await createTemporaryDirectory("ralph-atomic-stale-");
    await mkdir(directory, { recursive: true });
    const path = join(directory, ".run.json.42.11111111-1111-1111-1111-111111111111.tmp");
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
