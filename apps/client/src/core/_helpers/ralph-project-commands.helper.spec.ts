import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectRalphPythonTestCommand,
  findRalphProjectCommandRoot,
} from "./ralph-project-commands.helper.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("task project command detection", () => {
  it("uses the Python import root instead of a parent Cargo manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-python-"));
    roots.push(root);
    const scope = join(root, "python", "package", "module");
    await mkdir(scope, { recursive: true });
    await Promise.all([
      writeFile(join(root, "Cargo.toml"), "[package]"),
      writeFile(join(root, "python", "package", "__init__.py"), ""),
      writeFile(join(scope, "__init__.py"), ""),
      writeFile(join(scope, "code.py"), ""),
      writeFile(join(scope, "test_code.py"), "import unittest"),
    ]);
    expect(await findRalphProjectCommandRoot(scope, root)).toEqual({
      rootPath: join(root, "python"),
      pythonScope: scope,
    });
    expect(
      await detectRalphPythonTestCommand(scope, join(root, "python")),
    ).toContain("unittest discover -s 'package/module' -t .");
  });
  it("does not invent test coverage for a Python scope without tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-no-tests-"));
    roots.push(root);
    await writeFile(join(root, "code.py"), "");
    expect(await detectRalphPythonTestCommand(root, root)).toBeUndefined();
  });
});
