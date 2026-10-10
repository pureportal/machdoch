import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkspaceConfigFile,
  saveWorkspaceAutoGitignore,
} from "./config.js";
import { ensureWorkspaceStorage } from "./workspace-storage.js";
import { getWorkspaceStorageMarkerPath } from "./workspace-storage-paths.js";

let root: string;
let configPath: string;
let ignorePath: string;
const patterns = "/local/\n*.machdoch.lock*/\n*.json.lock/\n*.tmp\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-gitignore-"));
  await mkdir(join(root, ".machdoch"));
  configPath = join(root, ".machdoch/config.json");
  ignorePath = join(root, ".machdoch/.gitignore");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("automatic workspace ignore rules", () => {
  it("creates rules by default and restores deleted rules after migration", async () => {
    expect((await loadWorkspaceConfigFile(root)).config).toEqual({});
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
    const marker = await lstat(getWorkspaceStorageMarkerPath(root));
    await unlink(ignorePath);
    await loadWorkspaceConfigFile(root);
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
    expect((await lstat(getWorkspaceStorageMarkerPath(root))).mtimeMs).toBe(
      marker.mtimeMs,
    );
  });

  it("appends missing rules while preserving custom rules and CRLF", async () => {
    const original = "# Project rules\r\ncustom/\r\n/local/\r\n\r\n*.tmp";
    await writeFile(ignorePath, original);
    await ensureWorkspaceStorage(root);
    expect(await readFile(ignorePath, "utf8")).toBe(
      `${original}\r\n*.machdoch.lock*/\r\n*.json.lock/\r\n`,
    );
    const metadata = await lstat(ignorePath);
    await Promise.all(
      Array.from({ length: 5 }, () => ensureWorkspaceStorage(root)),
    );
    expect((await lstat(ignorePath)).mtimeMs).toBe(metadata.mtimeMs);
  });

  it("does not modify either ignore file when disabled before initialization", async () => {
    await saveWorkspaceAutoGitignore(root, false);
    const rootIgnore = join(root, ".gitignore");
    await writeFile(rootIgnore, "node_modules/\n.machdoch/\n");
    await writeFile(ignorePath, "custom/\n");
    await ensureWorkspaceStorage(root);
    expect(await readFile(ignorePath, "utf8")).toBe("custom/\n");
    expect(await readFile(rootIgnore, "utf8")).toBe(
      "node_modules/\n.machdoch/\n",
    );
    await unlink(ignorePath);
    await ensureWorkspaceStorage(root);
    await expect(lstat(ignorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors config changes in the same process and applies re-enabling immediately", async () => {
    await ensureWorkspaceStorage(root);
    await writeFile(
      configPath,
      JSON.stringify({ autoGitignore: false, model: "test" }),
    );
    await ensureWorkspaceStorage(root);
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
    await unlink(ignorePath);
    await loadWorkspaceConfigFile(root);
    await expect(lstat(ignorePath)).rejects.toMatchObject({ code: "ENOENT" });
    await saveWorkspaceAutoGitignore(root, true);
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      autoGitignore: true,
      model: "test",
    });
  });

  it("serializes concurrent updates without duplicate rules", async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => ensureWorkspaceStorage(root)),
    );
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
  });

  it.each([null, "false", 0, {}])(
    "rejects an invalid autoGitignore value: %j",
    async (autoGitignore) => {
      await ensureWorkspaceStorage(root);
      await writeFile(configPath, JSON.stringify({ autoGitignore }));
      await unlink(ignorePath);
      await expect(ensureWorkspaceStorage(root)).rejects.toThrow(
        "Expected autoGitignore to be a boolean.",
      );
      await expect(lstat(ignorePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a directory at the ignore path and retries after it is removed", async () => {
    await mkdir(ignorePath);
    await expect(ensureWorkspaceStorage(root)).rejects.toThrow("regular file");
    await rm(ignorePath, { recursive: true });
    await ensureWorkspaceStorage(root);
    expect(await readFile(ignorePath, "utf8")).toBe(patterns);
  });

  it("ignores local files while keeping shared configuration visible to Git", async () => {
    execFileSync("git", ["init", "--quiet", root]);
    await ensureWorkspaceStorage(root);
    await writeFile(configPath, "{}");
    const paths = [
      ".machdoch/local/state/storage-layout.json",
      ".machdoch/config.json.machdoch.lock/owner/owner.json",
      ".machdoch/ralph/flow.json.lock/owner.json",
      ".machdoch/ralph/flow.tmp",
    ];
    const ignored = execFileSync("git", ["check-ignore", ...paths], {
      cwd: root,
      encoding: "utf8",
    });
    expect(ignored.trim().split(/\r?\n/u)).toEqual(paths);
    const status = execFileSync(
      "git",
      ["status", "--short", "--untracked-files=all"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(status).toContain("?? .machdoch/.gitignore");
    expect(status).toContain("?? .machdoch/config.json");
    expect(status).not.toContain("local/");
  });
});
