import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function configurationPath(
  externalBaseUrl: string,
  listenAddress = "127.0.0.1",
  settingsManager?: Record<string, unknown>,
): string {
  const directory = mkdtempSync(join(tmpdir(), "machdoch-fleet-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fleet-manager.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      externalBaseUrl,
      listen: { address: listenAddress, port: 43188 },
      database: { path: "./fleet-manager.sqlite" },
      ...(settingsManager ? { settingsManager } : {}),
    }),
  );
  return path;
}

describe("Fleet Manager configuration", () => {
  it("accepts loopback HTTP origins in development", () => {
    const config = loadConfig(
      configurationPath("http://127.0.0.1:43188"),
      "development",
    );

    expect(config.externalBaseUrl).toBe("http://127.0.0.1:43188");

    expect(
      loadConfig(
        configurationPath("http://127.0.0.2:43188", "127.0.0.2"),
        "development",
      ).listen.address,
    ).toBe("127.0.0.2");
  });

  it("requires HTTPS in production", () => {
    expect(() =>
      loadConfig(configurationPath("http://127.0.0.1:43188")),
    ).toThrow("externalBaseUrl must be an HTTPS origin.");
  });

  it("rejects non-loopback HTTP origins in development", () => {
    expect(() =>
      loadConfig(
        configurationPath("http://fleet.example.internal"),
        "development",
      ),
    ).toThrow(/loopback HTTP origin/u);
  });

  it("rejects secret limits that exceed the delivery protocol", () => {
    expect(() =>
      loadConfig(
        configurationPath("https://fleet.example.test", "127.0.0.1", {
          limits: {
            maximumProfiles: 64,
            maximumInstructionsPerProfile: 128,
            maximumPacksPerProfile: 128,
            maximumPromptsPerProfile: 128,
            maximumRevisionsPerProfile: 100,
            maximumDocumentBytes: 1024 * 1024,
            maximumSecretBytes: 8 * 1024 + 1,
          },
        }),
      ),
    ).toThrow();
  });
});
