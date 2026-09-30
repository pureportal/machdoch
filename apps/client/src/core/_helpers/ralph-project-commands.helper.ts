import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { isResolvedPathInside } from "./ralph-scope-registry.helper.js";

export const findRalphProjectCommandRoot = async (
  requestedPath: string,
  workspaceRoot: string,
): Promise<{ rootPath: string; pythonScope?: string }> => {
  const workspace = resolve(workspaceRoot);
  const metadata = await stat(requestedPath);
  const directory = metadata.isFile() ? dirname(requestedPath) : requestedPath;
  const entries = await readdir(directory, { withFileTypes: true });
  const pythonScope =
    extname(requestedPath) === ".py" ||
    entries.some((entry) => entry.isFile() && entry.name.endsWith(".py"));
  if (pythonScope) {
    let importRoot = directory;
    while (
      existsSync(join(importRoot, "__init__.py")) &&
      importRoot !== workspace
    ) {
      importRoot = dirname(importRoot);
    }
    if (!isResolvedPathInside(importRoot, workspace)) {
      throw new Error("Python import root must stay inside the workspace.");
    }
    return { rootPath: importRoot, pythonScope: directory };
  }
  let current = resolve(directory);
  while (isResolvedPathInside(current, workspace)) {
    if (
      ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"].some(
        (manifest) => existsSync(join(current, manifest)),
      )
    ) {
      return { rootPath: current };
    }
    if (current === workspace) {
      break;
    }
    current = dirname(current);
  }
  return { rootPath: directory };
};

export const quoteRalphCommandArgument = (value: string): string =>
  process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;

export const resolveRalphPythonCommand = async (
  rootPath: string,
  workspaceRoot: string,
): Promise<string> => {
  const candidates: string[] = [];
  const executable =
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  let directory = resolve(rootPath);
  while (isResolvedPathInside(directory, workspaceRoot)) {
    candidates.push(join(directory, ".venv", executable));
    if (directory === resolve(workspaceRoot)) {
      break;
    }
    directory = dirname(directory);
  }
  if (process.env.VIRTUAL_ENV) {
    candidates.push(join(process.env.VIRTUAL_ENV, executable));
  }
  candidates.push("python", "python3");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const installations = join(process.env.LOCALAPPDATA, "Programs", "Python");
    if (existsSync(installations)) {
      const entries = await readdir(installations, { withFileTypes: true });
      candidates.push(
        ...entries
          .filter(
            (entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name),
          )
          .sort((left, right) =>
            right.name.localeCompare(left.name, undefined, { numeric: true }),
          )
          .map((entry) => join(installations, entry.name, "python.exe")),
      );
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (!existsSync(candidate)) {
        continue;
      }
    }
    const probe = spawnSync(
      candidate,
      ["-c", "import sys; print(sys.executable)"],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
    if (probe.status === 0 && probe.stdout.trim()) {
      const path = quoteRalphCommandArgument(probe.stdout.trim());
      return process.platform === "win32" ? `& ${path}` : path;
    }
  }
  throw new Error(
    "Python verification runtime is unavailable. Install Python or configure a project .venv.",
  );
};

export const detectRalphPythonTestCommand = async (
  scope: string,
  rootPath: string,
  pythonCommand = "python",
): Promise<string | undefined> => {
  const entries = await readdir(scope, { withFileTypes: true });
  const tests = entries.filter(
    (entry) => entry.isFile() && /^(?:test_.+|.+_test)\.py$/u.test(entry.name),
  );
  if (tests.length === 0) {
    return undefined;
  }
  const sources = await Promise.all(
    tests.map((entry) => readFile(join(scope, entry.name), "utf8")),
  );
  const unittest = sources.every((source) =>
    /(?:import unittest|from unittest import)/u.test(source),
  );
  const scopeArgument = quoteRalphCommandArgument(
    relative(rootPath, scope).replaceAll("\\", "/") || ".",
  );
  return unittest
    ? `${pythonCommand} -m unittest discover -s ${scopeArgument} -t . -p '*test*.py'`
    : `${pythonCommand} -m pytest ${scopeArgument}`;
};
