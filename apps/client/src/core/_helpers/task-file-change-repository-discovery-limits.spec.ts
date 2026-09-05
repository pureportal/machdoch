import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { discoverWorkspaceGitRepositories } from "./task-file-change-repository-discovery.js";

const mocks = vi.hoisted(() => ({ opendir: vi.fn(), runGit: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  opendir: mocks.opendir,
  realpath: async (path: string) => path,
}));
vi.mock("./task-git-command.js", () => ({ runTaskGitCommand: mocks.runGit }));
const root = resolve("discovery-limit-workspace");
const entry = (name: string, directory: boolean) => ({
  name,
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
});

beforeEach(() => {
  mocks.opendir.mockReset();
  mocks.runGit
    .mockReset()
    .mockImplementation(async (_args: string[], options: { cwd: string }) => ({
      stdout: `true\n${options.cwd}\n`,
      stderr: "",
      exitCode: 0,
    }));
});

it("stops reading an oversized directory, closes its iterator, and reports incomplete discovery", async () => {
  let read = 0;
  let closed = false;
  mocks.opendir.mockImplementation(async () =>
    (async function* () {
      try {
        yield entry(".git", true);
        for (let index = 0; index < 60_000; index += 1) {
          read += 1;
          yield entry(`file-${index}`, false);
        }
      } finally {
        closed = true;
      }
    })(),
  );
  const result = await discoverWorkspaceGitRepositories(root);
  expect(result.repositories).toHaveLength(1);
  expect(result.issues.join(" ")).toContain("limit");
  expect(read).toBe(50_000);
  expect(closed).toBe(true);
  expect(mocks.opendir).toHaveBeenCalledTimes(1);
});

it("bounds repository validation rather than launching a probe for every nested marker", async () => {
  mocks.opendir.mockImplementation(async (path: string) =>
    (async function* () {
      yield entry(".git", true);
      if (path === root) {
        for (let index = 0; index < 300; index += 1)
          yield entry(`repo-${index}`, true);
      }
    })(),
  );
  const result = await discoverWorkspaceGitRepositories(root);
  expect(result.repositories).toHaveLength(256);
  expect(mocks.runGit).toHaveBeenCalledTimes(256);
  expect(result.issues.join(" ")).toContain("limit");
});
