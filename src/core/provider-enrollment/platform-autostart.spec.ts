import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProviderSyncAutostartPath,
  installProviderSyncAutostart,
  renderProviderSyncAutostart,
} from "./platform-autostart.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider sync autostart", () => {
  it("renders a hidden Windows Script Host launcher", () => {
    const content = renderProviderSyncAutostart(
      "win32",
      "C:\\Program Files\\Machdoch\\node.exe",
      [
        "C:\\Program Files\\Machdoch\\machdoch cli.cjs",
        "provider-sync",
        "daemon",
        "--cwd",
        "C:\\Work Tree\\project",
      ],
    );

    expect(content).toContain('CreateObject("WScript.Shell")');
    expect(content).toContain(", 0, False");
    expect(content).toContain('""C:\\Program Files\\Machdoch\\node.exe""');
    expect(content).toContain('""C:\\Work Tree\\project""');
    expect(content).not.toContain("start \"\" /b");
  });

  it.runIf(process.platform === "win32")(
    "installs the hidden launcher and removes the legacy visible cmd entry",
    async () => {
      const appData = await mkdtemp(join(tmpdir(), "machdoch-autostart-"));
      roots.push(appData);
      vi.stubEnv("APPDATA", appData);
      const autostartPath = getProviderSyncAutostartPath();
      const legacyPath = join(dirname(autostartPath), "machdoch-provider-sync.cmd");
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, "@echo off\r\nstart \"\" /b node.exe\r\n", "utf8");

      await expect(installProviderSyncAutostart("C:\\workspace")).resolves.toBe(
        autostartPath,
      );

      expect(autostartPath).toMatch(/machdoch-provider-sync\.vbs$/u);
      await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(autostartPath, "utf8")).resolves.toContain(
        ", 0, False",
      );
    },
  );
});
