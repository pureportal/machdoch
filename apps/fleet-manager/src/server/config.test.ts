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

function configurationPath(externalBaseUrl: string): string {
  const directory = mkdtempSync(join(tmpdir(), "machdoch-fleet-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "fleet-manager.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      externalBaseUrl,
      listen: { address: "127.0.0.1", port: 43188 },
      database: { path: "./fleet-manager.sqlite" },
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
});
