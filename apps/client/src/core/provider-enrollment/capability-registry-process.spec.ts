/// <reference types="node" />
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeProviderCli } from "./capability-registry.js";

it.runIf(process.platform === "win32")(
  "executes real CLI wrappers from paths containing spaces",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch probe wrapper "));
    try {
      const executable = join(root, "fixture provider.cmd");
      await writeFile(
        executable,
        '@echo off\r\nif "%~1"=="--version" (\r\n  echo fixture-cli 1.0.0\r\n) else (\r\n  echo --append-system-prompt-file --output-format\r\n)\r\n',
      );
      const result = await probeProviderCli("claude-cli", executable);
      expect(result.available).toBe(true);
      expect(result.version).toBe("fixture-cli 1.0.0");
      expect(result.features).toEqual([
        "--append-system-prompt-file",
        "--output-format",
      ]);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
