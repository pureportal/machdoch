import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadDesktopConfigEntries,
  requestDesktopSettings,
} from "./cli-desktop-config.js";
import {
  clearConfigSetting,
  saveConfigSetting,
} from "./cli-config-commands.js";

let root: string;
let server: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-settings-bridge-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
});
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("desktop settings bridge", () => {
  it("keeps desktop controls visible when the desktop is closed", async () => {
    const entries = await loadDesktopConfigEntries();
    expect(
      entries.find((entry) => entry.setting === "defaults.provider"),
    ).toMatchObject({
      source: "unavailable",
      unavailable: expect.stringContaining("Open the desktop"),
    });
  });

  it("isolates a stale or invalid descriptor from the rest of configuration", async () => {
    await writeFile(join(root, "cli-settings-bridge.json"), "{}");
    const entries = await loadDesktopConfigEntries();
    expect(
      entries.every((entry) => entry.unavailable?.includes("Restart")),
    ).toBe(true);
  });

  it("authenticates a local request and masks secret settings", async () => {
    const requests: unknown[] = [];
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          requests.push(JSON.parse(buffer.trim()));
          socket.end(
            JSON.stringify({
              ok: true,
              data: {
                defaults: {
                  newChat: {
                    provider: "openai",
                    models: { openai: "test-model" },
                  },
                },
                civitai: true,
              },
            }) + "\n",
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local address");
    await writeFile(
      join(root, "cli-settings-bridge.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: address.port,
        token: "a".repeat(64),
      }),
    );
    const entries = await loadDesktopConfigEntries();
    expect(requests).toEqual([
      { token: "a".repeat(64), action: "snapshot", setting: "" },
    ]);
    expect(
      entries.find((entry) => entry.setting === "defaults.model")?.value,
    ).toBe("test-model");
    expect(
      entries.find((entry) => entry.setting === "civitai.key")?.value,
    ).toBe("configured");
    await expect(
      requestDesktopSettings("set", "defaults.mode", null),
    ).resolves.toBeDefined();
    expect(
      await saveConfigSetting(root, " DEFAULTS.MODEL ", "  raw model  "),
    ).toEqual({
      setting: "defaults.model",
      scope: "user",
      configPath: "desktop",
      status: "configured",
      value: "  raw model  ",
    });
    expect(
      await saveConfigSetting(root, "civitai.key", "private-key"),
    ).not.toHaveProperty("value");
    expect(await clearConfigSetting(root, "appearance.theme")).toEqual({
      setting: "appearance.theme",
      scope: "user",
      configPath: "desktop",
      status: "reset",
    });
    expect(requests.at(-1)).toEqual({
      token: "a".repeat(64),
      action: "set",
      setting: "appearance.theme",
      value: "dark",
    });
    await clearConfigSetting(root, "spoken-reply.enabled");
    expect(requests.at(-1)).toEqual({
      token: "a".repeat(64),
      action: "set",
      setting: "spoken-reply.autoSpeakResponses",
      value: false,
    });
  });
});
