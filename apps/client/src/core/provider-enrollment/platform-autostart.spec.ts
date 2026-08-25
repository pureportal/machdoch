import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      {
        command: "C:\\Program Files\\Machdoch\\node.exe",
        args: ["C:\\Program Files\\Machdoch\\machdoch cli.cjs"],
        cwd: "C:\\Program Files\\Machdoch",
        environment: { MACHDOCH_USER_CONFIG_DIR: "C:\\Machdoch Config" },
      },
      ["provider-sync", "daemon", "--cwd", "C:\\Work Tree\\project"],
    );

    expect(content).toContain('CreateObject("WScript.Shell")');
    expect(content).toContain(", 0, False");
    expect(content).toContain('""C:\\Program Files\\Machdoch\\node.exe""');
    expect(content).toContain('""C:\\Work Tree\\project""');
    expect(content).toContain(
      'shell.CurrentDirectory = "C:\\Program Files\\Machdoch"',
    );
    expect(content).toContain(
      'shell.Environment("Process")("MACHDOCH_USER_CONFIG_DIR") = "C:\\Machdoch Config"',
    );
    expect(content).not.toContain('start "" /b');
  });

  it("renders working directory and environment for Unix autostart formats", () => {
    const launch = {
      command: "/opt/Machdoch Runtime/node",
      args: [
        "--import",
        "@oxc-node/core/register",
        "/opt/Machdoch CLI/main.ts",
      ],
      cwd: "/opt/Machdoch Source",
      environment: { MACHDOCH_USER_CONFIG_DIR: "/home/user/Machdoch Config" },
    };

    const linux = renderProviderSyncAutostart("linux", launch, [
      "provider-sync",
      "daemon",
    ]);
    expect(linux).toContain("Path=/opt/Machdoch\\sSource");
    expect(linux).toContain(
      'Exec="env" "MACHDOCH_USER_CONFIG_DIR=/home/user/Machdoch Config"',
    );
    expect(linux).toContain('"--import" "@oxc-node/core/register"');

    const mac = renderProviderSyncAutostart("darwin", launch, [
      "provider-sync",
      "daemon",
    ]);
    expect(mac).toContain(
      "<key>WorkingDirectory</key><string>/opt/Machdoch Source</string>",
    );
    expect(mac).toContain("<key>EnvironmentVariables</key>");
    expect(mac).toContain(
      "<key>MACHDOCH_USER_CONFIG_DIR</key><string>/home/user/Machdoch Config</string>",
    );
  });

  it("escapes Linux desktop-entry field codes and shell metacharacters", () => {
    const content = renderProviderSyncAutostart(
      "linux",
      {
        command: "/opt/$Mach`doch%/node",
        args: ["/opt/Machdoch%/cli.cjs"],
        cwd: "/opt/Machdoch Source",
        environment: {},
      },
      ["provider-sync", "daemon"],
    );

    expect(content).toContain('Exec="/opt/\\$Mach\\`doch%%/node"');
    expect(content).toContain('"/opt/Machdoch%%/cli.cjs"');
  });

  it.runIf(process.platform === "win32")(
    "installs the hidden launcher",
    async () => {
      const appData = await mkdtemp(join(tmpdir(), "machdoch-autostart-"));
      roots.push(appData);
      vi.stubEnv("APPDATA", appData);
      const autostartPath = getProviderSyncAutostartPath();

      await expect(installProviderSyncAutostart("C:\\workspace")).resolves.toBe(
        autostartPath,
      );

      expect(autostartPath).toMatch(/machdoch-provider-sync\.vbs$/u);
      await expect(readFile(autostartPath, "utf8")).resolves.toContain(
        ", 0, False",
      );
    },
  );
});
