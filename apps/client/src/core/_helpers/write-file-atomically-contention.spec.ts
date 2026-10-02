import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "./write-file-atomically.helper.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockClear();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("atomic replacement ownership during contention", () => {
  it("checks the commit guard again after a failed replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atomic-contention-"));
    directories.push(directory);
    const path = join(directory, "record.json");
    await writeFile(path, "original", "utf8");
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error("locked"), { code: "EPERM" }),
    );
    const beforeCommit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("owner replaced"));

    await expect(
      writeFileAtomically(path, "stale", "utf8", { beforeCommit }),
    ).rejects.toThrow("owner replaced");

    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["record.json"]);
  });
});
